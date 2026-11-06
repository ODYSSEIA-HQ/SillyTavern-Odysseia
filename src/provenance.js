// 来源识别：哪些卡/世界书/预设是从平台导入的、导入的是哪个版本。
// 角色卡看 data.extensions.odysseia，世界书/预设看插件设置里的来源表。不扫描内容。

export const SUPPORTED_KINDS = ['character', 'worldbook', 'preset'];

export const KIND_LABELS = {
  character: '角色卡',
  worldbook: '世界书',
  preset: '预设',
  quickreply: '快速回复',
  theme: '主题',
  regex: '正则',
  other: '其他文件',
};

export function isSupportedKind(kind) {
  return SUPPORTED_KINDS.includes(kind);
}

/** 生成来源记录 */
export function makeSource({ workId, versionId, fileId, importedAt = Date.now() }) {
  return { workId: String(workId), versionId: String(versionId), fileId: String(fileId), importedAt };
}

function validSource(source) {
  return Boolean(
    source && typeof source === 'object' && typeof source.workId === 'string' && typeof source.versionId === 'string',
  );
}

/** 角色（酒馆 characters 数组里的一项）上的来源，没有返回 null */
export function characterSource(character) {
  const source = character?.data?.extensions?.odysseia;
  return validSource(source) ? source : null;
}

/** 预设在来源表里的键：同名预设在不同 API 下是不同文件 */
export function presetKey(apiId, name) {
  return `${apiId}/${name}`;
}

/** 空的来源表 */
export function emptySourceTable() {
  return { worldbook: {}, preset: {} };
}

/**
 * 汇总已安装的平台内容。
 * @param {{characters?: any[], sources?: {worldbook?: object, preset?: object}}} input
 * @returns {{kind:string, key:string, label:string, workId:string, versionId:string, fileId?:string, apiId?:string}[]}
 */
export function collectInstalled({ characters = [], sources = emptySourceTable() }) {
  const installed = [];
  for (const character of characters) {
    const source = characterSource(character);
    if (!source || !character.avatar) continue;
    installed.push({
      kind: 'character',
      key: character.avatar,
      label: character.name ?? character.avatar,
      workId: source.workId,
      versionId: source.versionId,
      fileId: source.fileId,
    });
  }
  for (const [name, source] of Object.entries(sources?.worldbook ?? {})) {
    if (!validSource(source)) continue;
    installed.push({ kind: 'worldbook', key: name, label: name, ...pick(source) });
  }
  for (const [key, source] of Object.entries(sources?.preset ?? {})) {
    if (!validSource(source)) continue;
    const label = source.name ?? key.slice(key.indexOf('/') + 1);
    installed.push({ kind: 'preset', key, label, apiId: source.apiId, ...pick(source) });
  }
  return installed;
}

function pick(source) {
  return { workId: source.workId, versionId: source.versionId, fileId: source.fileId };
}

/** 更新检查请求体：按 (workId, versionId) 去重 */
export function buildUpdateCheckItems(installed) {
  const seen = new Set();
  const items = [];
  for (const entry of installed) {
    const key = `${entry.workId}\n${entry.versionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ workId: entry.workId, versionId: entry.versionId });
  }
  return items;
}

/** 某个作品已经以什么形式装过（收件箱/链接导入时提示「已导入过」） */
export function findInstalledByWork(installed, workId) {
  return installed.filter((entry) => entry.workId === workId);
}
