// 更新比对：把 /updates/check 的结果对回本地已安装的条目。纯逻辑。

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 距上次检查是否已满 6 小时（时钟回拨也算到期） */
export function isCheckDue(lastCheckedAt, now = Date.now(), interval = CHECK_INTERVAL_MS) {
  if (!lastCheckedAt) return true;
  if (now < lastCheckedAt) return true;
  return now - lastCheckedAt >= interval;
}

/**
 * 在新版本的文件里挑出对应本地条目的那个：同类型优先，多个同类型时按原文件名匹配，否则取第一个。
 * @param {{kind:string, fileName?:string}} entry
 * @param {{id:string, name:string, kind:string}[]} files
 */
export function pickFileForEntry(entry, files = []) {
  const sameKind = files.filter((f) => f.kind === entry.kind);
  if (sameKind.length <= 1) return sameKind[0] ?? null;
  if (entry.fileName) {
    const byName = sameKind.find((f) => f.name === entry.fileName);
    if (byName) return byName;
  }
  return sameKind[0];
}

/**
 * @param {ReturnType<import('./provenance.js').collectInstalled>} installed
 * @param {{workId:string, currentVersionId:string, latest:{id:string,name:string,channel?:string,publishedAt?:string,changelog?:string}, files:any[]}[]} results
 * @param {Record<string,string>} [dismissed] workId → 用户选择忽略的版本 id
 * @returns {{entry:any, latest:any, file:any|null}[]}
 */
export function matchUpdates(installed, results, dismissed = {}) {
  const updates = [];
  for (const result of results ?? []) {
    if (!result?.latest?.id) continue;
    if (dismissed[result.workId] === result.latest.id) continue;
    for (const entry of installed) {
      if (entry.workId !== result.workId) continue;
      if (entry.versionId === result.latest.id) continue;
      if (result.currentVersionId && entry.versionId !== result.currentVersionId) continue;
      updates.push({ entry, latest: result.latest, file: pickFileForEntry(entry, result.files) });
    }
  }
  updates.sort((a, b) => String(b.latest.publishedAt ?? '').localeCompare(String(a.latest.publishedAt ?? '')));
  return updates;
}

/** 更新条目的唯一键（界面上用） */
export function updateKey(update) {
  return `${update.entry.kind}:${update.entry.key}`;
}

/** 提示文案：比上次多出来的新版本才弹 toastr，避免每 6 小时重复打扰 */
export function newlyFound(updates, notifiedVersions = {}) {
  return updates.filter((u) => notifiedVersions[u.entry.workId] !== u.latest.id);
}
