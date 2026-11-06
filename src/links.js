// 平台地址规范化、作品链接解析。纯逻辑。

/** 默认平台地址：留空，由用户在设置里填写 */
export const DEFAULT_SITE_URL = '';
/** 平台接口前缀（协议 1.1：前端和接口同源，接口在 /api/v1 下） */
export const API_PREFIX = '/api/v1';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 用户填的平台地址 → { siteUrl, apiRoot }。
 * 支持填站点首页（https://x.com）或接口根（https://x.com/api/v1）；本机开发允许 http。
 * 不合法返回 null。
 */
export function normalizeSiteUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith(API_PREFIX)) path = path.slice(0, -API_PREFIX.length);
  const siteUrl = `${url.origin}${path}`;
  return { siteUrl, apiRoot: `${siteUrl}${API_PREFIX}` };
}

/** 是否是不加密的远程地址（http 且不是本机），界面上提醒令牌会明文传输 */
export function isInsecureRemote(siteUrl) {
  try {
    const url = new URL(siteUrl);
    if (url.protocol !== 'http:') return false;
    return !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 从用户粘贴的内容里取作品 id：
 * - 完整链接 https://站点/works/<id>（后面可带 /版本、?query、#hash）
 * - 分享链接 /share/works/<id>
 * - 站内路径 /works/<id>
 * - 直接粘贴 id
 * 取不到返回 null。
 */
export function parseWorkRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (ID_PATTERN.test(raw) && raw !== 'works') return raw;
  let path;
  if (/^[a-z]+:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname;
    } catch {
      return null;
    }
  } else {
    path = raw.split(/[?#]/)[0];
  }
  const segments = path.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const index = segments.indexOf('works');
  if (index < 0) return null;
  const id = segments[index + 1];
  return id && ID_PATTERN.test(id) ? id : null;
}

/** 一次最多导入多少个作品（粘贴和网址参数共用） */
export const MAX_BATCH = 50;

/**
 * 批量解析：用户一次粘贴的很多链接/编号（换行、空格、逗号、顿号分隔）。
 * 每段用 parseWorkRef 解析，去重保持顺序；解析不了的原样列出来。
 * @returns {{ids: string[], invalid: string[]}}
 */
export function parseWorkRefs(input) {
  const ids = [];
  const invalid = [];
  const seen = new Set();
  for (const token of String(input ?? '').split(/[\s,，、;；]+/)) {
    if (!token) continue;
    const id = parseWorkRef(token);
    if (!id) {
      if (!invalid.includes(token)) invalid.push(token);
    } else if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids, invalid };
}

/**
 * 网址参数 odysseia_import 的值（逗号分隔的作品编号）→ 作品编号列表。
 * 只认纯编号（不认链接），去重，最多 MAX_BATCH 个。
 */
export function parseImportParam(value) {
  const ids = [];
  for (const part of String(value ?? '').split(',')) {
    const id = part.trim();
    if (ID_PATTERN.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_BATCH);
}
