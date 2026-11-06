// 插件主体：状态、动作、定时检查。对外依赖只有 tavern（适配层）和 createApi（平台客户端工厂）。

import { createPluginApi, describeError, PluginApiError } from './api.js';
import { applyUpdate, importWork } from './importer.js';
import { normalizeSiteUrl, parseImportParam, parseWorkRefs, DEFAULT_SITE_URL, MAX_BATCH } from './links.js';
import { buildUpdateCheckItems, collectInstalled, findInstalledByWork, isSupportedKind, KIND_LABELS } from './provenance.js';
import { badgeText, renderDrawerShell, renderPanelBody } from './ui.js';
import { isCheckDue, matchUpdates, newlyFound, updateKey } from './updates.js';

/** 定时器多久看一次是否到了 6 小时（到期判断在 isCheckDue） */
export const TICK_MS = 30 * 60 * 1000;

function summarizeImported(results) {
  return results.map((r) => `${KIND_LABELS[r.kind]}「${r.name}」`).join('、');
}

/** 作品类型的中文名 */
export function workTypeLabel(type) {
  return KIND_LABELS[type] ?? (type ? String(type) : '作品');
}

/**
 * 查到的作品 → 批量列表里的一行。
 * ready：会导入；latest：已导入过这个版本，跳过；manual：没有能一键导入的文件，跳过。
 */
function describeWork(workId, data, installedAll) {
  const installed = findInstalledByWork(installedAll, workId);
  const supported = (data.files ?? []).filter((f) => isSupportedKind(f.kind));
  const item = { workId, data, installed, status: 'ready', level: null, message: null };
  if (!supported.length) {
    item.status = 'manual';
    item.level = 'info';
    item.message = '没有可以一键导入的文件（角色卡/世界书/预设），可以下载后手动导入。';
  } else if (data.latestVersion?.id && installed.some((e) => e.versionId === data.latestVersion.id)) {
    item.status = 'latest';
    item.level = 'info';
    item.message = '已经导入过这个版本，跳过。';
  }
  return item;
}

/** 批量结果计数：成功 / 跳过 / 失败（查询失败也算失败） */
export function countBatch(batch) {
  const count = { ready: 0, done: 0, skipped: 0, failed: 0 };
  for (const item of batch?.items ?? []) {
    if (item.status === 'ready') count.ready += 1;
    else if (item.status === 'done') count.done += 1;
    else if (item.status === 'latest' || item.status === 'manual') count.skipped += 1;
    else if (item.status === 'failed' || item.status === 'error') count.failed += 1;
  }
  return count;
}

/** 网页链接导入的确认文字：列出会导入的和不会导入的 */
function urlConfirmMessage(batch) {
  const lines = ['有网页请求把下面的作品导入到你的酒馆。请确认是你自己在平台上点的「在酒馆中打开」：', ''];
  for (const item of batch.items.filter((i) => i.status === 'ready')) {
    const { work, latestVersion } = item.data;
    lines.push(`· ${work.title}（${workTypeLabel(work.type)}，${latestVersion?.name ?? '最新版本'}）`);
  }
  const rest = batch.items.filter((i) => i.status !== 'ready');
  if (rest.length) {
    lines.push('', '以下不会导入：');
    for (const item of rest) lines.push(`· ${item.data?.work?.title ?? item.workId}：${item.message}`);
  }
  lines.push('', `导入这 ${countBatch(batch).ready} 个作品吗？`);
  return lines.join('\n');
}

/**
 * @param {{tavern: ReturnType<import('./tavern.js').createTavernAdapter>, createApi?: typeof createPluginApi, now?: () => number}} deps
 */
export function createApp({ tavern, createApi = createPluginApi, now = () => Date.now() }) {
  const settings = tavern.getSettings();
  if (!settings.siteUrl) settings.siteUrl = DEFAULT_SITE_URL;

  const state = {
    busy: {},
    itemMsg: {},
    /** 批量导入：{source, invalid, items, phase: lookup|preview|importing|done, progress} */
    batch: null,
    /** 未登录时收到的网页导入请求，登录后再处理 */
    pendingUrlIds: null,
    accountMsg: null,
    linkMsg: null,
    updatesMsg: null,
    siteDraft: null,
    linkDraft: null,
  };
  let root = null;
  let timer = null;

  function api() {
    const site = normalizeSiteUrl(settings.siteUrl);
    return createApi({ apiRoot: site?.apiRoot ?? '', token: settings.token });
  }

  function render() {
    if (!root) return;
    const body = root.querySelector('.odys-body');
    if (body) body.innerHTML = renderPanelBody(state, settings);
    const badge = root.querySelector('.odys-badge');
    if (badge) {
      const text = badgeText(settings);
      badge.textContent = text;
      badge.hidden = !text;
    }
  }

  async function withBusy(key, fn) {
    if (state.busy[key]) return undefined;
    state.busy[key] = true;
    render();
    try {
      return await fn();
    } finally {
      state.busy[key] = false;
      render();
    }
  }

  /** 令牌失效：清掉登录状态，提示重新登录 */
  function handleAuthError(err) {
    if (err instanceof PluginApiError && err.code === 'unauthorized') {
      settings.token = '';
      settings.account = null;
      tavern.saveSettings();
      state.accountMsg = { level: 'error', text: err.message };
      return true;
    }
    return false;
  }

  async function runUrlImport(ids) {
    state.pendingUrlIds = null;
    const ok = await actions.previewLinks(ids.join('\n'), { source: 'url' });
    const batch = state.batch;
    if (!ok || !batch) return;
    if (!countBatch(batch).ready) {
      tavern.notify('warning', '网页请求导入的作品都不能导入，原因见扩展设置「Odysseia 平台」。');
      return;
    }
    if (!(await tavern.confirm(urlConfirmMessage(batch)))) {
      if (state.batch === batch) state.batch = null;
      state.linkDraft = null;
      tavern.notify('info', '已取消导入。');
      render();
      return;
    }
    await actions.importBatch();
  }

  const actions = {
    async login(siteInput, tokenInput) {
      const site = normalizeSiteUrl(siteInput);
      const token = String(tokenInput ?? '').trim();
      state.siteDraft = siteInput;
      if (!site) {
        state.accountMsg = { level: 'error', text: '平台地址不对，应该形如 https://example.com' };
        return render();
      }
      if (!token) {
        state.accountMsg = { level: 'error', text: '请粘贴插件令牌。' };
        return render();
      }
      await withBusy('login', async () => {
        try {
          const me = await createApi({ apiRoot: site.apiRoot, token }).me();
          settings.siteUrl = site.siteUrl;
          settings.token = token;
          settings.account = { id: me.user.id, name: me.user.name, avatar: me.user.avatar ?? null, canViewR18: Boolean(me.canViewR18) };
          tavern.saveSettings();
          state.siteDraft = null;
          state.accountMsg = null;
          tavern.notify('success', `已登录：${me.user.name}`);
        } catch (err) {
          state.accountMsg = { level: 'error', text: describeError(err) };
        }
      });
      if (settings.account) {
        if (state.pendingUrlIds) await runUrlImport(state.pendingUrlIds);
        await actions.checkUpdates({ silent: true });
      }
    },

    logout() {
      settings.token = '';
      settings.account = null;
      settings.pendingUpdates = [];
      tavern.saveSettings();
      state.batch = null;
      state.pendingUrlIds = null;
      state.accountMsg = {
        level: 'info',
        text: '已登出。令牌本身仍然有效，如不再使用请到平台「设置 → 酒馆插件」里删除。',
      };
      render();
    },

    async downloadFile(fileId) {
      const file = (state.batch?.items ?? []).flatMap((i) => i.data?.files ?? []).find((f) => f.id === fileId);
      if (!file) return;
      try {
        const { bytes, name, mime } = await api().downloadFile(file.id, file);
        tavern.saveFileToDisk(bytes, name ?? file.name, mime);
      } catch (err) {
        if (!handleAuthError(err)) tavern.notify('error', describeError(err));
        render();
      }
    },

    /**
     * 第一步：解析粘贴的链接/编号，逐个查询作品，列出将要导入的内容，等用户确认。
     * @returns {Promise<boolean>} 是否得到了可以确认的列表
     */
    async previewLinks(input, { source = 'paste' } = {}) {
      state.linkDraft = input;
      if (state.busy.batch || state.busy.lookup) return false;
      const { ids, invalid } = parseWorkRefs(input);
      state.batch = null;
      if (!ids.length) {
        state.linkMsg = {
          level: 'error',
          text: invalid.length
            ? `没认出作品链接：${invalid.join('、')}。请粘贴形如 https://…/works/作品编号 的链接，或直接粘贴作品编号。`
            : '请粘贴作品链接或作品编号，一行一个。',
        };
        render();
        return false;
      }
      if (ids.length > MAX_BATCH) {
        state.linkMsg = { level: 'error', text: `一次最多导入 ${MAX_BATCH} 个作品，现在有 ${ids.length} 个，请分批粘贴。` };
        render();
        return false;
      }
      state.linkMsg = null;
      const batch = { source, invalid, items: [], phase: 'lookup', progress: { done: 0, total: ids.length } };
      state.batch = batch;
      await withBusy('lookup', async () => {
        const installedAll = collectInstalled({ characters: tavern.listCharacters(), sources: settings.sources });
        for (const workId of ids) {
          try {
            batch.items.push(describeWork(workId, await api().work(workId), installedAll));
          } catch (err) {
            if (handleAuthError(err)) {
              state.batch = null;
              return;
            }
            batch.items.push({
              workId,
              status: 'error',
              level: err?.code === 'restricted' ? 'warning' : 'error',
              message: describeError(err),
            });
          }
          batch.progress.done += 1;
          render();
        }
        batch.phase = 'preview';
      });
      return state.batch === batch && batch.phase === 'preview';
    },

    /** 第二步：用户确认后依次导入。一个失败不影响其他。 */
    async importBatch() {
      const batch = state.batch;
      if (!batch || batch.phase !== 'preview') return;
      const todo = batch.items.filter((i) => i.status === 'ready');
      if (!todo.length) return;
      await withBusy('batch', async () => {
        batch.phase = 'importing';
        batch.progress = { done: 0, total: todo.length };
        for (const item of todo) {
          if (!settings.token) {
            item.status = 'failed';
            item.level = 'error';
            item.message = '登录已失效，没有导入。';
            batch.progress.done += 1;
            continue;
          }
          item.status = 'importing';
          render();
          try {
            const result = await importWork({ api: api(), tavern, settings, data: item.data });
            const parts = [];
            if (result.imported.length) parts.push(`已导入${summarizeImported(result.imported)}`);
            parts.push(...result.errors.map((e) => e.message));
            if (result.manual.length) parts.push(`另有 ${result.manual.length} 个文件需要下载后手动导入。`);
            item.status = result.errors.length ? 'failed' : 'done';
            item.level = result.errors.length ? 'error' : 'success';
            item.message = parts.join('\n');
          } catch (err) {
            handleAuthError(err);
            item.status = 'failed';
            item.level = 'error';
            item.message = describeError(err);
          }
          batch.progress.done += 1;
          render();
        }
        batch.phase = 'done';
        const count = countBatch(batch);
        const text = `导入完成：成功 ${count.done} 个，跳过 ${count.skipped} 个，失败 ${count.failed} 个。`;
        state.linkMsg = { level: count.failed ? 'warning' : 'success', text };
        state.linkDraft = null;
        tavern.notify(count.failed ? 'warning' : 'success', text);
      });
    },

    cancelBatch() {
      if (state.busy.batch || state.busy.lookup) return;
      state.batch = null;
      state.linkMsg = null;
      render();
    },

    /**
     * 平台网页「在酒馆中打开」：酒馆网址带 ?odysseia_import=作品ID1,作品ID2。
     * 别的网站也能伪造这种链接，所以必须先弹确认框列出作品，用户同意才导入。
     * 处理完后把参数从地址栏去掉，刷新不会重复触发。
     */
    async importFromUrl() {
      const raw = tavern.readImportParam();
      if (raw === null || raw === undefined) return;
      try {
        const ids = parseImportParam(raw);
        if (!ids.length) {
          tavern.notify('warning', '网址里的 Odysseia 导入参数看不懂，已忽略。');
          return;
        }
        if (!settings.token || !settings.account) {
          state.pendingUrlIds = ids;
          state.accountMsg = {
            level: 'warning',
            text: `网页请求导入 ${ids.length} 个作品。请先登录，登录后会列出作品请你确认。`,
          };
          render();
          tavern.notify('warning', `网页请求导入 ${ids.length} 个作品，请先在扩展设置「Odysseia 平台」里登录。`);
          return;
        }
        await runUrlImport(ids);
      } finally {
        tavern.clearImportParam();
      }
    },

    /**
     * 检查更新。silent=true 是自动检查：只在发现「没提醒过的新版本」时弹一条 toastr。
     */
    async checkUpdates({ silent = false } = {}) {
      if (!settings.token) return;
      await withBusy('updates', async () => {
        try {
          const installed = collectInstalled({ characters: tavern.listCharacters(), sources: settings.sources });
          const items = buildUpdateCheckItems(installed);
          const results = items.length ? await api().checkUpdates(items) : [];
          const updates = matchUpdates(installed, results, settings.dismissedUpdates);
          settings.pendingUpdates = updates;
          settings.lastUpdateCheckAt = now();
          const fresh = newlyFound(updates, settings.notifiedUpdates);
          for (const u of fresh) settings.notifiedUpdates[u.entry.workId] = u.latest.id;
          tavern.saveSettings();
          state.updatesMsg = null;
          if (fresh.length) {
            tavern.notify('info', `${fresh.length} 个从平台导入的内容有新版本，可在扩展设置「Odysseia 平台」里更新。`);
          } else if (!silent) {
            tavern.notify('success', updates.length ? '没有新的更新。' : '都是最新的。');
          }
        } catch (err) {
          if (handleAuthError(err)) return;
          if (!silent) state.updatesMsg = { level: 'error', text: describeError(err) };
        }
      });
    },

    async applyUpdate(key) {
      const update = (settings.pendingUpdates ?? []).find((u) => updateKey(u) === key);
      if (!update) return;
      const label = update.entry.label;
      const warning = {
        character: `将用新版本「${update.latest.name}」覆盖角色卡「${label}」。你对这张卡本身做过的修改（描述、开场白等）会被替换；和它的聊天记录会保留。继续吗？`,
        worldbook: `将用新版本「${update.latest.name}」覆盖世界书「${label}」，你自己改过的条目会被替换。继续吗？`,
        preset: `将用新版本「${update.latest.name}」覆盖预设「${label}」，你自己改过的参数会被替换。继续吗？`,
      }[update.entry.kind];
      if (!(await tavern.confirm(warning))) return;
      const msgKey = `update:${key}`;
      await withBusy(msgKey, async () => {
        try {
          const result = await applyUpdate({ api: api(), tavern, settings, update });
          state.itemMsg[msgKey] = null;
          tavern.notify('success', `已更新${KIND_LABELS[result.kind]}「${result.name}」到 ${update.latest.name}`);
        } catch (err) {
          if (!handleAuthError(err)) state.itemMsg[msgKey] = { level: 'error', text: describeError(err) };
        }
      });
    },

    ignoreUpdate(key) {
      const update = (settings.pendingUpdates ?? []).find((u) => updateKey(u) === key);
      if (!update) return;
      settings.dismissedUpdates[update.entry.workId] = update.latest.id;
      settings.pendingUpdates = settings.pendingUpdates.filter(
        (u) => !(u.entry.workId === update.entry.workId && u.latest.id === update.latest.id),
      );
      tavern.saveSettings();
      render();
    },

    /** 自动检查：到期才查 */
    async tick() {
      if (settings.token && isCheckDue(settings.lastUpdateCheckAt, now())) {
        await actions.checkUpdates({ silent: true });
      }
    },
  };

  function onClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || !root?.contains(target)) return;
    const id = target.getAttribute('data-id');
    const value = (sel) => root.querySelector(sel)?.value ?? '';
    switch (target.getAttribute('data-action')) {
      case 'login':
        return actions.login(value('#odys-site'), value('#odys-token'));
      case 'logout':
        return actions.logout();
      case 'download':
        return actions.downloadFile(id);
      case 'preview-links':
        return actions.previewLinks(value('#odys-link'));
      case 'confirm-batch':
        return actions.importBatch();
      case 'cancel-batch':
        return actions.cancelBatch();
      case 'check-updates':
        return actions.checkUpdates();
      case 'apply-update':
        return actions.applyUpdate(id);
      case 'ignore-update':
        return actions.ignoreUpdate(id);
      default:
        return undefined;
    }
  }

  function onKeydown(event) {
    if (event.key !== 'Enter') return;
    if (event.target instanceof HTMLInputElement && event.target.id === 'odys-token') {
      root.querySelector('[data-action="login"]')?.click();
    }
    // 多行输入框里回车是换行；Ctrl/⌘ + 回车 = 点「导入」
    if (event.target instanceof HTMLTextAreaElement && event.target.id === 'odys-link' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      root.querySelector('[data-action="preview-links"]')?.click();
    }
  }

  /** 输入时记下草稿，面板重绘（比如后台检查更新）时不丢内容 */
  function onInput(event) {
    if (event.target instanceof HTMLTextAreaElement && event.target.id === 'odys-link') state.linkDraft = event.target.value;
  }

  return {
    state,
    settings,
    actions,
    render,
    /** 挂到设置抽屉、启动后检查一次、之后定时检查 */
    mount() {
      const container = tavern.settingsContainer();
      if (!container) throw new Error('没找到酒馆的扩展设置容器');
      const wrapper = document.createElement('div');
      wrapper.innerHTML = renderDrawerShell();
      root = wrapper.firstElementChild;
      container.appendChild(root);
      root.addEventListener('click', onClick);
      root.addEventListener('keydown', onKeydown);
      root.addEventListener('input', onInput);
      render();
      return root;
    },
    start() {
      tavern.onAppReady(async () => {
        // 平台网页「在酒馆中打开」带来的导入请求（先确认再导入）
        await actions.importFromUrl();
        if (!settings.token) return;
        // 启动时总是查一次；之后由定时器按 6 小时间隔查
        await actions.checkUpdates({ silent: true });
      });
      timer = setInterval(() => void actions.tick(), TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
