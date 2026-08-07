/**
 * 简历审阅 —— 纯规则，不调模型
 *
 * 这一层的定位要说清楚：它【不重写】简历，它找出确定性的问题并给出确定性的改法。
 *
 * 为什么先做规则版而不是直接上模型：
 *   1. 简历上真正会被刷掉的问题，绝大多数是机械性的 ——
 *      没有数字、开头是 "Responsible for"、时态和在职状态对不上、超过一页。
 *      这些用正则就能百分之百查出来，交给模型反而不稳定
 *   2. 每条意见都要能说出【为什么】。"这句可以更好" 是废话，
 *      "这条 bullet 没有任何数字，同一段里另外两条都有" 才是可执行的
 *   3. 接了 API 之后这一层不删。模型负责的是「把这件事说得更好」，
 *      规则负责的是「这件事漏了」—— 后者不该花钱重算，也不该有随机性
 *
 * 每条 finding 都带 before / after 的，界面上可以一键应用；
 * 只有 before 没有 after 的，是需要用户自己补信息的（比如「加个数字」）。
 * 从头到尾没有「自动改完就完事」的路径 —— 简历是用户自己要署名的东西。
 */

import { buildDoc, keywordSet, estimateLines, bulletScore, TEMPLATE, monthsOfExperience } from './resume-template.mjs';

/* ────────────────────────────────────────────────────────────────
   词表
   ──────────────────────────────────────────────────────────────── */

// 常见的-ing → 过去式。不规则的必须列出来，规则的靠后面的兜底规则
const GERUND_PAST = {
  managing: 'Managed', leading: 'Led', building: 'Built', writing: 'Wrote', running: 'Ran',
  making: 'Made', doing: 'Did', taking: 'Took', giving: 'Gave', driving: 'Drove',
  holding: 'Held', keeping: 'Kept', meeting: 'Met', sending: 'Sent', spending: 'Spent',
  teaching: 'Taught', beginning: 'Began', overseeing: 'Oversaw', maintaining: 'Maintained',
  developing: 'Developed', designing: 'Designed', creating: 'Created', analyzing: 'Analyzed',
  supporting: 'Supported', coordinating: 'Coordinated', handling: 'Handled', ensuring: 'Ensured',
  performing: 'Performed', assisting: 'Assisted', helping: 'Helped', providing: 'Provided',
  monitoring: 'Monitored', reporting: 'Reported', tracking: 'Tracked', updating: 'Updated',
  processing: 'Processed', reviewing: 'Reviewed', training: 'Trained', testing: 'Tested',
};

/** "coordinating" → "Coordinated"：规则版的 -ing 去尾加 -ed */
function toPast(word) {
  const w = word.toLowerCase();
  if (GERUND_PAST[w]) return GERUND_PAST[w];
  if (!w.endsWith('ing')) return null;
  let stem = w.slice(0, -3);
  if (!stem) return null;
  // "planning" → "plann" → 双写辅音要去掉一个
  if (stem.length > 2 && stem.at(-1) === stem.at(-2) && !'aeiou'.includes(stem.at(-1))) stem = stem.slice(0, -1);
  const past = /e$/.test(stem) ? `${stem}d` : `${stem}ed`;
  return past[0].toUpperCase() + past.slice(1);
}

// 开头的虚词。这些短语本身不传达任何信息，
// 而且把真正的动作推到了第 3、4 个词 —— 招聘方扫简历时只看得到行首几个词
const WEAK_OPENERS = [
  { re: /^responsible for\s+/i, label: 'Responsible for' },
  { re: /^tasked with\s+/i, label: 'Tasked with' },
  { re: /^duties included\s+/i, label: 'Duties included' },
  { re: /^in charge of\s+/i, label: 'In charge of' },
  { re: /^involved in\s+/i, label: 'Involved in' },
  { re: /^worked on\s+/i, label: 'Worked on' },
  { re: /^worked with\s+/i, label: 'Worked with' },
  { re: /^helped (?:to\s+)?/i, label: 'Helped' },
  { re: /^assisted (?:in|with)\s+/i, label: 'Assisted in' },
  { re: /^participated in\s+/i, label: 'Participated in' },
  { re: /^part of (?:a |the )?/i, label: 'Part of' },
];

/**
 * 换个词就更好的。左边不是错，是弱。
 *
 * 必须【按词形替换】。第一版直接把 "Utilized" 换成 "Use"，
 * 结果一条过去式的 bullet 变成了现在时 —— 而时态不一致恰恰是这个文件
 * 另一条规则要查的问题。给出的修改本身引入新问题，比不给修改更糟。
 */
const WORD_SWAPS = [
  { re: /\butiliz(e|es|ed|ing)\b/i, map: { e: 'use', es: 'uses', ed: 'used', ing: 'using' },
    why: 'utilize 只是 use 的长写法，没有多传达任何信息。' },
  { re: /\bleverag(e|es|ed|ing)\b/i, map: { e: 'use', es: 'uses', ed: 'used', ing: 'using' },
    why: 'leverage 作动词在简历里已经被用滥了，读的人会自动略过。' },
  { re: /\bspearhead(s|ed|ing)?\b/i, map: { undefined: 'lead', s: 'leads', ed: 'led', ing: 'leading' },
    why: 'spearheaded 是套话，led 更短也更可信。' },
  { re: /\bsuccessfully\s+/i, map: null, why: '写在简历上的事默认就是做成了的，这个副词不承担信息。' },
  { re: /\b(various|numerous|several|multiple)\s+/i, map: null,
    why: '这类模糊数量词占着位置又不给数字 —— 直接写数量。' },
  { re: /\bhelped\s+to\s+/i, map: { _: 'helped ' }, why: '多余的 to。' },
];

/** 保持首字母大小写的替换 */
function matchCase(sample, word) {
  return sample[0] === sample[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
}

// 自我评价类的形容词。这些词无法验证，占地方，而且几乎每份简历上都有
const BUZZWORDS = ['team player', 'hard working', 'hard-working', 'detail oriented', 'detail-oriented',
  'results driven', 'results-driven', 'self motivated', 'self-motivated', 'go getter', 'go-getter',
  'think outside the box', 'synergy', 'synergies', 'dynamic individual', 'proven track record',
  'excellent communication skills', 'strong work ethic', 'fast learner', 'passionate about'];

// 行首的强动词。不求全，只用来判断「这条 bullet 是不是以动作开头」
const STRONG_VERBS = new Set(('built designed developed created launched shipped led managed ran drove '
  + 'owned founded established implemented deployed automated optimized improved increased reduced cut '
  + 'grew scaled accelerated streamlined rebuilt redesigned refactored migrated integrated architected '
  + 'analyzed modeled forecasted measured quantified evaluated benchmarked audited investigated '
  + 'identified diagnosed resolved fixed eliminated prevented mitigated negotiated secured won closed '
  + 'delivered shipped presented published authored wrote documented taught trained mentored coached '
  + 'coordinated organized planned prioritized standardized centralized consolidated partnered '
  + 'collaborated advised recommended proposed defined specified prototyped tested validated verified '
  + 'monitored tracked maintained supported administered configured provisioned '
  + 'build design develop create launch ship lead manage run drive own establish implement deploy '
  + 'automate optimize improve increase reduce cut grow scale streamline rebuild migrate integrate '
  + 'analyze model forecast measure quantify evaluate benchmark audit identify diagnose resolve '
  + 'negotiate secure deliver present publish write document teach train mentor coordinate organize '
  + 'plan prioritize standardize consolidate partner collaborate advise recommend propose define '
  + 'specify prototype test validate verify monitor track maintain support administer configure '
  + 'conduct support design').split(/\s+/));

const PRESENT_FORMS = new Set(('build design develop create launch ship lead manage run drive own '
  + 'establish implement deploy automate optimize improve increase reduce cut grow scale streamline '
  + 'rebuild migrate integrate analyze model forecast measure quantify evaluate benchmark audit '
  + 'identify diagnose resolve negotiate secure deliver present publish write document teach train '
  + 'mentor coordinate organize plan prioritize standardize consolidate partner collaborate advise '
  + 'recommend propose define specify prototype test validate verify monitor track maintain support '
  + 'administer configure conduct').split(/\s+/));

/**
 * 这条 bullet 里有没有量化。
 *
 * 第一版要求两位以上数字，于是 "engaging 8 robotics manufacturers"
 * 和 "isolating 5 product categories" 都被判成「没有数字」——
 * 而这两条恰恰是量化得最干净的。个位数在简历上非常常见，不能漏。
 *
 * 反过来要排掉的是【年份】："in 2024" 不是指标。
 * 判据是：光秃秃的 19xx/20xx 不算，带了 % $ × 或者单位的一律算。
 */
const YEARISH = /^(?:19|20)\d{2}$/;
function hasMetric(t) {
  for (const m of String(t).matchAll(/(\$\s?)?(\d[\d,]*(?:\.\d+)?)\s*(%|×|x|k|m|bn?|hours?|days?|weeks?|months?|pts?|points?)?\b/gi)) {
    if (m[1] || m[3]) return true;
    if (YEARISH.test(m[2].replace(/,/g, ''))) continue;
    return true;
  }
  return false;
}
const firstWord = (t) => (String(t).trim().match(/^[A-Za-z'-]+/) || [''])[0];

/* ────────────────────────────────────────────────────────────────
   单条 bullet
   ──────────────────────────────────────────────────────────────── */

/**
 * 检查一条 bullet，返回 finding 数组。
 *
 * ctx.current  这段经历是否在职（决定时态该用现在时还是过去时）
 */
function reviewBullet(text, where, ctx = {}) {
  const out = [];
  const at = (id, o) => out.push({ id: `${where.path}:${id}`, where, ...o });
  let working = text;

  // 1. 第一人称
  const fp = working.match(/^(?:I|We)\s+|^(?:My|Our)\s+/);
  if (fp) {
    const after = working.replace(/^(?:I|We)\s+/, '').replace(/^(?:My|Our)\s+/, '');
    at('firstperson', {
      level: 'fix', label: 'Drop the pronoun',
      what: `This bullet starts with "${fp[0].trim()}".`,
      why: 'Résumé bullets are written in an implied first person — every line is already about you, so the pronoun is pure overhead.',
      before: working, after: after[0].toUpperCase() + after.slice(1),
    });
    working = after;
  }

  // 2. 虚词开头
  for (const { re, label } of WEAK_OPENERS) {
    const m = working.match(re);
    if (!m) continue;
    let rest = working.slice(m[0].length);
    const w1 = firstWord(rest);
    const past = toPast(w1);
    // "Responsible for managing X" → "Managed X"：动词要从 -ing 变回过去式，
    // 变不出来就不给 after，让用户自己动手（给一个改坏的建议比不给更糟）
    const after = past ? past + rest.slice(w1.length) : null;
    at('weakopener', {
      level: 'fix', label: `"${label}" buries the verb`,
      what: `This bullet opens with "${label}", so the actual action doesn't appear until word ${m[0].trim().split(/\s+/).length + 1}.`,
      why: 'Recruiters scan the first two or three words of each line. Leading with the verb is the single highest-leverage edit on a résumé.',
      before: working, after,
    });
    if (after) working = after;
    break;
  }

  // 3. 不是动词开头
  const w0 = firstWord(working).toLowerCase();
  if (w0 && !STRONG_VERBS.has(w0) && !/ed$|ing$/.test(w0) && !/^(?:context|challenge|outcome|result|situation|action|task)$/i.test(w0)) {
    at('noverb', {
      level: 'improve', label: 'Start with a verb',
      what: `This bullet starts with "${firstWord(working)}", which isn't an action verb.`,
      why: 'Verb-first bullets read as accomplishments; noun-first bullets read as job descriptions.',
      before: working, after: null,
    });
  }

  // 4. 时态
  if (w0 && ctx.current === true && /ed$/.test(w0) && !PRESENT_FORMS.has(w0)) {
    at('tense', {
      level: 'improve', label: 'Past tense in a current role',
      what: `You still hold this role, but this bullet starts with "${firstWord(working)}".`,
      why: 'Mixing tenses inside one role is the most common consistency error on a résumé. Current role → present tense; past roles → past tense.',
      before: working, after: null,
    });
  }
  if (w0 && ctx.current === false && PRESENT_FORMS.has(w0) && !/ed$/.test(w0)) {
    at('tense', {
      level: 'improve', label: 'Present tense in a past role',
      what: `This role ended, but this bullet starts with "${firstWord(working)}".`,
      why: 'Past roles read in past tense. A present-tense verb here suggests the dates are wrong.',
      before: working, after: (() => { const p = toPast(`${w0}ing`); return p ? p + working.slice(w0.length) : null; })(),
    });
  }

  // 5. 没有量化
  if (!hasMetric(working)) {
    at('nometric', {
      level: 'improve', label: 'No number in this bullet',
      what: 'Nothing here is quantified.',
      why: 'A number is what turns a claim into evidence. Three questions usually produce one: how many, how much, how often?',
      before: working, after: null,
    });
  }

  // 6. 弱词
  for (const { re, map, why } of WORD_SWAPS) {
    const m = working.match(re);
    if (!m) continue;
    const hit = m[0];
    let after;
    let better = '';
    if (!map) {
      after = (working.slice(0, m.index) + working.slice(m.index + hit.length)).replace(/\s{2,}/g, ' ').trim();
      after = after[0] ? after[0].toUpperCase() + after.slice(1) : after;
    } else {
      const suffix = map._ !== undefined ? '_' : String(m[1] ?? undefined).toLowerCase();
      better = map[suffix] ?? map._ ?? Object.values(map)[0];
      after = working.slice(0, m.index) + matchCase(hit, better) + working.slice(m.index + hit.length);
    }
    at(`swap-${hit.toLowerCase().trim()}`, {
      level: 'improve',
      label: `"${hit.trim()}" → ${map ? `"${matchCase(hit, better).trim()}"` : 'cut it'}`,
      what: `This bullet uses "${hit.trim()}".`, why, before: working, after,
    });
    break;
  }

  // 7. 套话
  const buzz = BUZZWORDS.find((b) => working.toLowerCase().includes(b));
  if (buzz) {
    at('buzzword', {
      level: 'improve', label: `Unverifiable claim: "${buzz}"`,
      what: `This bullet contains "${buzz}".`,
      why: 'Nobody writes that they are a poor team player, so the phrase carries no information. Replace it with the thing you did that demonstrates it.',
      before: working, after: null,
    });
  }

  // 8. 被动语态
  const passive = working.match(/\b(?:was|were|been|being)\s+(\w+ed)\b/i);
  if (passive) {
    at('passive', {
      level: 'improve', label: 'Passive voice',
      what: `"${passive[0]}" hides who did it.`,
      why: 'On a résumé the answer is always "you" — say so directly.',
      before: working, after: null,
    });
  }

  // 9. 长度。上限按模板量的：一行约 118 字符，超过 240 就是三行起
  if (working.length > 240) {
    at('toolong', {
      level: 'improve', label: `Runs to ${Math.ceil(working.length / 118)} lines`,
      what: `${working.length} characters.`,
      why: 'Bullets longer than two lines stop being scanned. Usually there are two accomplishments in here that should be split, or a clause that can go.',
      before: working, after: null,
    });
  } else if (working.length < 55 && working.length > 0) {
    at('tooshort', {
      level: 'idea', label: 'Very short bullet',
      what: `${working.length} characters.`,
      why: 'There is probably room to say what the result was.',
      before: working, after: null,
    });
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────
   整份简历
   ──────────────────────────────────────────────────────────────── */

function allEntries(profile) {
  const list = [];
  (profile.experience || []).forEach((e, i) => list.push({
    section: 'experience', index: i, label: `${e.title || '?'} @ ${e.company || '?'}`,
    current: !!e.current, bullets: e.bullets || [],
  }));
  (profile.projects || []).forEach((p, i) => list.push({
    section: 'projects', index: i, label: p.name || '?',
    current: !!p.current, bullets: p.bullets || [],
  }));
  (profile.leadership || []).forEach((e, i) => list.push({
    section: 'leadership', index: i, label: `${e.title || '?'} @ ${e.company || '?'}`,
    current: !!e.current, bullets: e.bullets || [],
  }));
  return list;
}

/** 联系方式、页数、日期空档这些「整份简历层面」的问题 */
function reviewWhole(profile, doc, now) {
  const out = [];
  const add = (id, o) => out.push({ id, where: { section: 'resume', path: `resume:${id}` }, ...o });
  const b = profile.basics || {};

  const missing = [];
  if (!b.email) missing.push('email');
  if (!b.phone) missing.push('phone');
  if (!(b.address?.city && b.address?.state)) missing.push('city and state');
  if (missing.length) {
    add('contact', {
      level: 'fix', label: `Missing ${missing.join(', ')}`,
      what: `The header has no ${missing.join(', no ')}.`,
      why: 'ATS parsers pull contact details from the header. A missing phone number is a common reason a strong application never gets a call.',
    });
  }
  if (!b.links?.linkedin) {
    add('linkedin', {
      level: 'improve', label: 'No LinkedIn URL',
      what: 'The header has no LinkedIn link.',
      why: 'In the US market a recruiter will look you up anyway; giving them the right profile costs one line.',
    });
  }
  if (b.email && /\d{4,}|hotmail|sexy|cute|xoxo|princess|gamer/i.test(b.email.split('@')[0])) {
    add('email-style', {
      level: 'idea', label: 'Email address reads casually',
      what: `"${b.email}"`,
      why: 'A firstname.lastname address is the safest default. This is cosmetic, but it is the first thing on the page.',
    });
  }

  // 页数
  const lines = estimateLines(doc);
  const pages = Math.ceil(lines / TEMPLATE.linesPerPage);
  const months = monthsOfExperience(profile.experience || [], now);
  if (pages > 1 && months < 120) {
    const over = lines - TEMPLATE.linesPerPage;
    add('length', {
      level: 'fix', label: `Runs to about ${pages} pages`,
      what: `Roughly ${over} lines past a single page.`,
      why: months < 24
        ? 'With under two years of full-time experience the US convention is one page, and recruiters do enforce it. Cutting the weakest bullet from each role is usually enough.'
        : 'Under ten years of experience, one page is still the safer default in most US markets.',
      action: 'trim',
    });
  }

  // 全篇一个数字都没有
  const entries = allEntries(profile);
  const bullets = entries.flatMap((e) => e.bullets.map((x) => x.text || ''));
  const quantified = bullets.filter(hasMetric).length;
  if (bullets.length >= 4 && quantified / bullets.length < 0.4) {
    add('quantification', {
      level: 'improve', label: `Only ${quantified} of ${bullets.length} bullets have a number`,
      what: `${Math.round((quantified / bullets.length) * 100)}% quantified.`,
      why: 'Aim for roughly half. Numbers are the only part of a résumé a reader can check, so they carry most of the credibility.',
    });
  }

  // 行首动词重复
  const openers = {};
  for (const t of bullets) {
    const w = firstWord(t).toLowerCase();
    if (w) (openers[w] ||= []).push(t);
  }
  for (const [w, list] of Object.entries(openers)) {
    if (list.length >= 3) {
      add(`repeat-${w}`, {
        level: 'idea', label: `"${firstWord(list[0])}" opens ${list.length} bullets`,
        what: list.map((t) => t.slice(0, 60) + '…').join('  ·  '),
        why: 'Repeated openers make the page read as one long paragraph. Varying the verb is a two-minute fix that noticeably changes how the résumé scans.',
      });
    }
  }

  /* 时间空档。
   *
   * 在校期间的实习之间【天然就是空档】—— 学期在上课，暑假在实习。
   * 第一版把这些全报了出来：三段实习报了三个空档，
   * 而正确答案是一个都没有。误报会让用户不再相信这份报告里的任何一条，
   * 所以宁可漏报也不能这样报。
   *
   * 两种情况直接跳过：
   *   · 空档整个落在某段学历的就读期内（学历只写了毕业时间时，按毕业时间之前算在读）
   *   · 空档两头有一头是实习 —— 实习本来就是阶段性的
   */
  const enrolledThrough = (profile.education || []).map((e) => e.endDate).filter((d) => /^\d{4}-\d{2}$/.test(d));
  const isIntern = (e) => /\b(intern|internship|co-?op|fellow|trainee|part[-\s]?time|seasonal|summer)\b/i.test(e.title || '');

  const dated = (profile.experience || [])
    .filter((e) => /^\d{4}-\d{2}$/.test(e.startDate || ''))
    .sort((x, y) => (x.startDate < y.startDate ? 1 : -1));
  for (let i = 0; i < dated.length - 1; i++) {
    const later = dated[i], earlier = dated[i + 1];
    const endOfEarlier = earlier.current ? null : earlier.endDate;
    if (!endOfEarlier || !/^\d{4}-\d{2}$/.test(endOfEarlier)) continue;
    if (isIntern(later) || isIntern(earlier)) continue;
    if (enrolledThrough.some((grad) => grad >= later.startDate)) continue;
    const gap = (+later.startDate.slice(0, 4) - +endOfEarlier.slice(0, 4)) * 12
      + (+later.startDate.slice(5, 7) - +endOfEarlier.slice(5, 7));
    if (gap >= 7) {
      add(`gap-${i}`, {
        level: 'idea', label: `${gap}-month gap before ${later.company || later.title}`,
        what: `${endOfEarlier} → ${later.startDate}`,
        why: 'Gaps are fine and extremely common — but an unexplained one invites the question. If you were studying, that is what the education section is for.',
      });
    }
  }

  // GPA
  for (const e of profile.education || []) {
    if (!e.showGpa || !e.gpa) continue;
    const v = parseFloat(e.gpa);
    if (v && v < 3.0) {
      add(`gpa-${e.school}`, {
        level: 'idea', label: `GPA ${e.gpa} is shown`,
        what: `${e.school}`,
        why: 'Below about 3.0 it is conventional — and entirely acceptable — to simply leave the GPA off. Nobody asks why it is missing.',
      });
    }
  }

  if (!(profile.skills?.technical || []).length) {
    add('noskills', {
      level: 'fix', label: 'No skills section',
      what: 'The résumé lists no skills.',
      why: 'Keyword matching in an ATS leans heavily on this section, and it is the fastest place for a human to confirm you have the stack.',
    });
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────
   压到一页
   ──────────────────────────────────────────────────────────────── */

/**
 * 超过一页时，具体该砍哪几条 bullet。
 *
 * 「简历太长了」是句正确的废话 —— 用户知道长，不知道砍哪条。
 * 所以这里直接算出一个最小删除集合，并且给出每一条被选中的理由。
 *
 * 三条约束：
 *   · 每段经历至少留 2 条，最近的一段至少留 3 条 —— 只剩一条的经历看着像没干什么
 *   · 优先砍没有数字的、和目标岗位关键词不沾边的
 *   · 只删不改。改写要调模型，而且删掉一条弱 bullet 通常比改好它更管用
 */
export function suggestTrim(profile, doc, { job = null } = {}) {
  const budget = TEMPLATE.linesPerPage;
  let lines = estimateLines(doc);
  if (lines <= budget) return [];

  const jobWords = job ? keywordSet(`${job.title || ''} ${job.snippet || ''}`) : null;
  const cost = (t) => Math.max(1, Math.ceil(t.length / 118));

  // Context / Challenge / Outcome 这种带标签的三连是一个整体。
  // 单独抽掉 "Challenge:" 剩下 Context 和 Outcome，读起来是断的 ——
  // 这种结构要么整段留，要么整段去，不能挑着删
  const LABELLED = /^(?:context|challenge|outcome|situation|task|action|result|problem|approach|impact)\s*:/i;

  const pool = [];
  allEntries(profile).forEach((entry, order) => {
    const labelled = entry.bullets.filter((b) => LABELLED.test(b.text || '')).length >= 2;
    const floor = labelled ? entry.bullets.length : (order === 0 ? 3 : 2);
    entry.bullets.forEach((b, bi) => pool.push({
      path: `${entry.section}[${entry.index}].bullets[${bi}]`,
      where: { section: entry.section, index: entry.index, bullet: bi, label: entry.label },
      text: b.text || '', entryKey: `${entry.section}${entry.index}`, floor,
      total: entry.bullets.length,
      score: bulletScore(b.text || '', jobWords),
      quantified: hasMetric(b.text || ''),
    }));
  });

  pool.sort((a, b) => a.score - b.score || Number(a.quantified) - Number(b.quantified) || b.text.length - a.text.length);

  const removedPerEntry = {};
  const out = [];
  for (const c of pool) {
    if (lines <= budget) break;
    const left = c.total - (removedPerEntry[c.entryKey] || 0);
    if (left <= c.floor) continue;
    removedPerEntry[c.entryKey] = (removedPerEntry[c.entryKey] || 0) + 1;
    lines -= cost(c.text);
    out.push({
      path: c.path, where: c.where, text: c.text,
      reason: [
        !c.quantified && 'no number in it',
        jobWords && c.score === 0 && 'nothing in it matches the target job',
        cost(c.text) >= 3 && `takes ${cost(c.text)} lines on its own`,
      ].filter(Boolean).join('; ') || 'weakest bullet in this role',
    });
  }
  // 砍到底也还是超页 —— 必须说出来。给一份「照做就能一页」的假承诺，
  // 用户照做完发现还是两页，这份报告就没人信了
  out.stillOver = lines > budget ? lines - budget : 0;
  return out;
}

/* ────────────────────────────────────────────────────────────────
   目标岗位关键词覆盖
   ──────────────────────────────────────────────────────────────── */

/**
 * 简历对目标岗位关键词的覆盖情况。
 *
 * 三档要分开，因为对应的动作完全不同：
 *   onResume  已经写上了 —— 什么都不用做
 *   inProfile 档案里有、这次生成的简历上没有 —— 换一条 bullet 就解决
 *   missing   完全没有 —— 要么真不会，要么会但从没写下来过
 *
 * 注意 job.snippet 只有 400 字符，覆盖率是【近似】的。
 * 界面上必须写清楚这一点，不然用户会以为 60% 是个准确数字。
 */
export function keywordCoverage(profile, job, doc) {
  if (!job) return null;
  const jobWords = keywordSet(`${job.title || ''} ${job.department || ''} ${job.snippet || ''}`);
  const resumeText = JSON.stringify(doc?.sections || '');
  const resumeWords = keywordSet(resumeText);
  const profileWords = keywordSet(JSON.stringify(profile));

  const onResume = [], inProfile = [], missing = [];
  for (const w of jobWords) {
    if (w.length < 3) continue;
    if (resumeWords.has(w)) onResume.push(w);
    else if (profileWords.has(w)) inProfile.push(w);
    else missing.push(w);
  }
  const total = onResume.length + inProfile.length + missing.length;
  return {
    onResume: onResume.sort(), inProfile: inProfile.sort(), missing: missing.sort(),
    pct: total ? Math.round((onResume.length / total) * 100) : 0,
    approximate: true,
  };
}

/* ────────────────────────────────────────────────────────────────
   主入口
   ──────────────────────────────────────────────────────────────── */

const WEIGHT = { fix: 6, improve: 2, idea: 0 };

/**
 * 审阅一份档案。
 *
 * 分数只是把 findings 折成一个数，方便排序和「改完了没有」的直观反馈 ——
 * 它不代表「这份简历有多好」，那是规则判断不了的。界面上不要拿它当成绩单。
 */
export function reviewResume(profile = {}, opts = {}) {
  const { job = null, now = new Date() } = opts;
  const doc = opts.doc || buildDoc(profile, { job, now });

  const findings = [...reviewWhole(profile, doc, now)];

  // 「太长了」这条要带上【砍哪几条】，否则用户只知道超页、不知道下一步做什么
  const lengthFinding = findings.find((f) => f.id === 'length');
  if (lengthFinding) {
    const trim = suggestTrim(profile, doc, { job });
    lengthFinding.trim = trim;
    if (trim.length) {
      lengthFinding.what += trim.stillOver
        ? ` Dropping the ${trim.length} weakest bullets gets you most of the way; the remaining ~${trim.stillOver} lines have to come from shortening the long ones or cutting a whole entry.`
        : ` Dropping ${trim.length} bullet${trim.length > 1 ? 's' : ''} would fit it on one page.`;
    }
  }

  for (const entry of allEntries(profile)) {
    entry.bullets.forEach((b, bi) => {
      const where = {
        section: entry.section, index: entry.index, bullet: bi, label: entry.label,
        path: `${entry.section}[${entry.index}].bullets[${bi}]`,
      };
      findings.push(...reviewBullet(b.text || '', where, { current: entry.current }));
    });
  }

  const counts = { fix: 0, improve: 0, idea: 0 };
  for (const f of findings) counts[f.level] = (counts[f.level] || 0) + 1;
  const score = Math.max(0, Math.min(100,
    100 - counts.fix * WEIGHT.fix - counts.improve * WEIGHT.improve));

  return {
    score, counts, findings,
    coverage: keywordCoverage(profile, job, doc),
    pages: doc.meta.estimatedPages,
    // 通过的检查也要报出来。一份满屏红字的报告会让人直接关掉，
    // 而「这 6 项没问题」本身就是有用的信息
    passed: [
      doc.sections.length >= 3 && 'Standard section headings an ATS will recognise',
      'No tables, columns, text boxes, headers or footers',
      (profile.basics?.email && profile.basics?.phone) && 'Contact details in the document body',
      doc.sections.some((s) => s.key === 'skills') && 'Dedicated skills section',
      findings.every((f) => f.id.indexOf('tense') < 0) && 'Verb tense consistent with employment dates',
    ].filter(Boolean),
  };
}

/**
 * 把一条 finding 的 after 写回档案。
 *
 * 只改 bullet 文本，不动结构。返回新档案（不原地改）——
 * 界面上要能「撤销」，原地改就没得撤了。
 */
export function applyFinding(profile, finding) {
  if (!finding?.after || !finding.where?.section) return profile;
  const { section, index, bullet } = finding.where;
  const next = structuredClone(profile);
  const target = next[section]?.[index]?.bullets?.[bullet];
  if (!target || target.text !== finding.before) return profile;   // 内容变过了就不应用
  target.text = finding.after;
  return next;
}
