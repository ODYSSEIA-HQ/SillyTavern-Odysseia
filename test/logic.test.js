// 纯逻辑：链接解析、来源识别、更新比对、角色卡 PNG 读写
import { describe, expect, it } from 'vitest';
import { normalizeSiteUrl, parseWorkRef, parseWorkRefs, parseImportParam, isInsecureRemote, MAX_BATCH } from '../src/links.js';
import {
  buildUpdateCheckItems,
  characterSource,
  collectInstalled,
  findInstalledByWork,
  makeSource,
  presetKey,
} from '../src/provenance.js';
import { isCheckDue, matchUpdates, newlyFound, pickFileForEntry, CHECK_INTERVAL_MS } from '../src/updates.js';
import {
  base64ToUtf8,
  isPng,
  readCardFromPng,
  readPngChunks,
  utf8ToBase64,
  withOdysseiaSource,
  writeCardToPng,
  writePngChunks,
} from '../src/card.js';
import { makeCardPng } from './fake-platform.mjs';

describe('parseWorkRef 作品链接解析', () => {
  it.each([
    ['https://odysseia.example/works/w_013', 'w_013'],
    ['https://odysseia.example/works/w_013/versions/v2?tab=files#top', 'w_013'],
    ['http://127.0.0.1:5173/share/works/abc-1', 'abc-1'],
    ['/works/w_old_sprout', 'w_old_sprout'],
    ['works/w_1?x=1', 'w_1'],
    ['  w_013  ', 'w_013'],
    ['odysseia.example/works/w_9', 'w_9'],
  ])('%s → %s', (input, expected) => {
    expect(parseWorkRef(input)).toBe(expected);
  });

  it.each(['', '   ', 'https://odysseia.example/users/u1', 'https://odysseia.example/works/', '不是链接 呢', 'works'])(
    '认不出：%s',
    (input) => {
      expect(parseWorkRef(input)).toBeNull();
    },
  );
});

describe('parseWorkRefs 批量解析', () => {
  it('换行、空格、逗号（含中文逗号、顿号）分隔，去重保持顺序，列出解析不了的', () => {
    const text = [
      'https://odysseia.example/works/w_1',
      '  https://odysseia.example/share/works/w_2?from=x  ',
      '',
      'w_3, w_1，w_4、/works/w_2',
      '看看这个 https://odysseia.example/users/9',
    ].join('\n');
    expect(parseWorkRefs(text)).toEqual({
      ids: ['w_1', 'w_2', 'w_3', 'w_4'],
      invalid: ['看看这个', 'https://odysseia.example/users/9'],
    });
  });

  it('空输入', () => {
    expect(parseWorkRefs('  \n ')).toEqual({ ids: [], invalid: [] });
    expect(parseWorkRefs(null)).toEqual({ ids: [], invalid: [] });
  });
});

describe('parseImportParam 网址参数', () => {
  it('逗号分隔的作品编号，去重，忽略非法的', () => {
    expect(parseImportParam('w_1,w_2, w_1,,<script>,https://x/works/w_9')).toEqual(['w_1', 'w_2']);
    expect(parseImportParam('')).toEqual([]);
    expect(parseImportParam(null)).toEqual([]);
  });

  it('最多取 MAX_BATCH 个', () => {
    const many = Array.from({ length: MAX_BATCH + 5 }, (_, i) => `w${i}`).join(',');
    expect(parseImportParam(many)).toHaveLength(MAX_BATCH);
  });
});

describe('normalizeSiteUrl 平台地址', () => {
  it('站点首页补上 /api/v1', () => {
    expect(normalizeSiteUrl('https://odysseia.example/')).toEqual({
      siteUrl: 'https://odysseia.example',
      apiRoot: 'https://odysseia.example/api/v1',
    });
  });
  it('填了接口根也能认', () => {
    expect(normalizeSiteUrl('https://odysseia.example/api/v1/')?.siteUrl).toBe('https://odysseia.example');
  });
  it('不带协议默认 https', () => {
    expect(normalizeSiteUrl('odysseia.example')?.apiRoot).toBe('https://odysseia.example/api/v1');
  });
  it('非法地址返回 null', () => {
    expect(normalizeSiteUrl('')).toBeNull();
    expect(normalizeSiteUrl('ftp://x.com')).toBeNull();
    expect(normalizeSiteUrl('http://')).toBeNull();
  });
  it('远程 http 提示不安全，本机不提示', () => {
    expect(isInsecureRemote('http://example.com')).toBe(true);
    expect(isInsecureRemote('http://127.0.0.1:8787')).toBe(false);
    expect(isInsecureRemote('https://example.com')).toBe(false);
  });
});

describe('来源识别', () => {
  const characters = [
    { name: '莉莉', avatar: '莉莉.png', data: { extensions: { odysseia: makeSource({ workId: 'w_lily', versionId: 'v1', fileId: 'f1', importedAt: 1 }) } } },
    { name: '自己做的', avatar: 'mine.png', data: { extensions: {} } },
    { name: '坏数据', avatar: 'bad.png', data: { extensions: { odysseia: { workId: 1 } } } },
    { name: '无头像', data: { extensions: { odysseia: { workId: 'w_x', versionId: 'v' } } } },
  ];
  const sources = {
    worldbook: { 港口城: { workId: 'w_harbor', versionId: 'v_h1', fileId: 'fh' } },
    preset: { [presetKey('openai', '叙事')]: { workId: 'w_preset', versionId: 'v_p1', fileId: 'fp', apiId: 'openai', name: '叙事' } },
  };

  it('只认 data.extensions.odysseia 里结构正确的来源', () => {
    expect(characterSource(characters[0])?.workId).toBe('w_lily');
    expect(characterSource(characters[1])).toBeNull();
    expect(characterSource(characters[2])).toBeNull();
    expect(characterSource(null)).toBeNull();
  });

  it('汇总角色卡、世界书、预设', () => {
    const installed = collectInstalled({ characters, sources });
    expect(installed.map((e) => [e.kind, e.key, e.workId])).toEqual([
      ['character', '莉莉.png', 'w_lily'],
      ['worldbook', '港口城', 'w_harbor'],
      ['preset', 'openai/叙事', 'w_preset'],
    ]);
    expect(installed[2]).toMatchObject({ label: '叙事', apiId: 'openai' });
    expect(findInstalledByWork(installed, 'w_harbor')).toHaveLength(1);
  });

  it('更新请求按 (workId, versionId) 去重', () => {
    const items = buildUpdateCheckItems([
      { workId: 'a', versionId: '1' },
      { workId: 'a', versionId: '1' },
      { workId: 'a', versionId: '2' },
    ]);
    expect(items).toEqual([
      { workId: 'a', versionId: '1' },
      { workId: 'a', versionId: '2' },
    ]);
  });
});

describe('更新比对', () => {
  const installed = [
    { kind: 'character', key: 'a.png', label: 'A', workId: 'w1', versionId: 'v1' },
    { kind: 'worldbook', key: 'B', label: 'B', workId: 'w2', versionId: 'v1' },
    { kind: 'character', key: 'a2.png', label: 'A 旧副本', workId: 'w1', versionId: 'v0' },
  ];
  const results = [
    {
      workId: 'w1',
      currentVersionId: 'v1',
      latest: { id: 'v2', name: '2.0', publishedAt: '2026-10-01T00:00:00Z' },
      files: [{ id: 'f9', kind: 'character', name: 'a.png' }],
    },
    {
      workId: 'w2',
      currentVersionId: 'v1',
      latest: { id: 'v3', name: '3.0', publishedAt: '2026-10-30T00:00:00Z' },
      files: [{ id: 'g', kind: 'character', name: 'x.png' }],
    },
  ];

  it('按 currentVersionId 对回本地条目，新的排前面', () => {
    const updates = matchUpdates(installed, results);
    expect(updates.map((u) => [u.entry.key, u.latest.id, u.file?.id ?? null])).toEqual([
      ['B', 'v3', null],
      ['a.png', 'v2', 'f9'],
    ]);
  });

  it('忽略过的版本不再出现，更新的版本仍会出现', () => {
    expect(matchUpdates(installed, results, { w1: 'v2' }).map((u) => u.entry.key)).toEqual(['B']);
    expect(matchUpdates(installed, results, { w1: 'v1' })).toHaveLength(2);
  });

  it('本地已经是最新版时不算更新', () => {
    expect(matchUpdates([{ ...installed[0], versionId: 'v2' }], [{ ...results[0], currentVersionId: undefined }])).toEqual([]);
  });

  it('挑文件：同类型优先，多个时按文件名', () => {
    const files = [
      { id: '1', kind: 'worldbook', name: 'x.json' },
      { id: '2', kind: 'character', name: 'a.png' },
      { id: '3', kind: 'character', name: 'b.png' },
    ];
    expect(pickFileForEntry({ kind: 'character', fileName: 'b.png' }, files)?.id).toBe('3');
    expect(pickFileForEntry({ kind: 'character' }, files)?.id).toBe('2');
    expect(pickFileForEntry({ kind: 'worldbook' }, files)?.id).toBe('1');
    expect(pickFileForEntry({ kind: 'preset' }, files)).toBeNull();
  });

  it('6 小时到期判断', () => {
    const now = 1_000_000_000_000;
    expect(isCheckDue(0, now)).toBe(true);
    expect(isCheckDue(now - CHECK_INTERVAL_MS + 1, now)).toBe(false);
    expect(isCheckDue(now - CHECK_INTERVAL_MS, now)).toBe(true);
    expect(isCheckDue(now + 1000, now)).toBe(true);
  });

  it('只提醒没提醒过的版本', () => {
    const updates = matchUpdates(installed, results);
    expect(newlyFound(updates, { w1: 'v2' }).map((u) => u.entry.workId)).toEqual(['w2']);
  });
});

describe('角色卡 PNG', () => {
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '莉莉', description: '中文和 emoji 🌸', extensions: { other: 1 } } };

  it('base64 UTF-8 往返', () => {
    expect(base64ToUtf8(utf8ToBase64('你好 🌸 abc'))).toBe('你好 🌸 abc');
  });

  it('读出 chara 块', () => {
    const png = makeCardPng(card);
    expect(isPng(png)).toBe(true);
    expect(readCardFromPng(png)).toEqual(card);
    expect(readCardFromPng(makeCardPng(null))).toBeNull();
  });

  it('写入来源后能读回，图像块保持不变，其他扩展字段保留', () => {
    const png = makeCardPng(card);
    const source = makeSource({ workId: 'w', versionId: 'v', fileId: 'f', importedAt: 5 });
    const out = writeCardToPng(png, withOdysseiaSource(card, source));
    const back = readCardFromPng(out);
    expect(back.data.extensions).toEqual({ other: 1, odysseia: source });
    expect(card.data.extensions.odysseia).toBeUndefined();
    const idat = (bytes) => readPngChunks(bytes).find((c) => c.type === 'IDAT').data;
    expect(Array.from(idat(out))).toEqual(Array.from(idat(png)));
    expect(readPngChunks(out).at(-1).type).toBe('IEND');
    expect(readPngChunks(out).filter((c) => c.type === 'tEXt')).toHaveLength(1);
  });

  it('原来有 ccv3 块时两块都更新，读取优先 ccv3', () => {
    const png = makeCardPng(card);
    // 手工加一个 ccv3 块
    const withV3 = writeCardToPng(png, card);
    const chunks = readPngChunks(withV3);
    const v3Text = new TextEncoder().encode(`ccv3\0${utf8ToBase64(JSON.stringify({ ...card, spec: 'chara_card_v3' }))}`);
    const iend = chunks.length - 1;
    const rebuilt = [...chunks.slice(0, iend), { type: 'tEXt', data: v3Text }, chunks[iend]];
    const v3png = writePngChunks(rebuilt);
    const out = writeCardToPng(v3png, withOdysseiaSource(card, { workId: 'w', versionId: 'v', fileId: 'f' }));
    const texts = readPngChunks(out).filter((c) => c.type === 'tEXt');
    expect(texts).toHaveLength(2);
    const back = readCardFromPng(out);
    expect(back.spec).toBe('chara_card_v3');
    expect(back.data.extensions.odysseia.workId).toBe('w');
  });

  it('不是 PNG 时报错', () => {
    expect(() => readPngChunks(new Uint8Array([1, 2, 3]))).toThrow('不是 PNG');
  });
});
