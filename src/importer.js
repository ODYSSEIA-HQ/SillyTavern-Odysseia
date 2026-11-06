// 导入流程：下载 → 写来源 → 交给酒馆 → 记来源表 → ack。
// 只通过 api（平台客户端）和 tavern（适配层）对外打交道，测试里两者都可以换成假的。

import { cardName, isPng, readCardFromPng, withOdysseiaSource, writeCardToPng } from './card.js';
import { isSupportedKind, KIND_LABELS, makeSource, presetKey } from './provenance.js';
import { detectPresetApi, stripExtension, uniqueName } from './tavern.js';

export class ManualImportError extends Error {
  constructor(file) {
    super(`「${file.name}」是${KIND_LABELS[file.kind] ?? '其他文件'}，插件暂不支持一键导入，请下载后在酒馆里手动导入。`);
    this.name = 'ManualImportError';
    this.file = file;
  }
}

function parseJson(bytes, what) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${what}不是有效的 JSON 文件。`);
  }
}

function ensureExt(name, ext) {
  const base = String(name || 'character');
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${stripExtension(base)}.${ext}`;
}

/**
 * 导入一个文件。target 给了表示「更新已有的那一份」（覆盖），否则新建。
 * @param {{api:any, tavern:any, settings:any, workId:string, versionId:string, file:any, target?:any}} args
 * @returns {Promise<{kind:string, name:string, key:string}>}
 */
export async function importFile({ api, tavern, settings, workId, versionId, file, target }) {
  if (!isSupportedKind(file.kind)) throw new ManualImportError(file);
  const { bytes } = await api.downloadFile(file.id, file);
  const source = makeSource({ workId, versionId, fileId: file.id });

  if (file.kind === 'character') {
    let payload;
    let fileType;
    let card;
    if (isPng(bytes)) {
      card = readCardFromPng(bytes);
      if (!card) throw new Error(`「${file.name}」这张图片里没有角色卡数据。`);
      payload = writeCardToPng(bytes, withOdysseiaSource(card, source));
      fileType = 'png';
    } else {
      card = parseJson(bytes, `「${file.name}」`);
      payload = new TextEncoder().encode(JSON.stringify(withOdysseiaSource(card, source)));
      fileType = 'json';
    }
    const result = await tavern.importCharacter({
      bytes: payload,
      fileName: ensureExt(file.name, fileType),
      fileType,
      preservedName: target?.key,
    });
    return { kind: 'character', name: cardName(card) ?? file.name, key: result.avatar };
  }

  if (file.kind === 'worldbook') {
    const data = parseJson(bytes, `「${file.name}」`);
    if (!data || typeof data.entries !== 'object') {
      throw new Error(`「${file.name}」不是酒馆格式的世界书（缺少 entries），请下载后手动导入。`);
    }
    const table = settings.sources.worldbook;
    let name = target?.key;
    if (!name) {
      const base = stripExtension(file.name) || '世界书';
      // 同一作品之前导入过同名世界书：直接覆盖那一份；否则避开已有名字，不覆盖用户自己的世界书
      if (table[base]?.workId === workId) name = base;
      else name = uniqueName(base, (await tavern.listWorldNames()) ?? Object.keys(table));
    }
    const result = await tavern.importWorldInfo({ name, data });
    if (target?.key && target.key !== result.name) delete table[target.key];
    table[result.name] = { ...source, fileName: file.name };
    tavern.saveSettings();
    return { kind: 'worldbook', name: result.name, key: result.name };
  }

  // preset
  const data = parseJson(bytes, `「${file.name}」`);
  const apiId = target?.apiId ?? detectPresetApi(data);
  if (!apiId) throw new Error(`认不出「${file.name}」是哪种预设，请下载后在酒馆里手动导入。`);
  const table = settings.sources.preset;
  let name = target ? table[target.key]?.name ?? target.label : null;
  if (!name) {
    const base = stripExtension(file.name) || '预设';
    const ours = table[presetKey(apiId, base)]?.workId === workId;
    const existing = ours ? [] : ((await tavern.listPresetNames?.(apiId)) ?? []);
    name = uniqueName(base, existing);
  }
  const result = await tavern.importPreset({ apiId, name, data });
  table[presetKey(apiId, result.name)] = { ...source, apiId, name: result.name, fileName: file.name };
  tavern.saveSettings();
  return { kind: 'preset', name: result.name, key: presetKey(apiId, result.name), refreshed: result.refreshed };
}

/**
 * 导入收件箱里的一条：能一键导入的文件全部导入，然后 ack。
 * 全部是不支持的类型时不 ack（留在收件箱里，用户下载后可以手动「标记已处理」）。
 * @returns {Promise<{imported:any[], errors:{file:any, message:string}[], manual:any[], acked:string|null}>}
 */
export async function importInboxItem({ api, tavern, settings, item }) {
  const files = item.files ?? [];
  const manual = files.filter((f) => !isSupportedKind(f.kind));
  const supported = files.filter((f) => isSupportedKind(f.kind));
  const imported = [];
  const errors = [];
  for (const file of supported) {
    try {
      imported.push(
        await importFile({ api, tavern, settings, workId: item.work.id, versionId: item.version.id, file }),
      );
    } catch (err) {
      errors.push({ file, message: err?.message ?? String(err) });
    }
  }
  let acked = null;
  if (supported.length) {
    acked = errors.length ? 'failed' : 'imported';
    try {
      await api.ack(item.id, acked, errors.length ? errors.map((e) => e.message).join('；') : undefined);
    } catch {
      // ack 失败不影响已经导入的内容；条目 7 天后自然过期
      acked = null;
    }
  }
  return { imported, errors, manual, acked };
}

/**
 * 应用一条更新：用新版本的对应文件覆盖本地那一份。
 * @param {{api:any, tavern:any, settings:any, update:{entry:any, latest:any, file:any}}} args
 */
export async function applyUpdate({ api, tavern, settings, update }) {
  if (!update.file) throw new Error('新版本里没有同类型的文件，请到平台网页查看。');
  const result = await importFile({
    api,
    tavern,
    settings,
    workId: update.entry.workId,
    versionId: update.latest.id,
    file: update.file,
    target: update.entry,
  });
  settings.pendingUpdates = (settings.pendingUpdates ?? []).filter(
    (u) => !(u.entry.kind === update.entry.kind && u.entry.key === update.entry.key),
  );
  tavern.saveSettings();
  return result;
}
