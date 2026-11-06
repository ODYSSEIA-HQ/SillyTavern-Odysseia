// API 客户端：用假的 fetch 验证请求形状、错误映射、分批、下载校验
import { describe, expect, it, vi } from 'vitest';
import { createPluginApi, describeError, filenameFromDisposition, PluginApiError, sha256Hex } from '../src/api.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function setup(handler) {
  const fetchImpl = vi.fn(async (url, init) => handler(url, init));
  const api = createPluginApi({ apiRoot: 'https://p.example/api/v1/', token: 'odp_x', fetchImpl });
  return { api, fetchImpl };
}

describe('请求形状', () => {
  it('带 Bearer、不带 Cookie、地址拼对', async () => {
    const { api, fetchImpl } = setup(() => jsonResponse(200, { user: { id: 'u', name: 'n' }, canViewR18: false }));
    await api.me();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://p.example/api/v1/plugin/v1/me');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer odp_x');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
  });

  it('作品详情：编号做 URL 编码', async () => {
    const { api, fetchImpl } = setup(() => jsonResponse(200, { work: { id: 'w 1' }, latestVersion: {}, files: [] }));
    await api.work('w 1');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://p.example/api/v1/plugin/v1/works/w%201');
  });

  it('不再有收件箱接口', () => {
    const { api } = setup(() => jsonResponse(200, {}));
    expect(api.inbox).toBeUndefined();
    expect(api.ack).toBeUndefined();
  });

  it('检查更新按 500 条分批并合并结果', async () => {
    const { api, fetchImpl } = setup((_url, init) => {
      const { items } = JSON.parse(init.body);
      return jsonResponse(200, items.slice(0, 1).map((i) => ({ workId: i.workId })));
    });
    const items = Array.from({ length: 1200 }, (_, i) => ({ workId: `w${i}`, versionId: 'v' }));
    const results = await api.checkUpdates(items);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).items).toHaveLength(200);
    expect(results.map((r) => r.workId)).toEqual(['w0', 'w500', 'w1000']);
  });

  it('没登录不发请求', async () => {
    const fetchImpl = vi.fn();
    const api = createPluginApi({ apiRoot: 'https://p.example/api/v1', token: '', fetchImpl });
    await expect(api.work('w')).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('错误映射', () => {
  it.each([
    [401, { error: { code: 'unauthenticated', message: 'x' } }, 'unauthorized', /令牌无效/],
    [403, { error: { code: 'restricted', message: 'x', details: { reason: 'age_unverified' } } }, 'restricted', /年龄确认/],
    [403, { error: { code: 'restricted', message: 'x' } }, 'restricted', /R18\/受限作品/],
    [403, { error: { code: 'restricted_access_required', message: 'x' } }, 'restricted', /R18/],
    [403, { error: { code: 'forbidden', message: '不行' } }, 'forbidden', /不行/],
    [404, null, 'not_found', /没找到这个作品/],
    [429, null, 'rate_limited', /频繁/],
    [502, null, 'server', /服务器出错/],
    [400, { error: { code: 'validation_failed', message: '参数不对' } }, 'bad_response', /参数不对/],
  ])('%i %j → %s', async (status, body, code, text) => {
    const { api } = setup(() => (body ? jsonResponse(status, body) : new Response('oops', { status })));
    const err = await api.work('w').catch((e) => e);
    expect(err).toBeInstanceOf(PluginApiError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(describeError(err)).toMatch(text);
  });

  it('受限原因写进 reason', async () => {
    const { api } = setup(() => jsonResponse(403, { error: { code: 'restricted', message: '', details: { reason: 'banned' } } }));
    await expect(api.work('w')).rejects.toMatchObject({ reason: 'banned' });
  });

  it('网络错误 → network；超时 → timeout', async () => {
    const { api } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.me()).rejects.toMatchObject({ code: 'network' });

    const slow = createPluginApi({
      apiRoot: 'https://p.example/api/v1',
      token: 't',
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    });
    await expect(slow.me()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('返回的不是 JSON（地址填错，拿到网页）→ bad_response', async () => {
    const { api } = setup(() => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(api.me()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('describeError 兜底', () => {
    expect(describeError(new Error('具体原因'))).toBe('具体原因');
    expect(describeError(null)).toMatch(/出了点问题/);
  });
});

describe('下载', () => {
  const bytes = new TextEncoder().encode('{"entries":{}}');

  it('取文件名、校验大小和 sha256', async () => {
    const sha = await sha256Hex(bytes);
    const { api } = setup(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Disposition': "attachment; filename*=UTF-8''%E6%B8%AF.json" },
        }),
    );
    const out = await api.downloadFile('f1', { size: bytes.length, sha256: sha.toUpperCase() });
    expect(out.name).toBe('港.json');
    expect(out.mime).toBe('application/json');
    expect(new TextDecoder().decode(out.bytes)).toBe('{"entries":{}}');
  });

  it('大小不对 → integrity', async () => {
    const { api } = setup(() => new Response(bytes, { status: 200 }));
    await expect(api.downloadFile('f1', { size: 1 })).rejects.toMatchObject({ code: 'integrity' });
  });

  it('Content-Disposition 解析', () => {
    expect(filenameFromDisposition('attachment; filename="a b.png"')).toBe('a b.png');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%E8%8E%89.png; filename=\"x.png\"")).toBe('莉.png');
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
