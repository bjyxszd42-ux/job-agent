/**
 * 公司图标 —— 公司名 → favicon URL
 *
 * 岗位记录里【没有公司域名】：url 是 greenhouse / lever / ashby 的托管地址，
 * 拿它取 favicon 只会得到 ATS 自己的图标，所有公司长得一模一样。
 * 所以域名只能从公司名推。
 *
 * ── 关于隐私，这里要说清楚 ──
 * 走第三方 favicon 服务意味着：每渲染一次岗位列表，就等于告诉那个服务
 * 「这个人正在看这些公司」。对一个求职工具来说这是实打实的外泄 ——
 * 求职意向本身就是敏感信息，尤其是在职跳槽的人。
 * 这是明确权衡后选的：覆盖率换隐私。
 *
 * 换服务或者关掉都只需要改下面 PROVIDER 一个常量：
 *   'google'   覆盖率最高
 *   'duckduckgo'  同样是第三方，但 DDG 不做广告画像
 *   'off'      完全不联网，退回字母块
 *
 * 以后做成用户可选项时，默认值应该是 off —— 让用户自己开，
 * 而不是替他决定把浏览记录发出去。
 */

export const PROVIDER = 'google';

/**
 * 猜不对的公司放这里。
 *
 * 这张表和 companies.csv 一样，是【慢慢养】的资产：
 * 遇到一个显示成地球图标的就加一行，加过就永远对了。
 * 左边是小写去符号后的公司名，右边是真实域名。
 */
export const DOMAIN_OVERRIDES = {
  gehc: 'gehealthcare.com',
  gehealthcare: 'gehealthcare.com',
  mtb: 'mtb.com',
  mtbank: 'mtb.com',
  jpmorganchase: 'jpmorganchase.com',
  jpmorgan: 'jpmorganchase.com',
  bankofamerica: 'bankofamerica.com',
  alphabet: 'google.com',
  meta: 'meta.com',
  metaplatforms: 'meta.com',
  x: 'x.com',
  ibm: 'ibm.com',
  att: 'att.com',
  cvshealth: 'cvshealth.com',
  unitedhealthgroup: 'unitedhealthgroup.com',
  cignagroup: 'cigna.com',
  elevancehealth: 'elevancehealth.com',
  bristolmyerssquibb: 'bms.com',
  eelilly: 'lilly.com',
  elilly: 'lilly.com',
  lilly: 'lilly.com',
  johnsonjohnson: 'jnj.com',
  proctergamble: 'pg.com',
  goldmansachs: 'goldmansachs.com',
  morganstanley: 'morganstanley.com',
  charlesschwab: 'schwab.com',
  capitalone: 'capitalone.com',
  americanexpress: 'americanexpress.com',
  statestreet: 'statestreet.com',
  northropgrumman: 'northropgrumman.com',
  lockheedmartin: 'lockheedmartin.com',
  generaldynamics: 'gd.com',
  raytheon: 'rtx.com',
  rtx: 'rtx.com',
  thermofisherscientific: 'thermofisher.com',
  clickhouse: 'clickhouse.com',
  posthog: 'posthog.com',
  hpe: 'hpe.com',
  hp: 'hp.com',
  amd: 'amd.com',
  tsmc: 'tsmc.com',
  pwc: 'pwc.com',
  ey: 'ey.com',
  kpmg: 'kpmg.com',
  deloitte: 'deloitte.com',
  bcg: 'bcg.com',
  mckinseycompany: 'mckinsey.com',
  usbank: 'usbank.com',
  pnc: 'pnc.com',
  fifththirdbank: '53.com',
  nyu: 'nyu.edu',
};

// 公司名里的法人后缀。"DiamondUp Technology Co., Ltd" 的域名不会是
// diamonduptechnologycoltd.com，去掉这些之后猜中的概率高得多
const LEGAL_SUFFIX = /\b(?:inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|nv|bv|sa|srl|pte|pty|holdings?|group|technologies|technology|labs?|solutions|systems|international|worldwide|global|usa|us)\b/g;

/** 公司名 → 域名猜测。返回 null 表示猜不出来，界面应当退回字母块 */
export function domainFor(company) {
  const raw = String(company || '').trim();
  if (!raw) return null;

  // 已经是域名就直接用（有些 ATS 的 company 字段本来就填的域名）
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(raw)) return raw.toLowerCase();

  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (DOMAIN_OVERRIDES[key]) return DOMAIN_OVERRIDES[key];

  // 去掉法人后缀再压成一个词
  const stripped = raw.toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[^a-z0-9]/g, '');

  const base = stripped || key;
  // 太短的多半是缩写（ge、bp、mtb），猜 {缩写}.com 命中率很低，
  // 但也没有更好的办法 —— 至少不要在这里返回 null，
  // 让它去试一次，猜错了就是个地球图标，加进 OVERRIDES 就修好了
  if (base.length < 2 || base.length > 40) return null;
  return `${base}.com`;
}

/** 公司名 → favicon URL。PROVIDER 为 'off' 或域名猜不出来时返回 null */
export function logoUrl(company, size = 64) {
  if (PROVIDER === 'off') return null;
  const domain = domainFor(company);
  if (!domain) return null;
  return PROVIDER === 'duckduckgo'
    ? `https://icons.duckduckgo.com/ip3/${domain}.ico`
    : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

/** 首字母兜底 —— 图标加载失败时显示的那个字 */
export function initialFor(company) {
  return String(company || '?').trim().charAt(0).toUpperCase() || '?';
}
