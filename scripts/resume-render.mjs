/**
 * 简历渲染 —— 文档对象 → .docx / .html / .txt
 *
 * 三种格式各有各的用处，缺一个都不行：
 *   docx  投递时上传的主格式。绝大多数 ATS 对 .docx 的解析比 PDF 稳
 *   html  用来在界面里预览，以及用浏览器「打印成 PDF」——
 *         浏览器的 PDF 引擎比自己写一个可靠得多，也不用装依赖
 *   txt   很多申请表有一个「Paste your resume」的纯文本框，
 *         直接贴 docx 的内容进去会带一堆制表符和乱码
 *
 * docx 是从零拼的 ZIP + WordprocessingML，不引第三方库。
 * 理由和 resume-extract.mjs 一样：docx 只是个 ZIP，写它需要的
 * 就是 CRC32 加 deflate，Node 自带；为这点事装一个几 MB 的依赖不划算，
 * 而且这份文件要进 GitHub Actions，依赖越少越不容易在云端炸。
 */

import zlib from 'node:zlib';
import { TEMPLATE } from './resume-template.mjs';

/* ────────────────────────────────────────────────────────────────
   ZIP 写入
   ──────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 打一个 ZIP。
 *
 * 时间戳写死成 1980-01-01 —— 同样的输入应该产出逐字节相同的文件，
 * 这样测试才能断言输出，用户重新生成一次也不会看到「文件变了」。
 */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.from(data);
    const deflated = zlib.deflateRawSync(body, { level: 9 });
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(8, 8);             // method = deflate
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0x21, 12);         // mod date = 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra len
    locals.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + deflated.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

/* ────────────────────────────────────────────────────────────────
   XML
   ──────────────────────────────────────────────────────────────── */

// & 必须第一个换，否则后面换出来的 &lt; 会被二次转义成 &amp;lt;
export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 一个文字块。xml:space="preserve" 不能省，否则 "Label: " 结尾的空格会被 Word 吃掉 */
function run(text, { bold = false } = {}) {
  if (!text) return '';
  const rPr = `<w:rPr>${bold ? '<w:b/><w:bCs/>' : ''}<w:color w:val="000000"/></w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/* ────────────────────────────────────────────────────────────────
   DOCX
   ──────────────────────────────────────────────────────────────── */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="${TEMPLATE.font.family}" w:eastAsia="${TEMPLATE.font.family}" w:hAnsi="${TEMPLATE.font.family}" w:cs="${TEMPLATE.font.family}"/>
<w:sz w:val="${TEMPLATE.font.size}"/><w:szCs w:val="${TEMPLATE.font.size}"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:line="${TEMPLATE.lineExact}" w:lineRule="exact"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:contextualSpacing/></w:pPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${TEMPLATE.bullet.char}"/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="${TEMPLATE.bullet.indent}" w:hanging="${TEMPLATE.bullet.hanging}"/></w:pPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

/** 两列一行：左边正常流，右边靠一个右制表位顶到页面右缘 */
function rowXml(cells, { bold = false, before = 0 } = {}) {
  const [left = '', right = ''] = cells;
  const spacing = before ? `<w:spacing w:before="${before}"/>` : '';
  const pPr = `<w:pPr><w:tabs><w:tab w:val="right" w:pos="${TEMPLATE.tabStop}"/></w:tabs>${spacing}</w:pPr>`;
  const tab = right ? '<w:r><w:tab/></w:r>' : '';
  return `<w:p>${pPr}${run(left, { bold })}${tab}${run(right, { bold })}</w:p>`;
}

function bulletXml(text) {
  const pPr = `<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`
    + `<w:ind w:left="${TEMPLATE.bullet.indent}" w:hanging="${TEMPLATE.bullet.hanging}"/></w:pPr>`;
  return `<w:p>${pPr}${run(text)}</w:p>`;
}

function headingXml(title) {
  const pPr = '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="1" w:color="000000"/></w:pBdr>'
    + '<w:spacing w:before="95" w:after="26"/></w:pPr>';
  const rPr = `<w:rPr><w:b/><w:bCs/><w:spacing w:val="20"/><w:sz w:val="${TEMPLATE.font.headingSize}"/>`
    + `<w:szCs w:val="${TEMPLATE.font.headingSize}"/></w:rPr>`;
  return `<w:p>${pPr}<w:r>${rPr}<w:t>${esc(title)}</w:t></w:r></w:p>`;
}

export function renderDocx(doc) {
  const body = [];

  body.push(
    `<w:p><w:pPr><w:spacing w:after="20" w:line="340" w:lineRule="exact"/><w:jc w:val="center"/></w:pPr>`
    + `<w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="${TEMPLATE.font.nameSize}"/><w:szCs w:val="${TEMPLATE.font.nameSize}"/></w:rPr>`
    + `<w:t>${esc(doc.name)}</w:t></w:r></w:p>`,
  );
  if (doc.contact?.length) {
    body.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(doc.contact.join('  |  '))}</w:p>`);
  }

  for (const sec of doc.sections || []) {
    body.push(headingXml(sec.title));
    for (const p of sec.paragraphs || []) body.push(`<w:p>${run(p)}</w:p>`);
    for (const entry of sec.entries || []) {
      (entry.rows || []).forEach((r, i) => body.push(rowXml(r.cells, { bold: r.bold, before: i === 0 ? 20 : 0 })));
      for (const b of entry.bullets || []) body.push(bulletXml(b));
    }
    for (const l of sec.lines || []) {
      body.push(`<w:p><w:pPr><w:spacing w:before="8"/></w:pPr>${run(l.label, { bold: true })}${run(l.text)}</w:p>`);
    }
  }

  const { margin: m, width, height } = TEMPLATE.page;
  const sectPr = `<w:sectPr><w:pgSz w:w="${width}" w:h="${height}"/>`
    + `<w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="708" w:footer="708" w:gutter="0"/>`
    + '<w:cols w:space="720"/></w:sectPr>';

  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body.join('')}${sectPr}</w:body></w:document>`;

  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
  ]);
}

/* ────────────────────────────────────────────────────────────────
   HTML（预览 + 打印成 PDF）
   ──────────────────────────────────────────────────────────────── */

/**
 * 排版用 flex 的两端对齐来还原制表位。
 *
 * 注意这只影响【看】：用户如果从浏览器复制文字，中间不会带制表符。
 * 真正要投递的是 .docx 或者浏览器打印出来的 PDF。
 */
export function renderHtml(doc, { standalone = true } = {}) {
  const rows = (entry) => (entry.rows || []).map((r) => {
    const [l = '', rt = ''] = r.cells;
    const cls = r.bold ? 'row b' : 'row';
    return `<div class="${cls}"><span>${esc(l)}</span><span>${esc(rt)}</span></div>`;
  }).join('');

  const inner = (doc.sections || []).map((sec) => {
    const parts = [`<h2>${esc(sec.title)}</h2>`];
    for (const p of sec.paragraphs || []) parts.push(`<p class="sum">${esc(p)}</p>`);
    for (const e of sec.entries || []) {
      parts.push(`<div class="entry">${rows(e)}`
        + (e.bullets?.length ? `<ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '')
        + '</div>');
    }
    for (const l of sec.lines || []) {
      parts.push(`<p class="skill"><b>${esc(l.label)}</b>${esc(l.text)}</p>`);
    }
    return parts.join('');
  }).join('');

  const page = `<div class="resume"><h1>${esc(doc.name)}</h1>`
    + `<p class="contact">${doc.contact.map(esc).join('&nbsp; |&nbsp; ')}</p>${inner}</div>`;

  if (!standalone) return page;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(doc.name)} — Résumé</title>
<style>
  @page { size: Letter; margin: 0.5in; }
  body { margin: 0; background: #eef0f3; }
  .resume {
    font-family: "Times New Roman", Times, serif; font-size: 9.5pt; line-height: 1.22;
    color: #000; background: #fff; width: 7.5in; padding: 0.5in; margin: 24px auto;
    box-shadow: 0 1px 6px rgba(0,0,0,.16);
  }
  h1 { font-size: 18pt; text-align: center; margin: 0 0 2pt; letter-spacing: .2pt; }
  .contact { text-align: center; margin: 0 0 4pt; }
  h2 { font-size: 11pt; letter-spacing: 1pt; margin: 7pt 0 2pt;
       border-bottom: .75pt solid #000; padding-bottom: 1pt; }
  .entry { margin-bottom: 2pt; }
  .row { display: flex; justify-content: space-between; gap: 12pt; }
  .row span:last-child { text-align: right; white-space: nowrap; }
  .row.b { font-weight: bold; margin-top: 2pt; }
  ul { margin: 0 0 0 0; padding-left: 18pt; }
  li { margin: 0; }
  li::marker { content: "●  "; font-size: 7pt; }
  .skill, .sum { margin: 1pt 0; }
  @media print { body { background: #fff; } .resume { box-shadow: none; margin: 0; width: auto; padding: 0; } }
</style></head><body>${page}</body></html>`;
}

/* ────────────────────────────────────────────────────────────────
   纯文本（ATS 粘贴框）
   ──────────────────────────────────────────────────────────────── */

/**
 * 纯文本版【不用制表符也不用空格对齐】。
 *
 * 网页表单里的等宽假设根本不成立，用空格凑出来的两列在对方那边
 * 会变成参差不齐的一团。改成用 " | " 连接，信息一个不少，
 * 而且解析器按分隔符切也切得开。
 */
export function renderText(doc) {
  const out = [doc.name, doc.contact.join(' | '), ''];
  for (const sec of doc.sections || []) {
    out.push(sec.title.toUpperCase());
    for (const p of sec.paragraphs || []) out.push(p);
    for (const e of sec.entries || []) {
      for (const r of e.rows || []) {
        const line = r.cells.filter(Boolean).join(' | ');
        if (line) out.push(line);
      }
      for (const b of e.bullets || []) out.push(`- ${b}`);
    }
    for (const l of sec.lines || []) out.push(`${l.label}${l.text}`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** 文件名：Firstname_Lastname_Resume.docx —— 招聘方下载一堆简历后能认出是谁 */
export function fileNameFor(doc, ext) {
  const base = (doc.name || 'Resume')
    .replace(/\([^)]*\)/g, ' ')
    .trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '');
  return `${base || 'Resume'}_Resume.${ext}`;
}
