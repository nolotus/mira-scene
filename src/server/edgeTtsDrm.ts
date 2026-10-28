/**
 * `Sec-MS-GEC` 令牌生成器：本机 `edge_tts/drm.py` 的**逐位移植**。
 *
 * 为什么照抄而不是用标准 SHA-256：
 * 我们在复刻一个**客户端令牌生成器**，不是在实现密码学原语。服务端只认它能自己算出来的那一串，
 * 「这是不是标准 SHA-256」对校验毫无意义。`drm.py` 里那些看起来像笔误的地方——第 14 轮常量被换成
 * `0xC9DC06A7`、`_sigma0/_sigma1` 的额外 XOR 偏移、`data[:7]` 当初始状态、padding 长度用
 * `57 + len(data)`、末尾再拼一段 16 hex 的 CS64 前缀——全部是**协议事实**，改任何一处都会 403。
 *
 * 唯一保留的对照物：`sha256TokenStandard()`（标准 SHA-256 版本的同一算法）。它不是备选实现，
 * 只是用来在测试里把「两者不同」这件事钉住，避免以后有人把它当成随手可换的实现细节。
 *
 * 移植纪律：
 *  - 所有 32 位运算走 `>>> 0` / `| 0`，不依赖 JS 的 53 位浮点。
 *  - 两个 32 位整数相乘会到 2^64，超过双精度可精确表示的范围 → 一律用 `Math.imul` 取低 32 位。
 *  - 不要「优化」循环（比如把展开的 8 轮折回循环）—— 这段代码的价值就在于和源码一一对应，
 *    能对着 `drm.py` 逐行看。可读性换正确性是这个文件唯一正确的取舍。
 *
 * 与 `drm.py` 的对应关系（函数名一致，便于对照）：
 *   _rol16 ↔ rol16 · _words_le4_even ↔ wordsLe4Even · _sigma0/_sigma1 ↔ sigma0/sigma1
 *   _sha256_rounds ↔ sha256Rounds · _expand_sha256_schedule ↔ expandSha256Schedule
 *   _sha256_init ↔ sha256Init · _sha256_digest ↔ sha256Digest · _cs64_digest ↔ cs64Digest
 *   _token_hash ↔ tokenHash · generate_sec_ms_gec_v2 ↔ generateSecMsGec
 */

import { createHash } from "node:crypto";

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/** Windows FILETIME 的纪元差（秒） */
export const WIN_EPOCH_SECONDS = 11_644_473_600;
/** 令牌窗口（秒）：向下取整到 5 分钟 */
export const TOKEN_WINDOW_SECONDS = 300;



// ------------------------------------------------------------------ 常量表

/** FIPS 180-4 的初始状态（标准值，未改动） */
const SHA256_INITIAL_ = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** 起始工作状态（`drm.py` 里就不是标准初值，照抄） */
const SHA256_STATE_ = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];

/** 前 14 个调度字（`_sha256_init` 用它铺底） */
const SHA256_SCHEDULE_ = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];

/** 轮常量：标准 SHA-256 的 K 表 */
export const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** 第 14 轮常量被替换过（协议事实，不是笔误） */
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

// ------------------------------------------------------------------ 位运算助手

const u32 = (value: number): number => value >>> 0;

/** 32 位无符号乘法（低 32 位）。`a*b` 会到 2^64，双精度算不准，必须走 imul。 */
const mul32 = (a: number, b: number): number => Math.imul(a >>> 0, b >>> 0) >>> 0;

/** `_rol16`：左旋 16 位（等价于交换高低半字） */
function rol16(value: number): number {
  const v = value >>> 0;
  return (((v << 16) | (v >>> 16)) >>> 0) >>> 0;
}

function rotr(value: number, bits: number): number {
  const v = value >>> 0;
  return ((v >>> bits) | (v << (32 - bits))) >>> 0;
}

/** 小写 sigma 零（带源码里的额外 XOR 偏移） */
function sigma0(value: number): number {
  const v = value >>> 0;
  return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0;
}

/** 小写 sigma 一（带源码里的额外 XOR 偏移） */
function sigma1(value: number): number {
  const v = value >>> 0;
  return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0;
}

/** 大写 Σ1：`drm.py` 用 `e * (2^32+1)` 再右移来替代 ROTR，低 32 位等价 */
const bigSigma1 = (value: number): number =>
  ((rotr(value, 6) ^ rotr(value, 11) ^ rotr(value, 25)) >>> 0);
/** 大写 Σ0，同上 */
const bigSigma0 = (value: number): number =>
  ((rotr(value, 2) ^ rotr(value, 13) ^ rotr(value, 22)) >>> 0);

/** `_words_le4_even`：小端 32 位字，补零到 4 字节对齐，再补到偶数个 */
function wordsLe4Even(data: Uint8Array): number[] {
  const padded = new Uint8Array(Math.ceil(data.byteLength / 4) * 4);
  padded.set(data);
  const words: number[] = [];
  for (let offset = 0; offset < padded.byteLength; offset += 4) {
    words.push(
      (padded[offset]! | (padded[offset + 1]! << 8) | (padded[offset + 2]! << 16) | (padded[offset + 3]! << 24)) >>> 0,
    );
  }
  if (words.length % 2 === 1) words.push(0);
  return words;
}

// ------------------------------------------------------------------ SHA-256 变体

/**
 * `_sha256_rounds`：可从中途某轮开始跑。
 * 前半段用「轮转寄存器名」的写法，后半段（对齐到 8 的倍数之后）展开 8 轮。
 */
function sha256Rounds(state: readonly number[], words: number[], firstRound = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state.map(u32) as [number, number, number, number, number, number, number, number];
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);

  for (let index = firstRound; index < aligned; index += 1) {
    const t1 =
      h + bigSigma1(e) + (g ^ (e & (f ^ g))) + constants[index]! + words[index]!;
    const t2 = bigSigma0(a) + ((a & b) | (c & (a | b)));
    // 对应源码的 `a,b,c,d,e,f,g,h = newA, a, b, c, d+t1, e, f, g`（同时赋值，不能串着写）
    const nextA = (t1 + t2) >>> 0;
    const nextE = (d + t1) >>> 0;
    const pa = a;
    const pb = b;
    const pc = c;
    const pe = e;
    const pf = f;
    const pg = g;
    a = nextA;
    b = pa;
    c = pb;
    d = pc;
    e = nextE;
    f = pe;
    g = pf;
    h = pg;
  }

  for (let index = aligned; index < 64; index += 8) {
    // 每 8 轮寄存器名回到原位，所以只更新两个寄存器
    let t1 = h + bigSigma1(e) + (g ^ (e & (f ^ g))) + constants[index]! + words[index]!;
    d = (d + t1) >>> 0;
    h = (t1 + bigSigma0(a) + ((a & b) | (c & (a | b)))) >>> 0;

    t1 = g + bigSigma1(d) + (f ^ (d & (e ^ f))) + constants[index + 1]! + words[index + 1]!;
    c = (c + t1) >>> 0;
    g = (t1 + bigSigma0(h) + ((h & a) | (b & (h | a)))) >>> 0;

    t1 = f + bigSigma1(c) + (e ^ (c & (d ^ e))) + constants[index + 2]! + words[index + 2]!;
    b = (b + t1) >>> 0;
    f = (t1 + bigSigma0(g) + ((g & h) | (a & (g | h)))) >>> 0;

    t1 = e + bigSigma1(b) + (d ^ (b & (c ^ d))) + constants[index + 3]! + words[index + 3]!;
    a = (a + t1) >>> 0;
    e = (t1 + bigSigma0(f) + ((f & g) | (h & (f | g)))) >>> 0;

    t1 = d + bigSigma1(a) + (c ^ (a & (b ^ c))) + constants[index + 4]! + words[index + 4]!;
    h = (h + t1) >>> 0;
    d = (t1 + bigSigma0(e) + ((e & f) | (g & (e | f)))) >>> 0;

    t1 = c + bigSigma1(h) + (b ^ (h & (a ^ b))) + constants[index + 5]! + words[index + 5]!;
    g = (g + t1) >>> 0;
    c = (t1 + bigSigma0(d) + ((d & e) | (f & (d | e)))) >>> 0;

    t1 = b + bigSigma1(g) + (a ^ (g & (h ^ a))) + constants[index + 6]! + words[index + 6]!;
    f = (f + t1) >>> 0;
    b = (t1 + bigSigma0(c) + ((c & d) | (e & (c | d)))) >>> 0;

    t1 = a + bigSigma1(f) + (h ^ (f & (g ^ h))) + constants[index + 7]! + words[index + 7]!;
    e = (e + t1) >>> 0;
    a = (t1 + bigSigma0(b) + ((b & c) | (d & (b | c)))) >>> 0;
  }

  return [a, b, c, d, e, f, g, h];
}

function expandSha256Schedule(words: number[], firstWord = 16): void {
  for (let index = firstWord; index < 64; index += 1) {
    const x = words[index - 2]!;
    const y = words[index - 15]!;
    words.push(
      (sigma1(x) + words[index - 7]! + sigma0(y) + words[index - 16]!) >>> 0,
    );
  }
}

function sha256Init(data: Uint8Array): number[] {
  const words: number[] = new Array(14).fill(0);
  words.push(
    ((data[0]! << 16) | (data[1]! << 8) | data[2]!) >>> 0,
    ((data[3]! << 24) | (data[4]! << 16) | (data[5]! << 8) | data[6]!) >>> 0,
  );
  for (let index = 16; index < 30; index += 1) {
    let value = SHA256_SCHEDULE_[index - 16]!;
    if (index - 2 >= 14) {
      const term = sigma1(words[index - 2]!);
      value += index === 16 ? (term ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : term;
    }
    if (index - 7 >= 14) value += words[index - 7]!;
    if (index - 15 >= 14) {
      const term = sigma0(words[index - 15]!);
      value += index === 29 ? (term ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : term;
    }
    words.push(value >>> 0);
  }
  words.push(
    (sigma1(words[28]!) +
      words[23]! +
      sigma0(words[15]!) +
      words[14]! +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]!) >>>
      0,
  );
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE_, words, 14);
  return SHA256_INITIAL_.map((value, index) => (value + working[index]!) >>> 0);
}

export function sha256Digest(data: Uint8Array): Uint8Array {
  if (data.byteLength < 7) throw new Error("Token salt must contain at least seven bytes");
  const length = 57 + data.byteLength;
  const tailLength = ((55 - length) % 64 + 64) % 64;
  const padded = new Uint8Array(data.byteLength - 7 + 1 + tailLength + 8);
  padded.set(data.subarray(7), 0);
  padded[data.byteLength - 7] = 0x80;
  // 末尾 8 字节是大端比特长度（源码里就是 length*8，不是真实的字节长度 —— 协议事实）
  const bits = length * 8;
  padded[padded.byteLength - 8] = (bits / 2 ** 56) & 0xff;
  padded[padded.byteLength - 7] = (bits / 2 ** 48) & 0xff;
  padded[padded.byteLength - 6] = (bits / 2 ** 40) & 0xff;
  padded[padded.byteLength - 5] = (bits / 2 ** 32) & 0xff;
  padded[padded.byteLength - 4] = (bits >>> 24) & 0xff;
  padded[padded.byteLength - 3] = (bits >>> 16) & 0xff;
  padded[padded.byteLength - 2] = (bits >>> 8) & 0xff;
  padded[padded.byteLength - 1] = bits & 0xff;

  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.byteLength; offset += 64) {
    const words: number[] = [];
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words.push(
        ((padded[at]! << 24) | (padded[at + 1]! << 16) | (padded[at + 2]! << 8) | padded[at + 3]!) >>> 0,
      );
    }
    expandSha256Schedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((value, index) => (value + working[index]!) >>> 0);
  }
  const out = new Uint8Array(32);
  state.forEach((value, index) => {
    out[index * 4] = (value >>> 24) & 0xff;
    out[index * 4 + 1] = (value >>> 16) & 0xff;
    out[index * 4 + 2] = (value >>> 8) & 0xff;
    out[index * 4 + 3] = value & 0xff;
  });
  return out;
}

/** `_cs64_digest`：和 `sha256` 摘要混合出 16 hex 前缀的那个自定义哈希 */
export function cs64Digest(data: Uint8Array, digest: Uint8Array): [number, number] {
  // 用摘要的前 8 字节当 key（小端两个 32 位字），低位强制置 1
  const keyA = ((digest[0]! | (digest[1]! << 8) | (digest[2]! << 16) | (digest[3]! << 24)) | 1) >>> 0;
  const keyB = ((digest[4]! | (digest[5]! << 8) | (digest[6]! << 16) | (digest[7]! << 24)) | 1) >>> 0;
  const factors = [mul32(keyA, CS64_FACTOR), mul32(keyB, CS64_FACTOR)];

  const terms: number[] = [];
  const offsets: number[] = [];
  CS64_COEFFICIENTS.forEach(([coefficient, offset], index) => {
    terms.push(mul32(coefficient, factors[index % 2]!));
    offsets.push(offset >>> 0);
  });

  // 前面多塞一个 0 字节，让分组从源数据的第二个字节开始（源码如此）
  const seeded = new Uint8Array(data.byteLength + 1);
  seeded.set(data, 1);
  wordsLe4Even(seeded).forEach((word, index) => {
    let term = mul32(word, index % 2 === 0 ? keyA : keyB);
    let offset = mul32(rol16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (index === 0) {
      term += mul32(CS64_ADJUSTMENT0, factors[0]!);
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  });

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index]!;
    const y = terms[index + 1]!;
    let t = rol16((offsets[index]! + x) >>> 0);
    let q = mul32(t, 0x76f50f34);
    swapAcc += (mul32(rol16(q), 0xc3efea97) + q) >>> 0;
    t = rol16((offsets[index + 1]! + y) >>> 0);
    q = mul32(t, 0x1881ce3c);
    swapLast = (mul32(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul32(state, keyA) + x) >>> 0;
    state = mul32(rol16(state), 0xcf98b111);
    state = mul32(rol16(state), 0x87085b9f);
    state = mul32(rol16(state), 0x12ceb96d);
    state = mul32(rol16(state), 0x257e1d83);
    acc += state;
    let mixed = (mul32(state, keyB) + y) >>> 0;
    mixed = mul32(rol16(mixed), 0xa27416f5);
    mixed = mul32(rol16(mixed), 0xd38396ff);
    state = mul32(rol16(mul32(rol16(mixed), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }

  return [((swapLast ^ state) >>> 0) >>> 0, ((swapAcc ^ acc) >>> 0) >>> 0];
}

function hex(bytes: Uint8Array, upper = true): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return upper ? out.toUpperCase() : out;
}

/** `_token_hash`：返回 (cs64 的 16 hex, 变体 sha256 的 64 hex)，都是大写 */
export function tokenHash(data: Uint8Array): { cs64: string; sha256: string } {
  const digest = sha256Digest(data);
  const [a, b] = cs64Digest(data, digest);
  // struct.pack("<II", a, b) → 小端两字
  const le = (value: number): string => {
    const parts = [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
    return parts.map((part) => part.toString(16).padStart(2, "0")).join("");
  };
  return { cs64: `${le(a)}${le(b)}`.toUpperCase(), sha256: hex(digest) };
}

/**
 * 令牌的输入串：`<ticks><TRUSTED_CLIENT_TOKEN>`。
 *
 * 浮点顺序必须和 `drm.py` 一致（先加纪元差 → 取整到 300s → 乘 1e7），因为 1.34e17 已经
 * 超出 2^53 的精确整数范围，换一个运算顺序就会差出个位。Python 那边也是双精度，
 * 所以同样的顺序能拿到同样的十进制串 —— golden 测试就是钉这个。
 */
export function tokenPayload(unixSeconds: number, trustedToken = TRUSTED_CLIENT_TOKEN): string {
  let ticks = unixSeconds + WIN_EPOCH_SECONDS;
  ticks -= ticks % TOKEN_WINDOW_SECONDS;
  ticks *= 1e9 / 100;
  return `${Math.round(ticks).toFixed(0)}${trustedToken}`;
}

/** `generate_sec_ms_gec_v2`：`<16 hex>-<64 hex>` */
export function generateSecMsGec(unixSeconds: number, trustedToken = TRUSTED_CLIENT_TOKEN): string {
  const { cs64, sha256 } = tokenHash(new TextEncoder().encode(tokenPayload(unixSeconds, trustedToken)));
  return `${cs64}-${sha256}`;
}

// ------------------------------------------------------------------ 对照物

/**
 * 标准 SHA-256 版本的同一算法（`sha256("<ticks><token>")` 大写）。
 *
 * **不是备选实现**，只为在测试里钉住「本机 drm.py 的令牌 ≠ 标准 SHA-256」这一事实：
 * 同一输入下两者必然不同，谁把它们当成等价实现来「简化」，线上就是 403。
 */
export function sha256TokenStandard(
  unixSeconds: number,
  trustedToken = TRUSTED_CLIENT_TOKEN,
): string {
  return createHash("sha256")
    .update(tokenPayload(unixSeconds, trustedToken), "ascii")
    .digest("hex")
    .toUpperCase();
}

/** 测试用：把常量表原样暴露出来，和 `drm.py` 逐个对拍（抄错一个数就是 403） */
export const DRM_TABLES = {
  initial: SHA256_INITIAL_,
  state: SHA256_STATE_,
  schedule: SHA256_SCHEDULE_,
  round: SHA256_ROUND_CONSTANTS,
  cs64: CS64_COEFFICIENTS,
  adjustment: SHA256_ADJUSTMENT,
  sigma0Adjustment: SHA256_SIGMA0_ADJUSTMENT,
  sigma1Adjustment: SHA256_SIGMA1_ADJUSTMENT,
  cs64Factor: CS64_FACTOR,
  cs64Adjustment0: CS64_ADJUSTMENT0,
  cs64Adjustment1: CS64_ADJUSTMENT1,
} as const;
