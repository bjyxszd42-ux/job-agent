/**
 * 岗位匹配打分 —— 纯规则、可解释、零 API。
 *
 * 这个文件浏览器和 Node 都要用：
 *   · 浏览器（ui/index.html）在读取时按当前档案给全部岗位打分排序
 *   · scrape.mjs 用 detectSignals() 在抓取时从【完整 JD】提取 sponsorship 信号
 * 所以这里不能碰 fs、不能碰 document，只做纯计算。
 *
 * ── 为什么是加分制而不是「符合/不符合」 ──
 * 硬性过滤已经在侧栏做了（家族、级别、州、时间）。打分要回答的是另一个问题：
 * 在都符合的岗位里，先投哪个。所以每一项都给分而不是一票否决，
 * 最后把加分理由摊开给用户看 —— 分数不解释就没人信，没人信就不会用。
 *
 * ── 权重加起来正好 100 ──
 * 这样界面上列出的每条理由（+30 / +18 …）直接相加就是显示的分数，
 * 不需要「归一化」这种解释不清的东西。
 */

export const WEIGHTS = {
  family: 30,      // 最强信号：岗位家族是否是你的目标
  seniority: 18,   // 级别
  location: 14,    // 州 / 远程
  skills: 12,      // 技能关键词命中
  freshness: 10,   // 新鲜度 —— 早投一天胜过简历改十遍
  salary: 9,       // 薪资
  mode: 7,         // 工作模式
};

const SEN_ORDER = ['intern', 'entry', 'mid', 'senior', 'staff', 'manager', 'director', 'exec'];

/* ────────────────────────────────────────────────────────────────
   薪资解析
   ──────────────────────────────────────────────────────────────── */

/**
 * 把 ATS 给的薪资字符串解析成数字区间。见过的格式：
 *   "$140K – $170K"                            → 140000–170000
 *   "$104,054.50 – $156,079.00"                → 104054–156079
 *   "$200K – $265K • Offers Equity • Bonus"    → 200000–265000
 *   "$25.00 - $32.00 per hour"                 → 按 2080 小时折算年薪
 * 解析不出来返回 null，调用方按「未知」处理而不是按 0 处理 ——
 * 索引里只有 8% 的岗位贴了薪资，把没贴的当 0 分等于把 92% 的岗位打死。
 */
export function parseComp(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const hourly = /(?:per|\/)\s*(?:hour|hr)\b|hourly/i.test(raw);

  const nums = [];
  const re = /\$\s*([\d][\d,]*(?:\.\d+)?)\s*([KkMm])?/g;
  let m;
  while ((m = re.exec(raw))) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(n)) continue;
    const suffix = (m[2] || '').toLowerCase();
    if (suffix === 'k') n *= 1e3;
    else if (suffix === 'm') n *= 1e6;
    nums.push(n);
  }

  // 没有 $ 符号的写法，Ashby 常见："106000-146000 USD"。
  // 只在带货币词的时候才认，否则 "2024-2025" 这种年份也会被当成薪资。
  if (!nums.length && /\b(?:USD|EUR|GBP|CAD)\b/i.test(raw)) {
    const re2 = /\b(\d{4,7})(?:\.\d+)?\b/g;
    let m2;
    while ((m2 = re2.exec(raw))) nums.push(parseFloat(m2[1]));
  }
  if (!nums.length) return null;

  let lo = Math.min(...nums);
  let hi = Math.max(...nums);

  // 时薪折年薪。也兜住没写 "per hour" 但数字明显是时薪的情况 ——
  // 但「数字小」不等于「是时薪」：$500 的 stipend 乘 2080 会变成 104 万，
  // 所以只在数字落在真实时薪区间（联邦最低工资 $7.25 到高端外包 $400）时才折算。
  const looksHourly = hi >= 7 && hi <= 400;
  const asHourly = (hourly && hi < 2000) || (!hourly && looksHourly);
  if (asHourly) { lo *= 2080; hi *= 2080; }

  // 明显不是年薪的（几百块的 stipend、几千万的笔误）直接放弃，别拿脏数据打分
  if (hi < 10000 || hi > 5e6) return null;
  return { min: Math.round(lo), max: Math.round(hi), hourly: asHourly };
}

/* ────────────────────────────────────────────────────────────────
   Sponsorship / 国籍 / 安全许可 信号
   ──────────────────────────────────────────────────────────────── */

// 明确【不】提供 sponsorship
const NO_SPONSOR = [
  // 否定词到 sponsor 之间允许一小段（"unable to sponsor" / "will not be able to offer visa sponsorship"），
  // 但不许跨句号 —— 跨句就可能把「我们不歧视…我们提供 sponsorship」读反
  /\b(?:not|unable|won'?t|will\s+not|cannot|can'?t|do(?:es)?\s+not|are\s+not|no\s+longer)\b[^.]{0,45}?sponsor/i,
  /\bsponsorship\s+(?:is\s+)?(?:not\s+(?:available|offered|provided|possible)|unavailable)/i,
  /\bno\s+(?:visa\s+)?sponsorship\b/i,
  /\bwithout\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+)?(?:visa\s+|immigration\s+|employer\s+)?sponsorship/i,
  /\b(?:must|required?\s+to)\s+be\s+(?:legally\s+)?(?:authoriz|authoris)ed\s+to\s+work[^.]{0,60}\bwithout\b/i,
  /\bdoes\s+not\s+(?:currently\s+)?(?:offer|provide)\s+(?:employment\s+)?(?:visa\s+)?sponsorship/i,
];

// 明确【会】提供 sponsorship —— 这类岗位对需要身份的人是加分项
const WILL_SPONSOR = [
  /\bsponsorship\s+(?:is\s+)?(?:available|offered|provided)/i,
  /\bwe\s+(?:will|do|can|are\s+(?:able|willing|happy)\s+to)\s+sponsor/i,
  /\b(?:willing|able|happy)\s+to\s+sponsor/i,
  /\b(?:visa|h-?1b|employment)\s+sponsorship\s+(?:is\s+)?(?:available|offered|supported)/i,
  /\bwe\s+sponsor\s+(?:visas|h-?1b)/i,
];

// 必须是美国公民 —— 比「不给 sponsor」更硬，绿卡也不行
const CITIZEN_ONLY = [
  /\bmust\s+be\s+a\s+(?:U\.?S\.?|United\s+States)\s+citizen/i,
  /\b(?:U\.?S\.?|United\s+States)\s+citizenship\s+(?:is\s+)?(?:required|mandatory)/i,
  /\brestricted\s+to\s+(?:U\.?S\.?|United\s+States)\s+citizens/i,
  /\b(?:U\.?S\.?)\s+[Pp]erson\s+(?:status\s+)?(?:as\s+defined|is\s+required)/i,
];

// 需要安全许可 —— 实践上等同于公民限定，而且流程要几个月
const CLEARANCE = [
  /\b(?:active|current|existing)\s+(?:U\.?S\.?\s+)?(?:government\s+|security\s+|DoD\s+)?clearance/i,
  /\bsecurity\s+clearance\s+(?:is\s+)?(?:required|mandatory)/i,
  /\b(?:TS\/SCI|Top\s+Secret|Secret\s+clearance|Public\s+Trust)\b/i,
  /\bability\s+to\s+obtain\s+(?:and\s+maintain\s+)?a?\s*(?:security\s+)?clearance/i,
];

const any = (list, text) => list.some((re) => re.test(text));

/**
 * 从 JD 全文提取用工限制信号。
 *
 * 这个函数【应该在抓取时跑】，因为完整 JD 只在抓取那一刻存在 ——
 * jobs.json 里只留 400 字摘要，而这些话通常写在 JD 最后面，摘要里根本看不到。
 * 抓取时算好存进索引，读取时就是白拿的。
 *
 * 返回 null 表示「没提」，不是「不限制」—— 绝大多数 JD 什么都不写。
 * 这个区别很重要：不能把沉默当成拒绝。
 */
export function detectSignals(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.length > 60000 ? text.slice(0, 60000) : text;

  const out = {};
  // 先判否定 —— "we will not sponsor" 里也含 sponsor 字样，宁可从严
  if (any(NO_SPONSOR, t)) out.sponsor = 'no';
  else if (any(WILL_SPONSOR, t)) out.sponsor = 'yes';
  if (any(CITIZEN_ONLY, t)) out.citizenOnly = true;
  if (any(CLEARANCE, t)) out.clearance = true;

  return Object.keys(out).length ? out : null;
}

/* ────────────────────────────────────────────────────────────────
   关键词命中
   ──────────────────────────────────────────────────────────────── */

/**
 * 归一化成「空格分隔的词流」，两端补空格。
 * 这样查 " r " 不会命中 "react"，查 " go " 不会命中 "google" ——
 * 简单的 includes 子串匹配在技能名这件事上错得离谱。
 *
 * + # . & 保留为词内字符：
 *   + #  → "c++" / "c#" 不被切碎
 *   .    → "node.js" / ".net" 不被切碎
 *   &    → "R&D" 保持一个词，不会裂成 "r" 和 "d" 而把技能 R 误判成命中。
 *          这条是专门为单字母技能（R、C）设的 —— JD 里 R&D 出现得太频繁了。
 */
function wordStream(s) {
  return ' ' + String(s || '').toLowerCase()
    .split(/[^a-z0-9+#.&]+/)
    .map((w) => w.replace(/^[.&]+|[.&]+$/g, ''))
    .filter(Boolean)
    .join(' ') + ' ';
}

function countSkillHits(stream, skills) {
  const hits = [];
  for (const raw of skills) {
    const needle = wordStream(raw).trim();
    if (!needle) continue;
    if (stream.includes(' ' + needle + ' ')) hits.push(raw);
  }
  return hits;
}

/* ────────────────────────────────────────────────────────────────
   打分
   ──────────────────────────────────────────────────────────────── */

/** 档案是否填到了能打分的程度 —— 全空的话打分没有意义，界面据此提示去填 */
export function profileIsUsable(profile) {
  const p = profile?.preferences || {};
  const sk = profile?.skills || {};
  return !!(
    (p.families || []).length || p.seniority ||
    (p.targetStates || []).length || (p.workModes || []).length ||
    p.salaryMin || (sk.technical || []).length || (sk.tools || []).length
  );
}

/**
 * 给单个岗位打分。
 *
 * @returns {{score:number, reasons:Array<{k:string,label:string,delta:number}>, blockers:string[]}}
 *
 * reasons 里的 delta 相加 = score（在没有 blocker 的情况下）。
 * blockers 是硬伤：需要 sponsorship 但对方明说不给、只招公民、要安全许可。
 * 有 blocker 不是直接删掉岗位，而是扣分 + 打红标 —— 判断错了的时候
 * 用户还能自己看到并忽略，静默删除会让人不知道自己错过了什么。
 */
export function scoreJob(job, profile, now = Date.now()) {
  const pref = profile?.preferences || {};
  const auth = profile?.workAuth || {};
  const skills = [
    ...(profile?.skills?.technical || []),
    ...(profile?.skills?.tools || []),
  ];

  const reasons = [];
  const add = (k, label, delta) => { if (delta) reasons.push({ k, label, delta }); };

  // ── 岗位家族 ──
  const wantFams = pref.families || [];
  const jobFams = job.families || [];
  if (!wantFams.length) {
    add('family', 'No target families set', Math.round(WEIGHTS.family * 0.5));
  } else if (jobFams.some((f) => wantFams.includes(f))) {
    add('family', 'Target job family', WEIGHTS.family);
  } else {
    add('family', 'Outside your job families', 0);
  }

  // ── 级别 ──
  // 注意：索引里 45% 的岗位是 mid，因为标题里没有级别词时默认落到 mid。
  // 所以 mid 更接近「未知」而不是「确实是中级」，不该当成明确不匹配。
  const wantSen = pref.seniority;
  const jobSen = job.seniority;
  if (!wantSen) {
    add('seniority', 'No target level set', Math.round(WEIGHTS.seniority * 0.5));
  } else if (jobSen === wantSen) {
    add('seniority', `${cap(wantSen)} level`, WEIGHTS.seniority);
  } else {
    const d = Math.abs(SEN_ORDER.indexOf(jobSen) - SEN_ORDER.indexOf(wantSen));
    if (jobSen === 'mid') add('seniority', 'Level not stated in title', Math.round(WEIGHTS.seniority * 0.75));
    else if (d === 1) add('seniority', 'One level off', Math.round(WEIGHTS.seniority * 0.6));
    else if (d === 2) add('seniority', 'Two levels off', Math.round(WEIGHTS.seniority * 0.2));
    else add('seniority', 'Level mismatch', 0);
  }

  // ── 地点 ──
  const loc = job.location || {};
  const wantStates = pref.targetStates || [];
  const modes = pref.workModes || [];
  const wantsRemote = modes.includes('remote');
  if (loc.isRemote && (wantsRemote || !modes.length)) {
    add('location', 'Remote', WEIGHTS.location);
  } else if (!wantStates.length) {
    add('location', 'No state preference', Math.round(WEIGHTS.location * 0.7));
  } else if ((loc.states || []).some((s) => wantStates.includes(s))) {
    add('location', `In ${(loc.states || []).filter((s) => wantStates.includes(s)).join('/')}`, WEIGHTS.location);
  } else if (pref.willingToRelocate) {
    add('location', 'Outside target states — open to relocating', Math.round(WEIGHTS.location * 0.4));
  } else {
    add('location', 'Outside your target states', 0);
  }

  // ── 工作模式 ──
  if (!modes.length) {
    add('mode', 'No work-mode preference', Math.round(WEIGHTS.mode * 0.5));
  } else if (loc.isRemote) {
    add('mode', wantsRemote ? 'Remote, as preferred' : 'Remote (you prefer on-site)', wantsRemote ? WEIGHTS.mode : 0);
  } else {
    const onsiteOk = modes.includes('onsite') || modes.includes('hybrid');
    add('mode', onsiteOk ? 'On-site / hybrid, as preferred' : 'On-site (you prefer remote)', onsiteOk ? WEIGHTS.mode : 0);
  }

  // ── 薪资 ──
  const comp = parseComp(job.compensationRaw);
  const floor = pref.salaryMin;
  if (!floor) {
    add('salary', 'No salary floor set', Math.round(WEIGHTS.salary * 0.5));
  } else if (!comp) {
    add('salary', 'Salary not posted', Math.round(WEIGHTS.salary * 0.5));
  } else if (comp.max >= (pref.salaryMax || floor)) {
    add('salary', `Pays up to $${kfmt(comp.max)}`, WEIGHTS.salary);
  } else if (comp.max >= floor) {
    add('salary', `Above your $${kfmt(floor)} floor`, Math.round(WEIGHTS.salary * 0.7));
  } else {
    add('salary', `Below your $${kfmt(floor)} floor`, 0);
  }

  // ── 技能关键词 ──
  // 索引里只有 60% 的岗位有摘要（Workday 基本没有），没摘要的给中性分，
  // 不能因为对方 ATS 不返回描述就把岗位打低 —— 那等于按 ATS 供应商歧视岗位。
  let hits = [];
  if (!skills.length) {
    add('skills', 'No skills in profile', Math.round(WEIGHTS.skills * 0.5));
  } else if (!job.snippet || job.snippet.length < 40) {
    add('skills', 'No description text to match', Math.round(WEIGHTS.skills * 0.35));
  } else {
    hits = countSkillHits(wordStream(`${job.title} ${job.department || ''} ${job.snippet}`), skills);
    const pts = hits.length ? Math.min(WEIGHTS.skills, 4 + hits.length * 3) : 2;
    add('skills', hits.length ? `Matches ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? ` +${hits.length - 4}` : ''}` : 'No skill keywords found', pts);
  }

  // ── 新鲜度 ──
  // 招聘这件事上时间差是真实优势：投在前 50 份和第 500 份，看的人不一样。
  const posted = Date.parse(job.postedAt || job.firstSeenAt || 0);
  const days = isFinite(posted) ? (now - posted) / 864e5 : 999;
  const fr = days <= 1 ? 1 : days <= 3 ? 0.7 : days <= 7 ? 0.5 : days <= 14 ? 0.3 : days <= 30 ? 0.1 : 0;
  add('freshness', days <= 1 ? 'Posted today' : days <= 7 ? `Posted ${Math.round(days)}d ago` : days <= 30 ? 'Posted this month' : 'Older posting', Math.round(WEIGHTS.freshness * fr));

  let score = reasons.reduce((s, r) => s + r.delta, 0);

  // ── 用工限制 ──
  const blockers = [];
  const needsSponsor = auth.requireSponsorshipFuture === true || auth.requireSponsorshipNow === true;
  const isCitizen = auth.status === 'citizen';

  // 公民且不需要 sponsor 的话，这一整块信号对结果没有任何影响 ——
  // 直接跳过。省的不是一点：全量打分时这里是 19 条正则 × 一万多条摘要。
  // signals 优先用抓取时从【完整 JD】算好的；老索引没有这个字段时退回扫摘要
  //（摘要只有 400 字，这类话通常写在 JD 末尾，扫不到是常态，不是 bug）
  const sig = (isCitizen && !needsSponsor) ? null : (job.signals || detectSignals(job.snippet));

  if (sig) {
    if (sig.citizenOnly && !isCitizen) { blockers.push('US citizens only'); score -= 45; }
    else if (sig.clearance && !isCitizen) { blockers.push('Security clearance required'); score -= 35; }
    if (sig.sponsor === 'no' && needsSponsor) { blockers.push('No visa sponsorship'); score -= 45; }
    if (sig.sponsor === 'yes' && needsSponsor) { add('sponsor', 'Sponsorship available', 6); score += 6; }
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, blockers };
}

const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const kfmt = (n) => (n >= 1000 ? Math.round(n / 1000) + 'K' : String(n));
