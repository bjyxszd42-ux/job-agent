/**
 * 简历文本抽取 —— PDF / DOCX / TXT → 纯文本
 *
 * 这一层只负责「把字取出来」，不理解简历结构（那是 resume-parse.mjs 的事）。
 * 分成两个文件是因为它们坏的方式完全不同：抽取出问题是文件格式的锅，
 * 解析出问题是排版习惯的锅，混在一起排查会很痛苦。
 *
 * ── 换行为什么重要 ──
 * 简历的结构全靠版面表达：一行一个 bullet、日期靠右、公司和职位分行。
 * 把文件抽成一大段连续文本，等于把结构信息全扔掉，后面再怎么解析都白搭。
 * 所以这里花了不少力气还原行结构。
 */

import zlib from 'node:zlib';

/* ────────────────────────────────────────────────────────────────
   DOCX —— 纯 Node，零依赖
   ──────────────────────────────────────────────────────────────── */

/**
 * DOCX 本质上就是个 ZIP，正文在 word/document.xml。
 * Node 自带 zlib，ZIP 的中央目录格式也很简单，没必要为这个装库。
 *
 * 只实现读取所需的最小子集：定位 EOCD → 遍历中央目录 → 找到目标条目
 * → 按【本地文件头】的变长字段长度跳过 → inflateRaw。
 * 不支持加密，不支持 ZIP64（简历不会超过 4GB）。
 */
function unzipEntry(buf, wantName) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP / DOCX 文件');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (name === wantName) {
      // 本地文件头的 extra 字段长度经常和中央目录里的不一样，
      // 用中央目录的值去跳会偏移几个字节，解压直接报错 —— 必须重新读
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const xmlUnescape = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');                   // & 放最后，理由同 ats.mjs

export function extractDocx(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('DOCX 里找不到 word/document.xml');

  // 逐段处理而不是全局替换 —— 因为「这段是不是项目符号」是段落级属性（<w:numPr>）。
  // Word 的项目符号在 XML 里【没有字面上的圆点】，只有这个标记；
  // 不逐段看就没法把它还原成行首的「•」，而 bullet 正是经历库要抓的东西。
  const lines = [];
  for (const para of xml.toString('utf8').split(/<\/w:p>/)) {
    const isBullet = /<w:numPr[\s>]/.test(para);

    // 段内手动换行保成真换行；制表转空格 —— 日期靠右对齐几乎都是 tab 撑出来的，
    // 转成空格才能保住「职位 …… 日期」在同一行的关系
    const body = para
      .replace(/<w:br\b[^>]*\/?>/g, '<BR/>')
      .replace(/<w:tab\b[^>]*\/?>/g, '<TAB/>');

    const parts = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<BR\/>|<TAB\/>/g;
    let m;
    while ((m = re.exec(body))) {
      if (m[0] === '<BR/>') parts.push('\n');
      else if (m[0] === '<TAB/>') parts.push('\t');
      else parts.push(xmlUnescape(m[1]));
    }

    // 制表符最后才展开成两个空格，而且【只压缩空格不压缩制表符】——
    // 解析层靠「2 个以上空格」区分同一行里的公司 / 地点 / 日期，
    // 先压成一个空格就再也分不开了
    const text = parts.join('').replace(/ +/g, ' ').replace(/\t/g, '  ').trim();
    if (!text) { lines.push(''); continue; }
    text.split('\n').forEach((ln, i) => {
      const t = ln.trim();
      lines.push(isBullet && i === 0 && t ? `• ${t}` : t);
    });
  }
  return lines.join('\n');
}

/* ────────────────────────────────────────────────────────────────
   PDF —— 交给 pdfjs-dist
   ──────────────────────────────────────────────────────────────── */

/**
 * PDF 的文字抽取不自己写。
 *
 * 看着像「解个 Flate 流、读 Tj 操作符」就完事，实际上还要处理字体编码、
 * CMap、合字、字形到 Unicode 的映射……自己写的版本会在某些简历上悄悄吐乱码，
 * 而乱码比解析失败更糟：失败你知道要手填，乱码你不知道。
 * pdfjs 是 Firefox 在用的那一套，这种事交给它。
 *
 * 懒加载：每天在 GitHub Actions 上跑的抓取脚本根本不碰简历，
 * 不能因为少装一个包就把抓取搞挂。
 */
export async function extractPdf(buf) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    throw new Error('缺少 PDF 解析依赖 —— 在项目目录下跑一次 npm install 就好');
  }

  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await task.promise;

  const pages = [];
  const MAX_PAGES = 12;                                   // 简历再长也不至于此，防呆
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();

    // 按 y 坐标聚成行。pdfjs 给的 item 顺序不保证是阅读顺序，
    // 而且同一行经常被切成十几个 item（字距微调、加粗片段各算一个）
    const rows = new Map();
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || !it.str) continue;
      const y = Math.round(it.transform[5] * 2) / 2;      // 0.5pt 容差，压掉浮点抖动
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], w: it.width || 0, s: it.str });
    }

    // 同一行里的横向空白【不是空格字符】，是坐标间距 —— PDF 里根本没存空格。
    // 直接把 item 拼起来会得到 "Datafold Inc.New York, NYJun 2024 – Present"，
    // 结构信息全糊在一起。所以按间距还原：小间距补一个空格，
    // 大间距（右对齐撑出来的那种）补两个 —— 解析层正是靠这个区分同一行里的不同字段。
    const built = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])                        // PDF 的 y 轴朝上，从大到小才是从上往下
      .map(([, parts]) => {
        parts.sort((a, b) => a.x - b.x);
        let out = '';
        let prevEnd = null;
        for (const q of parts) {
          if (!q.s) continue;
          if (/^\s+$/.test(q.s)) {
            // pdfjs 把「右对齐撑出来的空白」表示成一个宽度很大的空格 item。
            // 按宽度还原成 1 个还是 2 个空格 —— 解析层正是靠「2 个以上空格」
            // 区分同一行里的公司 / 地点 / 日期
            out += q.w > 12 ? '  ' : ' ';
            prevEnd = q.x + q.w;
            continue;
          }
          if (prevEnd !== null) {
            const gap = q.x - prevEnd;
            if (gap > 12) out += '  ';
            else if (gap > 1.2 && !/\s$/.test(out)) out += ' ';
          }
          out += q.s;
          prevEnd = q.x + q.w;
        }
        return { x: parts[0]?.x ?? 0, text: out.replace(/ {3,}/g, '  ').trim() };
      })
      .filter((r) => r.text);

    /* PDF 里没有「列表」这个概念，项目符号是画上去的字形 ——
     * 而从浏览器 / Google Docs 导出的 PDF 连那个字形都不生成，
     * 抽出来的 bullet 就是一行普通文字。丢了 bullet 标记，
     * 经历库那一段会被整段读成抬头，解析结果直接报废。
     *
     * 唯一还留在 PDF 里的线索是【缩进】：bullet 比正文左边界靠右几个点。
     * 所以用 x 坐标把它认回来。
     * 顺序很重要：先合并折行，再打 bullet 标记 ——
     * 折行的续行和 bullet 缩进相同，反过来做会把 "…40" / "analysts"
     * 这种断句的后半截当成一条新 bullet。 */
    const baseX = Math.min(...built.map((r) => r.x));
    const lines = [];
    for (const r of built) {
      const indented = r.x > baseX + 6;
      const prev = lines[lines.length - 1];
      if (indented && prev?.indented && /^[a-z(,)]/.test(r.text)) {
        prev.text += ' ' + r.text;                        // 上一条 bullet 被排版折行了
        continue;
      }
      lines.push({ ...r, indented });
    }

    pages.push(lines.map((r, idx) => {
      if (!r.indented || r.text.length < 20) return r.text;
      if (/^[•·▪●‣◦○*+\-–—]/.test(r.text)) return r.text;
      // 抬头是居中排版的，居中也是缩进 —— 首页开头几行和带邮箱的行一律不当 bullet
      if (i === 1 && idx < 3) return r.text;
      if (r.text.includes('@')) return r.text;
      return `• ${r.text}`;
    }).join('\n'));
    page.cleanup();
  }
  await task.destroy();
  return pages.join('\n\n');
}

/* ────────────────────────────────────────────────────────────────
   入口
   ──────────────────────────────────────────────────────────────── */

/**
 * 按【文件内容】判断类型，不看扩展名 ——
 * 扩展名会骗人，浏览器传上来的文件名也不一定可靠。
 */
export async function extractText(buf, filename = '') {
  const head4 = buf.subarray(0, 4).toString('latin1');
  const head8 = buf.subarray(0, 8).toString('latin1');

  if (head4 === '%PDF') return { text: await extractPdf(buf), kind: 'pdf' };
  if (head4.startsWith('PK')) {
    if (/\.pages$/i.test(filename)) throw new Error('不支持 Apple Pages，请先导出成 PDF 或 Word');
    return { text: extractDocx(buf), kind: 'docx' };
  }
  if (head4.startsWith('{\\rt')) throw new Error('不支持 RTF，请先导出成 PDF 或 Word');
  if (head8 === '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1') {
    throw new Error('这是老式 .doc 格式，请用 Word 另存为 .docx，或导出 PDF');
  }

  // 剩下的按纯文本处理。控制字符太多说明猜错了类型
  const text = buf.toString('utf8');
  const junk = (text.match(/[\x00-\x08\x0e-\x1f]/g) || []).length;
  if (junk > text.length * 0.01) throw new Error('无法识别的文件格式 —— 支持 PDF / DOCX / TXT / Markdown');
  return { text, kind: 'text' };
}
