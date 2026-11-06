// Odysseia 平台助手 —— SillyTavern UI 扩展入口（manifest.json 的 js）。
// 酒馆以 ES 模块加载本文件；这里只负责组装，逻辑在 src/ 下，和酒馆打交道的部分全在 src/tavern.js。

import { createApp } from './src/app.js';
import { createTavernAdapter } from './src/tavern.js';

function boot() {
  try {
    const tavern = createTavernAdapter();
    const app = createApp({ tavern });
    app.mount();
    app.start();
    globalThis.__odysseiaExtension = app;
  } catch (err) {
    console.error('[Odysseia] 插件启动失败', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
