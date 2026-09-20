'use strict';

/**
 * 可复算抽签核心算法（纯函数，无任何 IO）。
 *
 * 公开规范（任何第三方可据此独立复算）：
 *   seed          : 32 字节随机数的 64 位小写 hex 字符串
 *   commitment    = SHA-256(seed 的 UTF-8 字节)
 *   candidateHash = SHA-256(JSON.stringify(candidates) 的 UTF-8 字节)
 *   随机流        : 第 k 块(k 从 0 起，十进制) = SHA-256(`draw-v1|<seed>|<nonce>|<k>`)
 *                   每块 32 字节按大端序依次读出 8 个 uint32，块用完取下一块
 *   uniform(n)    : limit = floor(2^32 / n) * n；重复取 x 直到 x < limit；返回 x mod n
 *                   （拒绝采样，保证 [0, n) 上严格均匀、无模偏置）
 *   洗牌          : Fisher-Yates，i 从 length-1 递减到 1，j = uniform(i+1)，交换
 *   中奖顺序      = 洗牌后数组的前 pickCount 个元素
 */

const crypto = require('node:crypto');

const UINT32_SPACE = 0x100000000; // 2^32

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 生成密码学安全的随机 seed（64 位小写 hex）。 */
function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/** 承诺：commitment = SHA-256(seed)。 */
function commitmentFor(seed) {
  return sha256Hex(seed);
}

/** 候选快照哈希：candidateHash = SHA-256(JSON.stringify(candidates))。 */
function candidateHashFor(candidates) {
  return sha256Hex(JSON.stringify(candidates));
}

/** 基于 SHA-256 计数器模式的确定性随机流。 */
class DrawRandom {
  constructor(seed, nonce) {
    this.seed = seed;
    this.nonce = nonce;
    this.counter = 0;
    this.block = Buffer.alloc(0);
    this.offset = 0;
  }

  #refill() {
    this.block = crypto
      .createHash('sha256')
      .update(`draw-v1|${this.seed}|${this.nonce}|${this.counter}`, 'utf8')
      .digest();
    this.counter += 1;
    this.offset = 0;
  }

  nextUint32() {
    if (this.offset + 4 > this.block.length) this.#refill();
    const value = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  /**
   * 拒绝采样生成 [0, n) 上的无偏均匀整数。
   * 拒绝 >= limit 的值，消除模偏置。
   */
  uniformBelow(n) {
    const limit = Math.floor(UINT32_SPACE / n) * n;
    for (;;) {
      const x = this.nextUint32();
      if (x < limit) return x % n;
    }
  }
}

/** Fisher-Yates 洗牌（返回新数组，不改动入参）。 */
function shuffle(seed, nonce, items) {
  const arr = items.slice();
  const rng = new DrawRandom(seed, nonce);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = rng.uniformBelow(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** 计算中奖顺序：洗牌后取前 pickCount 名。 */
function computeWinners(seed, nonce, candidates, pickCount) {
  return shuffle(seed, nonce, candidates).slice(0, pickCount);
}

module.exports = {
  generateSeed,
  commitmentFor,
  candidateHashFor,
  shuffle,
  computeWinners,
};
