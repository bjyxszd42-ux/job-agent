/**
 * 简历解析 —— 纯文本 → 档案字段 + 岗位家族建议
 *
 * 全部是规则，不调模型。规则版能稳拿下的是【格式确定】的东西：
 * 邮箱、电话、链接、日期、GPA、分节标题、bullet ——
 * 这些占了填表工作量的大头，而且错了一眼就能看出来。
 *
 * 会不准的是【格式自由】的东西：公司名和职位名怎么分、哪行属于哪段经历。
 * 所以每个字段都带 confidence，界面按它决定要不要默认勾选 ——
 * 整套流程是「审阅后应用」而不是「直接覆盖」。这不是保守，是因为
 * 一份填错的档案会污染后面所有环节：打分、投递、生成简历，全都基于它。
 *
 * 接了 API 之后，替换的只有 parseResume 里的结构化部分，
 * 正则能稳拿的那些字段没有理由花钱重算。
 */

import { STATES, matchFamilies } from './normalize.mjs';

const STATE_CODES = new Set(Object.values(STATES));

/* ────────────────────────────────────────────────────────────────
   分节
   ──────────────────────────────────────────────────────────────── */

/**
 * 分节标题的判定用【词表】而不是前缀正则。
 *
 * 一开始用的是 /^(...|languages)\b/ 这种前缀匹配，结果
 * "Languages: Python, SQL, R, VBA" 这一行被当成了「语言」小节的标题 ——
 * 整个技能区就这么凭空消失了，而且不报错，只是解析结果里少了东西。
 *
 * 改成：把这一行拆成词，【每个词】都得在某个小节的词表里才算标题。
 * "Languages: Python, SQL" 里有 python，不在任何词表里，于是它只是普通内容。
 * 同时天然支持 "Work Experience"、"Awards & Honors"、"Certifications and Licenses"
 * 这些组合写法，不用为每种排列写一条正则。
 */
const SECTION_WORDS = {
  experience: ['experience', 'employment', 'work', 'history', 'professional', 'relevant', 'industry', 'background', 'career'],
  education: ['education', 'academic', 'academics', 'training', 'schooling'],
  skills: ['skills', 'skill', 'technical', 'core', 'key', 'competencies', 'proficiencies', 'technologies', 'technology', 'tools', 'expertise', 'summary'],
  projects: ['projects', 'project', 'selected', 'personal', 'academic', 'side', 'portfolio'],
  summary: ['summary', 'profile', 'objective', 'about', 'me', 'professional'],
  awards: ['awards', 'award', 'honors', 'honours', 'achievements', 'certifications', 'certification',
           'certificates', 'licenses', 'licences', 'publications', 'leadership', 'activities',
           'volunteer', 'volunteering', 'interests', 'references', 'languages', 'affiliations', 'coursework'],
};
// 组合词里允许出现的连接词，本身不构成标题
const JOINERS = new Set(['and', '&', 'of', '/', ',', '-', '–', '—', '|']);

/** 是不是分节标题：短、没有句末标点、每个词都在同一类词表里 */
function sectionOf(line) {
  const t = line.replace(/^[\s•\-–—*●▪‣]+/, '').replace(/[:：\s]+$/, '').trim();
  if (!t || t.length > 42 || /[.!?,]$/.test(t) || /\d/.test(t)) return null;

  const words = t.toLowerCase().split(/[\s&/,|-]+/).filter((w) => w && !JOINERS.has(w));
  if (!words.length || words.length > 4) return null;

  // 第一个词决定归属；其余词只要在【任一】词表里就行
  // （"Skills & Interests" 归 skills，"Awards & Honors" 归 awards）
  let owner = null;
  for (const [key, vocab] of Object.entries(SECTION_WORDS)) {
    if (vocab.includes(words[0])) { owner = key; break; }
  }
  if (!owner) return null;
  const allKnown = words.every((w) => Object.values(SECTION_WORDS).some((v) => v.includes(w)));
  if (!allKnown) return null;

  // "Professional Summary" 别被 experience 抢走（professional 在两张表里都有）
  if (owner === 'experience' && words.includes('summary')) return 'summary';
  if (owner === 'skills' && words[0] === 'summary' && words.length === 1) return 'summary';
  return owner;
}

function splitSections(lines) {
  const out = { header: [] };
  let cur = 'header';
  for (const raw of lines) {
    const sec = sectionOf(raw);
    if (sec) { cur = sec; (out[cur] ||= []); continue; }
    (out[cur] ||= []).push(raw);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
   联系方式
   ──────────────────────────────────────────────────────────────── */

const RE = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  // 前后不能紧挨其它数字，否则会从 "2019202145551234" 这种拼接里切出假号码
  phone: /(?<![\d-])(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})(?![\d-])/,
  linkedin: /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i,
  github: /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9\-_.]+\/?/i,
  url: /https?:\/\/[^\s,;)]+|\bwww\.[^\s,;)]+/i,
  // 城市名前面必须是行首或分隔符，不能是普通空格 ——
  // 否则 "JIAYI CHEN\nBrooklyn, NY" 会被吞成城市 "JIAYI CHEN Brooklyn"，
  // 而这种错误填进地址栏是很难一眼看出来的
  cityState: /(?:^|[\n|·•–—,]|\s{2,})\s*([A-Z][A-Za-z.'\-]*(?: [A-Z][A-Za-z.'\-]*){0,2}),[ ]*([A-Z]{2})\b(?:\s+(\d{5})(?:-\d{4})?)?/,
  gpa: /\bGPA[:\s]*(?:of\s*)?([0-4](?:\.\d{1,2})?)(?:\s*\/\s*([0-5](?:\.\d{1,2})?))?/i,
};

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MON_RE = Object.keys(MONTHS).join('|');
const PRESENT = /\b(?:present|current|now|ongoing|today)\b/i;

/** 一个日期端点 → "YYYY-MM"（月份缺失时补 01，因为表单用的是 <input type=month>） */
function oneDate(s) {
  if (!s) return '';
  if (PRESENT.test(s)) return '';
  let m = s.match(new RegExp(`\\b(${MON_RE})[a-z]*\\.?\\s*,?\\s*(\\d{4})\\b`, 'i'));
  if (m) return `${m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}`;
  m = s.match(/\b(\d{1,2})\s*[/\-]\s*(\d{4})\b/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${String(+m[1]).padStart(2, '0')}`;
  m = s.match(/\b(19|20)\d{2}\b/);
  if (m) return `${m[0]}-01`;
  return '';
}

const DATE_TOKEN = `(?:(?:${MON_RE})[a-z]*\\.?\\s*,?\\s*)?(?:\\d{1,2}\\s*[/\\-]\\s*)?(?:19|20)\\d{2}`;
const RANGE_RE = new RegExp(`(${DATE_TOKEN})\\s*(?:–|—|-|to|until|through|~)\\s*(${DATE_TOKEN}|present|current|now|ongoing|today)`, 'i');

/** 从一行里抠出起止日期。返回 null 表示这行没有日期区间 */
function dateRange(line) {
  const m = line.match(RANGE_RE);
  if (!m) return null;
  return {
    startDate: oneDate(m[1]),
    endDate: oneDate(m[2]),
    current: PRESENT.test(m[2]),
    matched: m[0],
  };
}

/* ────────────────────────────────────────────────────────────────
   姓名
   ──────────────────────────────────────────────────────────────── */

const NOT_NAME = /\b(resume|curriculum|vitae|cv|profile|summary|objective|phone|email|address|linkedin|github|www|http)\b/i;

/**
 * 姓名基本只能靠位置猜：简历第一行，2–4 个词，没有数字和 @。
 * 猜错的代价很低（用户一眼看到就改了），所以宁可给个候选也不留空。
 * 全大写的名字（CHEN XIAOMING）转成首字母大写，否则表单里看着像在喊人。
 */
function guessName(headerLines) {
  for (const raw of headerLines.slice(0, 6)) {
    const t = raw.replace(/^[\s•\-–—*|]+|[\s•\-–—*|]+$/g, '').trim();
    if (!t || t.length > 46 || /[\d@]/.test(t) || NOT_NAME.test(t)) continue;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (!words.every((w) => /^[A-Za-z][A-Za-z.'\-]*$/.test(w))) continue;
    const cased = words.map((w) => (w === w.toUpperCase() && w.length > 1
      ? w[0] + w.slice(1).toLowerCase() : w));
    return { first: cased[0], last: cased[cased.length - 1] };
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────
   教育
   ──────────────────────────────────────────────────────────────── */

const SCHOOL_RE = /\b(university|college|institute|academy|school of|polytechnic|universit[àéy]|conservatory)\b/i;
const DEGREE_PATTERNS = [
  // 顺序即优先级：具体的写在前面。
  // "Master of Science" 必须先于泛化的 "Master"，否则学位会被记成 "Master's"；
  // B.A. 也不能被吞进 B.S. —— 文科学位写成理科学位，在申请里是实打实的错填
  [/\bph\.?\s?d\b|\bdoctorate\b|\bdoctoral\b/i, 'Ph.D.'],
  [/\bm\.?b\.?a\b|master(?:'?s)?\s+of\s+business\s+administration/i, 'M.B.A.'],
  [/\bm\.?\s?sc?\.?\b|master(?:'?s)?\s+of\s+science|\bm\.?eng\b|master(?:'?s)?\s+of\s+engineering/i, 'M.S.'],
  [/\bm\.?a\.?\b|master(?:'?s)?\s+of\s+arts|\bmpa\b|\bmph\b/i, 'M.A.'],
  [/\bmaster(?:'?s)?\b/i, "Master's"],
  [/\bb\.?\s?sc?\.?\b|bachelor(?:'?s)?\s+of\s+science|\bb\.?eng\b|\bb\.?tech\b/i, 'B.S.'],
  [/\bb\.?a\.?\b|bachelor(?:'?s)?\s+of\s+arts/i, 'B.A.'],
  [/\bbachelor(?:'?s)?\b/i, "Bachelor's"],
  [/\bassociate(?:'?s)?\s+degree\b|\ba\.?a\.?s?\b/i, 'Associate'],
  [/\bhigh\s+school\s+diploma\b/i, 'High School'],
];

// "Master of Science in Business Analytics" 里，"Science" 只是学位的一部分，
// 专业是后面那截。不剥掉的话表单里会填成「Science in Business Analytics」
const DEGREE_FILLER = /^(?:science|arts|engineering|business\s+administration|philosophy|technology|commerce|applied\s+science)\s+in\s+/i;
const FIELD_RE = /\b(?:in|of)\s+([A-Z][A-Za-z&\-\s]{2,48}?)(?=\s{2,}|\s*[,|·•]|\s+\d|\s*$)/;

function parseEducation(lines) {
  const out = [];
  let cur = null;
  const push = () => { if (cur && (cur.school || cur.degree)) out.push(cur); cur = null; };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (SCHOOL_RE.test(line)) {
      push();
      cur = { school: '', degree: '', field: '', gpa: '', showGpa: false,
              startDate: '', endDate: '', location: '', notes: '' };
      const dr = dateRange(line);
      let rest = line;
      if (dr) { cur.startDate = dr.startDate; cur.endDate = dr.endDate; rest = rest.replace(dr.matched, ''); }
      const loc = rest.match(RE.cityState);
      if (loc) { cur.location = `${loc[1]}, ${loc[2]}`; rest = rest.replace(loc[0], ''); }
      // 学校名有时和学位挤在同一行，用分隔符切开后挑含学校关键词的那段
      const seg = rest.split(SEG_SPLIT).map((x) => x.trim()).filter(Boolean);
      cur.school = (seg.find((x) => SCHOOL_RE.test(x)) || seg[0] || '').replace(/[,\s]+$/, '');
      for (const s of seg) applyDegree(cur, s);
      continue;
    }

    if (!cur) continue;
    let rest = line;
    const dr2 = dateRange(rest);
    if (dr2) {
      if (!cur.startDate) { cur.startDate = dr2.startDate; cur.endDate = dr2.endDate; }
      rest = rest.replace(dr2.matched, '  ');       // 摘掉日期再找专业，否则会把日期读成专业名
    }
    if (!cur.location) {
      const loc = rest.match(RE.cityState);
      if (loc && STATE_CODES.has(loc[2])) { cur.location = `${loc[1]}, ${loc[2]}`; rest = rest.replace(loc[0], '  '); }
    }
    applyDegree(cur, rest);
    const g = line.match(RE.gpa);
    if (g && !cur.gpa) cur.gpa = g[2] ? `${g[1]}/${g[2]}` : g[1];
  }
  push();
  return out;
}

function applyDegree(entry, text) {
  let degreeMatch = null;
  if (!entry.degree) {
    for (const [re, label] of DEGREE_PATTERNS) {
      const m = text.match(re);
      if (m) { entry.degree = label; degreeMatch = m; break; }
    }
  }
  // 学校名那一段整段跳过专业提取 —— "Stern School of Business" 里的 "of Business"
  // 会被读成专业「Business」，而真正的专业写在下一行的学位里
  if (entry.field || SCHOOL_RE.test(text)) return;

  const f = text.match(FIELD_RE);
  if (f) {
    entry.field = f[1].trim().replace(/[,\s]+$/, '').replace(DEGREE_FILLER, '');
    return;
  }

  // "M.S. Human-Computer Interaction" 这种没有 in/of 的写法：
  // 学位后面剩下的那截就是专业
  if (degreeMatch) {
    const tail = text.slice(degreeMatch.index + degreeMatch[0].length).replace(/^[\s.,:]+/, '').trim();
    if (/^[A-Z]/.test(tail) && tail.length >= 3 && tail.length <= 60 && !/\d/.test(tail)) {
      entry.field = tail.replace(/[,\s]+$/, '');
    }
  }
}

/* ────────────────────────────────────────────────────────────────
   工作经历
   ──────────────────────────────────────────────────────────────── */

// 一行里「公司 / 职位 / 地点 / 日期」的分隔符。注意破折号在 parseResume 里
// 已经统一成了 '-'，所以要匹配的是【两边带空格的】连字符，
// 不能是 "Human-Computer" 这种词内连字符
const SEG_SPLIT = /\s*[|·•]\s*|\s+-\s+|\s{2,}|,\s(?=[A-Z])/;

const BULLET_RE = /^\s*[•·▪●‣◦○*+\-–—]\s+/;
const TITLE_WORDS = /\b(engineer|developer|analyst|scientist|manager|designer|consultant|director|specialist|coordinator|associate|assistant|intern(?:ship)?|lead|architect|administrator|officer|president|founder|researcher|strategist|marketer|recruiter|accountant|auditor|controller|advisor|representative|executive|supervisor|technician|writer|editor|producer|planner|buyer|trader|actuary|paralegal|attorney|nurse|therapist|teacher|instructor|professor|fellow|apprentice)\b/i;
const ORG_SUFFIX = /\b(inc|llc|ltd|corp(?:oration)?|co|company|group|labs?|technologies|technology|solutions|systems|partners|capital|ventures|bank|university|hospital|foundation|institute|associates|consulting|holdings|gmbh|s\.?a\.?)\b\.?/i;

/**
 * 经历条目 = 一个「抬头块」（1–2 行）+ 后面挂的 bullet。
 *
 * 抬头的写法五花八门，常见三种：
 *   A) 公司 | 城市, ST            2023.01 – 至今
 *      职位
 *   B) 职位, 公司                 2023.01 – 至今
 *   C) 公司
 *      职位                       2023.01 – 至今
 *
 * 所以不去猜「第一行一定是公司」，而是看【哪一段像职位】——
 * 职位名有一批高度固定的词（engineer / analyst / manager…），公司名没有。
 * 分不出来的时候整段塞进 title 并降低 confidence，让用户自己改；
 * 猜错了还振振有词地填满，比留空更烦人。
 */
function parseExperience(lines) {
  const out = [];
  let cur = null;
  const push = () => {
    if (cur && (cur.company || cur.title)) {
      cur.bullets = cur.bullets.filter((b) => b.text.trim());
      out.push(cur);
    }
    cur = null;
  };

  const blank = (s) => !s.trim();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (BULLET_RE.test(line)) {
      if (!cur) continue;                                 // 没有抬头的孤儿 bullet，丢掉
      cur.bullets.push({ text: line.replace(BULLET_RE, '').trim(), tags: [] });
      continue;
    }

    // 续行：上一条 bullet 被排版折行了（不以大写/日期开头，且当前在 bullet 里）
    if (cur && cur.bullets.length && !dateRange(line) && /^[a-z(]/.test(line)) {
      cur.bullets[cur.bullets.length - 1].text += ' ' + line;
      continue;
    }

    const dr = dateRange(line);
    const nextHasDate = !blank(lines[i + 1] || '') && !BULLET_RE.test(lines[i + 1] || '')
      && !!dateRange(lines[i + 1] || '');

    /* 什么时候算「新的一段经历开始了」。
     *
     * 关键在于抬头可能有两行，日期单独占一行：
     *     Senior Software Engineer, Stripe
     *     March 2021 - Present
     * 第二行只有日期，它属于【上一行】那段经历，不是新的一段。
     * 之前的写法只要看见日期就开新条目，结果这种排版被切成两半：
     * 一条有职位没日期没 bullet，一条有日期没职位。
     *
     * 正确的判据是「当前这条是不是已经收完了」：
     *   · 已经挂上 bullet   → 收完了，这行是下一段的抬头
     *   · 已经有日期又来一个 → 收完了
     *   · 都没有             → 还在同一个抬头块里，继续补充
     */
    const startsNew = cur
      ? (cur.bullets.length > 0 || (dr && cur.startDate))
      : (dr || nextHasDate);

    if (startsNew) {
      push();
      cur = { company: '', title: '', location: '', startDate: '', endDate: '',
              current: false, bullets: [], _lowConfidence: false };
    }
    if (!cur) continue;

    let rest = line;
    if (dr) {
      cur.startDate ||= dr.startDate;
      cur.endDate ||= dr.endDate;
      cur.current ||= dr.current;
      rest = rest.replace(dr.matched, '');
    }
    const loc = rest.match(RE.cityState);
    if (loc && STATE_CODES.has(loc[2]) && !cur.location) {
      cur.location = `${loc[1]}, ${loc[2]}`;
      rest = rest.replace(loc[0], '');
    }

    for (const seg of rest.split(SEG_SPLIT).map((x) => x.replace(/[,\s]+$/, '').trim()).filter(Boolean)) {
      if (!cur.title && TITLE_WORDS.test(seg)) cur.title = seg;
      else if (!cur.company && (ORG_SUFFIX.test(seg) || !TITLE_WORDS.test(seg))) cur.company = seg;
    }
  }
  push();

  // 两个都填上了才算高置信；只认出一个的标记出来，界面上提示核对
  for (const e of out) e._lowConfidence = !(e.company && e.title);
  return out;
}

/* ────────────────────────────────────────────────────────────────
   技能
   ──────────────────────────────────────────────────────────────── */

// 只收「格式确定」的常见技能名。这份表的作用是【补漏】——
// 从 bullet 里捞出技能区没写全的东西，不是用来替代技能区。
const SKILL_DICT = [
  'Python', 'R', 'SQL', 'Java', 'JavaScript', 'TypeScript', 'C', 'C++', 'C#', 'Go', 'Rust', 'Scala',
  'Ruby', 'PHP', 'Swift', 'Kotlin', 'MATLAB', 'SAS', 'Stata', 'SPSS', 'VBA', 'Bash', 'Shell',
  'HTML', 'CSS', 'React', 'Vue', 'Angular', 'Node.js', 'Django', 'Flask', 'FastAPI', 'Spring',
  'Rails', '.NET', 'Next.js', 'GraphQL', 'REST',
  'Pandas', 'NumPy', 'SciPy', 'scikit-learn', 'PyTorch', 'TensorFlow', 'Keras', 'XGBoost',
  'Spark', 'Hadoop', 'Hive', 'Kafka', 'Airflow', 'dbt', 'Databricks', 'Snowflake', 'Redshift',
  'BigQuery', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'DynamoDB', 'SQLite',
  'Tableau', 'Power BI', 'Looker', 'Excel', 'Google Sheets', 'Alteryx', 'QlikView', 'Superset',
  'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'Git', 'GitHub', 'GitLab',
  'CI/CD', 'Linux', 'Ansible', 'Prometheus', 'Grafana', 'Datadog',
  'Figma', 'Sketch', 'Adobe XD', 'Photoshop', 'Illustrator', 'InDesign', 'Framer', 'Webflow',
  'Jira', 'Confluence', 'Asana', 'Notion', 'Trello', 'Salesforce', 'HubSpot', 'Marketo',
  'Google Analytics', 'Mixpanel', 'Amplitude', 'Segment', 'Optimizely', 'Braze',
  'NetSuite', 'SAP', 'Oracle', 'Workday', 'QuickBooks', 'Bloomberg', 'FactSet', 'Capital IQ',
  'machine learning', 'deep learning', 'NLP', 'computer vision', 'A/B testing', 'ETL', 'ELT',
  'data modeling', 'data visualization', 'statistics', 'regression', 'forecasting',
  'financial modeling', 'valuation', 'GAAP', 'IFRS', 'SEO', 'SEM', 'CRM', 'Agile', 'Scrum',
];

/** 词流化，边界规则和 score.mjs 一致（" r " 不能命中 "react"，R&D 不裂开） */
function wordStream(s) {
  return ' ' + String(s || '').toLowerCase()
    .split(/[^a-z0-9+#.&]+/)
    .map((w) => w.replace(/^[.&]+|[.&]+$/g, ''))
    .filter(Boolean).join(' ') + ' ';
}

function parseSkills(skillLines, fullText) {
  const found = [];
  const seen = new Set();
  const add = (s) => {
    const t = s.trim().replace(/[.,;]+$/, '');
    const k = t.toLowerCase();
    if (!t || t.length > 34 || seen.has(k)) return;
    // 单字母技能只认 R 和 C —— 别的单字母基本都是排版残渣
    if (t.length === 1 && !['r', 'c'].includes(k)) return;
    if (/^\d+$/.test(t)) return;
    seen.add(k); found.push(t);
  };

  for (const raw of skillLines) {
    // "Languages: Python, SQL, R" —— 冒号左边是分类名，不是技能
    const line = raw.replace(BULLET_RE, '').replace(/^[^:：]{2,28}[:：]\s*/, '');
    if (!line.trim()) continue;
    // '/' 只在两边有空格时才是分隔符 —— 否则 "A/B testing" 会被切成 "A" 和 "B testing"
    const parts = line.split(/\s*[,;|·•]\s*|\s+\/\s+|\s{3,}/);
    // 整行没有分隔符又很长，多半是句子而不是技能列表
    if (parts.length === 1 && line.length > 44) continue;
    for (const p of parts) if (p.split(/\s+/).length <= 4) add(p);
  }

  // 补漏：技能区没写但 bullet 里提到的
  const stream = wordStream(fullText);
  const extra = [];
  for (const s of SKILL_DICT) {
    if (seen.has(s.toLowerCase())) continue;
    if (stream.includes(' ' + wordStream(s).trim() + ' ')) { extra.push(s); seen.add(s.toLowerCase()); }
  }
  return { listed: found, inferred: extra };
}

/* ────────────────────────────────────────────────────────────────
   岗位家族建议
   ──────────────────────────────────────────────────────────────── */

// 技能 → 家族。只写「一看到这个技能就基本能确定方向」的强信号，
// 弱相关的不写 —— 宁可少推荐几个，也不要推一堆看着就不对的。
const SKILL_FAMILY = {
  data_analyst: ['SQL', 'Tableau', 'Power BI', 'Looker', 'Excel', 'Alteryx', 'dbt', 'Google Analytics'],
  data_scientist: ['Python', 'R', 'scikit-learn', 'statistics', 'regression', 'forecasting', 'A/B testing', 'machine learning'],
  data_engineer: ['Spark', 'Airflow', 'dbt', 'Kafka', 'Snowflake', 'BigQuery', 'ETL', 'ELT', 'Databricks'],
  ml_engineer: ['PyTorch', 'TensorFlow', 'machine learning', 'deep learning', 'NLP', 'computer vision', 'Keras'],
  software_engineer: ['Java', 'C++', 'Go', 'TypeScript', 'React', 'Node.js', 'Django', 'Spring'],
  devops_sre: ['Kubernetes', 'Docker', 'Terraform', 'Jenkins', 'CI/CD', 'Ansible', 'Prometheus', 'Grafana'],
  product_manager: ['Jira', 'Amplitude', 'Mixpanel', 'A/B testing', 'Figma', 'Agile', 'Scrum'],
  product_designer: ['Figma', 'Sketch', 'Adobe XD', 'Framer', 'InDesign', 'Illustrator'],
  growth_marketing: ['SEO', 'SEM', 'Google Analytics', 'HubSpot', 'Marketo', 'Braze', 'Optimizely', 'Segment'],
  finance_analyst: ['financial modeling', 'valuation', 'Bloomberg', 'FactSet', 'Capital IQ', 'GAAP', 'IFRS'],
  accounting: ['GAAP', 'IFRS', 'QuickBooks', 'NetSuite', 'SAP'],
  business_operations: ['SQL', 'Excel', 'Salesforce', 'Looker', 'Tableau'],
};

/**
 * 按简历推荐岗位家族。
 *
 * 三个信号，权重差得很开：
 *   1. 你【做过】的职位命中家族  —— 最强。过去的职位是最好的预测因子
 *   2. 家族的标题词出现在简历正文 —— 中等
 *   3. 技能命中                   —— 弱，只用来在方向已经差不多时加分
 *
 * 每条推荐都带理由。没理由的推荐用户不会勾，勾了也不会信。
 */
export function suggestFamilies(parsed, taxonomy, limit = 6) {
  const fams = taxonomy?.families || [];
  if (!fams.length) return [];

  // 接收 parseResume() 的返回值
  const titles = (parsed?.profile?.experience || []).map((e) => e.title).filter(Boolean);
  const stream = wordStream(parsed?.rawText || '');
  const skillSet = new Set((parsed?.profile?.skills?.technical || []).map((s) => s.toLowerCase()));

  const scored = [];
  for (const fam of fams) {
    let score = 0;
    const why = [];

    const titleHits = titles.filter((t) => matchFamilies(t, [fam]).length);
    if (titleHits.length) {
      score += 10 + Math.min(6, (titleHits.length - 1) * 3);
      why.push(`you've worked as ${titleHits.slice(0, 2).join(' and ')}`);
    }

    // 排除词直接出局：简历上写着 "Sales Engineer" 就不该推「软件工程」
    if ((fam.exclude_titles || []).some((x) => x && stream.includes(' ' + wordStream(x).trim() + ' '))) {
      score -= 6;
    }

    const phraseHits = (fam.include_titles || [])
      .filter((x) => x && x.length > 3 && stream.includes(' ' + wordStream(x).trim() + ' '));
    if (phraseHits.length && !titleHits.length) {
      score += Math.min(6, phraseHits.length * 2);
      why.push(`your résumé mentions ${phraseHits.slice(0, 2).join(', ')}`);
    }

    const skillHits = (SKILL_FAMILY[fam.key] || []).filter((s) => skillSet.has(s.toLowerCase()));
    if (skillHits.length >= 2) {
      score += Math.min(8, skillHits.length * 2);
      why.push(`you list ${skillHits.slice(0, 4).join(', ')}`);
    }

    if (score >= 8 && why.length) scored.push({ key: fam.key, label: fam.label, score, why });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ────────────────────────────────────────────────────────────────
   主入口
   ──────────────────────────────────────────────────────────────── */

export function parseResume(rawText) {
  const text = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[‐-―]/g, '-')      // 各种破折号统一，日期区间正则才好写
    .replace(/[ \t]+\n/g, '\n');

  const lines = text.split('\n');
  const sec = splitSections(lines);
  const headerText = (sec.header || []).join('\n');
  // 联系方式一般在抬头，但也见过塞在页脚的 —— 抬头找不到就全文兜底
  const findIn = (re) => (headerText.match(re) || text.match(re) || [])[0] || '';

  const name = guessName(sec.header || []);
  const email = findIn(RE.email);
  const phoneM = (headerText.match(RE.phone) || text.match(RE.phone));
  const locM = (sec.header || []).join('\n').match(RE.cityState);
  const linkedin = findIn(RE.linkedin);
  const github = findIn(RE.github);

  const education = parseEducation(sec.education || []);
  const experience = parseExperience(sec.experience || []);
  const skills = parseSkills(sec.skills || [], text);

  const other = (findIn(RE.url) || '').replace(/[.,]$/, '');
  const portfolio = other && !/linkedin\.com|github\.com/i.test(other) ? other : '';

  const profile = {
    basics: {
      legalFirstName: name?.first || '',
      legalLastName: name?.last || '',
      email,
      phone: phoneM ? `(${phoneM[1]}) ${phoneM[2]}-${phoneM[3]}` : '',
      address: {
        city: locM && STATE_CODES.has(locM[2]) ? locM[1] : '',
        state: locM && STATE_CODES.has(locM[2]) ? locM[2] : '',
        zip: (locM && locM[3]) || '',
        country: 'United States',
      },
      links: {
        linkedin: linkedin ? withScheme(linkedin) : '',
        github: github ? withScheme(github) : '',
        portfolio: portfolio ? withScheme(portfolio) : '',
      },
    },
    education,
    experience: experience.map(({ _lowConfidence, ...e }) => e),
    skills: { technical: [...skills.listed, ...skills.inferred].slice(0, 60) },
  };

  // 界面按这个决定默认勾不勾。低置信度的字段【不默认应用】——
  // 让用户主动点一下，比让他事后发现填错了强
  const confidence = {
    name: name ? 'high' : 'none',
    email: email ? 'high' : 'none',
    phone: phoneM ? 'high' : 'none',
    location: locM && STATE_CODES.has(locM[2]) ? 'high' : 'none',
    links: (linkedin || github) ? 'high' : 'none',
    education: education.length ? (education.every((e) => e.school && e.degree) ? 'high' : 'medium') : 'none',
    experience: experience.length
      ? (experience.some((e) => e._lowConfidence) ? 'medium' : 'high') : 'none',
    skills: skills.listed.length ? 'high' : (skills.inferred.length ? 'medium' : 'none'),
  };

  return {
    profile,
    confidence,
    rawText: text,
    stats: {
      lines: lines.filter((l) => l.trim()).length,
      sections: Object.keys(sec).filter((k) => k !== 'header'),
      education: education.length,
      experience: experience.length,
      bullets: experience.reduce((n, e) => n + e.bullets.length, 0),
      skillsListed: skills.listed.length,
      skillsInferred: skills.inferred.length,
      needsReview: experience.filter((e) => e._lowConfidence).map((e) => e.title || e.company),
    },
  };
}

const withScheme = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u.replace(/^\/+/, '')}`);
