#!/usr/bin/env node
/**
 * 本地岗位浏览服务 —— npm run ui
 *
 * 只做两件事：
 *   1. 静态托管仓库目录（浏览器要 fetch data/jobs.json，file:// 协议做不到）
 *   2. 提供 /api/marks 读写 data/marks.json（你的标记：感兴趣 / 已隐藏 / 已投递）
 *
 * 标记为什么不用浏览器 localStorage：
 *   · 换浏览器就没了，而这些标记是 Phase 3 投递模块的输入
 *   · 存成文件才能被后续脚本读取，也才能进 git（如果你愿意）
 *
 * 只监听 127.0.0.1，外网访问不到。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const MARKS = path.join(ROOT, 'data/marks.json');
const PROFILE = path.join(ROOT, 'data/profile.json');
const PROFILE_EXAMPLE = path.join(ROOT, 'data/profile.example.json');
const PORT = parseInt(process.env.PORT || '4321', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // 界面用 <script type="module"> 直接 import scripts/score.mjs 复用打分逻辑。
  // MIME 不对浏览器会拒绝执行模块，而且报错信息完全看不出是 MIME 的问题
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const readJSON = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
};

/**
 * 原子写：先写临时文件再 rename。
 *
 * profile.json 是纯手工录入、没有备份的数据 —— 自动保存每 800ms 就可能触发一次，
 * 如果直接覆盖写到一半进程被杀（Ctrl+C、关机、磁盘满），文件会变成半截 JSON，
 * 下次打开就是空白档案。rename 在同一文件系统内是原子的，要么旧的要么新的。
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

/** 读请求体成 Buffer（上传简历用，不能按字符串拼，会把二进制拼坏） */
function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); reject(new Error(`文件超过 ${Math.round(limit / 1e6)}MB`)); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 读请求体（限 2MB —— 档案就算写满经历也远不到这个量级） */
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/**
 * 首次打开时用 example 的结构建一份空档案。
 *
 * example 里的标量本来就是空值或者【有意为之的默认值】——
 * country: "United States"、salaryNegotiable: true、eeo 全 decline ——
 * 所以标量原样保留，只做两件事：去掉 _comment，把数组清空
 * （education/experience/projects 里那一条是结构示例，不是用户的经历）。
 */
function blankFrom(v) {
  if (Array.isArray(v)) return [];
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === '_comment') continue;
      out[k] = blankFrom(val);
    }
    return out;
  }
  return v;
}

async function loadProfile() {
  const saved = await readJSON(PROFILE, null);
  if (saved) return saved;
  const example = await readJSON(PROFILE_EXAMPLE, null);
  return example ? blankFrom(example) : {};
}

/**
 * 从 GitHub 拉取最新抓取结果。
 *
 * 云端每天 16:17 抓完会 commit 回仓库，本地只需要取下来 —— 没必要让用户
 * 每次手动 git pull。启动时拉一次，界面上的 Refresh 按钮也走这里。
 *
 * --autostash：你本地可能有没提交的改动（改了 companies.csv 之类），
 *   自动暂存再恢复，不会因为「working tree not clean」失败。
 * --rebase：避免产生无意义的 merge commit。
 * 拉取失败（离线、冲突、没配远程）不影响浏览，只是数据不是最新的。
 */
async function gitPull() {
  try {
    const { stdout } = await exec('git', ['pull', '--rebase', '--autostash'], {
      cwd: ROOT, timeout: 60000,
    });
    const out = String(stdout).trim();
    const changed = !/Already up to date|Current branch .* is up to date/i.test(out);
    return { ok: true, changed, message: out.split('\n').slice(-3).join(' ') };
  } catch (err) {
    const msg = String(err.stderr || err.message || err).trim().split('\n')[0];
    return { ok: false, changed: false, message: msg };
  }
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── 手动刷新：拉最新数据 ──
  if (url.pathname === '/api/pull' && req.method === 'POST') {
    const r = await gitPull();
    const jobs = await readJSON(path.join(ROOT, 'data/jobs.json'), null);
    return send(res, 200, { ...r, count: jobs?.count ?? null, generatedAt: jobs?.generatedAt ?? null });
  }

  // ── 个人档案 API ──
  //
  // 这份数据只存在于本机 data/profile.json，已在 .gitignore 里。
  // 不做 JSON Schema 校验：字段会随着模块一继续长，校验器只会挡住自己。
  // 只保证「存进去的是合法 JSON 对象」+「写入是原子的」。
  if (url.pathname === '/api/profile') {
    if (req.method === 'GET') return send(res, 200, await loadProfile());

    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const next = JSON.parse(body);
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          return send(res, 400, { error: 'profile must be an object' });
        }
        next.updatedAt = new Date().toISOString();
        await writeAtomic(PROFILE, JSON.stringify(next, null, 2));
        return send(res, 200, { ok: true, updatedAt: next.updatedAt });
      } catch (e) {
        return send(res, 400, { error: String(e.message) });
      }
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  // ── 简历解析 ──
  //
  // 简历【只在内存里过一遍】，不落盘。用户拿到的是解析出来的字段，
  // 原文不留 —— 少存一份含姓名住址电话的文件，就少一个泄漏面。
  // 要重新解析就再传一次，成本几乎为零。
  if (url.pathname === '/api/resume' && req.method === 'POST') {
    try {
      const name = url.searchParams.get('name') || '';
      const buf = await readBodyBuffer(req, 12e6);          // 12MB，带图的简历也够
      if (!buf.length) return send(res, 400, { error: '没有收到文件' });

      const { extractText } = await import('./resume-extract.mjs');
      const { parseResume, suggestFamilies } = await import('./resume-parse.mjs');

      const { text, kind } = await extractText(buf, name);
      if (!text.trim()) {
        return send(res, 422, {
          error: kind === 'pdf'
            ? '这份 PDF 里没有可选中的文字 —— 多半是扫描件或图片导出的。这种简历 ATS 也读不了，建议用原始文档重新导出一份。'
            : '文件里没有读到文字',
        });
      }

      const parsed = parseResume(text);
      const tax = await readJSON(path.join(ROOT, 'data/taxonomy.json'), null);
      return send(res, 200, {
        ok: true,
        kind,
        profile: parsed.profile,
        confidence: parsed.confidence,
        stats: parsed.stats,
        suggestions: tax ? suggestFamilies(parsed, tax) : [],
      });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }

  // ── 标记 API ──
  if (url.pathname === '/api/marks') {
    if (req.method === 'GET') return send(res, 200, await readJSON(MARKS, {}));

    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        try {
          const { id, state } = JSON.parse(raw);
          if (!id) return send(res, 400, { error: 'missing id' });
          const marks = await readJSON(MARKS, {});
          if (state) marks[id] = { state, at: new Date().toISOString() };
          else delete marks[id];                       // state 为空 = 取消标记
          await fs.writeFile(MARKS, JSON.stringify(marks, null, 0));
          send(res, 200, { ok: true, count: Object.keys(marks).length });
        } catch (e) { send(res, 400, { error: String(e.message) }); }
      });
      return;
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  // ── 静态文件 ──
  let rel = decodeURIComponent(url.pathname);

  // 档案要排在岗位搜索【前面】：没填过档案就先去填，填过了才进岗位页。
  // 这不是引导流程做得好看，是因为空档案下的岗位页只能按时间倒序列两万条，
  // 而两万条按时间排的岗位对求职者没有任何用处 —— 排序才是这个工具的价值。
  if (rel === '/') {
    const p = await readJSON(PROFILE, null);
    const filled = p && (
      (p.preferences?.families || []).length || p.preferences?.seniority ||
      (p.skills?.technical || []).length || p.basics?.email
    );
    rel = filled ? '/ui/index.html' : '/ui/profile.html';
  }
  const file = path.join(ROOT, rel);

  // 防目录穿越
  if (!file.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' });

  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, { error: `Not found: ${rel}` }, 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  // 启动时自动拉一次，保证打开就是最新的
  process.stdout.write('\n  Pulling latest data… ');
  const pull = await gitPull();
  console.log(pull.ok ? (pull.changed ? 'updated' : 'already up to date') : `skipped (${pull.message})`);

  const jobs = await readJSON(path.join(ROOT, 'data/jobs.json'), null);
  console.log(`\n  Job Browser  →  http://localhost:${PORT}\n`);
  if (jobs) {
    console.log(`  ${jobs.count.toLocaleString()} jobs indexed (${jobs.total.toLocaleString()} scraped)`);
    console.log(`  Updated ${(jobs.generatedAt || '').slice(0, 16).replace('T', ' ')} UTC\n`);
  } else {
    console.log(`  ⚠️  data/jobs.json not found — run "npm run scrape" first\n`);
  }
  console.log(`  Ctrl+C to stop\n`);
});
