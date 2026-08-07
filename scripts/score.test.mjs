#!/usr/bin/env node
/**
 * 打分引擎的测试 —— node scripts/score.test.mjs
 *
 * 打分是个「怎么跑都能出个数」的东西，错了不会崩，只会悄悄给你排错序。
 * 所以这里的重点不是覆盖率，是把几个【会静默出错】的地方钉死：
 * 薪资解析、关键词边界、sponsorship 否定句、没数据时不许扣分。
 */
import { parseComp, detectSignals, scoreJob, profileIsUsable, WEIGHTS } from './score.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `  → got ${JSON.stringify(extra)}` : ''}`); }
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), a);
const group = (t) => console.log(`\n${t}`);

/* ── 薪资 ── */
group('parseComp');
eq('K 记法', parseComp('$140K – $170K'), { min: 140000, max: 170000, hourly: false });
eq('带逗号小数', parseComp('$104,054.50 – $156,079.00'), { min: 104055, max: 156079, hourly: false });
eq('后缀噪音', parseComp('$200K – $265K • Offers Equity • Offers Bonus'), { min: 200000, max: 265000, hourly: false });
eq('单值', parseComp('$150,000'), { min: 150000, max: 150000, hourly: false });
eq('时薪显式折年薪', parseComp('$25.00 - $32.00 per hour'), { min: 52000, max: 66560, hourly: true });
eq('时薪隐式（数字太小）', parseComp('$30 – $45'), { min: 62400, max: 93600, hourly: true });
ok('空值', parseComp('') === null);
ok('无数字', parseComp('Competitive salary') === null);
ok('非年薪量级丢弃', parseComp('$500') === null, parseComp('$500'));
ok('乱序也取 min/max', parseComp('$170K then $140K').min === 140000);

/* ── 用工限制信号 ── */
group('detectSignals');
const s = (t) => detectSignals(t);
ok('will not sponsor', s('We are unable to sponsor visas at this time.')?.sponsor === 'no', s('We are unable to sponsor visas at this time.'));
ok('no sponsorship 短语', s('No visa sponsorship is available for this role.')?.sponsor === 'no');
ok('without sponsorship', s('Applicants must be authorized to work in the US without sponsorship.')?.sponsor === 'no');
ok('sponsorship is not available', s('Sponsorship is not available.')?.sponsor === 'no');
ok('does not provide sponsorship', s('Acme does not offer employment visa sponsorship.')?.sponsor === 'no');
ok('肯定：available', s('Visa sponsorship is available for this position.')?.sponsor === 'yes');
ok('肯定：we will sponsor', s('We will sponsor qualified candidates.')?.sponsor === 'yes');
ok('肯定：willing to sponsor', s('We are willing to sponsor H-1B.')?.sponsor === 'yes');
ok('否定优先于肯定（同段共现）',
  s('Sponsorship is available for some roles. For this role we will not sponsor.')?.sponsor === 'no',
  s('Sponsorship is available for some roles. For this role we will not sponsor.'));
ok('公民限定', s('Must be a US citizen.')?.citizenOnly === true);
ok('公民限定 2', s('U.S. citizenship is required.')?.citizenOnly === true);
ok('安全许可', s('Active TS/SCI clearance required.')?.clearance === true);
ok('安全许可 2', s('An active security clearance is required for this role.')?.clearance === true);
ok('普通 JD 不误报', s('We are a fast-growing team building payments infrastructure. Great benefits.') === null,
  s('We are a fast-growing team building payments infrastructure. Great benefits.'));
ok('提到 visa 但没说不给，不误报',
  s('We support employees through the visa process where applicable.')?.sponsor !== 'no',
  s('We support employees through the visa process where applicable.'));
ok('空输入', s('') === null);

/* ── 关键词边界（通过 scoreJob 的 skills 维度间接验证）── */
group('技能关键词边界');
const skJob = (title, snippet) => ({
  title, snippet, families: ['data_analyst'], seniority: 'mid', location: { states: ['NY'], isUS: true },
  postedAt: new Date().toISOString(),
});
const withSkills = (arr) => ({ preferences: { families: ['data_analyst'] }, skills: { technical: arr } });
const skillReason = (job, prof) => scoreJob(job, prof).reasons.find((r) => r.k === 'skills');

ok('R 不命中 react', !/Matches/.test(skillReason(skJob('Analyst', 'We use React and Redux heavily in our frontend stack today.'), withSkills(['R'])).label));
ok('R 命中独立的 R', /Matches R/.test(skillReason(skJob('Analyst', 'Experience with R and SAS for statistical modelling is required here.'), withSkills(['R'])).label));
ok('R 不命中 R&D', !/Matches/.test(skillReason(skJob('Analyst', 'You will partner with the R&D organisation on new product analytics.'), withSkills(['R'])).label));
ok('C 不命中 C++', !/Matches C /.test(skillReason(skJob('Engineer', 'Strong C++ background needed for our systems team here in New York.'), withSkills(['C'])).label));
ok('Go 不命中 Google', !/Matches/.test(skillReason(skJob('Analyst', 'We are a Google Cloud shop and love our tooling stack a lot.'), withSkills(['Go'])).label));
ok('c++ 能命中', /Matches C\+\+/.test(skillReason(skJob('Engineer', 'Strong C++ skills required for our low latency trading systems.'), withSkills(['C++'])).label));
ok('node.js 能命中', /Matches Node\.js/.test(skillReason(skJob('Engineer', 'Our backend is Node.js and TypeScript running on Kubernetes clusters.'), withSkills(['Node.js'])).label));
ok('句末带句号仍命中', /Matches Python/.test(skillReason(skJob('Analyst', 'The ideal candidate is fluent in Python. We move fast and ship often.'), withSkills(['Python'])).label));
ok('多词短语命中', /Matches machine learning/.test(skillReason(skJob('Analyst', 'You will apply machine learning to fraud detection at large scale.'), withSkills(['machine learning'])).label));
ok('大小写无关', /Matches SQL/.test(skillReason(skJob('Analyst', 'Daily sql work against our warehouse, plus dashboards for the team.'), withSkills(['SQL'])).label));

/* ── 缺数据时不许扣分 ── */
group('缺数据 = 中性，不是 0 分');
const base = {
  id: 'x', title: 'Data Analyst', company: 'Acme', families: ['data_analyst'], seniority: 'mid',
  location: { states: ['NY'], isUS: true, isRemote: false }, compensationRaw: '', snippet: '',
  postedAt: new Date().toISOString(),
};
const fullProf = {
  preferences: { families: ['data_analyst'], seniority: 'mid', targetStates: ['NY'], workModes: ['hybrid'], salaryMin: 90000 },
  skills: { technical: ['Python', 'SQL'] },
  workAuth: {},
};
const noComp = scoreJob(base, fullProf);
ok('没薪资仍拿到部分薪资分', noComp.reasons.find((r) => r.k === 'salary').delta > 0, noComp.reasons.find((r) => r.k === 'salary'));
ok('没摘要仍拿到部分技能分', noComp.reasons.find((r) => r.k === 'skills').delta > 0, noComp.reasons.find((r) => r.k === 'skills'));
ok('没摘要的岗位分数仍然可观（>55）', noComp.score > 55, noComp.score);

const emptyProf = { preferences: {}, skills: {}, workAuth: {} };
const neutral = scoreJob(base, emptyProf);
ok('空档案 = 中性分而不是 0', neutral.score >= 45 && neutral.score <= 65, neutral.score);
ok('空档案所有维度都有理由', neutral.reasons.length >= 7, neutral.reasons.length);

/* ── 打分单调性 ── */
group('打分方向正确');
const perfect = scoreJob({
  ...base, compensationRaw: '$150K – $200K',
  snippet: 'You will use Python and SQL daily to build reporting for the growth team here.',
  location: { states: ['NY'], isUS: true, isRemote: false },
}, fullProf);
ok('全中 ≥ 90', perfect.score >= 90, perfect.score);
ok('理由相加 = 分数', perfect.reasons.reduce((s, r) => s + r.delta, 0) === perfect.score, perfect.score);

const wrongFam = scoreJob({ ...base, families: ['sales'] }, fullProf);
ok('家族不符明显掉分', wrongFam.score < perfect.score - 25, [wrongFam.score, perfect.score]);

const wrongState = scoreJob({ ...base, location: { states: ['TX'], isUS: true, isRemote: false } }, fullProf);
ok('州不符掉分', wrongState.score < noComp.score, [wrongState.score, noComp.score]);
ok('愿意搬家能挽回一些', scoreJob({ ...base, location: { states: ['TX'], isUS: true, isRemote: false } },
  { ...fullProf, preferences: { ...fullProf.preferences, willingToRelocate: true } }).score > wrongState.score);

const old = scoreJob({ ...base, postedAt: new Date(Date.now() - 90 * 864e5).toISOString() }, fullProf);
ok('旧岗位比新岗位低', old.score < noComp.score, [old.score, noComp.score]);
ok('但旧岗位不至于归零', old.score > 40, old.score);

const exec = scoreJob({ ...base, seniority: 'exec' }, fullProf);
ok('级别差太远掉分', exec.score < noComp.score, [exec.score, noComp.score]);
ok('mid 当作「未标级别」而非不匹配',
  scoreJob({ ...base, seniority: 'mid' }, { ...fullProf, preferences: { ...fullProf.preferences, seniority: 'entry' } })
    .reasons.find((r) => r.k === 'seniority').delta > WEIGHTS.seniority * 0.5);

/* ── sponsorship 惩罚 ── */
group('sponsorship 惩罚');
const needsSponsor = { ...fullProf, workAuth: { status: 'f1_opt', authorizedToWork: true, requireSponsorshipFuture: true } };
const citizen = { ...fullProf, workAuth: { status: 'citizen', authorizedToWork: true, requireSponsorshipFuture: false } };
const noSponJob = { ...base, signals: { sponsor: 'no' } };
ok('需要 sponsor 的人被扣分', scoreJob(noSponJob, needsSponsor).score < scoreJob(base, needsSponsor).score - 30);
ok('并且列出 blocker', scoreJob(noSponJob, needsSponsor).blockers.includes('No visa sponsorship'));
ok('公民不受影响', scoreJob(noSponJob, citizen).score === scoreJob(base, citizen).score);
ok('公民岗位对非公民是 blocker', scoreJob({ ...base, signals: { citizenOnly: true } }, needsSponsor).blockers.length === 1);
ok('公民岗位对公民不是 blocker', scoreJob({ ...base, signals: { citizenOnly: true } }, citizen).blockers.length === 0);
ok('提供 sponsor 是加分', scoreJob({ ...base, signals: { sponsor: 'yes' } }, needsSponsor).score > scoreJob(base, needsSponsor).score);
ok('提供 sponsor 对公民无所谓', scoreJob({ ...base, signals: { sponsor: 'yes' } }, citizen).score === scoreJob(base, citizen).score);
ok('分数不会低于 0', scoreJob({ ...base, families: ['sales'], seniority: 'exec', location: { states: ['TX'], isUS: true },
  postedAt: new Date(Date.now() - 200 * 864e5).toISOString(), signals: { citizenOnly: true, sponsor: 'no' } }, needsSponsor).score >= 0);

/* ── profileIsUsable ── */
group('profileIsUsable');
ok('空档案不可用', !profileIsUsable({ preferences: {}, skills: {} }));
ok('只填了家族就可用', profileIsUsable({ preferences: { families: ['data_analyst'] } }));
ok('只填了技能就可用', profileIsUsable({ skills: { technical: ['Python'] } }));
ok('undefined 不崩', !profileIsUsable(undefined));

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
