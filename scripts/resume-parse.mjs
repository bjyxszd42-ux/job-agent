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
  // leadership 必须排在 awards 前面，而且不能共用词表。
  // 之前 'leadership' 挂在 awards 里，结果 LEADERSHIP 这一节被归成「奖项」——
  // 奖项是不带 bullet 的一行文字，而领导经历的结构和工作经历完全一样
  // （组织 / 角色 / 日期 / bullet），归错了整节就只剩几行散文
  leadership: ['leadership', 'activities', 'involvement', 'extracurricular', 'volunteer',
               'volunteering', 'community', 'service', 'organizations'],
  awards: ['awards', 'award', 'honors', 'honours', 'achievements', 'certifications', 'certification',
           'certificates', 'licenses', 'licences', 'publications',
           'interests', 'references', 'languages', 'affiliations', 'coursework'],
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

/* ────────────────────────────────────────────────────────────────
   地点
   ──────────────────────────────────────────────────────────────── */

// 海外实习在美国留学生的简历上是常态。只认 "City, ST" 的话，
// "Shenzhen, China" 和 "Remote" 都会掉到公司名或职位名里去 ——
// 不是留空那么简单，是把地点当成了公司
const COUNTRIES = ['China', 'Canada', 'Mexico', 'Brazil', 'Argentina', 'Chile', 'Colombia',
  'United Kingdom', 'UK', 'England', 'Scotland', 'Ireland', 'France', 'Germany', 'Spain', 'Portugal',
  'Italy', 'Netherlands', 'Belgium', 'Switzerland', 'Austria', 'Sweden', 'Norway', 'Denmark',
  'Finland', 'Poland', 'Czechia', 'Czech Republic', 'Greece', 'Turkey', 'Russia', 'Ukraine',
  'India', 'Pakistan', 'Bangladesh', 'Japan', 'South Korea', 'Korea', 'Taiwan', 'Hong Kong',
  'Singapore', 'Malaysia', 'Indonesia', 'Thailand', 'Vietnam', 'Philippines', 'Australia',
  'New Zealand', 'Israel', 'UAE', 'United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Egypt',
  'South Africa', 'Nigeria', 'Kenya', 'Ghana'];
const COUNTRY_RE = new RegExp(
  `(?:^|[\\n|·•–—]|\\s{2,})\\s*([A-Z][A-Za-z.'\\- ]{1,24}?),\\s*(${COUNTRIES.join('|')})\\b`,
);
// "Remote" / "Hybrid" 必须是独立的一段（行首、行尾或被分隔符夹住），
// 不能是 bullet 正文里的 "remote teams"
const REMOTE_RE = /(?:^|\s{2,}|[|·•])\s*(Remote|Hybrid|On-?site)\s*(?=$|\s{2,}|[|·•\n])/;

/**
 * 从一行里抠出地点。返回 { label, matched } 或 null。
 * 顺序：美国 City, ST → City, Country → Remote/Hybrid。
 */
function parseLocation(text) {
  const us = text.match(RE.cityState);
  if (us && STATE_CODES.has(us[2])) return { label: `${us[1]}, ${us[2]}`, zip: us[3] || '', matched: us[0] };
  const intl = text.match(COUNTRY_RE);
  if (intl) return { label: `${intl[1].trim()}, ${intl[2]}`, zip: '', matched: intl[0] };
  const rem = text.match(REMOTE_RE);
  if (rem) return { label: rem[1].replace(/^on-?site$/i, 'On-site'), zip: '', matched: rem[0] };
  return null;
}

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
    let t = raw.replace(/^[\s•\-–—*|]+|[\s•\-–—*|]+$/g, '').trim();
    if (!t || t.length > 46 || /[\d@]/.test(t) || NOT_NAME.test(t)) continue;

    // 括号里的英文名先摘出来。"Fei (Freya) Long" 是中国学生简历上最常见的写法，
    // 之前 (Freya) 过不了「每个词都是纯字母」这一关，整行被跳过 ——
    // 于是姓名字段直接空着，而这是简历上最不该解析失败的一个字段。
    // 摘出来的那个词也不能丢：它就是 preferredName，投递表格里「Preferred name」要用
    let preferred = '';
    const nick = t.match(/\s*[("'“](\s*[A-Za-z][A-Za-z.'\-]{0,20})\s*[)"'”]\s*/);
    if (nick) { preferred = nick[1].trim(); t = t.replace(nick[0], ' ').trim(); }

    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (!words.every((w) => /^[A-Za-z][A-Za-z.'\-]*$/.test(w))) continue;
    const fix = (w) => (w === w.toUpperCase() && w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w);
    const cased = words.map(fix);
    return { first: cased[0], last: cased[cased.length - 1], preferred: fix(preferred), full: cased.join(' ') };
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

/**
 * 大学【下属院系】不是另一所学校。
 *
 *     Columbia University              New York, NY
 *     School of Professional Studies   Expected December 2026
 *     M.S. in Applied Analytics        GPA: 4.0
 *
 * 第二行同时命中 SCHOOL_RE 里的 "school of"，之前直接开了一条新学历 ——
 * 于是一段学历被拆成两条：一条只有学校名，一条只有学位，
 * 而毕业时间挂在了错的那条上。
 *
 * 判据是「XX School/College/Department of YY」这种从属写法 + 当前这条还没拿到学位。
 * 残留风险：London School of Economics 紧跟在另一所没写学位的学校后面会被误判 ——
 * 但真实简历里两所学校中间一定隔着学位行，所以这个组合基本不会出现。
 */
const DIVISION_RE = /^(?:the\s+)?(?:[A-Z][\w'&.\-]*\s+){0,3}(?:school|college|department|faculty|division)\s+of\s+/i;
// "Expected December 2026" / "December 2024" —— 单个毕业时间，不是区间
const LONE_DATE_RE = new RegExp(`(?:(expected|anticipated|graduating|graduation)\\s*[:\\s]\\s*)?(${DATE_TOKEN})`, 'i');

function parseEducation(lines) {
  const out = [];
  let cur = null;
  const push = () => { if (cur && (cur.school || cur.degree)) out.push(cur); cur = null; };
  const blank = () => ({
    school: '', division: '', degree: '', field: '', gpa: '', showGpa: false,
    startDate: '', endDate: '', expected: false, location: '', honors: [], notes: '',
  });

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const isDivision = cur && cur.school && !cur.degree && DIVISION_RE.test(line);

    if (SCHOOL_RE.test(line) && !isDivision) {
      push();
      cur = blank();
      let rest = line;
      const dr = dateRange(line);
      if (dr) { cur.startDate = dr.startDate; cur.endDate = dr.endDate; rest = rest.replace(dr.matched, '  '); }
      const loc = parseLocation(rest);
      if (loc) { cur.location = loc.label; rest = rest.replace(loc.matched, '  '); }
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
      const loc = parseLocation(rest);
      if (loc) { cur.location = loc.label; rest = rest.replace(loc.matched, '  '); }
    }
    const g = rest.match(RE.gpa);
    if (g && !cur.gpa) {
      cur.gpa = g[2] ? `${g[1]}/${g[2]}` : g[1];
      cur.showGpa = true;                            // 简历上印着，说明本来就打算展示
      rest = rest.replace(g[0], '  ');
    }
    // 单个毕业时间：学历这一节里 "December 2024" 从来不是正文，就是毕业时间
    if (!dr2 && !cur.endDate) {
      const one = rest.match(LONE_DATE_RE);
      if (one) {
        cur.endDate = oneDate(one[2]);
        cur.expected = !!one[1];
        rest = rest.replace(one[0], '  ');
      }
    }

    if (isDivision) { cur.division = rest.trim().replace(/[,\s]+$/, ''); continue; }

    const before = cur.degree;
    applyDegree(cur, rest);
    if (before || !cur.degree) {
      // 学位已经有了，这行是荣誉/辅修那类补充：
      // "Minor: MIS      Dean's List: 4/7 Semesters" 是两列，别拼成一句
      for (const part of rest.split(/\s{2,}|\s*[|·•]\s*/).map((x) => x.trim()).filter(Boolean)) {
        if (part.length >= 3 && cur.honors.length < 4) cur.honors.push(part.replace(/[,\s]+$/, ''));
      }
    }
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

// 一行里「公司 / 职位 / 地点 / 日期」的分隔符。
// 连字符必须【两边带空格】才算分隔符，否则 "Human-Computer Interaction"
// 会被从中间切开。三种横线都要认（正文里的 – 和 — 不再被归一化成 -）
const SEG_SPLIT = /\s*[|·•]\s*|\s+[-–—]\s+|\s{2,}|,\s(?=[A-Z])/;

const BULLET_RE = /^\s*[•·▪●‣◦○*+\-–—]\s+/;
const TITLE_WORDS = /\b(engineer|developer|analyst|scientist|manager|designer|consultant|director|specialist|coordinator|associate|assistant|intern(?:ship)?|lead|architect|administrator|officer|president|founder|researcher|strategist|marketer|recruiter|accountant|auditor|controller|advisor|representative|executive|supervisor|technician|writer|editor|producer|planner|buyer|trader|actuary|paralegal|attorney|nurse|therapist|teacher|instructor|professor|fellow|apprentice)\b/i;
const ORG_SUFFIX = /\b(inc|llc|ltd|corp(?:oration)?|co|company|group|labs?|technologies|technology|solutions|systems|partners|capital|ventures|bank|university|hospital|foundation|institute|associates|consulting|holdings|gmbh|s\.?a\.?)\b\.?/i;
// 跟在职位后面的用工性质，本身不是一个独立职位 ——
// "Data Analytics Assistant, Intern" 是一个职位，不是「助理」加「实习生」两个
const ROLE_MODIFIER = /^(?:intern(?:ship)?|co-?op|contract(?:or)?|part[-\s]?time|full[-\s]?time|temporary|temp|seasonal|summer|fellow(?:ship)?|trainee|apprentice|volunteer|freelance|per\s?diem|pt|ft)$/i;
// "DiamondUp Technology Co., Ltd" 里的 Ltd 是公司名的一部分。
// 分隔符规则会在 "Co., Ltd" 的逗号处切开，切完之后 Ltd 无处安放就落进了职位栏 ——
// 于是职位变成 "Ltd, Intern"，真正的职位被挤掉
const ENTITY_TAIL = /^(?:ltd|inc|llc|l\.l\.c|corp|co|plc|ag|nv|bv|gmbh|s\.?a\.?|s\.?r\.?l|pte\.?\s*ltd|pty\.?\s*ltd|kk|oy|ab)\.?$/i;

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
    const loc = parseLocation(rest);
    if (loc && !cur.location) {
      cur.location = loc.label;
      rest = rest.replace(loc.matched, '  ');
    }

    for (const seg of rest.split(SEG_SPLIT).map((x) => x.replace(/[,\s]+$/, '').trim()).filter(Boolean)) {
      if (!cur.title && TITLE_WORDS.test(seg)) { cur.title = seg; continue; }
      if (!cur.company && (ORG_SUFFIX.test(seg) || !TITLE_WORDS.test(seg))) { cur.company = seg; continue; }

      /* 走到这里说明公司和职位至少有一个已经填上了，但这一段还没安置。
       * 之前这种段【直接丢掉】，结果 "Product Development Assistant, Intern"
       * 只留下 "Product Development Assistant"，"Value-Added Service, Intern"
       * 更惨 —— 公司在上一行已经填了，于是只剩一个光秃秃的 "Intern"。
       * 职位写成 Intern 会让后面的家族匹配和资历判定全错。 */
      if (cur.title && ROLE_MODIFIER.test(seg)) { cur.title += `, ${seg}`; continue; }
      if (cur.company && !cur.title && ENTITY_TAIL.test(seg)) { cur.company += `, ${seg}`; continue; }
      if (!cur.title) cur.title = seg;                 // 公司已定，剩下的就是职位
    }
  }
  push();

  // 两个都填上了才算高置信；只认出一个的标记出来，界面上提示核对
  for (const e of out) e._lowConfidence = !(e.company && e.title);
  return out;
}

/* ────────────────────────────────────────────────────────────────
   项目
   ──────────────────────────────────────────────────────────────── */

/**
 * 项目不能复用 parseExperience。
 *
 * 差别在切分符：经历那边把「空格连字符空格」当分隔符（"Analyst - Acme Corp"），
 * 但项目名里带破折号是常态 ——
 *     FlightShield – Parametric Flight-Delay Insurance    Columbia University
 * 用经历的规则会把项目名从中间切开，副标题被当成第二个字段。
 * 项目行的列分隔实际上只有「两个以上空格」和竖线/圆点，所以这里用更窄的切分符。
 *
 * 结构和经历一致（名称 / 归属 / 角色 / 日期 / bullet），这样打分和生成简历
 * 都不用为项目单独写一套逻辑。
 */
const PROJ_SPLIT = /\s{2,}|\s*[|·•]\s*/;

function parseProjects(lines) {
  const out = [];
  let cur = null;
  const push = () => { if (cur && cur.name) out.push(cur); cur = null; };
  const blank = (s) => !s.trim();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (BULLET_RE.test(line)) {
      if (!cur) continue;
      cur.bullets.push({ text: line.replace(BULLET_RE, '').trim(), tags: [] });
      continue;
    }
    if (cur && cur.bullets.length && !dateRange(line) && /^[a-z(]/.test(line)) {
      cur.bullets[cur.bullets.length - 1].text += ' ' + line;
      continue;
    }

    const dr = dateRange(line);
    const next = lines[i + 1] || '';
    const nextHasDate = !blank(next) && !BULLET_RE.test(next) && !!dateRange(next);
    const startsNew = cur ? (cur.bullets.length > 0 || (dr && cur.startDate)) : (dr || nextHasDate || true);

    if (startsNew) {
      push();
      cur = { name: '', org: '', role: '', url: '', startDate: '', endDate: '',
              current: false, bullets: [], tags: [], description: '' };
    }

    let rest = line;
    if (dr) {
      cur.startDate ||= dr.startDate;
      cur.endDate ||= dr.endDate;
      cur.current ||= dr.current;
      rest = rest.replace(dr.matched, '  ');
    }
    const u = rest.match(RE.url);
    if (u && !cur.url) { cur.url = withScheme(u[0].replace(/[.,]$/, '')); rest = rest.replace(u[0], '  '); }

    const segs = rest.split(PROJ_SPLIT).map((x) => x.replace(/[,\s]+$/, '').trim()).filter(Boolean);
    for (const seg of segs) {
      if (!cur.name) cur.name = seg;
      else if (!cur.org && !cur.role) cur.org = seg;    // 第一行右列 = 归属机构
      else if (!cur.role) cur.role = seg;
      else if (!cur.org) cur.org = seg;
    }
  }
  push();
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

/**
 * 只在【括号外】切分。
 *
 * "Python (pandas, NumPy, Scikit-learn), SQL, PostgreSQL" 用普通 split
 * 会切成 "Python (pandas" / "NumPy" / "Scikit-learn)" —— 三个都不是技能名，
 * 而且括号还是断的，直接填进档案里就是一串垃圾。
 */
function splitTopLevel(line, sepRe) {
  const out = [];
  let depth = 0, buf = '';
  for (const ch of line) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && sepRe.test(ch)) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

// 这些技能名同时也是普通英文词。用小写词流去匹配，
// "a single trusted oracle" 会被当成会用 Oracle 数据库，"go to market" 会被当成会写 Go ——
// 填进档案后又会流到打分和岗位推荐里，错得很隐蔽。
// 对这一批要求原文里【大写形式】出现过。
const CASE_SENSITIVE_SKILLS = new Set(['go', 'r', 'c', 'oracle', 'spring', 'rails', 'segment',
  'looker', 'braze', 'swift', 'scala', 'kotlin', 'rust', 'hive', 'shell', 'bash']);

function parseSkills(skillLines, fullText) {
  const found = [];
  const groups = [];
  const seen = new Set();
  const add = (s, bucket) => {
    const t = s.trim().replace(/[.,;]+$/, '');
    const k = t.toLowerCase();
    if (!t || t.length > 60 || seen.has(k)) return;
    // 单字母技能只认 R 和 C —— 别的单字母基本都是排版残渣
    if (t.length === 1 && !['r', 'c'].includes(k)) return;
    if (/^\d+$/.test(t)) return;
    seen.add(k); found.push(t); bucket?.push(t);
  };

  for (const raw of skillLines) {
    // "Databases & Visualizations: Python, SQL" —— 冒号左边是分类名，不是技能。
    // 但这个分类名要留着：模板里技能区就是按这几行分类排的，丢了就还原不回去
    const stripped = raw.replace(BULLET_RE, '');
    const m = stripped.match(/^([^:：]{2,40})[:：]\s*(.*)$/);
    const label = m ? m[1].trim() : '';
    const line = m ? m[2] : stripped;
    if (!line.trim()) continue;

    const bucket = [];
    // '/' 只在两边有空格时才是分隔符 —— 否则 "A/B testing" 会被切成 "A" 和 "B testing"
    const parts = splitTopLevel(line, /[,;|·•]/)
      .flatMap((p) => p.split(/\s+\/\s+|\s{3,}/));
    // 整行没有分隔符又很长，多半是句子而不是技能列表
    if (parts.length === 1 && line.length > 44) continue;
    for (const p of parts) if (p.replace(/\([^)]*\)/g, '').split(/\s+/).filter(Boolean).length <= 4) add(p, bucket);
    if (bucket.length) groups.push({ label, items: bucket });
  }

  // 补漏：技能区没写但 bullet 里提到的
  const stream = wordStream(fullText);
  const listedStream = wordStream(found.join(' '));
  const extra = [];
  for (const s of SKILL_DICT) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    const needle = ' ' + wordStream(s).trim() + ' ';
    if (!stream.includes(needle)) continue;
    // 已经写在技能区里了，只是外面套了括号（"Python (pandas, NumPy)"）—— 不算漏
    if (listedStream.includes(needle)) continue;
    if (CASE_SENSITIVE_SKILLS.has(key)
      && !new RegExp(`(?:^|[^A-Za-z0-9])${s.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(fullText)) continue;
    extra.push(s); seen.add(key);
  }
  return { listed: found, inferred: extra, groups };
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
    // 只把几种【长得像连字符但不是】的字符换成 '-'（U+2010/2011/2012/2015）。
    // 短横线 – 和长横线 — 保留原样：它们是正文的一部分，
    // "FlightShield – Parametric Flight-Delay Insurance" 被压成 '-' 之后，
    // 生成出来的简历标题和用户自己写的就不一样了 —— 模板的意义就在于原样还原。
    // 需要认这两个符号的地方（日期区间、分隔符）各自在正则里写全
    .replace(/[‐‑‒―]/g, '-')
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
  const projects = parseProjects(sec.projects || []);
  const leadership = parseExperience(sec.leadership || []);   // 结构和工作经历完全一样
  const skills = parseSkills(sec.skills || [], text);

  const other = (findIn(RE.url) || '').replace(/[.,]$/, '');
  const portfolio = other && !/linkedin\.com|github\.com/i.test(other) ? other : '';

  const profile = {
    basics: {
      legalFirstName: name?.first || '',
      legalLastName: name?.last || '',
      preferredName: name?.preferred || '',
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
    projects,
    leadership: leadership.map(({ _lowConfidence, ...e }) => e),
    skills: {
      technical: [...skills.listed, ...skills.inferred].slice(0, 60),
      // 分组是简历技能区【原本的排版】。生成简历时按这个还原，
      // 而不是把几十个技能拍平成一行 —— 拍平之后招聘方一眼看不出重点在哪
      groups: skills.groups,
    },
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
      projects: projects.length,
      leadership: leadership.length,
      bullets: [...experience, ...projects, ...leadership].reduce((n, e) => n + e.bullets.length, 0),
      skillsListed: skills.listed.length,
      skillsInferred: skills.inferred.length,
      needsReview: experience.filter((e) => e._lowConfidence).map((e) => e.title || e.company),
    },
  };
}

const withScheme = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u.replace(/^\/+/, '')}`);
