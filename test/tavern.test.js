// 适配层 + 导入流程：用假的 getContext / fetch
import { describe, expect, it, vi } from 'vitest';
import { createTavernAdapter, detectPresetApi, MODULE_NAME, stripExtension, uniqueName } from '../src/tavern.js';
import { applyUpdate, importFile, importInboxItem, ManualImportError } from '../src/importer.js';
import { readCardFromPng } from '../src/card.js';
import { makeCardPng } from './fake-platform.mjs';
import { createFakeApi, createFakeTavern } from './helpers.js';

function setup(options) {
  const fake = createFakeTavern(options);
  const tavern = createTavernAdapter({ getContext: fake.getContext, fetchImpl: fake.fetchImpl, toastr: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } });
  return { fake, tavern, settings: tavern.getSettings() };
}

const lilyCard = (v) => ({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '莉莉', description: v, extensions: {} } });

describe('适配层', () => {
  it('设置存在 extensionSettings.odysseia 下，补齐默认值，保存走 saveSettingsDebounced', () => {
    const { fake, tavern, settings } = setup();
    expect(fake.context.extensionSettings[MODULE_NAME]).toBe(settings);
    expect(settings.sources).toEqual({ worldbook: {}, preset: {} });
    settings.token = 'x';
    expect(tavern.getSettings().token).toBe('x');
    tavern.saveSettings();
    expect(fake.context.saveSettingsDebounced).toHaveBeenCalled();
  });

  it('没有 getContext 时给出清楚的错误', () => {
    const tavern = createTavernAdapter({ getContext: () => undefined });
    expect(() => tavern.getSettings()).toThrow('SillyTavern.getContext');
  });

  it('导入角色卡：FormData 字段、去掉 JSON Content-Type、带 CSRF 头、刷新角色列表', async () => {
    const { fake, tavern } = setup();
    const result = await tavern.importCharacter({ bytes: makeCardPng(lilyCard('a')), fileName: '莉莉.png', fileType: 'png' });
    expect(result.avatar).toBe('莉莉.png');
    const { init } = fake.calls[0];
    expect(init.headers).toEqual({ 'X-CSRF-Token': 'csrf' });
    expect(init.body.get('file_type')).toBe('png');
    expect(init.body.get('avatar').name).toBe('莉莉.png');
    expect(init.body.get('preserved_name')).toBeNull();
    expect(fake.context.getCharacters).toHaveBeenCalled();
  });

  it('覆盖已有角色时传 preserved_name（不带扩展名）', async () => {
    const { fake, tavern } = setup();
    await tavern.importCharacter({ bytes: makeCardPng(lilyCard('a')), fileName: 'x.png', fileType: 'png', preservedName: 'Lily_1.png' });
    expect(fake.calls[0].init.body.get('preserved_name')).toBe('Lily_1');
  });

  it('酒馆返回错误时抛出带说明的错误', async () => {
    const { tavern } = setup();
    const failing = createTavernAdapter({
      getContext: () => ({ getRequestHeaders: () => ({}) }),
      fetchImpl: async () => Response.json({ error: true }, { status: 500 }),
    });
    await expect(failing.importCharacter({ bytes: new Uint8Array(), fileName: 'a.png', fileType: 'png' })).rejects.toThrow('酒馆拒绝了导入角色卡');
    expect(tavern).toBeTruthy();
  });

  it('预设：有 PresetManager 用它，没有就调 /api/presets/save', async () => {
    const withManager = setup({ withPresetManager: true });
    expect(await withManager.tavern.importPreset({ apiId: 'openai', name: 'p', data: { a: 1 } })).toEqual({ name: 'p', refreshed: true });
    expect(withManager.fake.calls).toHaveLength(0);

    const bare = setup();
    expect(await bare.tavern.importPreset({ apiId: 'openai', name: 'p', data: { a: 1 } })).toEqual({ name: 'p', refreshed: false });
    expect(JSON.parse(bare.fake.calls[0].init.body)).toEqual({ apiId: 'openai', name: 'p', preset: { a: 1 } });
  });

  it('确认框：用 callGenericPopup，拿不到用 confirmFallback', async () => {
    const { fake, tavern } = setup();
    expect(await tavern.confirm('继续？')).toBe(true);
    fake.context.callGenericPopup.mockResolvedValueOnce(0);
    expect(await tavern.confirm('继续？')).toBe(false);
    const plain = createTavernAdapter({ getContext: () => ({}), confirmFallback: () => true });
    expect(await plain.confirm('x')).toBe(true);
  });

  it('APP_READY 触发一次；兜底定时器不会重复执行', () => {
    vi.useFakeTimers();
    const { fake, tavern } = setup();
    const cb = vi.fn();
    tavern.onAppReady(cb, 1000);
    fake.fireAppReady();
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('设置容器优先 #extensions_settings2', () => {
    document.body.innerHTML = '<div id="extensions_settings"></div><div id="extensions_settings2"></div>';
    const { tavern } = setup();
    expect(tavern.settingsContainer()?.id).toBe('extensions_settings2');
  });

  it('预设类型识别', () => {
    expect(detectPresetApi({ prompts: [], temperature: 1 })).toBe('openai');
    expect(detectPresetApi({ input_sequence: '', output_sequence: '' })).toBe('instruct');
    expect(detectPresetApi({ story_string: '' })).toBe('context');
    expect(detectPresetApi({ name: 'x', content: 'y' })).toBe('sysprompt');
    expect(detectPresetApi({ temp: 1, rep_pen: 1.1 })).toBe('textgenerationwebui');
    expect(detectPresetApi({ foo: 1 })).toBeNull();
    expect(detectPresetApi([])).toBeNull();
  });

  it('名字工具', () => {
    expect(stripExtension('a.b.json')).toBe('a.b');
    expect(uniqueName('港口城', [])).toBe('港口城');
    expect(uniqueName('港口城', ['港口城', '港口城 (Odysseia)'])).toBe('港口城 (Odysseia 2)');
  });
});

describe('导入流程', () => {
  const book = (v) => ({ entries: { 0: { uid: 0, content: v } } });

  it('角色卡 PNG：写入 data.extensions.odysseia 来源后交给酒馆', async () => {
    const { fake, tavern, settings } = setup();
    const api = createFakeApi({ f1: makeCardPng(lilyCard('v1')) });
    const result = await importFile({ api, tavern, settings, workId: 'w_lily', versionId: 'v1', file: { id: 'f1', name: '莉莉.png', kind: 'character' } });
    expect(result).toEqual({ kind: 'character', name: '莉莉', key: '莉莉.png' });
    const uploaded = new Uint8Array(await fake.calls[0].init.body.get('avatar').arrayBuffer());
    expect(readCardFromPng(uploaded).data.extensions.odysseia).toMatchObject({ workId: 'w_lily', versionId: 'v1', fileId: 'f1' });
    expect(fake.characters[0].data.extensions.odysseia.workId).toBe('w_lily');
  });

  it('角色卡 JSON 也支持', async () => {
    const { fake, tavern, settings } = setup();
    const api = createFakeApi({ f1: lilyCard('json') });
    await importFile({ api, tavern, settings, workId: 'w', versionId: 'v', file: { id: 'f1', name: 'lily', kind: 'character' } });
    expect(fake.calls[0].init.body.get('file_type')).toBe('json');
    expect(fake.calls[0].init.body.get('avatar').name).toBe('lily.json');
  });

  it('PNG 里没有卡数据时报错', async () => {
    const { tavern, settings } = setup();
    const api = createFakeApi({ f1: makeCardPng(null) });
    await expect(importFile({ api, tavern, settings, workId: 'w', versionId: 'v', file: { id: 'f1', name: 'x.png', kind: 'character' } })).rejects.toThrow('没有角色卡数据');
  });

  it('世界书：记来源表；和用户自己的同名世界书冲突时改名，不覆盖', async () => {
    const { fake, tavern, settings } = setup({ worldNames: ['港口城'] });
    const api = createFakeApi({ fw: book('v1') });
    const result = await importFile({ api, tavern, settings, workId: 'w_h', versionId: 'v1', file: { id: 'fw', name: '港口城.json', kind: 'worldbook' } });
    expect(result.name).toBe('港口城 (Odysseia)');
    expect(settings.sources.worldbook['港口城 (Odysseia)']).toMatchObject({ workId: 'w_h', versionId: 'v1', fileName: '港口城.json' });
    expect(fake.worlds.get('港口城')).toEqual({ entries: {} });
    expect(fake.context.saveSettingsDebounced).toHaveBeenCalled();
  });

  it('世界书：同一作品再次导入时覆盖自己那一份', async () => {
    const { tavern, settings } = setup({ worldNames: ['港口城'] });
    settings.sources.worldbook['港口城'] = { workId: 'w_h', versionId: 'v0', fileId: 'old' };
    const api = createFakeApi({ fw: book('v1') });
    const result = await importFile({ api, tavern, settings, workId: 'w_h', versionId: 'v1', file: { id: 'fw', name: '港口城.json', kind: 'worldbook' } });
    expect(result.name).toBe('港口城');
  });

  it('世界书格式不对时提示手动导入', async () => {
    const { tavern, settings } = setup();
    const api = createFakeApi({ fw: { foo: 1 } });
    await expect(importFile({ api, tavern, settings, workId: 'w', versionId: 'v', file: { id: 'fw', name: 'x.json', kind: 'worldbook' } })).rejects.toThrow('entries');
  });

  it('预设：识别类型、记来源表；认不出类型时报错', async () => {
    const { tavern, settings } = setup({ withPresetManager: true });
    const api = createFakeApi({ fp: { prompts: [], temperature: 1 }, bad: { foo: 1 } });
    const result = await importFile({ api, tavern, settings, workId: 'w_p', versionId: 'v1', file: { id: 'fp', name: '叙事.json', kind: 'preset' } });
    expect(result.key).toBe('openai/叙事');
    expect(settings.sources.preset['openai/叙事']).toMatchObject({ workId: 'w_p', apiId: 'openai', name: '叙事' });
    await expect(importFile({ api, tavern, settings, workId: 'w', versionId: 'v', file: { id: 'bad', name: 'b.json', kind: 'preset' } })).rejects.toThrow('认不出');
  });

  it('不支持的类型抛 ManualImportError 且不下载', async () => {
    const { tavern, settings } = setup();
    const api = createFakeApi({});
    await expect(importFile({ api, tavern, settings, workId: 'w', versionId: 'v', file: { id: 't', name: '主题.json', kind: 'theme' } })).rejects.toBeInstanceOf(ManualImportError);
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it('收件箱：全部成功 ack imported；有失败 ack failed 带原因；全是不支持类型时不 ack', async () => {
    const { tavern, settings } = setup();
    const api = createFakeApi({ f1: makeCardPng(lilyCard('v1')), fw: book('v1') });
    const item = (id, files) => ({ id, work: { id: 'w' }, version: { id: 'v' }, files });

    const ok = await importInboxItem({ api, tavern, settings, item: item('a', [{ id: 'f1', name: 'l.png', kind: 'character' }, { id: 'fw', name: 'b.json', kind: 'worldbook' }, { id: 't', name: 't.json', kind: 'theme' }]) });
    expect(ok.imported).toHaveLength(2);
    expect(ok.manual).toHaveLength(1);
    expect(ok.acked).toBe('imported');
    expect(api.ack).toHaveBeenLastCalledWith('a', 'imported', undefined);

    const bad = await importInboxItem({ api, tavern, settings, item: item('b', [{ id: 'missing', name: 'x.png', kind: 'character' }]) });
    expect(bad.acked).toBe('failed');
    expect(api.ack).toHaveBeenLastCalledWith('b', 'failed', '没有文件 missing');

    api.ack.mockClear();
    const manual = await importInboxItem({ api, tavern, settings, item: item('c', [{ id: 't', name: 't.json', kind: 'theme' }]) });
    expect(manual.acked).toBeNull();
    expect(api.ack).not.toHaveBeenCalled();
  });

  it('ack 失败不影响导入结果', async () => {
    const { tavern, settings } = setup();
    const api = createFakeApi({ fw: book('v1') });
    api.ack.mockRejectedValueOnce(new Error('net'));
    const result = await importInboxItem({ api, tavern, settings, item: { id: 'a', work: { id: 'w' }, version: { id: 'v' }, files: [{ id: 'fw', name: 'b.json', kind: 'worldbook' }] } });
    expect(result.imported).toHaveLength(1);
    expect(result.acked).toBeNull();
  });

  it('更新角色卡：覆盖原头像文件名（聊天记录跟着文件名走），来源更新到新版本，从待更新列表移除', async () => {
    const { fake, tavern, settings } = setup();
    const api = createFakeApi({ f1: makeCardPng(lilyCard('v1')), f2: makeCardPng(lilyCard('v2')) });
    await importFile({ api, tavern, settings, workId: 'w_lily', versionId: 'v1', file: { id: 'f1', name: '莉莉.png', kind: 'character' } });
    // 用户在酒馆里把卡改名存成了别的文件名，也要覆盖到原来那张
    fake.characters[0].avatar = 'Lily_2.png';
    const entry = { kind: 'character', key: 'Lily_2.png', label: '莉莉', workId: 'w_lily', versionId: 'v1' };
    const update = { entry, latest: { id: 'v2', name: '1.1' }, file: { id: 'f2', name: '莉莉.png', kind: 'character' } };
    settings.pendingUpdates = [update];
    await applyUpdate({ api, tavern, settings, update });
    expect(fake.calls.at(-1).init.body.get('preserved_name')).toBe('Lily_2');
    expect(fake.characters).toHaveLength(1);
    expect(fake.characters[0].data.description).toBe('v2');
    expect(fake.characters[0].data.extensions.odysseia.versionId).toBe('v2');
    expect(settings.pendingUpdates).toEqual([]);
  });

  it('更新世界书/预设：覆盖同名那一份并更新来源表', async () => {
    const { fake, tavern, settings } = setup({ withPresetManager: true });
    settings.sources.worldbook['港口城'] = { workId: 'w_h', versionId: 'v1', fileId: 'a' };
    settings.sources.preset['openai/叙事'] = { workId: 'w_p', versionId: 'v1', fileId: 'b', apiId: 'openai', name: '叙事' };
    const api = createFakeApi({ fw2: book('v2'), fp2: { prompts: [1] } });
    await applyUpdate({ api, tavern, settings, update: { entry: { kind: 'worldbook', key: '港口城', label: '港口城', workId: 'w_h', versionId: 'v1' }, latest: { id: 'v2' }, file: { id: 'fw2', name: '港口城-新.json', kind: 'worldbook' } } });
    expect(fake.worlds.get('港口城')).toEqual(book('v2'));
    expect(settings.sources.worldbook['港口城'].versionId).toBe('v2');
    await applyUpdate({ api, tavern, settings, update: { entry: { kind: 'preset', key: 'openai/叙事', label: '叙事', apiId: 'openai', workId: 'w_p', versionId: 'v1' }, latest: { id: 'v2' }, file: { id: 'fp2', name: 'x.json', kind: 'preset' } } });
    expect(fake.presets.get('openai/叙事')).toEqual({ prompts: [1] });
    expect(settings.sources.preset['openai/叙事'].versionId).toBe('v2');
  });

  it('新版本没有同类型文件时提示去网页', async () => {
    const { tavern, settings } = setup();
    await expect(applyUpdate({ api: createFakeApi(), tavern, settings, update: { entry: { kind: 'character' }, latest: { id: 'v2' }, file: null } })).rejects.toThrow('平台网页');
  });
});
