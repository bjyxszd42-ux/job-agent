/**
 * 简历模板 —— Master Profile → 版式化的简历文档
 *
 * 这里的「模板」是一套【排版规则】，不是一个填空的 Word 文件。
 * 用户上传的那份简历定下了规则，规则被抄进 TEMPLATE 常量，
 * 之后所有人的简历都按同一套规则生成 —— 这就是为什么它能是产品功能
 * 而不是给某一个人改的一份文件。
 *
 * 版式本身（两列右对齐、9.5pt Times、0.5 英寸页边距）在美国求职市场里
 * 是最保守的一种，好处正在于此：
 *   · 没有表格、没有分栏、没有文本框、没有页眉页脚 —— ATS 全都能读
 *   · 右列靠制表位对齐，不是靠空格凑 —— 复制粘贴到网页表单里不会散架
 *   · 一页塞得下 4 段经历 + 2 个项目，学生简历刚好够用
 *
 * 关键设计：档案里挂着的 bullet 比简历上显示的多。
 * 生成简历时按目标岗位【挑选和重排】，不是每次重写 ——
 * 重写要调模型、要花钱、而且每次结果都不一样；挑选是确定性的，
 * 挑错了用户自己能一眼看出来。
 */

/* ────────────────────────────────────────────────────────────────
   版式常量：全部从上传的那份简历里量出来的
   ──────────────────────────────────────────────────────────────── */

export const TEMPLATE = {
  page: { width: 12240, height: 15840, margin: { top: 720, right: 720, bottom: 431, left: 720 } },
  // 右制表位 = 页宽 - 左右页边距。改页边距时这个值必须跟着改，
  // 否则右列会跑到纸外面去（Word 里看不出来，打印和转 PDF 时才发现）
  get tabStop() { return this.page.width - this.page.margin.left - this.page.margin.right; },
  font: { family: 'Times New Roman', size: 19, nameSize: 36, headingSize: 22 },  // 半磅
  lineExact: 185,
  bullet: { char: '●', indent: 720, hanging: 360 },

  /* 一页装得下多少行。
   *
   * 这个数不是算出来的，是【量出来的】：把生成的 HTML 用 Chromium
   * 按 Letter + 0.5 英寸页边距打印，二分找翻页点。
   *   可用高度 = (11 - 1) 英寸 = 960px @96dpi
   *   行高     = 9.5pt × 1.22 = 15.45px
   *   → 960 / 15.45 ≈ 62 行
   * 一开始按行距 185 twips 硬算出 52，偏小 20%，
   * 于是「超出多少行」这个提示每次都虚报 —— 用户按提示砍完还是两页。
   */
  linesPerPage: 62,
  charsPerLine: 118,
};

/** 小节标题的显示名。用最常见的写法 —— ATS 的分节靠的就是关键词匹配 */
export const SECTION_TITLES = {
  summary: 'SUMMARY',
  education: 'EDUCATION',
  experience: 'PROFESSIONAL EXPERIENCE',
  projects: 'PROJECTS',
  leadership: 'LEADERSHIP',
  skills: 'SKILLS',
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-03" → "March 2026"；空字符串原样返回 */
export function fmtMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return String(ym || '');
  const i = +m[2] - 1;
  return i >= 0 && i < 12 ? `${MONTH_NAMES[i]} ${m[1]}` : m[1];
}

/**
 * 日期区间的显示写法。
 *
 * 空的起始日期不写成 "– May 2025"，直接只显示结束日期 ——
 * 学历那一节通常只印毕业时间，硬凑出一个区间反而像漏填了。
 */
export function fmtRange({ startDate, endDate, current, expected } = {}) {
  const s = fmtMonth(startDate);
  const e = current ? 'Present' : fmtMonth(endDate);
  if (s && e) return `${s} – ${e}`;
  if (!s && e) return expected ? `Expected ${e}` : e;
  if (s && !e) return `${s} – Present`;
  return '';
}

/* ────────────────────────────────────────────────────────────────
   联系方式行
   ──────────────────────────────────────────────────────────────── */

/** 链接去掉协议头再显示。"https://" 在纸上占地方又没人念 */
const bare = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

export function displayName(basics = {}) {
  const { legalFirstName: f = '', preferredName: p = '', legalLastName: l = '' } = basics;
  if (!f && !l) return '';
  // "Fei (Freya) Long" —— 英文名放括号里是留学生简历的通行写法：
  // 法定姓名要和证件一致（背调和 I-9 会核对），日常称呼用括号里那个
  return p && p.toLowerCase() !== f.toLowerCase() ? `${f} (${p}) ${l}`.trim() : `${f} ${l}`.trim();
}

export function contactLine(basics = {}) {
  const a = basics.address || {};
  const links = basics.links || {};
  return [
    [a.city, a.state].filter(Boolean).join(', '),
    basics.phone,
    basics.email,
    bare(links.linkedin),
    bare(links.github),
    bare(links.portfolio),
  ].filter(Boolean);
}

/* ────────────────────────────────────────────────────────────────
   按目标岗位挑 bullet
   ──────────────────────────────────────────────────────────────── */

const STOP = new Set(('a an the and or of for to in on at by with from as is are was were be been '
  + 'this that these those it its their our your you we i they he she will would can could should '
  + 'have has had do does did not no but if then than so such about into over under across per '
  + 'using used use new other more most any all each both any every via within while during also')
  .split(' '));

/** 文本 → 去掉停用词的词集合。和 score.mjs 的分词边界保持一致 */
export function keywordSet(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9+#.&]+/)) {
    const t = w.replace(/^[.&]+|[.&]+$/g, '');
    if (t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t)) out.add(t);
  }
  return out;
}

/**
 * 给一条 bullet 打「和目标岗位的相关度」。
 *
 * 只用关键词重合，不做语义。理由和 score.mjs 一样：
 * 规则版必须是【可解释】的 —— 用户能看到「这条被选中是因为提到了 SQL、Tableau」，
 * 看不懂的排序他不会信，也没法纠正。
 *
 * 带数字的 bullet 额外加分。量化过的成果在任何岗位上都更有说服力，
 * 岗位关键词一样多的时候，优先留带数字的那条。
 */
export function bulletScore(text, jobWords) {
  const words = keywordSet(text);
  let hits = 0;
  if (jobWords) for (const w of words) if (jobWords.has(w)) hits++;
  const hasNumber = /\b\d[\d,.]*\s*(?:%|percent|k\b|m\b|x\b)|\b\d[\d,]{2,}\b|\$\s?\d/.test(text);
  return hits * 2 + (hasNumber ? 1 : 0);
}

/**
 * 从一段经历的全部 bullet 里挑出要上简历的那几条。
 *
 * 挑完【按原顺序排回去】。相关度最高的排最前面读起来会很怪 ——
 * 简历上的 bullet 是有叙事顺序的（做了什么 → 怎么做的 → 结果如何），
 * 按分数重排会把结论提到前面、铺垫扔到后面。
 */
export function pickBullets(bullets = [], { jobWords = null, max = 0 } = {}) {
  const list = bullets.filter((b) => (b?.text || '').trim());
  if (!max || list.length <= max) return list;
  const ranked = list.map((b, i) => ({ b, i, s: bulletScore(b.text, jobWords) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .slice(0, max)
    .sort((x, y) => x.i - y.i);
  return ranked.map((r) => r.b);
}

/* ────────────────────────────────────────────────────────────────
   小节构造
   ──────────────────────────────────────────────────────────────── */

/**
 * 学历条目的行数取决于有没有 division（大学下属的院系）。
 *
 *   有 division —— 三行，和上传的那份简历一致：
 *     Columbia University              New York, NY
 *     School of Professional Studies   Expected December 2026
 *     M.S. in Applied Analytics        GPA: 4.0
 *
 *   没有 division —— 压成两行：
 *     New York University              New York, NY
 *     M.S. in Business Analytics, GPA: 3.82/4.0    September 2023 – May 2025
 *
 * 第一版不管有没有 division 都留三行，没有 division 时第二行就只剩右边一个日期、
 * 左边空着 —— 版面上是一道莫名其妙的空隙，而且白白多占一行。
 * 简历上每一行都是要抢的。
 */
function eduEntry(e) {
  const rows = [{ cells: [e.school || '', e.location || ''], bold: true }];
  const dateStr = fmtRange(e);
  const degree = [e.degree, e.field].filter(Boolean).join(' in ');
  const gpa = e.showGpa && e.gpa ? `GPA: ${e.gpa}` : '';

  if (e.division) {
    rows.push({ cells: [e.division, dateStr] });
    if (degree || gpa) rows.push({ cells: [degree, gpa] });
  } else if (degree || gpa || dateStr) {
    rows.push({ cells: [[degree, gpa].filter(Boolean).join(', '), dateStr] });
  }

  const h = (e.honors || []).filter(Boolean);
  for (let i = 0; i < h.length; i += 2) rows.push({ cells: [h[i], h[i + 1] || ''] });

  return { rows, bullets: [] };
}

function jobEntry(e, opts) {
  const rows = [
    { cells: [e.company || '', e.location || ''], bold: true },
    { cells: [e.title || '', fmtRange(e)] },
  ];
  return { rows, bullets: pickBullets(e.bullets, opts).map((b) => b.text) };
}

function projEntry(p, opts) {
  const rows = [
    { cells: [p.name || '', p.org || ''], bold: true },
    { cells: [p.role || '', fmtRange(p)] },
  ];
  if (!rows[1].cells[0] && !rows[1].cells[1]) rows.pop();
  return { rows, bullets: pickBullets(p.bullets, opts).map((b) => b.text) };
}

/**
 * 技能区：优先用简历原本的分组，没有分组就拍成一行。
 *
 * 分组不是排版偏好。招聘方扫技能区平均只花两三秒，
 * 「Databases & Visualizations: …」这样的标签让他一眼知道该往哪看；
 * 二十个技能挤成一行，等于让他自己去分类。
 */
function skillLines(skills = {}) {
  const groups = (skills.groups || []).filter((g) => (g.items || []).length);
  if (groups.length) {
    return groups.map((g) => ({ label: g.label ? `${g.label}: ` : '', text: g.items.join(', ') }));
  }
  const all = (skills.technical || []).filter(Boolean);
  if (!all.length) return [];
  return [{ label: '', text: all.join(', ') }];
}

/* ────────────────────────────────────────────────────────────────
   小节顺序
   ──────────────────────────────────────────────────────────────── */

/** 用有结束日期的经历估算总工作月数（在职的算到今天） */
export function monthsOfExperience(experience = [], now = new Date()) {
  let months = 0;
  for (const e of experience) {
    const s = /^(\d{4})-(\d{2})$/.exec(e.startDate || '');
    if (!s) continue;
    const end = e.current || !e.endDate
      ? now
      : new Date(+(/^(\d{4})/.exec(e.endDate) || [])[1] || 0, +(e.endDate.slice(5, 7)) - 1, 1);
    const start = new Date(+s[1], +s[2] - 1, 1);
    const d = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    if (d > 0 && d < 600) months += d;
  }
  return months;
}

/**
 * 学历放前面还是经历放前面。
 *
 * 美国市场的惯例很明确：在读学生和应届生把学历放最前面，
 * 工作两年以上把经历放最前面。判据不是「年龄」而是
 * 「招聘方最想先看到的是哪一段」——
 * 在读学生最强的凭证就是学校和专业，工作过几年之后学校就不重要了。
 */
export function sectionOrder(profile, now = new Date()) {
  const edu = profile.education || [];
  const stillStudying = edu.some((e) => {
    if (e.expected) return true;
    const m = /^(\d{4})-(\d{2})$/.exec(e.endDate || '');
    return m && new Date(+m[1], +m[2] - 1, 1) > now;
  });
  const months = monthsOfExperience(profile.experience || [], now);
  const eduFirst = stillStudying || months < 24;
  return eduFirst
    ? ['summary', 'education', 'experience', 'projects', 'leadership', 'skills']
    : ['summary', 'experience', 'education', 'projects', 'leadership', 'skills'];
}

/* ────────────────────────────────────────────────────────────────
   主入口
   ──────────────────────────────────────────────────────────────── */

/**
 * Master Profile → 简历文档。
 *
 * opts:
 *   job          目标岗位（{title, snippet, ...}）。给了就按它挑 bullet
 *   maxBullets   每段经历最多留几条 bullet；0 = 全留
 *   sections     只生成这几节
 *   now          注入当前时间，方便测试
 */
export function buildDoc(profile = {}, opts = {}) {
  const { job = null, maxBullets = 0, now = new Date() } = opts;
  const jobWords = job ? keywordSet(`${job.title || ''} ${job.department || ''} ${job.snippet || ''}`) : null;
  const pick = { jobWords, max: maxBullets };

  const basics = profile.basics || {};
  const built = {
    summary: profile.summary
      ? { key: 'summary', title: SECTION_TITLES.summary, paragraphs: [profile.summary] }
      : null,
    education: (profile.education || []).length
      ? { key: 'education', title: SECTION_TITLES.education, entries: profile.education.map(eduEntry) }
      : null,
    experience: (profile.experience || []).length
      ? { key: 'experience', title: SECTION_TITLES.experience, entries: profile.experience.map((e) => jobEntry(e, pick)) }
      : null,
    projects: (profile.projects || []).filter((p) => p.name).length
      ? { key: 'projects', title: SECTION_TITLES.projects, entries: profile.projects.filter((p) => p.name).map((p) => projEntry(p, pick)) }
      : null,
    leadership: (profile.leadership || []).length
      ? { key: 'leadership', title: SECTION_TITLES.leadership, entries: profile.leadership.map((e) => jobEntry(e, pick)) }
      : null,
    skills: skillLines(profile.skills).length
      ? { key: 'skills', title: SECTION_TITLES.skills, lines: skillLines(profile.skills) }
      : null,
  };

  const order = opts.sections || sectionOrder(profile, now);
  const sections = order.map((k) => built[k]).filter(Boolean);

  return {
    name: displayName(basics),
    contact: contactLine(basics),
    sections,
    meta: {
      targetJob: job ? { id: job.id, title: job.title, company: job.company } : null,
      estimatedLines: estimateLines({ sections }),
      estimatedPages: Math.max(1, Math.ceil(estimateLines({ sections }) / TEMPLATE.linesPerPage)),
    },
  };
}

/**
 * 估算行数 —— 用来提醒「超过一页了」。
 *
 * bullet 按 118 字符折一行。这个数字是从模板量的：
 * 9.5pt Times New Roman，正文宽度 7.5 英寸减去 bullet 缩进 0.5 英寸。
 * 估得不准也没关系，它只用来给提示，不用来做排版决策。
 */
export function estimateLines(doc) {
  let n = 3;                                        // 姓名 + 联系方式 + 一点空隙
  for (const s of doc.sections || []) {
    n += 2;                                          // 小节标题 + 标题上下的间距
    for (const e of s.entries || []) {
      n += (e.rows || []).length;
      for (const b of e.bullets || []) n += Math.max(1, Math.ceil(b.length / TEMPLATE.charsPerLine));
    }
    for (const l of s.lines || []) n += Math.max(1, Math.ceil((l.label.length + l.text.length) / TEMPLATE.charsPerLine));
    for (const p of s.paragraphs || []) n += Math.max(1, Math.ceil(p.length / TEMPLATE.charsPerLine));
  }
  return n;
}
