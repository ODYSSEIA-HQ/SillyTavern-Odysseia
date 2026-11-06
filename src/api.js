// 平台插件接口客户端。
// 只认 Bearer 令牌，不带 Cookie（credentials: 'omit'）。不依赖酒馆。

export const UPDATE_CHECK_BATCH = 500;

export class PluginApiError extends Error {
  /**
   * @param {string} code unauthorized | restricted | forbidden | not_found | rate_limited | server | network | timeout | bad_response | not_configured | integrity
   * @param {string} message 给用户看的中文说明
   * @param {{status?: number, reason?: string, serverMessage?: string}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PluginApiError';
    this.code = code;
    this.status = extra.status ?? null;
    this.reason = extra.reason ?? null;
    this.serverMessage = extra.serverMessage ?? null;
  }
}

/** 受限原因 → 说明（平台 403 restricted 的 details.reason） */
const RESTRICTED_REASONS = {
  age_unverified: '这是 R18/受限作品，你的账号还没通过年龄确认。请先在平台网页上完成确认，再回来导入。',
  r18_disabled: '这是 R18/受限作品，你的账号没有开启 R18 内容。请在平台网页的设置里开启后再试。',
  banned: '你的账号当前被限制访问此类内容，详情请在平台网页查看通知。',
  visibility: '作者把这个作品设成了受限可见，你的账号暂时没有查看权限。',
};
const RESTRICTED_DEFAULT =
  '这是 R18/受限作品，你的账号目前不能查看（可能是还没通过年龄确认、未开启 R18 或作品受限可见）。请在平台网页上确认账号状态后再试。';

function errorFromResponse(status, body) {
  const code = body?.error?.code;
  const serverMessage = body?.error?.message ?? null;
  const reason = body?.error?.details?.reason ?? null;
  const extra = { status, reason, serverMessage };
  if (status === 401) {
    return new PluginApiError('unauthorized', '令牌无效或已被撤销，请到平台设置里重新创建令牌后再登录。', extra);
  }
  if (status === 403 && (code === 'restricted' || code === 'restricted_access_required')) {
    return new PluginApiError('restricted', RESTRICTED_REASONS[reason] ?? RESTRICTED_DEFAULT, extra);
  }
  if (status === 403) {
    return new PluginApiError('forbidden', serverMessage || '没有权限执行这个操作。', extra);
  }
  if (status === 404) {
    return new PluginApiError('not_found', '没找到这个作品：可能已被删除，或者链接有误。', extra);
  }
  if (status === 429) {
    return new PluginApiError('rate_limited', '请求太频繁，请稍后再试。', extra);
  }
  if (status >= 500) {
    return new PluginApiError('server', '平台服务器出错了，请稍后再试。', extra);
  }
  return new PluginApiError('bad_response', serverMessage || `请求失败（${status}）`, extra);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 从 Content-Disposition 取文件名（支持 filename*=UTF-8''） */
export function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* 落到普通 filename */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/** 十六进制 sha256；没有 WebCrypto 时返回 null（跳过校验） */
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {{apiRoot: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function createPluginApi({ apiRoot, token, fetchImpl, timeoutMs = 30000 }) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const base = `${String(apiRoot).replace(/\/+$/, '')}/plugin/v1`;

  async function send(method, path, { body, raw = false } = {}) {
    if (!apiRoot || !token) throw new PluginApiError('not_configured', '还没有登录平台账号。');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: raw ? '*/*' : 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        mode: 'cors',
        signal: controller?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new PluginApiError('timeout', '连接平台超时，请检查网络后重试。');
      throw new PluginApiError('network', '连不上平台：请检查平台地址是否正确、网络是否可用。');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!response.ok) throw errorFromResponse(response.status, await readJson(response));
    if (raw) return response;
    if (response.status === 204) return null;
    const data = await readJson(response);
    if (data === null) throw new PluginApiError('bad_response', '平台返回的数据看不懂，可能是平台地址填错了。');
    return data;
  }

  return {
    /** @returns {Promise<{user:{id:string,name:string,avatar?:string}, canViewR18:boolean}>} */
    me: () => send('GET', '/me'),

    /** @returns {Promise<{work, latestVersion, files}>} */
    work: (workId) => send('GET', `/works/${encodeURIComponent(workId)}`),

    /**
     * 批量查更新，超过 500 条自动分批。只返回有新版的。
     * @param {{workId:string, versionId:string}[]} items
     */
    async checkUpdates(items) {
      const results = [];
      for (let i = 0; i < items.length; i += UPDATE_CHECK_BATCH) {
        const batch = items.slice(i, i + UPDATE_CHECK_BATCH);
        const data = await send('POST', '/updates/check', { body: { items: batch } });
        if (Array.isArray(data)) results.push(...data);
      }
      return results;
    },

    /**
     * 下载文件。给了 expected（PluginFile）时校验大小与 sha256。
     * @returns {Promise<{bytes: Uint8Array, name: string|null, mime: string|null}>}
     */
    async downloadFile(fileId, expected) {
      const response = await send('GET', `/files/${encodeURIComponent(fileId)}`, { raw: true });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (expected?.size != null && expected.size !== bytes.length) {
        throw new PluginApiError('integrity', '下载的文件不完整（大小不对），请重试。');
      }
      if (expected?.sha256) {
        const actual = await sha256Hex(bytes);
        if (actual && actual !== String(expected.sha256).toLowerCase()) {
          throw new PluginApiError('integrity', '下载的文件校验失败（sha256 不一致），请重试。');
        }
      }
      return {
        bytes,
        name: filenameFromDisposition(response.headers.get('Content-Disposition')) ?? expected?.name ?? null,
        mime: response.headers.get('Content-Type') ?? expected?.mime ?? null,
      };
    },
  };
}

/** 任意错误 → 给用户看的一句话 */
export function describeError(err) {
  if (err instanceof PluginApiError) return err.message;
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return '出了点问题，请稍后再试。';
}
