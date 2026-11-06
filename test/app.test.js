// 面板 + 动作：真 API 客户端 + 假平台（test/fake-platform.mjs）+ 假酒馆，走一遍完整流程
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createTavernAdapter } from '../src/tavern.js';
import { escapeHtml, formatSize, renderPanelBody } from '../src/ui.js';
import { startMockServer } from './fake-platform.mjs';
import { createFakeTavern } from './helpers.js';

// 每个用例一个新的假平台（收件箱 ack 后会变）
let server;
beforeEach(async () => {
  server = await startMockServer({ port: 0 });
});
afterEach(async () => {
  await server?.close();
});

function setup(options = {}) {
  document.body.innerHTML = '<div id="extensions_settings2"></div>';
  const fake = createFakeTavern(options);
  const toastr = { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() };
  const tavern = createTavernAdapter({ getContext: fake.getContext, fetchImpl: fake.fetchImpl, toastr });
  const app = createApp({ tavern, now: options.now });
  const root = app.mount();
  const $ = (sel) => root.querySelector(sel);
  const click = async (action, id) => {
    const selector = id ? `[data-action="${action}"][data-id="${id}"]` : `[data-action="${action}"]`;
    const el = $(selector);
    if (!el) throw new Error(`找不到按钮 ${selector}`);
    el.click();
    await vi.waitFor(() => expect(Object.values(app.state.busy).some(Boolean)).toBe(false));
    // 让 click 里串起来的后续 await 跑完
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(Object.values(app.state.busy).some(Boolean)).toBe(false));
  };
  return { fake, toastr, tavern, app, root, $, click };
}

async function login(ctx, token = 'odp_dev_alice') {
  ctx.$('#odys-site').value = server.url;
  ctx.$('#odys-token').value = token;
  await ctx.click('login');
  await vi.waitFor(() => expect(ctx.app.state.inbox).not.toBeNull());
}

describe('面板', () => {
  it('挂在设置抽屉里，未登录时只显示登录表单', () => {
    const { root, $ } = setup();
    expect(document.getElementById('extensions_settings2')?.contains(root)).toBe(true);
    expect(root.querySelector('.inline-drawer-header')?.textContent).toContain('Odysseia 平台');
    expect($('#odys-site')).not.toBeNull();
    expect($('#odys-token')?.getAttribute('type')).toBe('password');
    expect(root.textContent).toContain('设置 → 酒馆插件');
    expect(root.textContent).not.toContain('收件箱');
  });

  it('地址或令牌不对时给出提示', async () => {
    const ctx = setup();
    ctx.$('#odys-site').value = 'ftp://x';
    await ctx.click('login');
    expect(ctx.root.textContent).toContain('平台地址不对');
    ctx.$('#odys-site').value = server.url;
    ctx.$('#odys-token').value = 'odp_wrong';
    await ctx.click('login');
    expect(ctx.root.textContent).toContain('令牌无效');
    expect(ctx.app.settings.token).toBe('');
  });

  it('登录 → 显示账号、收件箱；登出清掉令牌但保留来源表', async () => {
    const ctx = setup();
    await login(ctx);
    expect(ctx.root.textContent).toContain('当前账号：爱丽丝');
    expect(ctx.root.textContent).toContain('R18 内容：不可查看');
    expect(ctx.app.settings.token).toBe('odp_dev_alice');
    expect(ctx.root.querySelectorAll('[data-item]')).toHaveLength(3);
    expect(ctx.root.textContent).toContain('花店店员莉莉');
    // 主题不能一键导入：显示「下载」和「标记已处理」
    const themeItem = ctx.root.querySelector('[data-item="in_3"]');
    expect(themeItem?.querySelector('[data-action="import-inbox"]')).toBeNull();
    expect(themeItem?.querySelector('[data-action="download"]')).not.toBeNull();
    expect(themeItem?.textContent).toContain('标记已处理');
    expect(ctx.fake.context.saveSettingsDebounced).toHaveBeenCalled();

    ctx.app.settings.sources.worldbook.x = { workId: 'w', versionId: 'v' };
    await ctx.click('logout');
    expect(ctx.app.settings.token).toBe('');
    expect(ctx.app.settings.sources.worldbook.x).toBeDefined();
    expect(ctx.root.textContent).toContain('令牌本身仍然有效');
  });

  it('收件箱一键导入角色卡 → ack → 检查更新发现新版 → 徽标 + toastr → 确认后更新', async () => {
    const ctx = setup();
    await login(ctx);
    await ctx.click('import-inbox', 'in_1');
    expect(ctx.fake.characters).toHaveLength(1);
    expect(ctx.fake.characters[0].data.extensions.odysseia).toMatchObject({ workId: 'w_lily', versionId: 'v_lily_1' });
    expect(ctx.toastr.success).toHaveBeenCalledWith(expect.stringContaining('角色卡「莉莉」'), 'Odysseia', expect.anything());
    expect(server.data.acks.at(-1)).toMatchObject({ itemId: 'in_1', status: 'imported' });
    expect(ctx.root.querySelector('[data-item="in_1"]')).toBeNull();

    await ctx.click('check-updates');
    expect(ctx.app.settings.pendingUpdates).toHaveLength(1);
    const badge = ctx.root.querySelector('.odys-badge');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1 个更新');
    expect(ctx.toastr.info).toHaveBeenCalledWith(expect.stringContaining('有新版本'), 'Odysseia', expect.anything());
    expect(ctx.root.textContent).toContain('新增雨天开场白');

    // 第二次检查不再重复弹提示
    ctx.toastr.info.mockClear();
    await ctx.app.actions.checkUpdates({ silent: true });
    expect(ctx.toastr.info).not.toHaveBeenCalled();

    await ctx.click('apply-update', 'character:莉莉.png');
    expect(ctx.fake.context.callGenericPopup).toHaveBeenCalledWith(expect.stringContaining('聊天记录会保留'), 2);
    await vi.waitFor(() => expect(ctx.app.settings.pendingUpdates).toHaveLength(0));
    expect(ctx.fake.characters).toHaveLength(1);
    expect(ctx.fake.characters[0].data.extensions.odysseia.versionId).toBe('v_lily_2');
    expect(badge.hidden).toBe(true);
  });

  it('取消确认时不更新', async () => {
    const ctx = setup();
    await login(ctx);
    await ctx.click('import-inbox', 'in_1');
    await ctx.click('check-updates');
    ctx.fake.context.callGenericPopup.mockResolvedValueOnce(0);
    await ctx.click('apply-update', 'character:莉莉.png');
    expect(ctx.app.settings.pendingUpdates).toHaveLength(1);
    expect(ctx.fake.characters[0].data.extensions.odysseia.versionId).toBe('v_lily_1');
  });

  it('忽略此版本后不再提示', async () => {
    const ctx = setup();
    await login(ctx);
    await ctx.click('import-inbox', 'in_2');
    expect(ctx.app.settings.sources.worldbook['港口城']).toMatchObject({ workId: 'w_harbor', versionId: 'v_harbor_1' });
    await ctx.click('check-updates');
    await ctx.click('ignore-update', 'worldbook:港口城');
    expect(ctx.app.settings.dismissedUpdates).toEqual({ w_harbor: 'v_harbor_2' });
    await ctx.click('check-updates');
    expect(ctx.app.settings.pendingUpdates).toHaveLength(0);
  });

  it('粘贴链接：查找 → 导入；受限作品给出 R18 提示', async () => {
    const ctx = setup({ withPresetManager: true });
    await login(ctx);
    ctx.$('#odys-link').value = `${server.url}/works/w_preset?from=share`;
    await ctx.click('lookup-link');
    expect(ctx.root.textContent).toContain('细腻叙事预设');
    await ctx.click('import-link');
    expect(ctx.fake.presets.get('openai/叙事预设')).toBeDefined();
    expect(ctx.app.settings.sources.preset['openai/叙事预设']).toMatchObject({ workId: 'w_preset' });
    expect(ctx.root.textContent).toContain('已导入预设「叙事预设」');

    ctx.$('#odys-link').value = `${server.url}/works/w_secret`;
    await ctx.click('lookup-link');
    const msg = ctx.root.querySelector('.odys-msg-warning');
    expect(msg?.textContent).toContain('R18');
    expect(msg?.textContent).toContain('开启 R18');

    ctx.$('#odys-link').value = 'https://x.example/users/1';
    await ctx.click('lookup-link');
    expect(ctx.root.textContent).toContain('没认出作品链接');
  });

  it('令牌被撤销（401）时自动登出并提示', async () => {
    const ctx = setup();
    await login(ctx);
    ctx.app.settings.token = 'odp_revoked';
    await ctx.click('refresh-inbox');
    expect(ctx.app.settings.account).toBeNull();
    expect(ctx.root.textContent).toContain('令牌无效');
    expect(ctx.$('#odys-token')).not.toBeNull();
  });

  it('启动：APP_READY 后拉收件箱并检查更新；定时器按 6 小时间隔检查', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let clock = Date.parse('2026-10-31T00:00:00Z');
    const ctx = setup({ now: () => clock });
    await login(ctx);
    const spy = vi.spyOn(ctx.app.actions, 'checkUpdates');
    ctx.app.start();
    ctx.fake.fireAppReady();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(30 * 60 * 1000);
    await Promise.resolve();
    // tick 走的是 actions.checkUpdates 的内部引用，用 lastUpdateCheckAt 判断
    const first = ctx.app.settings.lastUpdateCheckAt;
    clock += 6 * 60 * 60 * 1000;
    vi.advanceTimersByTime(30 * 60 * 1000);
    await vi.waitFor(() => expect(ctx.app.settings.lastUpdateCheckAt).toBe(clock));
    expect(first).toBeLessThan(clock);
    ctx.app.stop();
    vi.useRealTimers();
  });
});

describe('渲染工具', () => {
  it('转义 HTML，防止作品标题注入', () => {
    expect(escapeHtml('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    const html = renderPanelBody(
      { busy: {}, itemMsg: {}, inbox: [{ id: 'i', createdAt: '', work: { id: 'w', title: '<script>x</script>', cover: null }, version: { id: 'v', name: 'v' }, files: [] }] },
      { token: 't', account: { name: '<b>', canViewR18: true }, siteUrl: 'https://a', pendingUpdates: [], sources: {} },
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
  });

  it('文件大小', () => {
    expect(formatSize(10)).toBe('10 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
