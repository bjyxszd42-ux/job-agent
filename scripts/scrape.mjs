#!/usr/bin/env node
/**
 * 岗位抓取主程序 —— 跑在 GitHub Actions 上
 *
 *   node scripts/scrape.mjs           正常抓取
 *   node scripts/scrape.mjs --verify  只验证 companies.csv 里的 token 是否有效
 *
 * 产出（全部 commit 回仓库，git 历史即快照历史）：
 *   data/state.json    每个岗位的 first_seen_at / last_seen_at / closed_at
 *   data/jobs.json     当前在招岗位全量
 *   out/digest.md      本次新增岗位摘要
 *   out/health.json    各公司抓取健康状况
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ADAPTERS, sleep } from './ats.mjs';
import { normalizeLocation, matchFamilies, detectSeniority, matchesUserPrefs, dedupeKey, stableId } from './normalize.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const P = {
  companies: path.join(ROOT, 'data/companies.csv'),
  taxonomy: path.join(ROOT, 'data/taxonomy.json'),
  state: path.join(ROOT, 'data/state.json'),
  prefs: path.join(ROOT, 'data/prefs.json'),
  jobs: path.join(ROOT, 'data/jobs.json'),
  digest: path.join(ROOT, 'out/digest.md'),
  health: path.join(ROOT, 'out/health.json'),
};

// 并发和间隔可用环境变量覆盖。
// 本地跑不赶时间可以保守些；GitHub Actions 的机器只有 2 核、网络也慢，
// 2300 家公司用 4 并发 + 400ms 间隔会超 25 分钟，必须调高。
// 注意这里的并发是【跨所有 ATS 的总并发】—— 实际落到 Greenhouse 单个域名上
// 的并发只有几分之一，所以 10 并发对任何一家接口都不算猛。
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '150', 10);
const GHOST_DAYS = 60;      // 挂超过这么久还没撤的，标为疑似幽灵岗位
const VERIFY_ONLY = process.argv.includes('--verify');
const PRUNE = process.argv.includes('--prune');   // 验证后自动把失效的置为 enabled=false
const FULL  = process.argv.includes('--full');    // 保留所有岗位（默认只留命中岗位家族的）

// ── 规模化的三个约束（2000+ 家公司时必须处理）──
// 1. jobs.json 默认【只保留命中岗位家族的美国岗位】。全量十几万个岗位、
//    每个还带完整 JD，文件会到几百 MB，GitHub 单文件 100MB 就硬拒了。
//    没命中家族的岗位你本来也不会投，存着纯粹是负担。
// 2. 不存完整 JD，只留 400 字摘要 —— 打分够用，真要看全文点 url 就行。
// 3. state.json 里关闭超过 STATE_KEEP_DAYS 天的记录会被清掉，否则无限膨胀。
const STATE_KEEP_DAYS = 45;    // 实测 186k 条记录，120 天保留期会让文件涨到上百 MB
const SNIPPET_LEN = 400;

const readJSON = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
};

// ── state 的紧凑编码 ────────────────────────────────────────────
// 实测 186k 条记录用可读的对象格式要 37MB（每条约 200 字节），
// 按现在的岗位流转速度几个月内就会撞上 GitHub 100MB 硬上限。
// 改成定长数组 + epoch 秒（不存 ISO 字符串），每条约 65 字节，省三分之二。
//   [firstSeen, lastSeen, closedAt, atsPostedAt, contentHash, contentChangedAt]
//   时间戳为 0 表示「无」
const sec = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);
const iso = (s0) => (s0 ? new Date(s0 * 1000).toISOString() : null);

function encodeState(state) {
  const j = {};
  for (const [id, v] of Object.entries(state)) {
    j[id] = [sec(v.firstSeenAt), sec(v.lastSeenAt), sec(v.closedAt),
             sec(v.atsPostedAt), v.contentHash || '', sec(v.contentChangedAt)];
  }
  return { v: 2, j };
}

function decodeState(raw) {
  if (!raw) return {};
  if (raw.v !== 2) return raw;                    // 旧格式，原样读入，下次写入自动升级
  const out = {};
  for (const [id, a] of Object.entries(raw.j || {})) {
    out[id] = {
      firstSeenAt: iso(a[0]), lastSeenAt: iso(a[1]), closedAt: iso(a[2]),
      atsPostedAt: iso(a[3]), contentHash: a[4] || '',
      ...(a[5] ? { contentChangedAt: iso(a[5]) } : {}),
    };
  }
  return out;
}

// ── 两层过滤：共享索引 vs 个人偏好 ─────────────────────────────
//
// 这是多用户架构的关键分工，别搞混：
//
//   【抓取时】用户无关的粗筛 —— 产出所有用户共享的岗位索引。
//     规则只有两条：命中 taxonomy 里任意一个岗位家族 + 在美国。
//     刷掉的是仓库工、零售、餐饮这类没人会用这个 agent 找的岗位，
//     以及非美国岗位。不做级别过滤 —— 应届生和总监看的是同一份索引。
//     实测 17.4 万 → 2.2 万，20MB，git 扛得住。
//
//   【读取时】用户相关的细筛 —— 每个用户自己的 families / seniority /
//     states，由应用层用 matchesUserPrefs() 在这 2.2 万条上现算，毫秒级。
//     绝不能放到抓取阶段，否则每个用户都要跑一遍自己的抓取。
//
// data/prefs.json 只是【本地调试用】的可选覆盖，不是产品机制。
// 它在 .gitignore 里，正式的用户偏好将来存在应用的数据库里。
const DEFAULT_PREFS = null;   // null = 不做个人过滤，产出共享索引

async function loadCompanies() {
  const raw = await fs.readFile(P.companies, 'utf8');
  const [header, ...lines] = raw.trim().split('\n');
  const cols = header.split(',').map((c) => c.trim());
  return lines
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((line) => {
      const cells = line.split(',').map((c) => c.trim());
      return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
    })
    .filter((r) => r.ats && r.token && String(r.enabled).toLowerCase() !== 'false');
}

/** 简单并发池 */
async function pool(items, limit, worker) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx], idx);
        await sleep(DELAY_MS);
      }
    })
  );
  return results;
}

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

async function main() {
  const now = new Date().toISOString();
  const companies = await loadCompanies();
  const taxonomy = await readJSON(P.taxonomy, { families: [] });
  const prevState = decodeState(await readJSON(P.state, null));
  const localPrefs = await readJSON(P.prefs, null);   // 可选的本地调试覆盖
  const prevHealth = await readJSON(P.health, { companies: {} });

  console.log(`[${now}] 开始抓取 ${companies.length} 家公司${VERIFY_ONLY ? '（仅验证模式）' : ''}`);

  const health = { runAt: now, companies: {}, errors: [] };
  const allJobs = [];

  await pool(companies, CONCURRENCY, async (c) => {
    const adapter = ADAPTERS[c.ats];
    const key = `${c.ats}:${c.token}`;
    if (!adapter) {
      health.companies[key] = { status: 'unknown_ats', count: 0 };
      health.errors.push(`${key}: 未知 ATS 类型`);
      return;
    }
    try {
      // 验证模式下 Workday 只翻 1 页 —— 否则几百个租户全量翻页要跑几小时
      const { jobs, notFound } = await adapter(
        c.token, c.company || c.token, VERIFY_ONLY ? { maxPages: 1 } : {}
      );
      if (notFound) {
        health.companies[key] = { status: 'token_invalid', count: 0 };
        health.errors.push(`${key}: token 无效（404），请到该公司 careers 页确认`);
        return;
      }
      const prevCount = prevHealth.companies?.[key]?.count ?? null;
      // 健康检查：之前有岗位、这次突然归零，多半是接口变了而不是真没岗位
      const suspicious = prevCount > 3 && jobs.length === 0;
      health.companies[key] = {
        status: suspicious ? 'suspicious_zero' : 'ok',
        count: jobs.length,
        prevCount,
      };
      if (suspicious) health.errors.push(`${key}: 上次 ${prevCount} 个岗位，这次 0 个 —— 疑似接口变更`);
      allJobs.push(...jobs);
      console.log(`  ✓ ${key} → ${jobs.length}`);
    } catch (err) {
      health.companies[key] = { status: 'error', count: 0, error: String(err.message) };
      health.errors.push(`${key}: ${err.message}`);
      console.log(`  ✗ ${key} → ${err.message}`);
    }
  });

  await fs.mkdir(path.dirname(P.health), { recursive: true });
  await fs.writeFile(P.health, JSON.stringify(health, null, 2));

  if (VERIFY_ONLY) {
    const all = Object.entries(health.companies);
    const bad = all.filter(([, v]) => v.status !== 'ok');
    const empty = all.filter(([, v]) => v.status === 'ok' && v.count === 0);
    console.log(`\n有效 ${all.length - bad.length} / ${all.length}（其中 ${empty.length} 家接口通但 0 岗位）`);

    if (!PRUNE) {
      bad.slice(0, 40).forEach(([k, v]) => console.log(`  ${k}: ${v.status}`));
      if (bad.length > 40) console.log(`  …… 另有 ${bad.length - 40} 家`);
      if (bad.length > 20) {
        console.log(`\n失效的太多，手改不现实。跑这个自动置为 enabled=false：`);
        console.log(`  node scripts/scrape.mjs --verify --prune`);
      }
      return;
    }

    // 自动修剪：失效的和 0 岗位的都置为 enabled=false，保留记录不删除
    const badKeys = new Set(bad.map(([k]) => k));
    const emptyKeys = new Set(empty.map(([k]) => k));
    const raw = await fs.readFile(P.companies, 'utf8');
    const out = [];
    let disabled = 0;
    for (const line of raw.split('\n')) {
      const c = line.split(',');
      if (c.length < 4 || line.startsWith('#') || c[0] === 'company') { out.push(line); continue; }
      const key = `${c[1]}:${c[2]}`;
      if (badKeys.has(key) || emptyKeys.has(key)) {
        c[3] = 'false';
        c[4] = badKeys.has(key) ? '验证失效' : '验证时 0 岗位';
        disabled++;
        out.push(c.join(','));
      } else out.push(line);
    }
    await fs.writeFile(P.companies, out.join('\n'));
    console.log(`\n已把 ${disabled} 家置为 enabled=false（保留在表里，不会重复探测）`);
    console.log(`剩余在用：${all.length - bad.length - empty.length} 家`);
    return;
  }

  // ── 快照 diff：这是「24 小时内 / 一周内」的唯一可信来源 ──
  const state = { ...prevState };
  const seenIds = new Set();
  const enriched = [];
  const dedupe = new Set();
  let newCount = 0;

  // 第一遍：为每一条原始岗位维护 state。
  // 必须在去重之前做 —— 否则跨源重复中「被去掉」的那条永远拿不到 firstSeenAt，
  // 等哪天胜出的那条下架了，它就会被误判成全新岗位，天天发假的新岗位提醒。
  for (const job of allJobs) {
    const id = stableId(job);
    seenIds.add(id);
    const contentHash = hash(job.title + '|' + job.locationRaw + '|' + (job.descriptionText || '').slice(0, 4000));
    const prev = state[id];
    if (!prev) {
      state[id] = { firstSeenAt: now, lastSeenAt: now, contentHash, atsPostedAt: job.atsPostedAt || null, closedAt: null };
      newCount++;
    } else {
      if (prev.contentHash !== contentHash) prev.contentChangedAt = now; // JD 被悄悄改了
      prev.lastSeenAt = now;
      prev.contentHash = contentHash;
      prev.closedAt = null; // 撤了又挂回来
      if (!prev.atsPostedAt && job.atsPostedAt) prev.atsPostedAt = job.atsPostedAt;
    }
  }

  // 第二遍：去重后构建输出列表
  for (const job of allJobs) {
    const id = stableId(job);

    const dk = dedupeKey(job);
    if (dedupe.has(dk)) continue;      // 跨源去重（仅影响展示，不影响 state）
    dedupe.add(dk);

    const loc = normalizeLocation(job.locationRaw);
    const families = matchFamilies(job.title, taxonomy.families || []);
    const s = state[id];
    const openDays = Math.floor((Date.parse(now) - Date.parse(s.atsPostedAt || s.firstSeenAt)) / 86400000);

    enriched.push({
      id,
      ...job,
      location: loc,
      families,
      seniority: detectSeniority(job.title),
      firstSeenAt: s.firstSeenAt,
      atsPostedAt: s.atsPostedAt,
      // 优先信 ATS 自报的首发时间（Greenhouse first_published / Lever createdAt /
      // Ashby publishedAt 实测均可靠），没有时退回自己观测到的首见时间
      postedAt: s.atsPostedAt || s.firstSeenAt,
      openDays,
      isGhostSuspect: openDays > GHOST_DAYS,
      contentChangedAt: s.contentChangedAt || null,
    });
  }

  // 已下架的岗位
  let closedCount = 0;
  for (const [id, s] of Object.entries(state)) {
    if (!seenIds.has(id) && !s.closedAt) { s.closedAt = now; closedCount++; }
  }

  enriched.sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));

  // ── state 瘦身：关闭很久的记录清掉，否则文件无限膨胀 ──
  const cutoff = Date.parse(now) - STATE_KEEP_DAYS * 86400000;
  let purged = 0;
  for (const [id, s0] of Object.entries(state)) {
    if (s0.closedAt && Date.parse(s0.closedAt) < cutoff) { delete state[id]; purged++; }
  }
  await fs.writeFile(P.state, JSON.stringify(encodeState(state), null, 0));

  // ── jobs.json 瘦身：只留命中家族的美国岗位，且不存完整 JD ──
  // 共享索引的粗筛：命中任意家族 + 在美国。localPrefs 存在时再叠加个人细筛（仅调试用）
  const kept = FULL
    ? enriched
    : enriched
        .filter((j) => j.families.length > 0 && j.location.isUS)
        .filter((j) => !localPrefs || matchesUserPrefs(j, localPrefs));

  const slim = kept.map((j) => ({
    id: j.id, ats: j.ats, company: j.company, title: j.title,
    url: j.url, department: j.department, employmentType: j.employmentType,
    location: j.location, families: j.families, seniority: j.seniority,
    compensationRaw: j.compensationRaw,
    postedAt: j.postedAt, firstSeenAt: j.firstSeenAt, openDays: j.openDays,
    isGhostSuspect: j.isGhostSuspect, contentChangedAt: j.contentChangedAt,
    // 完整 JD 不入库 —— 打分用摘要足够，要全文点 url
    snippet: (j.descriptionText || '').slice(0, SNIPPET_LEN),
  }));

  await fs.writeFile(P.jobs, JSON.stringify({
    generatedAt: now, total: enriched.length, count: slim.length,
    // 这是【共享索引】：命中任意岗位家族的美国岗位。个人偏好在应用层过滤。
    scope: FULL ? 'all' : (localPrefs ? 'local-prefs' : 'shared-index'),
    localPrefs: localPrefs || undefined,
    jobs: slim,
  }, null, 0));

  const mb = (n) => (n / 1048576).toFixed(1);
  const jobsSize = (await fs.stat(P.jobs)).size;
  const stateSize = (await fs.stat(P.state)).size;

  // ── 生成本次摘要 ──
  const dayAgo = Date.parse(now) - 86400000;
  const fresh = enriched.filter((j) => Date.parse(j.postedAt) >= dayAgo);
  const usFresh = fresh.filter((j) => j.location.isUS);
  const matched = usFresh.filter((j) => j.families.length > 0
    && (!localPrefs || matchesUserPrefs(j, localPrefs)));

  const lines = [
    `# 新岗位摘要 · ${now.slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `抓取公司 ${companies.length} 家 · 在招岗位 ${enriched.length} 个 · 本次新入库 ${newCount} 个 · 下架 ${closedCount} 个`,
    `过去 24 小时发布 ${fresh.length} 个，其中美国 ${usFresh.length} 个，命中岗位家族 **${matched.length}** 个`,
    localPrefs
      ? `本地偏好覆盖生效：${(localPrefs.families || []).join(' / ') || '全部家族'} · ${localPrefs.seniority || '不限'} 级`
      : `共享索引模式 —— 个人偏好（家族 / 级别 / 州）由应用层在读取时过滤`,
    '',
  ];

  if (matched.length) {
    lines.push('## 命中岗位家族（优先看这些）', '');
    for (const j of matched.slice(0, 60)) {
      const where = j.location.isRemote ? 'Remote' : (j.location.states.join('/') || j.location.raw || '—');
      lines.push(`- **${j.title}** · ${j.company} · ${where} · \`${j.families.join(',')}\`  \n  ${j.url}`);
    }
    lines.push('');
  }

  const others = usFresh.filter((j) => !j.families.length);
  if (others.length) {
    lines.push(`<details><summary>其余 ${others.length} 个美国新岗位</summary>`, '');
    for (const j of others.slice(0, 150)) {
      const where = j.location.isRemote ? 'Remote' : (j.location.states.join('/') || j.location.raw || '—');
      lines.push(`- ${j.title} · ${j.company} · ${where} — ${j.url}`);
    }
    lines.push('', '</details>', '');
  }

  const ghosts = enriched.filter((j) => j.isGhostSuspect).length;
  if (ghosts) lines.push(`> 疑似幽灵岗位（挂满 ${GHOST_DAYS} 天未撤）：${ghosts} 个，已在 jobs.json 中标记 \`isGhostSuspect\``, '');
  if (health.errors.length) {
    lines.push('## ⚠️ 抓取异常', '');
    health.errors.forEach((e) => lines.push(`- ${e}`));
  }

  await fs.writeFile(P.digest, lines.join('\n'));

  console.log(`\n完成：抓到 ${enriched.length} 个岗位 · 入库 ${slim.length} 个 · 新增 ${newCount} · 下架 ${closedCount} · 24h 内命中 ${matched.length}`);
  console.log(`文件：jobs.json ${mb(jobsSize)}MB · state.json ${mb(stateSize)}MB${purged ? `（清理了 ${purged} 条超期记录）` : ''}`);
  if (jobsSize > 45 * 1048576 || stateSize > 45 * 1048576) {
    console.log(`\n⚠️  文件接近 GitHub 的 50MB 警告线（100MB 硬上限）。`);
    console.log(`   收窄 taxonomy 里的岗位家族，或减少 companies.csv 里 enabled=true 的公司。`);
  }
  if (health.errors.length) console.log(`异常 ${health.errors.length} 条，见 out/health.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
