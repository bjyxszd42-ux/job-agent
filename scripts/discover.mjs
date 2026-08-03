#!/usr/bin/env node
/**
 * 自动发现公司的 ATS 和 board token
 *
 *   node scripts/discover.mjs                    # 用 data/candidates.txt
 *   node scripts/discover.mjs my-list.txt        # 用你自己的名单
 *   node scripts/discover.mjs --merge            # 发现完直接并入 companies.csv
 *
 * 输入：一行一个公司名（支持 "显示名 | 指定slug" 覆盖自动猜测）
 * 原理：对每家公司生成几个 slug 变体，依次探测 6 家 ATS 的公开接口，
 *      命中（返回 >0 个岗位）就记下来。分三轮递进，命中即停，
 *      所以大多数公司只花 1–6 个请求，不会把接口打爆。
 *
 * 输出：data/companies.discovered.csv
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ADAPTERS, sleep, UA } from './ats.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const MERGE = args.includes('--merge');
const WORKDAY = args.includes('--workday');   // 只探测 Workday
const GUESS = args.includes('--guess');       // Workday: 没给 URL 时也硬猜（命中率极低）
const inputFile = args.find((a) => !a.startsWith('--'))
  || (WORKDAY ? 'data/candidates-workday.txt' : 'data/candidates.txt');

const OUT = path.join(ROOT, 'data/companies.discovered.csv');
const MAIN = path.join(ROOT, 'data/companies.csv');

const CONCURRENCY = 3;   // 探测阶段请求量大，比日常抓取更保守
const DELAY_MS = 500;

/** 从公司名生成 slug 变体 */
function slugs(name) {
  const clean = name.replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs|the)\b/gi, '').trim();
  const words = clean.split(/[\s\-_/&,.]+/).filter(Boolean);
  const lowerNoSpace = words.join('').toLowerCase();
  const lowerHyphen = words.join('-').toLowerCase();
  const camel = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return {
    v1: lowerNoSpace,                                   // stripe, capitalone
    v2: lowerHyphen,                                    // capital-one
    v3: camel,                                          // CapitalOne（Ashby 常用）
  };
}

/** 探测单个 (ats, token) 组合 */
async function probe(ats, token, display) {
  try {
    const { jobs, notFound } = await ADAPTERS[ats](token, display);
    if (notFound) return null;
    if (!jobs || jobs.length === 0) return { ats, token, count: 0, weak: true };
    return { ats, token, count: jobs.length };
  } catch {
    return null;
  }
}

/**
 * Workday 专用探测。
 *
 * Workday 的难点在于一个租户要同时确定三样东西：tenant、site、host(wd1/wd3/wd5)。
 * 组合数很大，所以单独一个模式跑，并且请求间隔更长（Akamai bot 管理很敏感）。
 *
 * 支持在名单里直接写完整 careers URL，那样就不用猜了 —— 强烈推荐这种写法：
 *   NVIDIA | https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
 */
// 实测过的真实 site 名：External_Career_Site、Cisco_Careers、Capital_One、
// CVS_Health_Careers、targetcareers、AccentureCareers…… 完全没有规律，
// 所以【不再穷举 site 名】。改成两个未知数：tenant 和 host，site 靠根路径的
// 302 跳转直接读出来 —— Workday 根域名会跳到该租户的默认 site。
const WD_HOSTS = ['wd1', 'wd5', 'wd3', 'wd12', 'wd2', 'wd6', 'wd10', 'wd103', 'wd101', 'wd102', 'wd105', 'wd8'];

/** 从完整 Workday careers URL 里直接解析出 tenant|site|host */
export function parseWorkdayUrl(url) {
  const m = String(url).match(/https?:\/\/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/i);
  return m ? { tenant: m[1], host: m[2], site: m[3] } : null;
}

/**
 * 关键一步：给定 tenant + host，让 Workday 自己告诉我们 site 是什么。
 * 根路径 https://{tenant}.{host}.myworkdayjobs.com/ 会 302 到默认 site。
 * 这样就从「猜 4×7=28 种组合」降到「每个 host 试 1 次」。
 */
const SITE_BLACKLIST = /^(wday|en-US|en|us|assets|static|favicon\.ico)$/i;

async function resolveWorkdaySite(tenant, host) {
  const base = `https://${tenant}.${host}.myworkdayjobs.com/`;
  try {
    const res = await fetch(base, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(15000),
    });

    const loc = res.headers.get('location');
    if (loc) {
      const m = loc.match(/(?:myworkdayjobs\.com)?\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]{2,})/);
      if (m && !SITE_BLACKLIST.test(m[1])) return m[1];
    }

    // 没有 Location 头就从 HTML 里找（有些租户用 JS 跳转）
    if (res.status === 200) {
      const html = await res.text();
      const m2 = html.match(/myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]{2,})/);
      if (m2 && !SITE_BLACKLIST.test(m2[1])) return m2[1];
    }
  } catch { /* host 不存在，静默跳过 */ }
  return null;
}

/**
 * Workday 探测，三档递进：
 *   档1  名单里给了完整 URL          → 直接解析，1 次请求（最快最准，强烈推荐）
 *   档2  名单里给了 tenant.wdN 提示   → 只解析 site，1–2 次请求
 *   档3  只有公司名                   → 猜 tenant，逐个 host 试根跳转，最多 12 次
 */
async function discoverWorkday(entry) {
  const [rawName, hint] = entry.split('|').map((s) => s.trim());
  const display = rawName;

  // 档1：完整 URL
  if (hint && hint.includes('myworkdayjobs.com')) {
    const p = parseWorkdayUrl(hint);
    if (p) {
      const token = `${p.tenant}|${p.site}|${p.host}`;
      const hit = await probe('workday', token, display);
      if (hit && !hit.weak) return { display, ...hit, status: 'found' };
      return { display, ats: 'workday', token, count: 0, status: 'empty' };
    }
  }

  // 没给 URL 的：默认直接跳过并列进待办，不做无谓的猜测。
  //
  // 实测结论：根路径 302 解析 site 这招【不成立】（Akamai 会拦 HTML 请求，
  // 且不少租户根本不跳转）。而 site 名实测有 Ext / nke / ANT / ms / Careers_GM
  // 这种值，穷举永远猜不中。所以默认不猜 —— 猜 188 家白跑 7 分钟一无所获，
  // 不如直接告诉你哪几家需要花 20 秒 Google 一下。
  //
  // 真想碰运气就加 --guess。
  if (!GUESS) return { display, status: 'need_url' };

  const hostHint = hint?.match(/^([\w-]+)\.(wd\d+)$/i);
  const s = slugs(rawName);
  const tenant = hostHint ? hostHint[1] : (hint && !hint.includes('.') && !hint.includes('/') ? hint : s.v1);
  const hosts = hostHint ? [hostHint[2]] : WD_HOSTS;

  for (const host of hosts) {
    const site = await resolveWorkdaySite(tenant, host);
    await sleep(400);
    if (!site) continue;
    const token = `${tenant}|${site}|${host}`;
    const hit = await probe('workday', token, display);
    await sleep(400);
    if (hit && !hit.weak) return { display, ...hit, status: 'found' };
    if (hit?.weak) return { display, ats: 'workday', token, count: 0, status: 'empty' };
  }
  return { display, status: 'need_url' };
}

/**
 * 分三轮递进探测，命中即停：
 *   轮1  6 家 ATS × 小写无空格        （覆盖绝大多数）
 *   轮2  greenhouse/lever/ashby × 连字符
 *   轮3  ashby × 驼峰（Ashby 的 token 大小写敏感）
 */
async function discoverOne(entry) {
  const [rawName, forced] = entry.split('|').map((s) => s.trim());
  const display = rawName;
  const s = slugs(rawName);
  const weakHits = [];

  const rounds = forced
    ? [[['greenhouse', forced], ['lever', forced], ['ashby', forced], ['workable', forced], ['recruitee', forced], ['smartrecruiters', forced]]]
    : [
        [['greenhouse', s.v1], ['lever', s.v1], ['ashby', s.v1], ['workable', s.v1], ['recruitee', s.v1], ['smartrecruiters', s.v1]],
        [['greenhouse', s.v2], ['lever', s.v2], ['ashby', s.v2]],
        [['ashby', s.v3], ['smartrecruiters', s.v3]],
      ];

  for (const round of rounds) {
    for (const [ats, token] of round) {
      if (!token) continue;
      const hit = await probe(ats, token, display);
      await sleep(120);
      if (hit && !hit.weak) return { display, ...hit, status: 'found' };
      if (hit?.weak) weakHits.push(hit);
    }
  }
  // 接口通但 0 个岗位：可能是真没在招，也可能 token 猜错了，交给你人工判断
  if (weakHits.length) return { display, ...weakHits[0], status: 'empty' };
  return { display, status: 'notfound' };
}

async function pool(items, limit, worker) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx], idx);
        await sleep(DELAY_MS);
      }
    })
  );
  return out;
}

/** 快速验证单个 Workday URL：node scripts/discover.mjs --probe <url> */
async function probeOne(url) {
  const p = parseWorkdayUrl(url);
  if (!p) return console.log('这不是一个 Workday careers URL');
  const token = `${p.tenant}|${p.site}|${p.host}`;
  console.log(`解析为  tenant=${p.tenant}  site=${p.site}  host=${p.host}`);
  console.log(`探测中 ...`);
  const hit = await probe('workday', token, 'test');
  if (hit && !hit.weak) console.log(`✓ 有效，返回 ${hit.count} 个岗位\n  写进名单：  公司名 | ${url}`);
  else if (hit?.weak) console.log('· 接口通但返回 0 个岗位 —— site 可能不对，或该租户确实没在招');
  else console.log('✗ 无效，检查 URL 是否完整');
}

async function main() {
  const probeUrl = args[args.indexOf('--probe') + 1];
  if (args.includes('--probe')) return probeOne(probeUrl);

  const raw = await fs.readFile(path.resolve(ROOT, inputFile), 'utf8');
  const entries = raw.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  // 已经在 companies.csv 里的跳过，避免重复探测
  let known = new Set();
  try {
    const cur = await fs.readFile(MAIN, 'utf8');
    cur.split('\n').slice(1).forEach((l) => {
      const c = l.split(',');
      if (c[0] && !c[0].startsWith('#')) known.add(c[0].trim().toLowerCase());
    });
  } catch {}

  const todo = entries.filter((e) => !known.has(e.split('|')[0].trim().toLowerCase()));
  const mode = WORKDAY ? 'Workday' : '通用 ATS';
  const perItem = WORKDAY ? 6 : 4;
  const conc = WORKDAY ? 2 : CONCURRENCY;   // Workday 并发压到 2，避免被 Akamai 拦
  console.log(`【${mode} 模式】名单 ${entries.length} 家，已在 companies.csv 的跳过 ${entries.length - todo.length} 家，本次探测 ${todo.length} 家`);
  console.log(`预计 ${Math.ceil(todo.length * perItem * 0.7 / conc / 60)} 分钟左右\n`);
  if (WORKDAY) {
    console.log('提示：名单里直接写完整 careers URL 可以一次命中，不用猜，快很多：');
    console.log('      NVIDIA | https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite\n');
  }

  let done = 0;
  const results = await pool(todo, conc, async (e) => {
    const r = WORKDAY ? await discoverWorkday(e) : await discoverOne(e);
    done++;
    const mark = r.status === 'found' ? '✓' : r.status === 'empty' ? '·'
      : r.status === 'need_url' ? '?' : '✗';
    const detail = r.status === 'found' ? `${r.ats}/${r.token} → ${r.count}`
      : r.status === 'empty' ? `${r.ats}/${r.token} → 0 个岗位（存疑）`
      : r.status === 'need_url' ? '待补 careers URL'
      : '未找到';
    console.log(`  ${mark} [${String(done).padStart(3)}/${todo.length}] ${r.display.padEnd(24)} ${detail}`);
    return r;
  });

  const found = results.filter((r) => r.status === 'found');
  const empty = results.filter((r) => r.status === 'empty');
  const miss = results.filter((r) => r.status === 'notfound');
  const needUrl = results.filter((r) => r.status === 'need_url');

  // Workday 模式：把「需要补 URL」的公司写成可直接编辑的待办文件，
  // 每行都是填好一半的名单格式 + 现成的 Google 搜索串，补一家花 20 秒。
  if (needUrl.length) {
    const todoFile = path.join(ROOT, 'data/workday-todo.txt');
    const tl = [
      '# 这些公司需要你手工补一个 careers URL（补完粘回 data/candidates-workday.txt）',
      '#',
      '# 每家 20 秒：复制下面注释里的搜索串丢进 Google，结果里那串',
      '#   xxx.wdN.myworkdayjobs.com/YYY  整个复制到 | 后面即可。',
      '#',
      '# 不用全补 —— 只补你真正想投的那些。剩下的留着不管也不影响。',
      '',
    ];
    for (const r of needUrl) {
      tl.push(`# 搜: site:myworkdayjobs.com "${r.display}"`);
      tl.push(`${r.display} | `);
      tl.push('');
    }
    await fs.writeFile(todoFile, tl.join('\n'));
  }

  const lines = ['company,ats,token,enabled,notes'];
  for (const r of found) lines.push(`${r.display},${r.ats},${r.token},true,自动发现 ${r.count} 个岗位`);
  for (const r of empty) lines.push(`${r.display},${r.ats},${r.token},false,接口通但 0 岗位 请人工确认`);
  await fs.writeFile(OUT, lines.join('\n') + '\n');

  console.log(`\n找到 ${found.length} 家 · 存疑 ${empty.length} 家` +
    (miss.length ? ` · 没找到 ${miss.length} 家` : '') +
    (needUrl.length ? ` · 待补 URL ${needUrl.length} 家` : ''));
  console.log(`已写入 data/companies.discovered.csv`);

  if (miss.length) {
    console.log(`
没找到的（多半用 Workday 或自建系统，需要手工去 careers 页确认）：`);
    console.log('  ' + miss.map((r) => r.display).join(', '));
  }

  if (needUrl.length) {
    console.log(`
${needUrl.length} 家需要手工补 careers URL —— 已生成待办清单：`);
    console.log(`  data/workday-todo.txt`);
    console.log(`
里面每家都配好了现成的 Google 搜索串，补一家约 20 秒。`);
    console.log(`只补你真正想投的那些就行，不用全补。`);
    console.log(`补完把那几行粘回 data/candidates-workday.txt，再跑一次本命令。`);
  }

  if (MERGE) {
    const cur = await fs.readFile(MAIN, 'utf8');
    const add = lines.slice(1).join('\n');
    await fs.writeFile(MAIN, cur.trimEnd() + '\n' + add + '\n');
    console.log(`\n已并入 data/companies.csv（存疑的以 enabled=false 写入，确认后自己改成 true）`);
  } else {
    console.log(`\n确认无误后跑 node scripts/discover.mjs --merge 并入主表，或手工复制粘贴`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
