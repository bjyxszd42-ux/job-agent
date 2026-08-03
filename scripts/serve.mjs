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

const ROOT = path.resolve(import.meta.dirname, '..');
const MARKS = path.join(ROOT, 'data/marks.json');
const PORT = parseInt(process.env.PORT || '4321', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const readJSON = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

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
  if (rel === '/') rel = '/ui/index.html';
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
