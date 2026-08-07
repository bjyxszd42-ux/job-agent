#!/usr/bin/env node
/**
 * 简历抽取 + 解析的测试 —— node scripts/resume.test.mjs
 *
 * 简历解析最危险的失效方式是【安静地少东西】：某一节没识别出来，
 * 结果只是少填了几个字段，不报错、不崩溃，你还以为它本来就没解析出来。
 * 所以这里的断言全是「必须解析出什么」，而不是「不要崩」。
 *
 * 三份样本对应三种真实排版：
 *   A 学生简历，公司和日期同一行、职位另起一行
 *   B 职位在前公司在后、日期单独占一行
 *   C 职位 / 公司 / 日期挤在同一行
 * 另外 A 还有 .docx 和 .pdf 两个真实文件版本，验证抽取层不丢结构。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractText } from './resume-extract.mjs';
import { parseResume, suggestFamilies } from './resume-parse.mjs';

const DIR = path.join(import.meta.dirname, '../test/fixtures');
let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `  → got ${JSON.stringify(extra)}` : ''}`); }
};
const group = (t) => console.log(`\n${t}`);
const read = (f) => fs.readFile(path.join(DIR, f));
const txt = (f) => fs.readFile(path.join(DIR, f), 'utf8');

const tax = JSON.parse(await fs.readFile(path.join(DIR, '../../data/taxonomy.json'), 'utf8'));

/* ── A：学生简历 ── */
group('A — 学生简历（txt）');
const A = parseResume(await txt('resume-a.txt'));
ok('姓名', A.profile.basics.legalFirstName === 'Jiayi' && A.profile.basics.legalLastName === 'Chen', A.profile.basics);
ok('邮箱', A.profile.basics.email === 'jiayi.chen@nyu.edu');
ok('电话规范化', A.profile.basics.phone === '(646) 555-0182', A.profile.basics.phone);
ok('城市没有把姓名吃进去', A.profile.basics.address.city === 'Brooklyn', A.profile.basics.address);
ok('州 + 邮编', A.profile.basics.address.state === 'NY' && A.profile.basics.address.zip === '11217');
ok('LinkedIn 补全协议', A.profile.basics.links.linkedin === 'https://linkedin.com/in/jiayichen', A.profile.basics.links);
ok('GitHub', A.profile.basics.links.github === 'https://github.com/jiayichen');
ok('两段学历', A.profile.education.length === 2, A.profile.education.length);
ok('学校名', A.profile.education[0].school === 'New York University', A.profile.education[0].school);
ok('学位', A.profile.education[0].degree === 'M.S.', A.profile.education[0].degree);
ok('专业剥掉了 "Science in"', A.profile.education[0].field === 'Business Analytics', A.profile.education[0].field);
ok('学历起止', A.profile.education[0].startDate === '2023-09' && A.profile.education[0].endDate === '2025-05');
ok('GPA', A.profile.education[0].gpa === '3.82/4.0', A.profile.education[0].gpa);
ok('两段经历', A.profile.experience.length === 2, A.profile.experience.map((e) => e.title));
ok('公司 / 职位分得开', A.profile.experience[0].company === 'Datafold Inc.' && A.profile.experience[0].title === 'Data Analyst Intern', A.profile.experience[0]);
ok('Present → current', A.profile.experience[0].current === true && A.profile.experience[0].endDate === '');
ok('地点', A.profile.experience[0].location === 'New York, NY', A.profile.experience[0].location);
ok('bullet 数量', A.profile.experience[0].bullets.length === 3, A.profile.experience[0].bullets.length);
ok('bullet 去掉了符号', /^Rebuilt the weekly/.test(A.profile.experience[0].bullets[0].text));
ok('技能区被识别（不是被当成节标题吃掉）', A.stats.skillsListed >= 10, A.stats.skillsListed);
ok('单字母技能 R 收到了', A.profile.skills.technical.includes('R'), A.profile.skills.technical.slice(0, 6));
ok('A/B testing 没被 / 切开', A.profile.skills.technical.includes('A/B testing'), A.profile.skills.technical);
ok('没有假节标题', !A.stats.sections.includes('awards'), A.stats.sections);

group('A — 岗位家族推荐');
const sugA = suggestFamilies(A, tax);
ok('首推数据分析', sugA[0]?.key === 'data_analyst', sugA.map((s) => s.key));
ok('推荐带理由', sugA[0]?.why.some((w) => /worked as/.test(w)), sugA[0]?.why);
ok('理由里点出了技能', sugA[0]?.why.some((w) => /SQL|Tableau/.test(w)), sugA[0]?.why);
ok('不会推销售之类不相干的', !sugA.some((s) => ['account_executive', 'recruiting'].includes(s.key)), sugA.map((s) => s.key));

/* ── B：日期单独占一行 ── */
group('B — 资深工程师（日期单独一行）');
const B = parseResume(await txt('resume-b.txt'));
ok('两段经历，没被日期行切碎', B.profile.experience.length === 2, B.profile.experience.map((e) => `${e.title}@${e.company}`));
ok('第一段完整', B.profile.experience[0].title === 'Senior Software Engineer'
  && B.profile.experience[0].company === 'Stripe'
  && B.profile.experience[0].startDate === '2021-03'
  && B.profile.experience[0].current === true, B.profile.experience[0]);
ok('第一段 bullet 没丢', B.profile.experience[0].bullets.length === 3, B.profile.experience[0].bullets.length);
ok('第二段（公司在职位下一行）', B.profile.experience[1].title === 'Software Engineer'
  && B.profile.experience[1].company === 'Rackspace', B.profile.experience[1]);
ok('数字日期 08/2017', B.profile.experience[1].startDate === '2017-08', B.profile.experience[1].startDate);
ok('summary 单独成节，没混进经历', B.stats.sections.includes('summary'), B.stats.sections);
ok('学历专业', B.profile.education[0].field === 'Computer Science', B.profile.education[0].field);
ok('全部高置信', B.confidence.experience === 'high', B.stats.needsReview);
ok('推荐软件工程', suggestFamilies(B, tax)[0]?.key === 'software_engineer', suggestFamilies(B, tax).map((s) => s.key));

/* ── C：全挤在一行 ── */
group('C — 产品经理（职位/公司/日期同一行）');
const C = parseResume(await txt('resume-c.txt'));
ok('两段经历', C.profile.experience.length === 2, C.profile.experience.map((e) => `${e.title}@${e.company}`));
ok('三元素分得开', C.profile.experience[0].title === 'Product Manager'
  && C.profile.experience[0].company === 'Figma', C.profile.experience[0]);
ok('B.A. 没被当成 B.S.', C.profile.education[1].degree === 'B.A.', C.profile.education[1].degree);
ok('没有 in/of 时也能取到专业', C.profile.education[0].field === 'Human-Computer Interaction', C.profile.education[0].field);
ok('推荐产品经理', suggestFamilies(C, tax)[0]?.key === 'product_manager', suggestFamilies(C, tax).map((s) => s.key));

/* ── 抽取层：真实文件 ── */
group('抽取层 — 真实 DOCX / PDF');
const docx = await extractText(await read('resume-a.docx'), 'resume-a.docx');
ok('DOCX 识别为 docx', docx.kind === 'docx');
ok('DOCX 保住了 bullet 标记（3+2+1）', (docx.text.match(/^• /gm) || []).length === 6, (docx.text.match(/^• /gm) || []).length);
ok('DOCX 保住了列分隔（2 空格）', /Business {2,}New York, NY/.test(docx.text));
const Ad = parseResume(docx.text);
ok('DOCX 解析结果 = txt 版', JSON.stringify(Ad.profile.experience) === JSON.stringify(A.profile.experience),
  Ad.profile.experience.map((e) => `${e.title}@${e.company}/${e.bullets.length}b`));
ok('DOCX 学历一致', Ad.profile.education[0].field === 'Business Analytics', Ad.profile.education[0]);

const pdf = await extractText(await read('resume-a.pdf'), 'resume-a.pdf');
ok('PDF 识别为 pdf', pdf.kind === 'pdf');
ok('PDF 靠缩进认回了 bullet', (pdf.text.match(/^• /gm) || []).length === 5, (pdf.text.match(/^• /gm) || []).length);
ok('PDF 折行被合并（不是两条 bullet）', /team of 40 analysts/.test(pdf.text));
ok('PDF 抬头没被误标成 bullet', !/^• .*@/m.test(pdf.text));
ok('PDF 保住了列分隔', /Business {2,}New York, NY/.test(pdf.text), pdf.text.split('\n')[3]);
const Ap = parseResume(pdf.text);
ok('PDF 姓名', Ap.profile.basics.legalFirstName === 'Jiayi');
ok('PDF 两段经历', Ap.profile.experience.length === 2, Ap.profile.experience.map((e) => `${e.title}@${e.company}`));
ok('PDF bullet 数量对', Ap.profile.experience[0].bullets.length === 3, Ap.profile.experience[0].bullets.length);
ok('PDF 学历', Ap.profile.education[0].field === 'Business Analytics', Ap.profile.education[0].field);
ok('PDF 推荐结果和 txt 一致', suggestFamilies(Ap, tax)[0]?.key === 'data_analyst');

/* ── 坏输入不能炸 ── */
group('异常输入');
const bad = async (label, buf, name) => {
  try { await extractText(buf, name); ok(label + '（应当报错）', false); }
  catch (e) { ok(`${label} → ${e.message.slice(0, 34)}…`, true); }
};
await bad('老式 .doc', Buffer.from('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1junk', 'latin1'), 'x.doc');
await bad('RTF', Buffer.from('{\\rtf1\\ansi hello}'), 'x.rtf');
await bad('二进制垃圾', Buffer.from(Array.from({ length: 400 }, (_, i) => i % 7)), 'x.bin');
ok('空文本不崩', parseResume('').profile.basics.email === '');
ok('只有一行不崩', parseResume('Hello').profile.experience.length === 0);
ok('null 不崩', parseResume(null).stats.lines === 0);
ok('无 taxonomy 时返回空推荐', suggestFamilies(A, null).length === 0);
ok('超长输入不卡死', (() => {
  const t0 = Date.now();
  parseResume('word '.repeat(50000));
  return Date.now() - t0 < 3000;
})());

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
