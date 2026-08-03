/**
 * ATS 适配器集合
 *
 * 每个适配器接收 board token，返回统一格式的岗位数组：
 * {
 *   ats, company, externalId, title, locationRaw, department,
 *   employmentType, url, descriptionText, compensationRaw,
 *   atsPostedAt   // ATS 自己给的时间（多数不可靠，仅作参考，绝不用于 24h 判断）
 * }
 *
 * 所有接口均为公司公开发布的 job board 接口，无需认证。
 * 注意：绝不在此处加入 LinkedIn / Indeed 等聚合站的抓取。
 */

export const UA = 'job-agent/0.1 (personal job search tool)';

/** 带超时、重试和 Retry-After 处理的 fetch */
export async function fetchJSON(url, { retries = 2, timeoutMs = 20000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status === 404) return { notFound: true };

      // 尊重限流：Greenhouse 官方说法是「合理轮询没问题，猛打就封」
      if (res.status === 429 || res.status === 503) {
        const wait = Number(res.headers.get('retry-after')) || 5 * (attempt + 1);
        if (attempt < retries) {
          await sleep(wait * 1000);
          continue;
        }
        throw new Error(`rate limited (${res.status})`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { data: await res.json() };
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await sleep(1500 * (attempt + 1));
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripHtml = (s = '') =>
  String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ─────────────────────────────────────────────────────────────
// Greenhouse
// 已实测确认：返回 first_published（真实首发时间，可靠）和 updated_at（不可靠，
// 常见整块公司岗位的 updated_at 完全相同，是 board 级批量刷新）。用 first_published。
// ─────────────────────────────────────────────────────────────
export async function greenhouse(token, company, _opts = {}) {
  const { data, notFound } = await fetchJSON(
    `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`
  );
  if (notFound) return { notFound: true, jobs: [] };
  return {
    jobs: (data?.jobs || []).map((j) => ({
      ats: 'greenhouse',
      company,
      externalId: String(j.id),
      title: j.title,
      locationRaw: j.location?.name || '',
      department: j.departments?.[0]?.name || j.metadata?.department || '',
      employmentType: '',
      url: j.absolute_url,
      descriptionText: stripHtml(j.content),
      compensationRaw: '',
      atsPostedAt: j.first_published || null, // 可靠
      atsUpdatedAt: j.updated_at || null,     // 仅供参考，不要用它判断新旧
      deadline: j.application_deadline || null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Lever
// 有真正的 createdAt（epoch ms）—— 公开接口里最可靠的日期字段
// ─────────────────────────────────────────────────────────────
export async function lever(token, company, _opts = {}) {
  const { data, notFound } = await fetchJSON(
    `https://api.lever.co/v0/postings/${token}?mode=json`
  );
  if (notFound) return { notFound: true, jobs: [] };
  const list = Array.isArray(data) ? data : [];
  return {
    jobs: list.map((j) => ({
      ats: 'lever',
      company,
      externalId: String(j.id),
      title: j.text,
      locationRaw: j.categories?.location || '',
      department: j.categories?.team || j.categories?.department || '',
      employmentType: j.categories?.commitment || '',
      url: j.hostedUrl || j.applyUrl,
      descriptionText: stripHtml(j.descriptionPlain || j.description),
      compensationRaw: j.salaryRange
        ? `${j.salaryRange.min}-${j.salaryRange.max} ${j.salaryRange.currency || ''}`
        : '',
      atsPostedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null, // 相对可靠
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Ashby — 自带薪资字段，接口不支持过滤
// ─────────────────────────────────────────────────────────────
export async function ashby(token, company, _opts = {}) {
  const { data, notFound } = await fetchJSON(
    `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`
  );
  if (notFound) return { notFound: true, jobs: [] };
  return {
    jobs: (data?.jobs || []).map((j) => ({
      ats: 'ashby',
      company,
      externalId: String(j.id),
      title: j.title,
      locationRaw:
        j.location ||
        j.address?.postalAddress?.addressLocality ||
        (j.isRemote ? 'Remote' : ''),
      department: j.department || j.team || '',
      employmentType: j.employmentType || '',
      url: j.jobUrl || j.applyUrl,
      descriptionText: stripHtml(j.descriptionPlain || j.descriptionHtml),
      compensationRaw: j.compensation?.compensationTierSummary || '',
      atsPostedAt: j.publishedAt || null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Workable — 中小公司居多
// ─────────────────────────────────────────────────────────────
export async function workable(token, company, _opts = {}) {
  const { data, notFound } = await fetchJSON(
    `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`
  );
  if (notFound) return { notFound: true, jobs: [] };
  return {
    jobs: (data?.jobs || []).map((j) => ({
      ats: 'workable',
      company,
      externalId: String(j.shortcode || j.id),
      title: j.title,
      locationRaw: [j.city, j.state, j.country].filter(Boolean).join(', ') ||
        j.location?.location_str || '',
      department: j.department || '',
      employmentType: j.employment_type || '',
      url: j.url || j.application_url,
      descriptionText: stripHtml(j.description),
      compensationRaw: '',
      atsPostedAt: j.published_on || j.created_at || null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Recruitee
// ─────────────────────────────────────────────────────────────
export async function recruitee(token, company, _opts = {}) {
  const { data, notFound } = await fetchJSON(
    `https://${token}.recruitee.com/api/offers/`
  );
  if (notFound) return { notFound: true, jobs: [] };
  return {
    jobs: (data?.offers || []).map((j) => ({
      ats: 'recruitee',
      company,
      externalId: String(j.id),
      title: j.title,
      locationRaw: [j.city, j.state_code || j.state_name, j.country_code]
        .filter(Boolean).join(', '),
      department: j.department || '',
      employmentType: j.employment_type_code || '',
      url: j.careers_url || j.careers_apply_url,
      descriptionText: stripHtml(j.description),
      compensationRaw: '',
      atsPostedAt: j.published_at || null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// SmartRecruiters — 公开 posting 接口，列表不含正文
// ─────────────────────────────────────────────────────────────
export async function smartrecruiters(token, company, _opts = {}) {
  const { data, notFound } = await fetchJSON(
    `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`
  );
  if (notFound) return { notFound: true, jobs: [] };
  return {
    jobs: (data?.content || []).map((j) => ({
      ats: 'smartrecruiters',
      company,
      externalId: String(j.id),
      title: j.name,
      locationRaw: [j.location?.city, j.location?.region, j.location?.country]
        .filter(Boolean).join(', ') + (j.location?.remote ? ' (Remote)' : ''),
      department: j.department?.label || j.function?.label || '',
      employmentType: j.typeOfEmployment?.label || '',
      url: j.ref
        ? `https://jobs.smartrecruiters.com/${token}/${j.id}`
        : j.applyUrl,
      descriptionText: '', // 需再请求详情接口，Phase 2 再补
      compensationRaw: '',
      atsPostedAt: j.releasedDate || null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Workday —— 覆盖大公司的钥匙，财富 500 里大部分用它
//
// 注意区分两件事：
//   读岗位列表  = 可行（就是下面这段），返回结构化 JSON
//   自动填表投递 = 难（字段被藏起来，基础工具解析准确率约 34%），放 Phase 6
//
// token 格式：tenant|site|host    例如  nvidia|NVIDIAExternalCareerSite|wd5
//   完整 URL 是 https://{tenant}.{host}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//   host 通常是 wd1 / wd3 / wd5 / wd103 之一，每个租户不一样，要单独确定。
//
// 三个必须知道的坑：
//   1. Workday 用 Akamai bot 管理，单 IP 猛打几分钟内会被封 —— 所以并发要低、
//      翻页之间要有停顿，且每天只跑一次（我们本来就是每天下午 4 点跑一次）。
//   2. 单次查询有 10000 条硬上限。单个公司通常远低于这个数，不用切片。
//   3. postedOn 是 "Posted 30+ Days Ago" 这种模糊值，不可解析 —— 所以 Workday
//      的岗位完全依赖我们自己的快照 diff 来判断新旧。
// ─────────────────────────────────────────────────────────────
const WD_PAGE = 20;          // Workday 单页上限就是 20
// 日常抓取的翻页上限。150 页 = 3000 个岗位，但大租户（CVS 3000+）单家就要
// 105 秒，几百个租户直接撑爆 Actions 超时。40 页 = 800 个岗位，够绝大多数公司，
// 超大租户拿不全也无所谓 —— 你不会去投一家公司的全部 3000 个岗位。
// 需要全量时用环境变量覆盖：WD_MAX_PAGES=150 npm run scrape
const WD_MAX_PAGES = parseInt(process.env.WD_MAX_PAGES || '40', 10);
const WD_PAGE_DELAY = 700;   // 翻页间隔，避免触发 Akamai

export async function workday(token, company, opts = {}) {
  const [tenant, site, host = 'wd1'] = String(token).split('|').map((s) => s.trim());
  if (!tenant || !site) throw new Error('workday token 格式应为 tenant|site|host');

  const base = `https://${tenant}.${host}.myworkdayjobs.com`;
  const api = `${base}/wday/cxs/${tenant}/${site}/jobs`;
  const jobs = [];
  let total = null;
  // 验证模式只翻 1 页 —— 只需确认租户有效，不需要全量
  const maxPages = opts.maxPages || WD_MAX_PAGES;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * WD_PAGE;
    let data;
    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ appliedFacets: {}, limit: WD_PAGE, offset, searchText: '' }),
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 404) return { notFound: true, jobs: [] };
      if (res.status === 403 || res.status === 429) {
        // 被 Akamai 拦了。已经拿到的先返回，别硬刚。
        if (jobs.length) break;
        throw new Error(`被拦截 (${res.status}) —— 降低频率或换 IP`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      if (jobs.length) break;      // 已有数据就别丢
      throw err;
    }

    const batch = data?.jobPostings || [];
    if (total === null) total = data?.total ?? null;
    if (!batch.length) break;

    for (const j of batch) {
      const p = j.externalPath || '';
      jobs.push({
        ats: 'workday',
        company,
        // externalPath 末段带唯一 requisition id，是稳定的
        externalId: p.split('/').pop() || j.bulletFields?.[0] || j.title,
        title: j.title,
        locationRaw: j.locationsText || j.locations || '',
        department: '',
        employmentType: '',
        url: p ? `${base}/${site}${p}` : base,
        descriptionText: '',      // 详情要再请求单个岗位接口，量大，Phase 2 再按需补
        compensationRaw: '',
        atsPostedAt: null,        // "Posted 30+ Days Ago" 无法解析，靠我们自己的快照
        atsPostedRaw: j.postedOn || '',
      });
    }

    if (total !== null && jobs.length >= total) break;
    if (batch.length < WD_PAGE) break;
    await sleep(WD_PAGE_DELAY);
  }

  return { jobs };
}

export const ADAPTERS = {
  greenhouse,
  lever,
  ashby,
  workable,
  recruitee,
  smartrecruiters,
  workday,
};
