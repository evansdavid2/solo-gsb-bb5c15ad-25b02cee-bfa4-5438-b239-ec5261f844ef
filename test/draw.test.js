'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  generateSeed,
  commitmentFor,
  candidateHashFor,
  shuffle,
  computeWinners,
} = require('../src/draw');

test('commitment 等于 seed 的 SHA-256', () => {
  const seed = generateSeed();
  assert.match(seed, /^[0-9a-f]{64}$/);
  const expected = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
  assert.equal(commitmentFor(seed), expected);
});

test('candidateHash 等于候选 JSON 快照的 SHA-256', () => {
  const candidates = ['alice', 'bob', 'carol'];
  const expected = crypto
    .createHash('sha256')
    .update(JSON.stringify(candidates), 'utf8')
    .digest('hex');
  assert.equal(candidateHashFor(candidates), expected);
});

test('相同 (seed, nonce, candidates) 重算结果完全一致（可复算）', () => {
  const seed = generateSeed();
  const candidates = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const first = computeWinners(seed, 'nonce-1', candidates, 3);
  const second = computeWinners(seed, 'nonce-1', candidates, 3);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
});

test('不同 nonce 产生不同顺序（概率上必然）', () => {
  const seed = generateSeed();
  const candidates = Array.from({ length: 20 }, (_, i) => `c${i}`);
  const a = shuffle(seed, 'nonce-A', candidates);
  const b = shuffle(seed, 'nonce-B', candidates);
  assert.notDeepEqual(a, b);
});

test('洗牌结果是原数组的排列，中奖者无重复且来自候选集', () => {
  const seed = generateSeed();
  const candidates = Array.from({ length: 100 }, (_, i) => `user-${i}`);
  const shuffled = shuffle(seed, 'n', candidates);
  assert.deepEqual([...shuffled].sort(), [...candidates].sort());
  const winners = computeWinners(seed, 'n', candidates, 10);
  assert.equal(new Set(winners).size, 10);
  for (const w of winners) assert.ok(candidates.includes(w));
});

test('拒绝采样边界：uniform(1) 恒为 0，洗牌不越界', () => {
  const seed = generateSeed();
  assert.deepEqual(shuffle(seed, 'n', ['only']), ['only']);
  assert.deepEqual(computeWinners(seed, 'n', ['x', 'y'], 2).sort(), ['x', 'y']);
});

test('不改动传入的候选数组', () => {
  const seed = generateSeed();
  const candidates = ['a', 'b', 'c', 'd'];
  const snapshot = candidates.slice();
  shuffle(seed, 'n', candidates);
  assert.deepEqual(candidates, snapshot);
});
