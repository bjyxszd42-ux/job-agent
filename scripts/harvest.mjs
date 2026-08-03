#!/usr/bin/env node
/**
 * 从 Common Crawl 批量收割公司 slug —— 可断点续跑
 *
 *   npm run harvest              抓一轮（每个 pattern 最多 10 页）
 *   npm run harvest -- --pages 5 抓少一点
 *   npm run harvest:status       看已经攒了多少
 *   npm run harvest:merge        把攒到的并进 companies.csv
 *
 * ── 为什么要能续跑 ──────────────────────────────────────────────
 * Common Crawl 的 URL 索引服务器是给小规模查询用的，官方明确说批量应该走
 * 列式索引。我们这种大域名查询（jobs.lever.co 下面有几十万条记录）会经常
 * 撞上 400 / 502 / 504 / 连接中断 —— 这【不是 bug，是常态】。
 *
 * 所以本脚本不追求一次跑完：
 *   · 每成功一页就立刻落盘，进度永不丢
 *   · 已经成功的 (快照, pattern, 页码) 记在 harvest-state.json 里，重跑自动跳过
 *   · 某个 pattern 挂了就换下一个，不阻塞整轮
 *   · slug 跨轮次累加去重，跑三五次就能攒到上万个
 *
 * 正确用法是【隔一会儿跑一次，跑几轮】，而不是指望一次成功。
 *
 * ── 原理 ────────────────────────────────────────────────────────
 * Common Crawl 每月爬遍互联网并公开 URL 索引，里面本来就有大量 ATS 页面：
 *     https://boards.greenhouse.io/stripe/jobs/4567
 *     https://nike.wd1.myworkdayjobs.com/en-US/nke/job/...
 * 正则一提，公司 slug 就掉出来了。Workday 尤其划算 —— tenant/host/site
 * 三样全在 URL 里，正是我们猜不出来的那三样。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep, UA } from './ats.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const MAX_PAGES  = parseInt(argVal('--pages', '10'), 10);
const ONLY_ATS   = argVal('--ats', null);
const TOP        = parseInt(argVal('--top', '0'), 10) || 0;
const STATUS     = args.includes('--status');
const MERGE_ONLY = args.includes('--merge-only');
const RESET      = args.includes('--reset');

const DELAY_MS   = 2000;    // 慢一点，索引服务器很脆弱
const PAGE_SIZE  = 1;       // 索引块数。1 已经是几千条记录，越大越容易超时

const F = {
  out:   path.join(ROOT, 'data/harvested.csv'),
  state: path.join(ROOT, 'data/harvest-state.json'),
  main:  path.join(ROOT, 'data/companies.csv'),
};

const NOISE = new Set([
  'embed', 'jobs', 'job', 'static', 'assets', 'api', 'wday', 'en-us', 'en',
  'careers', 'search', 'login', 'signin', 'apply', 'o', 'j', 'boards',
  'index.html', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'privacy', 'terms',
]);

// 用 /* 通配（pywb 的 prefix 匹配）。实测比 matchType=domain 稳 ——
// domain 模式会把所有子域名都算进来，结果集大一个数量级，服务器直接拒绝。
const SOURCES = [
  { ats: 'greenhouse', patterns: ['boards.greenhouse.io/*', 'job-boards.greenhouse.io/*'],
    extract: (u) => { const m = u.match(/(?:job-)?boards\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/);
      return m && !NOISE.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null; } },

  { ats: 'lever', patterns: ['jobs.lever.co/*'],
    extract: (u) => { const m = u.match(/jobs\.lever\.co\/([A-Za-z0-9_-]+)/);
      return m && !NOISE.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null; } },

  // Ashby 的 token 大小写敏感，原样保留
  { ats: 'ashby', patterns: ['jobs.ashbyhq.com/*'],
    extract: (u) => { const m = u.match(/jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/);
      return m && !NOISE.has(m[1].toLowerCase()) ? m[1] : null; } },

  { ats: 'workable', patterns: ['apply.workable.com/*'],
    extract: (u) => { const m = u.match(/apply\.workable\.com\/([A-Za-z0-9_-]+)/);
      return m && !NOISE.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null; } },

  { ats: 'smartrecruiters', patterns: ['jobs.smartrecruiters.com/*'],
    extract: (u) => { const m = u.match(/jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/);
      return m && !NOISE.has(m[1].toLowerCase()) ? m[1] : null; } },

  { ats: 'recruitee', patterns: ['*.recruitee.com'],
    extract: (u) => { const m = u.match(/https?:\/\/([A-Za-z0-9-]+)\.recruitee\.com/);
      return m && m[1] !== 'www' && !NOISE.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null; } },

  // ★ tenant / host / site 三样全在 URL 里
  { ats: 'workday', patterns: ['*.myworkdayjobs.com'],
    extract: (u) => {
      const m = u.match(/https?:\/\/([A-Za-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Za-z]{2}\/)?([A-Za-z0-9_-]+)/);
      if (!m || NOISE.has(m[3].toLowerCase())) return null;
      return `${m[1]}|${m[3]}|${m[2]}`;
    } },
];

const readJSON = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return d; } };

/** 载入已攒下的 slug（跨轮次累加） */
async function loadHarvested() {
  const map = new Map();   // "ats\ttoken" -> hits
  try {
    const raw = await fs.readFile(F.out, 'utf8');
    for (const line of raw.split('\n').slice(1)) {
      const c = line.split(',');
      if (c.length < 3 || !c[1]) continue;
      const hits = parseInt((c[4] || '').match(/命中(\d+)/)?.[1] || '1', 10);
      map.set(`${c[1]}\t${c[2]}`, hits);
    }
  } catch {}
  return map;
}

async function saveHarvested(map) {
  const rows = [...map.entries()].map(([k, hits]) => {
    const [ats, token] = k.split('\t');
    return { ats, token, hits };
  }).sort((a, b) => a.ats.localeCompare(b.ats) || b.hits - a.hits);

  const lines = ['company,ats,token,enabled,notes'];
  for (const r of rows) {
    const name = r.ats === 'workday' ? r.token.split('|')[0] : r.token;
    lines.push(`${name},${r.ats},${r.token},true,CommonCrawl 命中${r.hits}次`);
  }
  await fs.writeFile(F.out, lines.join('\n') + '\n');
  return rows;
}

async function latestCrawl() {
  const res = await fetch('https://index.commoncrawl.org/collinfo.json',
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`拿不到 collinfo.json（HTTP ${res.status}）`);
  return (await res.json())[0].id;
}

/**
 * 查一页。返回 {urls} / {done} / {busy}
 * 400 / 5xx / 连接中断 一律归类为 busy —— 索引服务器过载的表现形式很多，
 * 但对我们来说都一样：这页这次没拿到，下次再来。
 */
async function cdxPage(crawl, pattern, page) {
  const url = `https://index.commoncrawl.org/${crawl}-index`
    + `?url=${encodeURIComponent(pattern)}&output=json&pageSize=${PAGE_SIZE}&page=${page}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(90000) });
    if (res.status === 404) return { done: true };
    if (!res.ok) return { busy: `HTTP ${res.status}` };

    const text = await res.text();
    if (!text.trim() || /No Captures found/i.test(text)) return { done: true };

    const urls = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.url) urls.push(r.url); } catch {}
    }
    return urls.length ? { urls } : { done: true };
  } catch (err) {
    return { busy: err.message };
  }
}

async function mergeIntoMain(rows) {
  const cur = await fs.readFile(F.main, 'utf8');
  const known = new Set();
  for (const l of cur.split('\n')) {
    const c = l.split(',');
    if (c.length >= 3) known.add(`${c[1]}\t${c[2]}`);
  }
  const picked = TOP
    ? Object.values(rows.reduce((acc, r) => { (acc[r.ats] ||= []).push(r); return acc; }, {}))
        .flatMap((g) => g.slice(0, TOP))
    : rows;
  const add = picked.filter((r) => !known.has(`${r.ats}\t${r.token}`));
  if (!add.length) { console.log('\n没有新增（都已经在 companies.csv 里了）'); return; }

  const lines = add.map((r) => {
    const name = r.ats === 'workday' ? r.token.split('|')[0] : r.token;
    return `${name},${r.ats},${r.token},true,CommonCrawl 命中${r.hits}次`;
  });
  await fs.writeFile(F.main, cur.trimEnd() + '\n# ── 以下由 Common Crawl 收割，尚未验证 ──\n' + lines.join('\n') + '\n');
  console.log(`\n已并入 companies.csv：新增 ${add.length} 家${TOP ? `（每个 ATS 取命中最高的前 ${TOP} 个）` : ''}`);
  console.log(`⚠️  必须立刻跑一次  npm run verify  —— 收割来的 slug 实测三到五成已失效`);
}

async function main() {
  if (RESET) { await fs.rm(F.state, { force: true }); console.log('进度已清空'); return; }

  const harvested = await loadHarvested();

  if (STATUS || MERGE_ONLY) {
    const rows = await saveHarvested(harvested);
    const by = rows.reduce((a, r) => { a[r.ats] = (a[r.ats] || 0) + 1; return a; }, {});
    console.log('已攒下的 slug：');
    for (const [ats, n] of Object.entries(by)) console.log(`  ${ats.padEnd(16)} ${n}`);
    console.log(`  ${'合计'.padEnd(14)} ${rows.length}`);
    const state = await readJSON(F.state, {});
    console.log(`\n已完成 ${Object.keys(state).length} 个页面`);
    if (MERGE_ONLY) await mergeIntoMain(rows);
    return;
  }

  const state = await readJSON(F.state, {});
  const crawl = await latestCrawl();
  const sources = ONLY_ATS ? SOURCES.filter((s) => s.ats === ONLY_ATS) : SOURCES;

  console.log(`Common Crawl 收割 · 快照 ${crawl}`);
  console.log(`每个 pattern 最多 ${MAX_PAGES} 页 · 间隔 ${DELAY_MS}ms`);
  console.log(`已攒 ${harvested.size} 个 slug，已完成 ${Object.keys(state).length} 个页面\n`);
  console.log('索引服务器不稳定是常态，挂了会自动跳过，重跑本命令即可续上。\n');

  let gained = 0, okPages = 0, busyPages = 0;

  for (const src of sources) {
    for (const pattern of src.patterns) {
      let consecutiveBusy = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const key = `${crawl}|${pattern}|${page}`;
        if (state[key]) continue;                       // 这页之前已经成功过

        const r = await cdxPage(crawl, pattern, page);

        if (r.done) { state[key] = 'end'; break; }      // 没有更多结果了
        if (r.busy) {
          busyPages++;
          consecutiveBusy++;
          console.log(`  ${src.ats.padEnd(15)} p${page}  忙 (${r.busy})`);
          await sleep(3000);
          if (consecutiveBusy >= 2) break;              // 连挂两次就换下一个 pattern
          continue;
        }

        consecutiveBusy = 0;
        const before = harvested.size;
        for (const u of r.urls) {
          const tok = src.extract(u);
          if (!tok) continue;
          const k = `${src.ats}\t${tok}`;
          harvested.set(k, (harvested.get(k) || 0) + 1);
        }
        const added = harvested.size - before;
        gained += added;
        okPages++;
        state[key] = 'ok';

        // 每页都落盘，进度永不丢
        await saveHarvested(harvested);
        await fs.writeFile(F.state, JSON.stringify(state));

        console.log(`  ${src.ats.padEnd(15)} p${page}  +${String(added).padStart(4)}  累计 ${harvested.size}`);
        await sleep(DELAY_MS);
      }
    }
  }

  const rows = await saveHarvested(harvested);
  console.log('\n────────────────────────────');
  console.log(`本轮：成功 ${okPages} 页 · 服务器忙 ${busyPages} 页 · 新增 ${gained} 个 slug`);
  console.log(`累计：${rows.length} 个 slug`);
  const by = rows.reduce((a, r) => { a[r.ats] = (a[r.ats] || 0) + 1; return a; }, {});
  for (const [ats, n] of Object.entries(by)) console.log(`  ${ats.padEnd(16)} ${n}`);

  if (busyPages) {
    console.log(`\n有 ${busyPages} 页因为服务器忙没拿到 —— 这是常态，不是出错。`);
    console.log(`过几分钟再跑一次 npm run harvest 就会从断掉的地方续上。`);
  }
  console.log(`\n攒够了就并入主表：  npm run harvest:merge`);
}

main().catch((e) => { console.error(e); process.exit(1); });
