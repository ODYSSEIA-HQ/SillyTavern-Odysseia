// 插件主体：状态、动作、定时检查。对外依赖只有 tavern（适配层）和 createApi（平台客户端工厂）。

import { createPluginApi, describeError, PluginApiError } from './api.js';
import { applyUpdate, importInboxItem, importFile } from './importer.js';
import { normalizeSiteUrl, parseWorkRef, DEFAULT_SITE_URL } from './links.js';
import { buildUpdateCheckItems, collectInstalled, findInstalledByWork, isSupportedKind, KIND_LABELS } from './provenance.js';
import { badgeText, renderDrawerShell, renderPanelBody } from './ui.js';
import { isCheckDue, matchUpdates, newlyFound, updateKey } from './updates.js';

/** 定时器多久看一次是否到了 6 小时（到期判断在 isCheckDue） */
export const TICK_MS = 30 * 60 * 1000;

function summarizeImported(results) {
  return results.map((r) => `${KIND_LABELS[r.kind]}「${r.name}」`).join('、');
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
    inbox: null,
    linkResult: null,
    accountMsg: null,
    inboxMsg: null,
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
        await actions.refreshInbox();
        await actions.checkUpdates({ silent: true });
      }
    },

    logout() {
      settings.token = '';
      settings.account = null;
      settings.pendingUpdates = [];
      tavern.saveSettings();
      state.inbox = null;
      state.linkResult = null;
      state.accountMsg = {
        level: 'info',
        text: '已登出。令牌本身仍然有效，如不再使用请到平台「设置 → 酒馆插件」里删除。',
      };
      render();
    },

    async refreshInbox() {
      await withBusy('inbox', async () => {
        try {
          state.inbox = await api().inbox();
          state.inboxMsg = null;
        } catch (err) {
          if (!handleAuthError(err)) state.inboxMsg = { level: 'error', text: describeError(err) };
        }
      });
    },

    async importInbox(itemId) {
      const item = state.inbox?.find((i) => i.id === itemId);
      if (!item) return;
      const key = `inbox:${itemId}`;
      await withBusy(key, async () => {
        try {
          const result = await importInboxItem({ api: api(), tavern, settings, item });
          if (result.errors.length) {
            state.itemMsg[key] = { level: 'error', text: result.errors.map((e) => e.message).join('\n') };
          } else {
            state.itemMsg[key] = null;
            tavern.notify('success', `已导入${summarizeImported(result.imported)}`);
          }
          if (result.manual.length) {
            tavern.notify('info', `还有 ${result.manual.length} 个文件需要下载后手动导入。`);
          }
          if (result.acked === 'imported' && !result.manual.length) {
            state.inbox = state.inbox.filter((i) => i.id !== itemId);
          }
        } catch (err) {
          if (!handleAuthError(err)) state.itemMsg[key] = { level: 'error', text: describeError(err) };
        }
      });
    },

    async dismissInbox(itemId) {
      const key = `inbox:${itemId}`;
      await withBusy(key, async () => {
        try {
          await api().ack(itemId, 'dismissed');
          state.inbox = (state.inbox ?? []).filter((i) => i.id !== itemId);
        } catch (err) {
          if (!handleAuthError(err)) state.itemMsg[key] = { level: 'error', text: describeError(err) };
        }
      });
    },

    async downloadFile(fileId) {
      const file =
        state.inbox?.flatMap((i) => i.files ?? []).find((f) => f.id === fileId) ??
        state.linkResult?.files?.find((f) => f.id === fileId);
      if (!file) return;
      try {
        const { bytes, name, mime } = await api().downloadFile(file.id, file);
        tavern.saveFileToDisk(bytes, name ?? file.name, mime);
      } catch (err) {
        if (!handleAuthError(err)) tavern.notify('error', describeError(err));
        render();
      }
    },

    async lookupLink(input) {
      state.linkDraft = input;
      const workId = parseWorkRef(input);
      if (!workId) {
        state.linkResult = null;
        state.linkMsg = { level: 'error', text: '没认出作品链接。请粘贴形如 https://…/works/作品编号 的链接。' };
        return render();
      }
      await withBusy('lookup', async () => {
        try {
          const data = await api().work(workId);
          const installed = findInstalledByWork(
            collectInstalled({ characters: tavern.listCharacters(), sources: settings.sources }),
            workId,
          );
          state.linkResult = { ...data, installed };
          const supported = (data.files ?? []).filter((f) => isSupportedKind(f.kind));
          state.linkMsg = supported.length
            ? null
            : { level: 'info', text: '这个作品没有可以一键导入的文件（角色卡/世界书/预设），可以下载后手动导入。' };
        } catch (err) {
          state.linkResult = null;
          if (!handleAuthError(err)) {
            state.linkMsg = { level: err?.code === 'restricted' ? 'warning' : 'error', text: describeError(err) };
          }
        }
      });
    },

    async importLink() {
      const r = state.linkResult;
      if (!r) return;
      await withBusy('link', async () => {
        const imported = [];
        const errors = [];
        for (const file of (r.files ?? []).filter((f) => isSupportedKind(f.kind))) {
          try {
            imported.push(
              await importFile({ api: api(), tavern, settings, workId: r.work.id, versionId: r.latestVersion.id, file }),
            );
          } catch (err) {
            if (handleAuthError(err)) return;
            errors.push(describeError(err));
          }
        }
        if (imported.length) tavern.notify('success', `已导入${summarizeImported(imported)}`);
        state.linkMsg = errors.length
          ? { level: 'error', text: errors.join('\n') }
          : { level: 'success', text: `已导入${summarizeImported(imported)}` };
        state.linkResult = null;
        state.linkDraft = null;
      });
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
      case 'refresh-inbox':
        return actions.refreshInbox();
      case 'import-inbox':
        return actions.importInbox(id);
      case 'dismiss-inbox':
      case 'done-inbox':
        return actions.dismissInbox(id);
      case 'download':
        return actions.downloadFile(id);
      case 'lookup-link':
        return actions.lookupLink(value('#odys-link'));
      case 'import-link':
        return actions.importLink();
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
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    if (event.target.id === 'odys-token') root.querySelector('[data-action="login"]')?.click();
    if (event.target.id === 'odys-link') root.querySelector('[data-action="lookup-link"]')?.click();
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
      render();
      return root;
    },
    start() {
      tavern.onAppReady(async () => {
        if (!settings.token) return;
        await actions.refreshInbox();
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
