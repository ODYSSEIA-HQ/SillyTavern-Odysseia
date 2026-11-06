// 面板 + 动作：真 API 客户端 + 假平台（test/fake-platform.mjs）+ 假酒馆，走一遍完整流程
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createTavernAdapter } from '../src/tavern.js';
import { escapeHtml, formatSize, renderPanelBody } from '../src/ui.js';
import { startMockServer } from './fake-platform.mjs';
import { createFakeTavern } from './helpers.js';

// 每个用例一个新的假平台
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
  const win = {
    location: { href: options.href ?? 'https://tavern.local/' },
    history: { state: null, replaceState: vi.fn((_s, _t, url) => { win.location.href = new URL(url, win.location.href).href; }) },
  };
  const tavern = createTavernAdapter({ getContext: fake.getContext, fetchImpl: fake.fetchImpl, toastr, win });
  const app = createApp({ tavern, now: options.now });
  const root = app.mount();
  const $ = (sel) => root.querySelector(sel);
  const idle = async () => {
    await vi.waitFor(() => expect(Object.values(app.state.busy).some(Boolean)).toBe(false));
    // 让 click 里串起来的后续 await 跑完
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(Object.values(app.state.busy).some(Boolean)).toBe(false));
  };
  const click = async (action, id) => {
    const selector = id ? `[data-action="${action}"][data-id="${id}"]` : `[data-action="${action}"]`;
    const el = $(selector);
    if (!el) throw new Error(`找不到按钮 ${selector}`);
    el.click();
    await idle();
  };
  return { fake, toastr, tavern, win, app, root, $, click, idle };
}

async function login(ctx, token = 'odp_dev_alice') {
  ctx.$('#odys-site').value = server.url;
  ctx.$('#odys-token').value = token;
  await ctx.click('login');
  await vi.waitFor(() => expect(ctx.app.settings.account).not.toBeNull());
}

/** 粘贴 → 点「导入」列出作品 */
async function preview(ctx, text) {
  ctx.$('#odys-link').value = text;
  await ctx.click('preview-links');
}

/** 导入作品的旧版本（假平台临时去掉最新版），用来造出「有更新」 */
async function importOldVersion(ctx, workId) {
  const w = server.data.works.get(workId);
  const latest = w.versions.pop();
  await preview(ctx, workId);
  await ctx.click('confirm-batch');
  w.versions.push(latest);
  await ctx.click('cancel-batch');
}

const item = (ctx, workId) => ctx.root.querySelector(`[data-work="${workId}"]`);

describe('面板', () => {
  it('挂在设置抽屉里，未登录时只显示登录表单', () => {
    const { root, $ } = setup();
    expect(document.getElementById('extensions_settings2')?.contains(root)).toBe(true);
    expect(root.querySelector('.inline-drawer-header')?.textContent).toContain('Odysseia 平台');
    expect($('#odys-site')).not.toBeNull();
    expect($('#odys-token')?.getAttribute('type')).toBe('password');
    expect(root.textContent).toContain('设置 → 酒馆插件');
    expect($('#odys-link')).toBeNull();
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

  it('登录 → 显示账号和多行链接输入框，没有收件箱；登出清掉令牌但保留来源表', async () => {
    const ctx = setup();
    await login(ctx);
    expect(ctx.root.textContent).toContain('当前账号：爱丽丝');
    expect(ctx.root.textContent).toContain('R18 内容：不可查看');
    expect(ctx.app.settings.token).toBe('odp_dev_alice');
    expect(ctx.$('#odys-link')?.tagName).toBe('TEXTAREA');
    expect(ctx.root.textContent).not.toContain('收件箱');
    expect(ctx.fake.context.saveSettingsDebounced).toHaveBeenCalled();

    ctx.app.settings.sources.worldbook.x = { workId: 'w', versionId: 'v' };
    await ctx.click('logout');
    expect(ctx.app.settings.token).toBe('');
    expect(ctx.app.settings.sources.worldbook.x).toBeDefined();
    expect(ctx.root.textContent).toContain('令牌本身仍然有效');
  });

  it('批量链接导入：先列出作品（名字/类型/版本），确认后依次导入，显示每个的结果', async () => {
    const ctx = setup({ withPresetManager: true });
    await login(ctx);
    await preview(
      ctx,
      [
        `${server.url}/works/w_lily`,
        `${server.url}/share/works/w_harbor?from=x`,
        'w_preset, w_theme，w_secret',
        `${server.url}/works/w_lily`,
        '乱写的一行',
        'w_nope',
      ].join('\n'),
    );
    // 只列出，还没导入
    expect(ctx.fake.characters).toHaveLength(0);
    expect(ctx.app.state.batch.items.map((i) => i.workId)).toEqual(['w_lily', 'w_harbor', 'w_preset', 'w_theme', 'w_secret', 'w_nope']);
    expect(item(ctx, 'w_lily').textContent).toContain('花店店员莉莉');
    expect(item(ctx, 'w_lily').textContent).toContain('角色卡');
    expect(item(ctx, 'w_lily').textContent).toContain('v1.1');
    expect(item(ctx, 'w_harbor').textContent).toContain('世界书');
    expect(item(ctx, 'w_theme').textContent).toContain('跳过');
    expect(item(ctx, 'w_theme').querySelector('[data-action="download"]')).not.toBeNull();
    expect(item(ctx, 'w_secret').querySelector('.odys-msg-warning')?.textContent).toContain('开启 R18');
    expect(item(ctx, 'w_nope').textContent).toContain('没找到这个作品');
    expect(ctx.root.textContent).toContain('乱写的一行');
    expect(ctx.$('[data-action="confirm-batch"]')?.textContent).toBe('确认导入 3 个');

    // 一个失败不影响其他：莉莉的文件在平台上没了
    server.data.files.delete('f_lily_v2');
    await ctx.click('confirm-batch');
    expect(ctx.fake.characters).toHaveLength(0);
    expect(item(ctx, 'w_lily').textContent).toContain('失败');
    expect(ctx.app.settings.sources.worldbook['港口城']).toMatchObject({ workId: 'w_harbor', versionId: 'v_harbor_2' });
    expect(ctx.fake.presets.get('openai/叙事预设')).toBeDefined();
    expect(item(ctx, 'w_harbor').textContent).toContain('成功');
    expect(item(ctx, 'w_preset').textContent).toContain('已导入预设「叙事预设」');
    expect(ctx.root.textContent).toContain('导入完成：成功 2 个，跳过 1 个，失败 3 个。');
    expect(ctx.toastr.warning).toHaveBeenCalledWith(expect.stringContaining('成功 2 个'), 'Odysseia', expect.anything());

    // 再导入同一版本：跳过
    await ctx.click('cancel-batch');
    await preview(ctx, 'w_harbor');
    expect(item(ctx, 'w_harbor').textContent).toContain('已经导入过这个版本');
    expect(ctx.$('[data-action="confirm-batch"]')).toBeNull();
  });

  it('取消时什么都不导入；全是认不出的内容时提示', async () => {
    const ctx = setup();
    await login(ctx);
    await preview(ctx, 'w_lily w_harbor');
    await ctx.click('cancel-batch');
    expect(ctx.app.state.batch).toBeNull();
    expect(ctx.fake.characters).toHaveLength(0);
    expect(ctx.fake.worlds.size).toBe(0);

    await preview(ctx, 'https://x.example/users/1');
    expect(ctx.root.textContent).toContain('没认出作品链接');
  });

  it('导入旧版本 → 检查更新发现新版 → 徽标 + toastr → 确认后更新', async () => {
    const ctx = setup();
    await login(ctx);
    await importOldVersion(ctx, 'w_lily');
    expect(ctx.fake.characters).toHaveLength(1);
    expect(ctx.fake.characters[0].data.extensions.odysseia).toMatchObject({ workId: 'w_lily', versionId: 'v_lily_1' });

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
    await importOldVersion(ctx, 'w_lily');
    await ctx.click('check-updates');
    ctx.fake.context.callGenericPopup.mockResolvedValueOnce(0);
    await ctx.click('apply-update', 'character:莉莉.png');
    expect(ctx.app.settings.pendingUpdates).toHaveLength(1);
    expect(ctx.fake.characters[0].data.extensions.odysseia.versionId).toBe('v_lily_1');
  });

  it('忽略此版本后不再提示', async () => {
    const ctx = setup();
    await login(ctx);
    await importOldVersion(ctx, 'w_harbor');
    expect(ctx.app.settings.sources.worldbook['港口城']).toMatchObject({ workId: 'w_harbor', versionId: 'v_harbor_1' });
    await ctx.click('check-updates');
    await ctx.click('ignore-update', 'worldbook:港口城');
    expect(ctx.app.settings.dismissedUpdates).toEqual({ w_harbor: 'v_harbor_2' });
    await ctx.click('check-updates');
    expect(ctx.app.settings.pendingUpdates).toHaveLength(0);
  });

  it('令牌被撤销（401）时自动登出并提示', async () => {
    const ctx = setup();
    await login(ctx);
    ctx.app.settings.token = 'odp_revoked';
    await preview(ctx, 'w_lily');
    expect(ctx.app.settings.account).toBeNull();
    expect(ctx.app.state.batch).toBeNull();
    expect(ctx.root.textContent).toContain('令牌无效');
    expect(ctx.$('#odys-token')).not.toBeNull();
  });

  it('启动：APP_READY 后检查更新；定时器按 6 小时间隔检查', async () => {
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

describe('从网页打开（?odysseia_import=）', () => {
  const href = 'https://tavern.local/?odysseia_import=w_lily,w_secret,w_lily&x=1#chat';

  it('先弹确认框列出作品，确认后导入，并把参数从地址里去掉', async () => {
    const ctx = setup({ href });
    await login(ctx);
    ctx.app.start();
    ctx.fake.fireAppReady();
    await vi.waitFor(() => expect(ctx.win.history.replaceState).toHaveBeenCalled());
    await ctx.idle();
    const [message, type] = ctx.fake.context.callGenericPopup.mock.calls[0];
    expect(type).toBe(2);
    expect(message).toContain('花店店员莉莉（角色卡，v1.1）');
    expect(message).toContain('以下不会导入');
    expect(message).toContain('开启 R18');
    expect(ctx.fake.characters).toHaveLength(1);
    expect(ctx.fake.characters[0].data.extensions.odysseia.versionId).toBe('v_lily_2');
    expect(ctx.win.location.href).toBe('https://tavern.local/?x=1#chat');
    ctx.app.stop();
  });

  it('用户取消时什么都不导入，参数照样去掉', async () => {
    const ctx = setup({ href });
    await login(ctx);
    ctx.fake.context.callGenericPopup.mockResolvedValueOnce(0);
    await ctx.app.actions.importFromUrl();
    await ctx.idle();
    expect(ctx.fake.context.callGenericPopup).toHaveBeenCalledTimes(1);
    expect(ctx.fake.characters).toHaveLength(0);
    expect(ctx.app.state.batch).toBeNull();
    expect(ctx.toastr.info).toHaveBeenCalledWith('已取消导入。', 'Odysseia', expect.anything());
    expect(ctx.win.location.href).toBe('https://tavern.local/?x=1#chat');
    // 再调一次（相当于刷新）：参数已经没了，不会再触发
    await ctx.app.actions.importFromUrl();
    expect(ctx.fake.context.callGenericPopup).toHaveBeenCalledTimes(1);
  });

  it('未登录时提示先登录，不访问平台；登录后再弹确认框', async () => {
    const ctx = setup({ href });
    await ctx.app.actions.importFromUrl();
    expect(ctx.toastr.warning).toHaveBeenCalledWith(expect.stringContaining('请先'), 'Odysseia', expect.anything());
    expect(ctx.root.textContent).toContain('请先登录');
    expect(ctx.fake.context.callGenericPopup).not.toHaveBeenCalled();
    expect(ctx.win.location.href).toBe('https://tavern.local/?x=1#chat');

    await login(ctx);
    await ctx.idle();
    expect(ctx.fake.context.callGenericPopup).toHaveBeenCalledTimes(1);
    expect(ctx.fake.characters).toHaveLength(1);
  });

  it('参数看不懂时忽略并提示', async () => {
    const ctx = setup({ href: 'https://tavern.local/?odysseia_import=%3Cscript%3E' });
    await login(ctx);
    await ctx.app.actions.importFromUrl();
    expect(ctx.toastr.warning).toHaveBeenCalledWith(expect.stringContaining('看不懂'), 'Odysseia', expect.anything());
    expect(ctx.fake.context.callGenericPopup).not.toHaveBeenCalled();
    expect(ctx.win.location.href).toBe('https://tavern.local/');
  });
});

describe('渲染工具', () => {
  it('转义 HTML，防止作品标题注入', () => {
    expect(escapeHtml('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    const html = renderPanelBody(
      {
        busy: {},
        itemMsg: {},
        batch: {
          phase: 'preview',
          invalid: ['<i>bad</i>'],
          progress: { done: 1, total: 1 },
          items: [{ workId: 'w', status: 'ready', data: { work: { id: 'w', title: '<script>x</script>', type: 'character', cover: null }, latestVersion: { id: 'v', name: 'v' }, files: [] } }],
        },
      },
      { token: 't', account: { name: '<b>', canViewR18: true }, siteUrl: 'https://a', pendingUpdates: [], sources: {} },
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<i>bad');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
  });

  it('文件大小', () => {
    expect(formatSize(10)).toBe('10 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
