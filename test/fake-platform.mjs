// 测试用的假平台，只给单元测试用。

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

// ---------------- 最小 PNG + chara tEXt ----------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 纯色 PNG（RGB），可带角色卡 JSON（写进 chara tEXt 块，base64） */
export function makeCardPng(card, { size = 64, color = [200, 120, 160] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set(color, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
  ];
  if (card) {
    const text = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
    parts.push(chunk('tEXt', Buffer.from(`chara\0${text}`, 'latin1')));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function lilyCard(version) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '莉莉',
      description: `港口城的花店店员（${version}）。`,
      personality: '温柔、好奇',
      scenario: '雨天的花店',
      first_mes: version === 'v2' ? '（v2）欢迎光临！今天想看看什么花？' : '欢迎光临！',
      mes_example: '',
      creator_notes: 'Odysseia 假服务器示例卡',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['示例'],
      creator: 'odysseia-mock',
      character_version: version,
      extensions: {},
    },
  };
}

function harborBook(version) {
  return {
    entries: {
      0: {
        uid: 0,
        key: ['港口城'],
        keysecondary: [],
        comment: '港口城',
        content: `港口城是一座雾气很重的海港城市（${version}）。`,
        constant: false,
        selective: true,
        order: 100,
        position: 0,
        disable: false,
      },
    },
  };
}

const storyPreset = {
  temperature: 0.9,
  openai_max_context: 16384,
  openai_max_tokens: 600,
  prompts: [{ identifier: 'main', name: 'Main Prompt', role: 'system', content: '你是一位细腻的叙事者。' }],
  prompt_order: [],
};

const duskTheme = { name: '黄昏', blur_strength: 10, main_text_color: 'rgba(220, 220, 210, 1)' };

// ---------------- 假数据 ----------------

function fileEntry(id, name, kind, mime, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(JSON.stringify(content, null, 2), 'utf8');
  return {
    meta: { id, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind, mime },
    bytes,
  };
}

function buildData() {
  const files = new Map();
  const add = (entry) => {
    files.set(entry.meta.id, entry);
    return entry.meta;
  };
  const lily1 = add(fileEntry('f_lily_v1', '莉莉.png', 'character', 'image/png', makeCardPng(lilyCard('v1'))));
  const lily2 = add(fileEntry('f_lily_v2', '莉莉.png', 'character', 'image/png', makeCardPng(lilyCard('v2'), { color: [120, 160, 220] })));
  const harbor1 = add(fileEntry('f_harbor_v1', '港口城.json', 'worldbook', 'application/json', harborBook('v1')));
  const harbor2 = add(fileEntry('f_harbor_v2', '港口城.json', 'worldbook', 'application/json', harborBook('v2')));
  const preset = add(fileEntry('f_story_preset', '叙事预设.json', 'preset', 'application/json', storyPreset));
  const theme = add(fileEntry('f_dusk_theme', '黄昏.json', 'theme', 'application/json', duskTheme));
  const secret = add(fileEntry('f_secret', '夜之卡.png', 'character', 'image/png', makeCardPng({ ...lilyCard('v1'), data: { ...lilyCard('v1').data, name: '夜' } })));

  const version = (id, name, publishedAt, changelog = '', channel = 'stable') => ({ id, name, channel, publishedAt, changelog });
  const works = new Map([
    ['w_lily', {
      work: { id: 'w_lily', title: '花店店员莉莉', type: 'character', cover: null, restricted: false },
      versions: [
        { ...version('v_lily_1', 'v1.0', '2026-10-01T10:00:00Z'), files: [lily1] },
        { ...version('v_lily_2', 'v1.1', '2026-10-28T10:00:00Z', '新增雨天开场白；修正性格描述。'), files: [lily2] },
      ],
    }],
    ['w_harbor', {
      work: { id: 'w_harbor', title: '港口城世界书', type: 'worldbook', cover: null, restricted: false },
      versions: [
        { ...version('v_harbor_1', '初版', '2026-09-20T10:00:00Z'), files: [harbor1] },
        { ...version('v_harbor_2', '第二版', '2026-10-30T10:00:00Z', '补充港口城的地理条目。'), files: [harbor2] },
      ],
    }],
    ['w_preset', {
      work: { id: 'w_preset', title: '细腻叙事预设', type: 'preset', cover: null, restricted: false },
      versions: [{ ...version('v_preset_1', '1.0', '2026-10-10T10:00:00Z'), files: [preset] }],
    }],
    ['w_theme', {
      work: { id: 'w_theme', title: '黄昏主题', type: 'theme', cover: null, restricted: false },
      versions: [{ ...version('v_theme_1', '1.0', '2026-10-12T10:00:00Z'), files: [theme] }],
    }],
    ['w_secret', {
      work: { id: 'w_secret', title: '夜之卡（R18）', type: 'character', cover: null, restricted: true },
      versions: [{ ...version('v_secret_1', '1.0', '2026-10-15T10:00:00Z'), files: [secret] }],
    }],
  ]);
  const fileToWork = new Map();
  for (const [workId, w] of works) for (const v of w.versions) for (const f of v.files) fileToWork.set(f.id, workId);

  const users = new Map([
    ['odp_dev_alice', { user: { id: 'u_alice', name: '爱丽丝', avatar: null }, canViewR18: false }],
    ['odp_dev_bob', { user: { id: 'u_bob', name: '鲍勃', avatar: null }, canViewR18: true }],
  ]);

  return { files, works, fileToWork, users };
}

// ---------------- HTTP ----------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
  'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
  'Access-Control-Max-Age': '600',
};

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, { ...CORS, ...headers });
    return res.end();
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

const fail = (res, status, code, message, details) =>
  send(res, status, { error: { code, message, ...(details ? { details } : {}) } });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function latestOf(w) {
  return w.versions[w.versions.length - 1];
}

function publicVersion(v) {
  const { files: _f, ...rest } = v;
  return rest;
}

/** @param {{latencyMs?: number}} [options] */
export function createMockServer(options = {}) {
  const data = buildData();

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname.replace(/^\/api\/v1(?=\/plugin\/)/, '');
    if (!path.startsWith('/plugin/v1/')) return fail(res, 404, 'not_found', '没有这个接口');
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));

    // 只认 Bearer，不认 Cookie
    const auth = req.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    const account = token ? data.users.get(token) : null;
    if (!account) return fail(res, 401, 'unauthenticated', '令牌无效或已撤销');

    const route = path.slice('/plugin/v1'.length);
    const guard = (w) => {
      if (w.work.restricted && !account.canViewR18) {
        fail(res, 403, 'restricted', '受限作品', { reason: 'r18_disabled' });
        return false;
      }
      return true;
    };
    let m;

    if (req.method === 'GET' && route === '/me') return send(res, 200, account);

    if (req.method === 'GET' && (m = /^\/works\/([^/]+)$/.exec(route))) {
      const w = data.works.get(decodeURIComponent(m[1]));
      if (!w) return fail(res, 404, 'not_found', '作品不存在');
      if (!guard(w)) return undefined;
      const latest = latestOf(w);
      const { restricted: _r, ...work } = w.work;
      return send(res, 200, { work, latestVersion: publicVersion(latest), files: latest.files });
    }

    if (req.method === 'POST' && route === '/updates/check') {
      const body = await readBody(req);
      const items = body?.items;
      if (!Array.isArray(items) || items.length > 500) {
        return fail(res, 422, 'validation_failed', 'items 必须是不超过 500 条的数组');
      }
      const out = [];
      for (const item of items) {
        const w = data.works.get(item?.workId);
        if (!w || (w.work.restricted && !account.canViewR18)) continue;
        const latest = latestOf(w);
        if (latest.id === item.versionId) continue;
        out.push({ workId: w.work.id, currentVersionId: item.versionId, latest: publicVersion(latest), files: latest.files });
      }
      return send(res, 200, out);
    }

    if (req.method === 'GET' && (m = /^\/files\/([^/]+)$/.exec(route))) {
      const id = decodeURIComponent(m[1]);
      const entry = data.files.get(id);
      if (!entry) return fail(res, 404, 'not_found', '文件不存在');
      const w = data.works.get(data.fileToWork.get(id));
      if (!guard(w)) return undefined;
      res.writeHead(200, {
        ...CORS,
        'Content-Type': entry.meta.mime,
        'Content-Length': entry.bytes.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.meta.name)}`,
      });
      return res.end(entry.bytes);
    }

    return fail(res, 404, 'not_found', '没有这个接口');
  });

  return { server, data };
}

/** 起服务；port 传 0 用随机端口。返回 { url, close, data } */
export async function startMockServer({ port = 8787, host = '127.0.0.1', ...options } = {}) {
  const { server, data } = createMockServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    data,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  const { url } = await startMockServer({ port });
  console.log(`Odysseia 假平台已启动：${url}`);
  console.log('令牌：odp_dev_alice（未开 R18）/ odp_dev_bob（已开 R18）');
}
