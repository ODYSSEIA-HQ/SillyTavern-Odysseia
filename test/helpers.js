// 测试用的假酒馆：只提供插件会调用的 getContext 字段和 /api/* 接口
import { vi } from 'vitest';
import { readCardFromPng } from '../src/card.js';

/**
 * @param {{characters?: any[], withPresetManager?: boolean, worldNames?: string[]}} [options]
 */
export function createFakeTavern(options = {}) {
  const characters = options.characters ?? [];
  const worlds = new Map((options.worldNames ?? []).map((n) => [n, { entries: {} }]));
  const presets = new Map();
  const calls = [];
  const listeners = new Map();

  const presetManager = (apiId) => ({
    savePreset: vi.fn(async (name, data) => {
      presets.set(`${apiId}/${name}`, data);
    }),
    getAllPresets: () => [...presets.keys()].filter((k) => k.startsWith(`${apiId}/`)).map((k) => k.slice(apiId.length + 1)),
  });

  const context = {
    characters,
    extensionSettings: {},
    saveSettingsDebounced: vi.fn(),
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }),
    getCharacters: vi.fn(async () => {}),
    eventSource: { on: (name, fn) => listeners.set(name, fn) },
    event_types: { APP_READY: 'app_ready' },
    POPUP_TYPE: { CONFIRM: 2 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    callGenericPopup: vi.fn(async () => 1),
  };
  if (options.withPresetManager) context.getPresetManager = vi.fn(presetManager);

  async function readFormFile(form) {
    const file = form.get('avatar');
    return { file, bytes: new Uint8Array(await file.arrayBuffer()) };
  }

  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/characters/import') {
      const { file, bytes } = await readFormFile(init.body);
      const type = init.body.get('file_type');
      const card = type === 'png' ? readCardFromPng(bytes) : JSON.parse(new TextDecoder().decode(bytes));
      const preserved = init.body.get('preserved_name');
      const fileName = preserved || card.data?.name || file.name.replace(/\.\w+$/, '');
      const avatar = `${fileName}.png`;
      const existing = characters.find((c) => c.avatar === avatar);
      if (existing) Object.assign(existing, { name: card.data.name, data: card.data });
      else characters.push({ name: card.data.name, avatar, data: card.data });
      return Response.json({ file_name: fileName });
    }
    if (url === '/api/worldinfo/import') {
      const { file, bytes } = await readFormFile(init.body);
      const name = file.name.replace(/\.json$/, '');
      worlds.set(name, JSON.parse(new TextDecoder().decode(bytes)));
      return Response.json({ name });
    }
    if (url === '/api/settings/get') {
      return Response.json({ settings: '{}', world_names: [...worlds.keys()] });
    }
    if (url === '/api/presets/save') {
      const body = JSON.parse(init.body);
      presets.set(`${body.apiId}/${body.name}`, body.preset);
      return Response.json({ name: body.name });
    }
    return new Response('not found', { status: 404 });
  });

  return {
    context,
    characters,
    worlds,
    presets,
    calls,
    fetchImpl,
    fireAppReady: () => listeners.get('app_ready')?.(),
    getContext: () => context,
  };
}

/** 假平台 API：文件按 id 给字节 */
export function createFakeApi(files = {}) {
  return {
    downloadFile: vi.fn(async (id) => {
      if (!(id in files)) throw new Error(`没有文件 ${id}`);
      const value = files[id];
      return { bytes: ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new TextEncoder().encode(JSON.stringify(value)), name: null, mime: null };
    }),
    me: vi.fn(),
    work: vi.fn(),
    checkUpdates: vi.fn(async () => []),
  };
}
