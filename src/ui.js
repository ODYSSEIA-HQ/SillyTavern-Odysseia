// 设置面板的 HTML。纯函数：状态 → HTML 字符串；事件由 app.js 用 data-action 委托处理。
// 样式类沿用酒馆自带的 inline-drawer / menu_button / text_pole，其余在 style.css 里以 odys- 开头。

import { KIND_LABELS, isSupportedKind } from './provenance.js';
import { isInsecureRemote } from './links.js';
import { updateKey } from './updates.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CHANNEL_LABELS = { stable: '正式版', beta: '测试版', alpha: '尝鲜版' };

function channelTag(channel) {
  if (!channel || channel === 'stable') return '';
  return `<span class="odys-tag">${escapeHtml(CHANNEL_LABELS[channel] ?? channel)}</span>`;
}

function button(action, label, { id = '', primary = false, disabled = false, title = '' } = {}) {
  return `<button type="button" class="menu_button odys-btn${primary ? ' odys-btn-primary' : ''}" data-action="${action}"${
    id ? ` data-id="${escapeHtml(id)}"` : ''
  }${disabled ? ' disabled' : ''}${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</button>`;
}

function message(msg) {
  if (!msg) return '';
  return `<div class="odys-msg odys-msg-${escapeHtml(msg.level ?? 'info')}" role="status">${escapeHtml(msg.text)}</div>`;
}

function fileList(files) {
  return `<ul class="odys-files">${files
    .map(
      (f) => `<li>
        <span class="odys-kind${isSupportedKind(f.kind) ? '' : ' odys-kind-manual'}">${escapeHtml(KIND_LABELS[f.kind] ?? f.kind)}</span>
        <span class="odys-file-name">${escapeHtml(f.name)}</span>
        <span class="odys-muted">${escapeHtml(formatSize(f.size))}</span>
        ${isSupportedKind(f.kind) ? '' : button('download', '下载', { id: f.id, title: '这种类型暂不支持一键导入，下载后在酒馆里手动导入' })}
      </li>`,
    )
    .join('')}</ul>`;
}

function renderAccount(state, settings) {
  const insecure = settings.siteUrl && isInsecureRemote(settings.siteUrl);
  if (settings.token && settings.account) {
    const a = settings.account;
    return `<section class="odys-section">
      <div class="odys-account">
        <div>
          <div>当前账号：<b>${escapeHtml(a.name)}</b></div>
          <div class="odys-muted">${escapeHtml(settings.siteUrl)} · R18 内容：${a.canViewR18 ? '可查看' : '不可查看'}</div>
        </div>
        ${button('logout', '登出')}
      </div>
      ${insecure ? '<div class="odys-msg odys-msg-warning">平台地址不是 https，令牌会明文传输。</div>' : ''}
      ${message(state.accountMsg)}
    </section>`;
  }
  return `<section class="odys-section">
    <label class="odys-label" for="odys-site">平台地址</label>
    <input id="odys-site" class="text_pole" type="url" placeholder="平台网址，如 https://example.com" value="${escapeHtml(state.siteDraft ?? settings.siteUrl)}" />
    <label class="odys-label" for="odys-token">插件令牌</label>
    <input id="odys-token" class="text_pole" type="password" autocomplete="off" spellcheck="false" placeholder="odp_ 开头的令牌" />
    <div class="odys-hint">在平台网页「设置 → 酒馆插件」里创建令牌，复制后粘贴到这里。令牌只显示一次。</div>
    <div class="odys-row">${button('login', state.busy.login ? '正在登录…' : '登录', { primary: true, disabled: state.busy.login })}</div>
    ${message(state.accountMsg)}
  </section>`;
}

const BATCH_STATUS = {
  ready: '待导入',
  importing: '正在导入…',
  done: '成功',
  latest: '跳过',
  manual: '跳过',
  error: '无法导入',
  failed: '失败',
};

function batchItem(item) {
  const work = item.data?.work;
  const version = item.data?.latestVersion;
  const showFiles = item.status === 'manual' || (item.data?.files ?? []).some((f) => !isSupportedKind(f.kind));
  return `<div class="odys-item odys-batch-item odys-batch-${escapeHtml(item.status)}" data-work="${escapeHtml(item.workId)}">
    <div class="odys-item-head">
      ${work?.cover ? `<img class="odys-cover" src="${escapeHtml(work.cover)}" alt="" loading="lazy" />` : '<div class="odys-cover odys-cover-empty"></div>'}
      <div class="odys-item-main">
        <div class="odys-title">${escapeHtml(work?.title ?? item.workId)} <span class="odys-status">${escapeHtml(BATCH_STATUS[item.status] ?? '')}</span></div>
        ${work ? `<div class="odys-muted"><span class="odys-kind">${escapeHtml(KIND_LABELS[work.type] ?? work.type ?? '作品')}</span> ${escapeHtml(version?.name ?? '')} ${channelTag(version?.channel)}</div>` : `<div class="odys-muted">作品编号 ${escapeHtml(item.workId)}</div>`}
        ${item.installed?.length ? `<div class="odys-muted">已导入过：${item.installed.map((e) => escapeHtml(e.label)).join('、')}</div>` : ''}
      </div>
    </div>
    ${showFiles ? fileList(item.data.files ?? []) : ''}
    ${item.message ? message({ level: item.level ?? 'info', text: item.message }) : ''}
  </div>`;
}

function renderBatch(state) {
  const b = state.batch;
  if (!b) return '';
  const ready = b.items.filter((i) => i.status === 'ready').length;
  let head = '';
  let actions = '';
  if (b.phase === 'lookup') {
    head = `正在查询作品 ${b.progress.done}/${b.progress.total}…`;
  } else if (b.phase === 'preview') {
    head = ready ? `将导入以下 ${ready} 个作品，确认后开始：` : '没有可以导入的作品。';
    actions = `<div class="odys-row">
      ${ready ? button('confirm-batch', `确认导入 ${ready} 个`, { primary: true }) : ''}
      ${button('cancel-batch', ready ? '取消' : '关闭')}
    </div>`;
  } else if (b.phase === 'importing') {
    head = `正在导入 ${b.progress.done}/${b.progress.total}…`;
  } else {
    head = '导入结果：';
    actions = `<div class="odys-row">${button('cancel-batch', '关闭')}</div>`;
  }
  const invalid = b.invalid?.length
    ? message({ level: 'warning', text: `以下内容没认出是作品链接，已跳过：\n${b.invalid.join('\n')}` })
    : '';
  return `<div class="odys-batch">
    <div class="odys-muted odys-progress" role="status">${escapeHtml(head)}</div>
    ${invalid}
    ${b.items.map(batchItem).join('')}
    ${actions}
  </div>`;
}

function renderLink(state) {
  const working = state.busy.lookup || state.busy.batch;
  return `<section class="odys-section">
    <h4>粘贴作品链接导入</h4>
    <textarea id="odys-link" class="text_pole odys-links" rows="4" spellcheck="false" placeholder="粘贴作品页链接或作品编号，可以一次粘贴很多个，一行一个">${escapeHtml(state.linkDraft ?? '')}</textarea>
    <div class="odys-hint">在平台网页点「复制全部导入链接」，粘贴到这里即可批量导入。</div>
    <div class="odys-row">${button('preview-links', state.busy.lookup ? '查询中…' : '导入', { primary: true, disabled: working })}</div>
    ${renderBatch(state)}
    ${message(state.linkMsg)}
  </section>`;
}

function renderUpdates(state, settings) {
  const updates = settings.pendingUpdates ?? [];
  const list = updates
    .map((u) => {
      const key = updateKey(u);
      const busy = state.busy[`update:${key}`];
      return `<div class="odys-item">
        <div class="odys-title">${escapeHtml(u.entry.label)} <span class="odys-kind">${escapeHtml(KIND_LABELS[u.entry.kind] ?? '')}</span></div>
        <div class="odys-muted">新版本：${escapeHtml(u.latest.name)} ${channelTag(u.latest.channel)}${u.latest.publishedAt ? ` · ${escapeHtml(formatTime(u.latest.publishedAt))}` : ''}</div>
        ${u.latest.changelog ? `<div class="odys-changelog">${escapeHtml(u.latest.changelog)}</div>` : ''}
        <div class="odys-row">
          ${button('apply-update', busy ? '正在更新…' : '更新', { id: key, primary: true, disabled: busy || !u.file })}
          ${button('ignore-update', '忽略此版本', { id: key, disabled: busy })}
        </div>
        ${message(state.itemMsg[`update:${key}`])}
      </div>`;
    })
    .join('');
  const last = settings.lastUpdateCheckAt ? `上次检查：${formatTime(settings.lastUpdateCheckAt)}` : '还没检查过';
  return `<section class="odys-section">
    <div class="odys-section-head">
      <h4>更新${updates.length ? ` <span class="odys-count odys-count-accent">${updates.length}</span>` : ''}</h4>
      ${button('check-updates', state.busy.updates ? '检查中…' : '检查更新', { disabled: state.busy.updates })}
    </div>
    ${list || `<div class="odys-empty">从平台导入的内容都是最新的。<span class="odys-muted">${escapeHtml(last)}</span></div>`}
    ${list ? `<div class="odys-muted">${escapeHtml(last)}；每 6 小时自动检查一次。</div>` : ''}
    ${message(state.updatesMsg)}
  </section>`;
}

/** 面板主体 */
export function renderPanelBody(state, settings) {
  const loggedIn = Boolean(settings.token && settings.account);
  return [
    renderAccount(state, settings),
    loggedIn ? renderLink(state) : '',
    loggedIn ? renderUpdates(state, settings) : '',
  ].join('');
}

/** 抽屉外壳（只渲染一次；之后只重绘主体，避免抽屉开合状态被重置） */
export function renderDrawerShell() {
  return `<div class="odysseia-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Odysseia 平台</b>
        <span class="odys-badge" hidden></span>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="odys-body"></div>
      </div>
    </div>
  </div>`;
}

/** 徽标文字：只数更新 */
export function badgeText(settings) {
  const n = settings.token ? (settings.pendingUpdates ?? []).length : 0;
  return n ? `${n} 个更新` : '';
}
