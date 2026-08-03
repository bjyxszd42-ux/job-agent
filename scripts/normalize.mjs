/**
 * 地点归一化 + 岗位家族匹配 + 去重
 *
 * 美国岗位的地点字符串极其混乱：
 *   "Remote - US" / "San Francisco, CA" / "SF Bay Area" / "Multiple Locations"
 *   "United States" / "NYC / Remote" / "Seattle, WA; Austin, TX"
 * 目标是解析成 { states:[], cities:[], isRemote, isUS }
 */

export const STATES = {
  alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',
  connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',
  illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',
  maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',
  mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
  'north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',
  pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',
  tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA',
  'west virginia':'WV',wisconsin:'WI',wyoming:'WY','district of columbia':'DC',
  'washington dc':'DC','washington, d.c.':'DC',
};
const STATE_CODES = new Set(Object.values(STATES));

/** 城市 → 州。按 metro area 找工作比按州更贴近实际，这里同时给出 metro 归属 */
export const CITY_MAP = {
  'san francisco':['CA','bay_area'], 'sf':['CA','bay_area'], 'south san francisco':['CA','bay_area'],
  'palo alto':['CA','bay_area'], 'mountain view':['CA','bay_area'], 'menlo park':['CA','bay_area'],
  'sunnyvale':['CA','bay_area'], 'san jose':['CA','bay_area'], 'santa clara':['CA','bay_area'],
  'oakland':['CA','bay_area'], 'redwood city':['CA','bay_area'], 'cupertino':['CA','bay_area'],
  'bay area':['CA','bay_area'], 'silicon valley':['CA','bay_area'],
  'los angeles':['CA','socal'], 'santa monica':['CA','socal'], 'irvine':['CA','socal'],
  'san diego':['CA','socal'], 'pasadena':['CA','socal'], 'culver city':['CA','socal'],
  'new york':['NY','nyc'], 'new york city':['NY','nyc'], 'nyc':['NY','nyc'],
  'brooklyn':['NY','nyc'], 'manhattan':['NY','nyc'], 'jersey city':['NJ','nyc'],
  'seattle':['WA','seattle'], 'bellevue':['WA','seattle'], 'redmond':['WA','seattle'],
  'kirkland':['WA','seattle'],
  'austin':['TX','austin'], 'dallas':['TX','dallas'], 'houston':['TX','houston'],
  'plano':['TX','dallas'], 'irving':['TX','dallas'],
  'boston':['MA','boston'], 'cambridge':['MA','boston'], 'somerville':['MA','boston'],
  'waltham':['MA','boston'], 'burlington':['MA','boston'],
  'chicago':['IL','chicago'], 'evanston':['IL','chicago'],
  'denver':['CO','denver'], 'boulder':['CO','denver'],
  'atlanta':['GA','atlanta'], 'miami':['FL','miami'], 'tampa':['FL','tampa'],
  'phoenix':['AZ','phoenix'], 'tempe':['AZ','phoenix'], 'scottsdale':['AZ','phoenix'],
  'portland':['OR','portland'], 'salt lake city':['UT','slc'], 'lehi':['UT','slc'],
  'nashville':['TN','nashville'], 'raleigh':['NC','rtp'], 'durham':['NC','rtp'],
  'charlotte':['NC','charlotte'], 'pittsburgh':['PA','pittsburgh'],
  'philadelphia':['PA','philly'], 'minneapolis':['MN','msp'], 'detroit':['MI','detroit'],
  'ann arbor':['MI','detroit'], 'columbus':['OH','columbus'], 'madison':['WI','madison'],
  'arlington':['VA','dc'], 'mclean':['VA','dc'], 'reston':['VA','dc'],
  'bethesda':['MD','dc'], 'washington':['DC','dc'], 'alexandria':['VA','dc'],
};

const NON_US = /\b(london|dublin|berlin|paris|amsterdam|munich|zurich|barcelona|madrid|lisbon|warsaw|prague|stockholm|toronto|vancouver|montreal|sydney|melbourne|singapore|tokyo|seoul|bangalore|bengaluru|hyderabad|pune|mumbai|delhi|shanghai|beijing|shenzhen|hong kong|taipei|tel aviv|s[aã]o paulo|mexico city|bogot[aá]|buenos aires|dubai|cairo|lagos|nairobi|manila|jakarta|bangkok|ho chi minh|kuala lumpur|auckland|wellington|copenhagen|oslo|helsinki|vienna|brussels|milan|rome|athens|istanbul|bucharest|budapest|sofia|belgrade|zagreb|tallinn|riga|vilnius|edinburgh|manchester|birmingham|glasgow|cambridge, uk|remote - (emea|apac|europe|uk|india|canada|latam)|united kingdom|germany|france|netherlands|spain|italy|poland|india|china|japan|korea|brazil|mexico|canada|australia|israel|ireland|sweden|switzerland|denmark|norway|finland|portugal|austria|belgium|czech|romania|singapore)\b/i;

const REMOTE_RE = /\b(remote|distributed|work from home|wfh|anywhere|virtual)\b/i;

export function normalizeLocation(raw = '') {
  const s = String(raw).trim();
  const lower = s.toLowerCase();
  const out = { raw: s, states: [], cities: [], metros: [], isRemote: false, isUS: false, isMulti: false };
  if (!s) return out;

  out.isRemote = REMOTE_RE.test(lower);
  out.isMulti = /multiple|various|several/i.test(lower) || (s.match(/[;|]/g) || []).length >= 1;

  // 按分隔符切成片段（";" "|" " or " " and " 都可能出现）
  const parts = s.split(/[;|]|\bor\b|\band\b|\/(?![^(]*\))/i).map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    const p = part.toLowerCase();

    // "City, ST" 或 "City, State"
    const m = part.match(/([A-Za-z .'-]+?)\s*,\s*([A-Za-z .]{2,})/);
    if (m) {
      const city = m[1].trim().toLowerCase();
      let st = m[2].trim();
      const code = STATE_CODES.has(st.toUpperCase()) ? st.toUpperCase() : STATES[st.toLowerCase()];
      if (code) {
        out.states.push(code);
        out.cities.push(m[1].trim());
        if (CITY_MAP[city]) out.metros.push(CITY_MAP[city][1]);
        out.isUS = true;
        continue;
      }
    }

    // 裸城市名
    for (const [city, [st, metro]] of Object.entries(CITY_MAP)) {
      if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(p)) {
        out.states.push(st); out.metros.push(metro);
        out.cities.push(city.replace(/\b\w/g, (c) => c.toUpperCase()));
        out.isUS = true;
        break;
      }
    }

    // 裸州名 / 州代码
    for (const [name, code] of Object.entries(STATES)) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(p)) { out.states.push(code); out.isUS = true; }
    }
    const codeMatch = part.match(/\b([A-Z]{2})\b/);
    if (codeMatch && STATE_CODES.has(codeMatch[1])) { out.states.push(codeMatch[1]); out.isUS = true; }
  }

  if (/\b(usa|u\.s\.|united states|us only|us-based|americas|nationwide)\b/i.test(lower)) out.isUS = true;
  if (out.isRemote && !out.isUS && !NON_US.test(lower)) out.isUS = true; // 裸 "Remote" 默认按美国算，人工再筛
  if (NON_US.test(lower) && out.states.length === 0) out.isUS = false;

  out.states = [...new Set(out.states)];
  out.metros = [...new Set(out.metros)];
  out.cities = [...new Set(out.cities)];
  return out;
}

/**
 * 级别识别 —— 独立于岗位家族。
 *
 * 这是面向多用户的关键设计：级别是【用户维度】的偏好，不是岗位家族的属性。
 * 同一个 data_analyst 家族，应届生要 entry，工作五年的要 senior。
 * 所以这里只负责给每个岗位打上级别标签，按用户偏好过滤放在下游。
 *
 * 返回：intern | entry | mid | senior | staff | manager | director | exec | unknown
 */
export function detectSeniority(title) {
  const t = String(title).toLowerCase();

  if (/\b(intern|internship|co-?op|apprentice|trainee|summer analyst)\b/.test(t)) return 'intern';
  if (/\b(chief|cto|ceo|cfo|coo|cpo|ciso|head of|svp|evp|vice president|\bvp\b)\b/.test(t)) return 'exec';
  if (/\b(director|group manager|senior manager)\b/.test(t)) return 'director';
  if (/\b(manager|mgr|team lead|engineering lead|people lead)\b/.test(t)
      && !/\b(product manager|program manager|project manager|account manager|marketing manager|community manager|content manager|social media manager|category manager|partner manager|success manager)\b/.test(t)) return 'manager';
  if (/\b(staff|principal|distinguished|fellow|architect|lead\b)\b/.test(t)) return 'staff';
  if (/\b(senior|sr\.?|snr)\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|associate|entry.?level|new ?grad|graduate|university|campus|early career|i{1,2}\b|\b1\b)\b/.test(t)) return 'entry';
  if (/\b(iii|iv|v)\b/.test(t)) return 'senior';

  return 'mid'; // 无修饰的裸标题（"Data Analyst"）默认按 mid 处理，entry 和 mid 通常都能投
}

/** 用户偏好级别 → 可接受的岗位级别集合（相邻一档也放进来，避免漏投） */
export const SENIORITY_TOLERANCE = {
  intern: ['intern'],
  entry: ['entry', 'mid', 'unknown'],
  mid: ['entry', 'mid', 'senior', 'unknown'],
  senior: ['mid', 'senior', 'staff', 'unknown'],
  staff: ['senior', 'staff', 'director', 'unknown'],
  manager: ['manager', 'director', 'staff'],
  director: ['manager', 'director', 'exec'],
};

/**
 * Job Family 匹配 —— 模块一和模块二的接口。
 * 用 include / exclude 标题词表，而不是自由文本搜索。
 * 不做级别过滤（级别交给 detectSeniority + 用户偏好）。
 */
export function matchFamilies(title, families) {
  const t = String(title).toLowerCase();
  const hits = [];
  for (const fam of families) {
    if ((fam.exclude_titles || []).some((x) => x && t.includes(x.toLowerCase()))) continue;
    if ((fam.include_titles || []).some((x) => x && t.includes(x.toLowerCase()))) hits.push(fam.key);
  }
  return hits;
}

/** 按用户偏好过滤岗位（模块一勾选的家族 + 级别 + 地点） */
export function matchesUserPrefs(job, prefs = {}) {
  const { families = [], seniority = 'mid', states = [], remoteOk = true, usOnly = true } = prefs;
  if (families.length && !job.families?.some((f) => families.includes(f))) return false;
  const allowed = SENIORITY_TOLERANCE[seniority] || ['mid'];
  if (!allowed.includes(job.seniority)) return false;
  if (usOnly && !job.location?.isUS) return false;
  if (states.length) {
    const locOk = job.location?.states?.some((s) => states.includes(s)) || (remoteOk && job.location?.isRemote);
    if (!locOk) return false;
  }
  if (!remoteOk && job.location?.isRemote && !job.location?.states?.length) return false;
  return true;
}

/** 跨源去重键：同一岗位可能在多个源出现 */
export function dedupeKey(job) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const loc = normalizeLocation(job.locationRaw);
  const locKey = loc.isRemote ? 'remote' : (loc.states.sort().join('-') || norm(job.locationRaw).slice(0, 20));
  return `${norm(job.company)}::${norm(job.title)}::${locKey}`;
}

/** 稳定 ID：同一岗位在多次抓取之间必须得到相同的 id */
export function stableId(job) {
  return `${job.ats}:${String(job.company).toLowerCase()}:${job.externalId}`;
}
