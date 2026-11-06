// 角色卡文件处理：PNG 里的 tEXt 块（chara / ccv3）读写、JSON 卡的来源字段。
// 纯逻辑，不依赖酒馆；浏览器和 Node 都能跑（只用 TextEncoder/TextDecoder/atob/btoa）。

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** 角色卡常用的两个 tEXt 关键字：V2 卡用 chara，V3 卡额外带 ccv3 */
const CARD_KEYWORDS = ['chara', 'ccv3'];

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** UTF-8 字符串 → base64（不用 Buffer，浏览器可用） */
export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** base64 → UTF-8 字符串 */
export function base64ToUtf8(b64) {
  const binary = atob(b64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function latin1Bytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** 把 PNG 拆成块：[{type, data}]（data 不含长度和 CRC） */
export function readPngChunks(bytes) {
  if (!isPng(bytes)) throw new Error('不是 PNG 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1(bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error('PNG 文件不完整');
    chunks.push({ type, data: bytes.subarray(start, end) });
    offset = end + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** 把块拼回 PNG（重新计算 CRC） */
export function writePngChunks(chunks) {
  const total = 8 + chunks.reduce((sum, c) => sum + 12 + c.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let offset = 8;
  for (const chunk of chunks) {
    const typeBytes = latin1Bytes(chunk.type);
    view.setUint32(offset, chunk.data.length);
    out.set(typeBytes, offset + 4);
    out.set(chunk.data, offset + 8);
    const crcInput = new Uint8Array(4 + chunk.data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(chunk.data, 4);
    view.setUint32(offset + 8 + chunk.data.length, crc32(crcInput));
    offset += 12 + chunk.data.length;
  }
  return out;
}

function parseTextChunk(data) {
  const zero = data.indexOf(0);
  if (zero < 0) return null;
  return { keyword: latin1(data.subarray(0, zero)), text: latin1(data.subarray(zero + 1)) };
}

function makeTextChunk(keyword, text) {
  return { type: 'tEXt', data: latin1Bytes(`${keyword}\0${text}`) };
}

/** 读 PNG 里的角色卡 JSON：优先 ccv3，其次 chara；没有返回 null */
export function readCardFromPng(bytes) {
  const texts = {};
  for (const chunk of readPngChunks(bytes)) {
    if (chunk.type !== 'tEXt') continue;
    const parsed = parseTextChunk(chunk.data);
    if (parsed && CARD_KEYWORDS.includes(parsed.keyword.toLowerCase())) {
      texts[parsed.keyword.toLowerCase()] = parsed.text;
    }
  }
  const raw = texts.ccv3 ?? texts.chara;
  if (raw === undefined) return null;
  return JSON.parse(base64ToUtf8(raw));
}

/**
 * 把角色卡 JSON 写回 PNG：替换原有 chara（和 ccv3，若原来有）块，插在 IEND 前。
 * 原图没有卡数据时只写 chara。
 */
export function writeCardToPng(bytes, card) {
  const chunks = readPngChunks(bytes);
  const hadV3 = chunks.some((c) => c.type === 'tEXt' && parseTextChunk(c.data)?.keyword.toLowerCase() === 'ccv3');
  const kept = chunks.filter((c) => {
    if (c.type !== 'tEXt') return true;
    const parsed = parseTextChunk(c.data);
    return !parsed || !CARD_KEYWORDS.includes(parsed.keyword.toLowerCase());
  });
  const encoded = utf8ToBase64(JSON.stringify(card));
  const cardChunks = [makeTextChunk('chara', encoded)];
  if (hadV3) {
    // V3 块的 spec 字段应是 chara_card_v3；保持原卡的其他内容不变
    const v3 = { ...card, spec: 'chara_card_v3', spec_version: card.spec_version ?? '3.0' };
    cardChunks.push(makeTextChunk('ccv3', utf8ToBase64(JSON.stringify(v3))));
  }
  const iend = kept.findIndex((c) => c.type === 'IEND');
  const insertAt = iend < 0 ? kept.length : iend;
  return writePngChunks([...kept.slice(0, insertAt), ...cardChunks, ...kept.slice(insertAt)]);
}

/** 给卡写上来源（返回新对象，不改原对象）：data.extensions.odysseia */
export function withOdysseiaSource(card, source) {
  const next = structuredClone(card ?? {});
  if (!next.data || typeof next.data !== 'object') next.data = {};
  if (!next.data.extensions || typeof next.data.extensions !== 'object') next.data.extensions = {};
  next.data.extensions.odysseia = { ...source };
  return next;
}

/** 卡的显示名 */
export function cardName(card) {
  return card?.data?.name ?? card?.name ?? null;
}
