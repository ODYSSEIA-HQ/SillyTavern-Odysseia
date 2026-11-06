// 酒馆（SillyTavern）适配层：插件和酒馆打交道的地方全部集中在这里。
//
// 【未实测】下面用到的酒馆接口都是按公开扩展接口的印象写的，没有在真实酒馆里跑过。
// 每处标了「实测」的地方，第一次在真酒馆里试的时候重点看：
//   - SillyTavern.getContext() 返回的字段名（extensionSettings / saveSettingsDebounced / getRequestHeaders /
//     characters / getCharacters / eventSource / event_types / callGenericPopup / POPUP_TYPE / POPUP_RESULT /
//     getPresetManager / updateWorldInfoList）
//   - POST /api/characters/import（FormData：avatar、file_type、preserved_name）及返回的 file_name
//   - POST /api/worldinfo/import（FormData：avatar）及返回的 name
//   - POST /api/presets/save（JSON：apiId、name、preset）
//   - POST /api/settings/get 返回的 world_names
//   - 扩展设置抽屉的容器 #extensions_settings2 / #extensions_settings 与 inline-drawer 样式
//   - callGenericPopup 的字符串内容按 HTML 显示（所以 confirm 里先转义再把换行换成 <br>）
//   - 网页「在酒馆中打开」：酒馆首页带 ?odysseia_import=… 时，参数在扩展加载时还在地址栏里
//
// 其余模块只通过 createTavernAdapter() 返回的对象访问酒馆，测试里换成假的 getContext/fetch 即可。

export const MODULE_NAME = 'odysseia';

/** 平台网页「在酒馆中打开」带的网址参数：逗号分隔的作品编号 */
export const IMPORT_PARAM = 'odysseia_import';

function escapeText(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export const DEFAULT_SETTINGS = Object.freeze({
  siteUrl: '',
  token: '',
  account: null,
  sources: { worldbook: {}, preset: {} },
  lastUpdateCheckAt: 0,
  /** 上次检查得到的更新（重载页面后徽标仍在） */
  pendingUpdates: [],
  /** workId → 用户点了「忽略此版本」的版本 id */
  dismissedUpdates: {},
  /** workId → 已经弹过 toastr 的版本 id */
  notifiedUpdates: {},
});

/**
 * 根据预设 JSON 的字段猜它是哪类预设（对应酒馆 PresetManager 的 apiId）。认不出返回 null。
 * 【实测】字段特征凭印象整理，如有新的预设格式需要补。
 */
export function detectPresetApi(preset) {
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return null;
  const has = (...keys) => keys.every((k) => k in preset);
  if (has('prompts') || has('prompt_order') || has('openai_max_context')) return 'openai';
  if (has('input_sequence', 'output_sequence')) return 'instruct';
  if (has('story_string')) return 'context';
  if (has('content') && Object.keys(preset).every((k) => ['name', 'content', 'post_history'].includes(k))) {
    return 'sysprompt';
  }
  if (has('temp') && (has('rep_pen') || has('top_p') || has('top_k'))) return 'textgenerationwebui';
  return null;
}

export const PRESET_API_LABELS = {
  openai: '对话补全预设',
  instruct: '指令模板',
  context: '上下文模板',
  sysprompt: '系统提示词',
  textgenerationwebui: '文本补全预设',
};

/** 去掉扩展名，得到酒馆里显示的名字 */
export function stripExtension(fileName) {
  return String(fileName ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

/** 在已有名字里找一个不冲突的名字：名字、名字 (Odysseia)、名字 (Odysseia 2)… */
export function uniqueName(base, existing) {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${base} (Odysseia)` : `${base} (Odysseia ${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

function withoutContentType(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() !== 'content-type') out[k] = v;
  }
  return out;
}

async function readResponse(response, what) {
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    const detail = typeof data?.error === 'string' ? `：${data.error}` : `（${response.status}）`;
    throw new Error(`酒馆拒绝了${what}${detail}`);
  }
  return data;
}

/**
 * @param {{
 *   getContext?: () => any,
 *   fetchImpl?: typeof fetch,
 *   toastr?: any,
 *   doc?: Document,
 *   confirmFallback?: (message: string) => boolean,
 *   win?: {location: {href: string}, history: History},
 * }} [deps]
 */
export function createTavernAdapter(deps = {}) {
  const getContext = deps.getContext ?? (() => globalThis.SillyTavern?.getContext?.());
  const doFetch = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const toast = () => deps.toastr ?? globalThis.toastr ?? null;
  const doc = () => deps.doc ?? globalThis.document;
  const win = () => deps.win ?? globalThis.window;

  function ctx() {
    const context = getContext();
    if (!context) throw new Error('没找到 SillyTavern.getContext()，插件只能在酒馆里运行。');
    return context;
  }

  /** 酒馆自己的接口要带 CSRF 头 —— 【实测】getContext().getRequestHeaders */
  function tavernHeaders() {
    const context = ctx();
    return typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
  }

  async function postForm(url, form, what) {
    const response = await doFetch(url, {
      method: 'POST',
      headers: withoutContentType(tavernHeaders()),
      body: form,
      cache: 'no-cache',
    });
    return readResponse(response, what);
  }

  async function postJson(url, body, what) {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { ...tavernHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readResponse(response, what);
  }

  const adapter = {
    // ---------- 设置 ----------

    /** 插件设置（存在酒馆的 extension_settings 里，随酒馆 settings.json 保存） */
    getSettings() {
      const context = ctx();
      const all = context.extensionSettings ?? (context.extensionSettings = {});
      const current = all[MODULE_NAME] ?? (all[MODULE_NAME] = {});
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (current[key] === undefined) current[key] = structuredClone(value);
      }
      if (!current.sources.worldbook) current.sources.worldbook = {};
      if (!current.sources.preset) current.sources.preset = {};
      return current;
    },

    saveSettings() {
      const context = ctx();
      if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    },

    // ---------- 角色 ----------

    /** 当前所有角色（酒馆 characters 数组） */
    listCharacters() {
      const list = ctx().characters;
      return Array.isArray(list) ? list : [];
    },

    /**
     * 导入角色卡。preservedName（已有角色的头像文件名）给了就覆盖那张卡（更新用），聊天记录跟着头像文件名，不受影响。
     * 【实测】/api/characters/import 的字段与返回值
     * @returns {Promise<{avatar: string}>}
     */
    async importCharacter({ bytes, fileName, fileType, preservedName }) {
      const mime = fileType === 'png' ? 'image/png' : 'application/json';
      const form = new FormData();
      form.append('avatar', new File([bytes], fileName, { type: mime }));
      form.append('file_type', fileType);
      if (preservedName) form.append('preserved_name', stripExtension(preservedName));
      const data = await postForm('/api/characters/import', form, '导入角色卡');
      const fileNameOut = data?.file_name ? `${stripExtension(data.file_name)}.png` : null;
      await adapter.refreshCharacters();
      return { avatar: fileNameOut ?? preservedName ?? fileName };
    },

    async refreshCharacters() {
      const context = ctx();
      // 【实测】getContext().getCharacters 重新拉列表并刷新界面
      if (typeof context.getCharacters === 'function') {
        try {
          await context.getCharacters();
          return true;
        } catch {
          return false;
        }
      }
      return false;
    },

    // ---------- 世界书 ----------

    /** 已有世界书名字；拿不到返回 null（此时不做重名检查）【实测】/api/settings/get 的 world_names */
    async listWorldNames() {
      try {
        const data = await postJson('/api/settings/get', {}, '读取设置');
        return Array.isArray(data?.world_names) ? data.world_names : null;
      } catch {
        return null;
      }
    },

    /**
     * 导入世界书（酒馆格式：顶层有 entries）。返回酒馆里的世界书名。
     * 【实测】/api/worldinfo/import 的字段与返回值
     */
    async importWorldInfo({ name, data }) {
      const form = new FormData();
      form.append('avatar', new File([JSON.stringify(data)], `${name}.json`, { type: 'application/json' }));
      const result = await postForm('/api/worldinfo/import', form, '导入世界书');
      const context = ctx();
      // 【实测】刷新世界书下拉列表
      if (typeof context.updateWorldInfoList === 'function') {
        try {
          await context.updateWorldInfoList();
        } catch {
          /* 刷新失败不影响导入结果 */
        }
      }
      return { name: result?.name ?? name };
    },

    // ---------- 预设 ----------

    /** 某类预设已有的名字；拿不到返回 null【实测】PresetManager.getAllPresets() */
    listPresetNames(apiId) {
      try {
        const context = ctx();
        const manager = typeof context.getPresetManager === 'function' ? context.getPresetManager(apiId) : null;
        const names = manager?.getAllPresets?.();
        return Array.isArray(names) ? names.map(String) : null;
      } catch {
        return null;
      }
    },

    /**
     * 保存预设。优先用 PresetManager（会刷新下拉框），没有就直接调接口（刷新页面后可见）。
     * 【实测】getContext().getPresetManager(apiId).savePreset(name, settings) 与 /api/presets/save
     */
    async importPreset({ apiId, name, data }) {
      const context = ctx();
      const manager = typeof context.getPresetManager === 'function' ? context.getPresetManager(apiId) : null;
      if (manager && typeof manager.savePreset === 'function') {
        await manager.savePreset(name, data);
        return { name, refreshed: true };
      }
      await postJson('/api/presets/save', { apiId, name, preset: data }, '保存预设');
      return { name, refreshed: false };
    },

    // ---------- 界面 ----------

    notify(level, message, title) {
      const t = toast();
      if (t && typeof t[level] === 'function') {
        t[level](message, title ?? 'Odysseia', { timeOut: level === 'error' ? 8000 : 4000 });
      } else if (level === 'error' || level === 'warning') {
        console.warn(`[Odysseia] ${message}`);
      }
    },

    /**
     * 确认框：【实测】getContext().callGenericPopup + POPUP_TYPE.CONFIRM，拿不到用浏览器 confirm。
     * message 是纯文本（可能含作品标题等平台数据），交给酒馆前先转义，换行变 <br>。
     */
    async confirm(message) {
      const context = getContext();
      if (context && typeof context.callGenericPopup === 'function' && context.POPUP_TYPE) {
        const html = escapeText(message).replace(/\n/g, '<br>');
        const result = await context.callGenericPopup(html, context.POPUP_TYPE.CONFIRM);
        const yes = context.POPUP_RESULT?.AFFIRMATIVE ?? 1;
        return result === yes || result === true;
      }
      const fallback = deps.confirmFallback ?? ((m) => globalThis.confirm?.(m) ?? false);
      return fallback(message);
    },

    /** 设置抽屉的容器：【实测】第三方扩展一般放 #extensions_settings2（右栏） */
    settingsContainer() {
      const d = doc();
      return d?.getElementById('extensions_settings2') ?? d?.getElementById('extensions_settings') ?? null;
    },

    /** 酒馆启动完成后执行一次（APP_READY）；拿不到事件就延时执行 */
    onAppReady(callback, fallbackDelayMs = 15000) {
      let done = false;
      const run = () => {
        if (done) return;
        done = true;
        callback();
      };
      const context = getContext();
      const eventName = context?.event_types?.APP_READY;
      if (eventName && typeof context.eventSource?.on === 'function') {
        context.eventSource.on(eventName, run);
      }
      // 插件可能在 APP_READY 之后才加载，兜底延时执行（run 只会跑一次）
      setTimeout(run, fallbackDelayMs);
    },

    // ---------- 网址参数 ----------

    /** 当前酒馆网址里的 odysseia_import 参数值；没有返回 null */
    readImportParam() {
      try {
        return new URL(win().location.href).searchParams.get(IMPORT_PARAM);
      } catch {
        return null;
      }
    },

    /** 用 history.replaceState 把 odysseia_import 从地址栏去掉（不刷新页面），避免刷新时重复触发 */
    clearImportParam() {
      try {
        const w = win();
        const url = new URL(w.location.href);
        if (!url.searchParams.has(IMPORT_PARAM)) return false;
        url.searchParams.delete(IMPORT_PARAM);
        w.history.replaceState(w.history.state, '', `${url.pathname}${url.search}${url.hash}`);
        return true;
      } catch {
        return false;
      }
    },

    /** 把文件交给浏览器下载（不支持一键导入的类型用） */
    saveFileToDisk(bytes, fileName, mime) {
      const d = doc();
      const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
      const a = d.createElement('a');
      a.href = url;
      a.download = fileName;
      d.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
  };
  return adapter;
}
