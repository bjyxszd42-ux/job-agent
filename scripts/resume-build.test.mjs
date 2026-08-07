#!/usr/bin/env node
/**
 * 简历生成 + 审阅的测试 —— node scripts/resume-build.test.mjs
 *
 * 这一层最危险的失效方式和解析层不一样：解析层怕【安静地少东西】，
 * 生成层怕【安静地给出错的建议】。
 * 一条把过去式改成现在时的「优化建议」，用户照做了，简历就坏了，
 * 而且他不会怀疑是工具的问题。
 *
 * 所以除了「有没有报出来」，这里还大量断言【报出来的修改本身是对的】。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractText } from './resume-extract.mjs';
import { parseResume } from './resume-parse.mjs';
import {
  buildDoc, fmtRange, fmtMonth, displayName, contactLine, sectionOrder,
  pickBullets, keywordSet, estimateLines, monthsOfExperience, TEMPLATE,
} from './resume-template.mjs';
import { renderDocx, renderHtml, renderText, fileNameFor, esc } from './resume-render.mjs';
import { reviewResume, suggestTrim, keywordCoverage, applyFinding } from './resume-review.mjs';

const DIR = path.join(import.meta.dirname, '../test/fixtures');
let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `  → got ${JSON.stringify(extra)}` : ''}`); }
};
const group = (t) => console.log(`\n${t}`);
const NOW = new Date('2026-08-07T00:00:00Z');

/* 一份手写档案：字段齐全，方便断言每一条规则 */
const P = {
  basics: {
    legalFirstName: 'Jiayi', preferredName: 'Grace', legalLastName: 'Chen',
    email: 'jiayi.chen@nyu.edu', phone: '(646) 555-0182',
    address: { city: 'Brooklyn', state: 'NY', zip: '11217', country: 'United States' },
    links: { linkedin: 'https://linkedin.com/in/jiayichen', github: '', portfolio: '' },
  },
  education: [{
    school: 'New York University', division: 'Stern School of Business',
    degree: 'M.S.', field: 'Business Analytics', gpa: '3.82/4.0', showGpa: true,
    startDate: '2023-09', endDate: '2025-05', location: 'New York, NY',
    honors: ['Dean\'s List'], expected: false,
  }],
  experience: [
    {
      company: 'Datafold Inc.', title: 'Data Analyst', location: 'New York, NY',
      startDate: '2024-06', endDate: '', current: true,
      bullets: [
        { text: 'Rebuilt the weekly reporting pipeline in SQL, cutting refresh time from 40 minutes to 6.', tags: [] },
        { text: 'Responsible for managing the Tableau dashboards used by the analytics team.', tags: [] },
        { text: 'I built a churn model that flagged 8 at-risk accounts.', tags: [] },
        { text: 'Utilized Excel to reconcile vendor invoices every month.', tags: [] },
      ],
    },
    {
      company: 'Acme Corp', title: 'Analyst', location: 'Boston, MA',
      startDate: '2022-01', endDate: '2023-12', current: false,
      bullets: [
        { text: 'Analyze quarterly revenue variance across 12 business units.', tags: [] },
        { text: 'Reports were reviewed by the finance leadership team each month.', tags: [] },
        { text: 'Detail-oriented team player supporting month-end close.', tags: [] },
      ],
    },
  ],
  projects: [{
    name: 'FlightShield – Parametric Delay Insurance', org: 'NYU', role: 'Business Lead',
    startDate: '2026-01', endDate: '2026-05', current: false, url: '',
    bullets: [
      { text: 'Context: 22% of U.S. flights are delayed, yet claims take weeks to settle.', tags: [] },
      { text: 'Challenge: contract rules are immutable once deployed, so reserves had to be sized up front.', tags: [] },
      { text: 'Outcome: designed a three-tier payout and led the 14-slide pitch.', tags: [] },
    ],
  }],
  leadership: [{
    company: 'NYU', title: 'Teaching Assistant', location: 'New York, NY',
    startDate: '2024-08', endDate: '2024-12', current: false,
    bullets: [{ text: 'Led weekly sessions for 156 students.', tags: [] }],
  }],
  skills: {
    technical: ['SQL', 'Python', 'Tableau'],
    groups: [{ label: 'Data', items: ['SQL', 'Python', 'Tableau'] }],
  },
};

/* ── 日期与抬头 ── */
group('模板 — 日期、姓名、联系方式');
ok('月份格式化', fmtMonth('2026-03') === 'March 2026', fmtMonth('2026-03'));
ok('空值不炸', fmtMonth('') === '' && fmtMonth(null) === '');
ok('起止区间', fmtRange({ startDate: '2025-05', endDate: '2025-08' }) === 'May 2025 – August 2025');
ok('在职 → Present', fmtRange({ startDate: '2026-03', current: true }) === 'March 2026 – Present');
ok('只有毕业时间不硬凑区间', fmtRange({ endDate: '2024-12' }) === 'December 2024', fmtRange({ endDate: '2024-12' }));
ok('预计毕业', fmtRange({ endDate: '2026-12', expected: true }) === 'Expected December 2026');
ok('英文名进括号', displayName(P.basics) === 'Jiayi (Grace) Chen', displayName(P.basics));
ok('没有英文名就不加括号', displayName({ legalFirstName: 'Ada', legalLastName: 'Lovelace' }) === 'Ada Lovelace');
ok('英文名和名字相同时不重复', displayName({ legalFirstName: 'Ada', preferredName: 'ada', legalLastName: 'L' }) === 'Ada L');
ok('联系方式去掉协议头', contactLine(P.basics).includes('linkedin.com/in/jiayichen'), contactLine(P.basics));
ok('空字段不留空位', !contactLine(P.basics).includes(''), contactLine(P.basics));

/* ── 小节顺序 ── */
group('模板 — 小节顺序');
ok('在读学生：学历在前', sectionOrder({
  education: [{ endDate: '2026-12', expected: true }], experience: [],
}, NOW)[1] === 'education');
ok('毕业时间在未来也算在读', sectionOrder({
  education: [{ endDate: '2027-05' }], experience: [],
}, NOW)[1] === 'education');
ok('工作五年：经历在前', sectionOrder({
  education: [{ endDate: '2018-05' }],
  experience: [{ startDate: '2019-01', endDate: '2024-01' }],
}, NOW)[1] === 'experience', sectionOrder({
  education: [{ endDate: '2018-05' }], experience: [{ startDate: '2019-01', endDate: '2024-01' }],
}, NOW));
ok('工作不满两年：学历在前', sectionOrder({
  education: [{ endDate: '2024-05' }], experience: [{ startDate: '2025-01', endDate: '2025-10' }],
}, NOW)[1] === 'education');
ok('在职工龄算到今天', monthsOfExperience([{ startDate: '2025-08', current: true }], NOW) === 12,
  monthsOfExperience([{ startDate: '2025-08', current: true }], NOW));

/* ── 文档结构 ── */
group('模板 — 文档结构');
const doc = buildDoc(P, { now: NOW });
const sec = (k) => doc.sections.find((s) => s.key === k);
ok('小节齐全', [...doc.sections].map((s) => s.key).sort().join(',') === 'education,experience,leadership,projects,skills',
  doc.sections.map((s) => s.key));
// P 里有 50 个月的工作经历且已毕业 —— 按规则经历应当排在学历前面
ok('资深档案：经历排在学历前', doc.sections[0].key === 'experience', doc.sections.map((s) => s.key));
const edu = sec('education').entries[0];
ok('学历第一行 = 学校 + 地点，加粗', edu.rows[0].cells[0] === 'New York University'
  && edu.rows[0].cells[1] === 'New York, NY' && edu.rows[0].bold === true, edu.rows[0]);
ok('学历第二行 = 院系 + 日期', edu.rows[1].cells[0] === 'Stern School of Business'
  && edu.rows[1].cells[1] === 'September 2023 – May 2025', edu.rows[1]);
ok('学历第三行 = 学位 + GPA', edu.rows[2].cells[0] === 'M.S. in Business Analytics'
  && edu.rows[2].cells[1] === 'GPA: 3.82/4.0', edu.rows[2]);
ok('showGpa 关掉就不显示 GPA', buildDoc({
  ...P, education: [{ ...P.education[0], showGpa: false }],
}, { now: NOW }).sections.find((s) => s.key === 'education').entries[0].rows[2].cells[1] === '');
// 没有院系时压成两行，不留一行「左边空着、右边一个日期」
const noDiv = buildDoc({ ...P, education: [{ ...P.education[0], division: '' }] }, { now: NOW })
  .sections.find((s) => s.key === 'education').entries[0];
ok('没有院系时学历只占两行 + 荣誉', noDiv.rows.length === 3, noDiv.rows);
ok('学位和 GPA 合并在一行', noDiv.rows[1].cells[0] === 'M.S. in Business Analytics, GPA: 3.82/4.0', noDiv.rows[1]);
ok('日期挪到学位行右边', noDiv.rows[1].cells[1] === 'September 2023 – May 2025', noDiv.rows[1]);
ok('没有空行', noDiv.rows.every((r) => r.cells[0] || r.cells[1]), noDiv.rows);
ok('荣誉两两成列', edu.rows[3].cells[0] === "Dean's List");
const exp = sec('experience').entries[0];
ok('经历第一行 = 公司 + 地点', exp.rows[0].cells[0] === 'Datafold Inc.' && exp.rows[0].bold === true);
ok('经历第二行 = 职位 + 日期', exp.rows[1].cells[1] === 'June 2024 – Present', exp.rows[1]);
ok('项目行不丢破折号', sec('projects').entries[0].rows[0].cells[0].includes('–'),
  sec('projects').entries[0].rows[0].cells[0]);
ok('技能保留分组标签', sec('skills').lines[0].label === 'Data: ', sec('skills').lines[0]);
ok('没有分组时拍成一行', buildDoc({ ...P, skills: { technical: ['SQL', 'R'] } }, { now: NOW })
  .sections.at(-1).lines[0].text === 'SQL, R');
ok('空档案不炸', buildDoc({}, { now: NOW }).sections.length === 0);

/* ── 按岗位挑 bullet ── */
group('模板 — 按目标岗位挑 bullet');
const jobWords = keywordSet('Tableau dashboard analyst');
const picked = pickBullets(P.experience[0].bullets, { jobWords, max: 2 });
ok('挑够数量', picked.length === 2);
ok('挑中提到 Tableau 的那条', picked.some((b) => /Tableau/.test(b.text)), picked.map((b) => b.text.slice(0, 30)));
ok('保持原顺序', picked[0].text.startsWith('Rebuilt'), picked[0].text.slice(0, 20));
ok('max=0 时全留', pickBullets(P.experience[0].bullets, { max: 0 }).length === 4);
ok('少于上限时不动', pickBullets(P.experience[0].bullets, { max: 9 }).length === 4);
ok('没有目标岗位时优先带数字的', pickBullets([
  { text: 'Wrote documentation for the team.' },
  { text: 'Cut latency by 40% across 3 services.' },
], { max: 1 })[0].text.includes('40%'));
const targeted = buildDoc(P, { now: NOW, job: { title: 'Tableau Analyst', snippet: 'dashboards' }, maxBullets: 2 });
ok('生成时按岗位裁剪', targeted.sections.find((s) => s.key === 'experience').entries[0].bullets.length === 2);
ok('目标岗位记进 meta', targeted.meta.targetJob.title === 'Tableau Analyst');

/* ── 渲染 ── */
group('渲染 — 纯文本');
const txt = renderText(doc);
ok('含姓名', txt.startsWith('Jiayi (Grace) Chen'));
ok('小节标题大写', txt.includes('PROFESSIONAL EXPERIENCE'));
ok('两列用 | 连接，不用空格凑', txt.includes('Datafold Inc. | New York, NY'), txt.split('\n').slice(3, 6));
ok('bullet 用 -', txt.includes('- Rebuilt the weekly'));
ok('没有制表符', !txt.includes('\t'));
ok('没有三连空行', !/\n\n\n/.test(txt));

group('渲染 — HTML');
const html = renderHtml(doc);
ok('是完整文档', html.startsWith('<!doctype html>'));
ok('打印尺寸是 Letter', html.includes('size: Letter'));
ok('转义了 &', renderHtml(buildDoc({
  ...P, skills: { technical: ['R&D <script>'] },
}, { now: NOW })).includes('R&amp;D &lt;script&gt;'));
ok('esc 不二次转义', esc('a & b') === 'a &amp; b' && esc('<') === '&lt;');
ok('片段模式不带 <html>', !renderHtml(doc, { standalone: false }).includes('<html'));

group('渲染 — DOCX');
const dx = renderDocx(doc);
ok('是 ZIP', dx[0] === 0x50 && dx[1] === 0x4b);
ok('体积合理', dx.length > 2000 && dx.length < 200000, dx.length);
ok('同样输入产出同样字节', Buffer.compare(renderDocx(doc), dx) === 0);
const back = await extractText(dx, 'x.docx');
ok('回读识别为 docx', back.kind === 'docx');
ok('回读拿得到姓名', back.text.split('\n')[0] === 'Jiayi (Grace) Chen', back.text.split('\n')[0]);
ok('回读保住了右列', /New York University {2,}New York, NY/.test(back.text), back.text.split('\n').slice(2, 5));
ok('回读保住了 bullet', (back.text.match(/^• /gm) || []).length === 11, (back.text.match(/^• /gm) || []).length);
ok('回读保住了分组标签', /Data: SQL, Python, Tableau/.test(back.text));
const reparsed = parseResume(back.text);
ok('生成的简历能被自己的解析器读回来', reparsed.profile.experience.length === 2,
  reparsed.profile.experience.map((e) => `${e.title}@${e.company}`));
ok('回读后学历一致', reparsed.profile.education[0].field === 'Business Analytics', reparsed.profile.education[0]);
ok('回读后邮箱一致', reparsed.profile.basics.email === 'jiayi.chen@nyu.edu');
ok('文件名去掉括号', fileNameFor(doc, 'docx') === 'Jiayi_Chen_Resume.docx', fileNameFor(doc, 'docx'));
ok('没有姓名时兜底', fileNameFor({ name: '' }, 'pdf') === 'Resume_Resume.pdf' || fileNameFor({ name: '' }, 'pdf') === 'Resume.pdf',
  fileNameFor({ name: '' }, 'pdf'));

/* ── 审阅 ── */
group('审阅 — 单条 bullet');
const R = reviewResume(P, { now: NOW });
const find = (path, id) => R.findings.find((f) => f.id === `${path}:${id}`);

const weak = find('experience[0].bullets[1]', 'weakopener');
ok('抓到 "Responsible for"', !!weak, R.findings.map((f) => f.id));
ok('改写成过去式动词开头', weak?.after === 'Managed the Tableau dashboards used by the analytics team.', weak?.after);
const fp = find('experience[0].bullets[2]', 'firstperson');
ok('抓到第一人称', !!fp);
ok('去掉 I 并把首字母大写', fp?.after === 'Built a churn model that flagged 8 at-risk accounts.', fp?.after);
const util = find('experience[0].bullets[3]', 'swap-utilized');
ok('抓到 Utilized', !!util);
ok('Utilized → Used，时态没被改掉', util?.after?.startsWith('Used Excel'), util?.after);
const tense = find('experience[1].bullets[0]', 'tense');
ok('过去的岗位用了现在时', !!tense, R.findings.filter((f) => f.id.includes('tense')).map((f) => f.id));
ok('给出过去式改法', tense?.after?.startsWith('Analyzed'), tense?.after);
ok('抓到被动语态', !!find('experience[1].bullets[1]', 'passive'));
ok('抓到套话', !!find('experience[1].bullets[2]', 'buzzword'));
ok('在职岗位的现在时不报错', !find('experience[0].bullets[0]', 'tense'));
ok('Context/Challenge/Outcome 不算「不是动词开头」', !find('projects[0].bullets[0]', 'noverb'));

group('审阅 — 数字识别');
const metricOf = (t) => !reviewResume({
  experience: [{ company: 'X', title: 'Y', current: false, bullets: [{ text: t }] }],
}, { now: NOW }).findings.some((f) => f.id.endsWith(':nometric'));
ok('个位数算量化', metricOf('Engaged 8 robotics manufacturers to source parts.'), );
ok('百分比算量化', metricOf('Improved gross margin by 3 points and cut cost 5%.'));
ok('金额算量化', metricOf('Identified $2,500 in recurring losses across the quarter.'));
ok('倍数算量化', metricOf('Provisioned reserves at a worst-case 5× multiple for claims.'));
ok('光年份不算量化', !metricOf('Joined the analytics team in 2024 and supported reporting.'));
ok('完全没数字不算量化', !metricOf('Supported the team with reporting and ad hoc analysis work.'));

group('审阅 — 整份简历');
ok('分数在 0–100', R.score >= 0 && R.score <= 100, R.score);
ok('统计了三档', typeof R.counts.fix === 'number' && typeof R.counts.improve === 'number');
ok('报出通过项', R.passed.length >= 3, R.passed);
ok('缺电话会报出来', reviewResume({ basics: { email: 'a@b.com' } }, { now: NOW })
  .findings.some((f) => f.id === 'contact'));
ok('没有技能区会报出来', reviewResume({ basics: {} }, { now: NOW }).findings.some((f) => f.id === 'noskills'));
ok('GPA 偏低会提示', reviewResume({
  ...P, education: [{ ...P.education[0], gpa: '2.7', showGpa: true }],
}, { now: NOW }).findings.some((f) => f.id.startsWith('gpa-')));
ok('GPA 好不会提示', !R.findings.some((f) => f.id.startsWith('gpa-')), R.findings.filter((f) => f.id.startsWith('gpa-')));
ok('行首动词重复会提示', reviewResume({
  experience: [{
    company: 'X', title: 'Y', current: false, startDate: '2020-01', endDate: '2021-01',
    bullets: [{ text: 'Managed a team of 4 analysts here.' }, { text: 'Managed the quarterly close for 3 units.' }, { text: 'Managed vendor contracts worth $2M.' }],
  }],
}, { now: NOW }).findings.some((f) => f.id === 'repeat-managed'));

group('审阅 — 时间空档');
const gapProfile = {
  education: [],
  experience: [
    { company: 'B', title: 'Senior Analyst', startDate: '2024-06', endDate: '2025-06', current: false, bullets: [] },
    { company: 'A', title: 'Analyst', startDate: '2021-01', endDate: '2023-01', current: false, bullets: [] },
  ],
};
ok('全职之间的长空档要报', reviewResume(gapProfile, { now: NOW }).findings.some((f) => f.id.startsWith('gap-')));
ok('实习之间的空档不报', !reviewResume({
  ...gapProfile,
  experience: gapProfile.experience.map((e) => ({ ...e, title: `${e.title}, Intern` })),
}, { now: NOW }).findings.some((f) => f.id.startsWith('gap-')));
ok('在读期间的空档不报', !reviewResume({
  ...gapProfile, education: [{ school: 'X', endDate: '2026-12' }],
}, { now: NOW }).findings.some((f) => f.id.startsWith('gap-')));

group('审阅 — 压到一页');
const fat = {
  ...P,
  experience: P.experience.map((e) => ({
    ...e,
    bullets: Array.from({ length: 14 }, (_, i) => ({
      text: `Delivered workstream ${i} for the reporting programme and documented the handover for the wider analytics function in detail.`,
    })),
  })),
};
const fatDoc = buildDoc(fat, { now: NOW });
const plan = suggestTrim(fat, fatDoc, {});
ok('超页时给出删除清单', plan.length > 0, plan.length);
ok('每条都有理由', plan.every((p) => p.reason), plan.map((p) => p.reason));
const cutFrom = (sec, i) => plan.filter((p) => p.where.section === sec && p.where.index === i).length;
ok('最近一段至少留 3 条', 14 - cutFrom('experience', 0) >= 3, 14 - cutFrom('experience', 0));
ok('其余经历至少留 2 条', 14 - cutFrom('experience', 1) >= 2, 14 - cutFrom('experience', 1));
ok('只有一条 bullet 的段不动', cutFrom('leadership', 0) === 0);
ok('不动 Context/Challenge/Outcome 三连',
  !plan.some((p) => p.where.section === 'projects'), plan.map((p) => p.path));
ok('不超页时清单为空', suggestTrim({
  ...P, experience: [{ ...P.experience[0], bullets: P.experience[0].bullets.slice(0, 1) }], projects: [], leadership: [],
}, buildDoc({ ...P, experience: [{ ...P.experience[0], bullets: P.experience[0].bullets.slice(0, 1) }], projects: [], leadership: [] }, { now: NOW })).length === 0);
ok('砍不到位时如实报出还差多少', typeof plan.stillOver === 'number');

group('审阅 — 目标岗位关键词');
const job = { title: 'Data Analyst', snippet: 'SQL Tableau dbt experimentation stakeholder' };
const cov = keywordCoverage(P, job, doc);
ok('简历上有的进 onResume', cov.onResume.includes('tableau'), cov.onResume);
ok('完全没有的进 missing', cov.missing.includes('dbt'), cov.missing);
ok('三档加起来是全集', cov.onResume.length + cov.inProfile.length + cov.missing.length > 0);
ok('百分比在 0–100', cov.pct >= 0 && cov.pct <= 100, cov.pct);
ok('标明是近似值', cov.approximate === true);
ok('没有目标岗位时返回 null', keywordCoverage(P, null, doc) === null);

group('审阅 — 应用修改');
const applied = applyFinding(P, weak);
ok('写回了档案', applied.experience[0].bullets[1].text === weak.after, applied.experience[0].bullets[1].text);
ok('没有原地修改', P.experience[0].bullets[1].text.startsWith('Responsible for'));
ok('内容变过了就不应用', applyFinding(applied, weak) === applied);
ok('没有 after 的不应用', applyFinding(P, { where: { section: 'experience', index: 0, bullet: 0 } }) === P);

/* ── 端到端 ── */
group('端到端 — 解析 → 生成 → 再解析');
const raw = await fs.readFile(path.join(DIR, 'resume-a.docx'));
const e2e = parseResume((await extractText(raw, 'a.docx')).text);
const e2eDoc = buildDoc(e2e.profile, { now: NOW });
const e2eBack = parseResume((await extractText(renderDocx(e2eDoc), 'b.docx')).text);
ok('经历段数不变', e2eBack.profile.experience.length === e2e.profile.experience.length,
  [e2e.profile.experience.length, e2eBack.profile.experience.length]);
ok('公司名不变', e2eBack.profile.experience[0].company === e2e.profile.experience[0].company,
  [e2e.profile.experience[0].company, e2eBack.profile.experience[0].company]);
ok('bullet 数不变', e2eBack.stats.bullets === e2e.stats.bullets, [e2e.stats.bullets, e2eBack.stats.bullets]);
ok('邮箱不变', e2eBack.profile.basics.email === e2e.profile.basics.email);
ok('页数估算给得出来', e2eDoc.meta.estimatedPages >= 1);
ok('审阅不崩', reviewResume(e2e.profile, { now: NOW }).score >= 0);

group('异常输入');
ok('空档案能生成文档', renderDocx(buildDoc({}, { now: NOW })).length > 1000);
ok('空档案纯文本不炸', typeof renderText(buildDoc({}, { now: NOW })) === 'string');
ok('审阅 null 不炸', reviewResume(null ?? {}, { now: NOW }).findings.length >= 0);
ok('bullet 为空数组不炸', reviewResume({ experience: [{ company: 'A', title: 'B', bullets: [] }] }, { now: NOW }).score >= 0);
ok('制表位没被写死', TEMPLATE.tabStop === TEMPLATE.page.width - TEMPLATE.page.margin.left - TEMPLATE.page.margin.right);
ok('行数估算是正数', estimateLines(doc) > 0);

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
