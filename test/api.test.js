'use strict';

// 必须在加载 app/db 之前指向内存数据库
process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const buildApp = require('../src/app');
const db = require('../src/db');

const CANDIDATES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];

async function createDraw(app, overrides = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/draws',
    payload: { candidates: CANDIDATES, pickCount: 3, ...overrides },
  });
  return res;
}

test('完整流程：承诺 -> 揭示 -> 校验', async (t) => {
  const app = buildApp();
  await t.after(() => app.close());

  // 创建：只返回承诺，不泄露 seed
  const createRes = await createDraw(app);
  assert.equal(createRes.statusCode, 201);
  const created = createRes.json();
  assert.match(created.commitment, /^[0-9a-f]{64}$/);
  assert.match(created.candidateHash, /^[0-9a-f]{64}$/);
  assert.equal(created.status, 'committed');
  assert.equal(created.seed, undefined);

  // 揭示前查询：不含 seed
  const beforeRes = await app.inject({ method: 'GET', url: `/draws/${created.drawId}` });
  assert.equal(beforeRes.statusCode, 200);
  assert.equal(beforeRes.json().seed, undefined);

  // 揭示前校验：409
  const earlyVerify = await app.inject({
    method: 'GET',
    url: `/draws/${created.drawId}/verify`,
  });
  assert.equal(earlyVerify.statusCode, 409);

  // 揭示：返回 seed 与中奖顺序
  const revealRes = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'public-nonce-2026' },
  });
  assert.equal(revealRes.statusCode, 200);
  const revealed = revealRes.json();
  assert.match(revealed.seed, /^[0-9a-f]{64}$/);
  assert.equal(revealed.winners.length, 3);
  assert.equal(new Set(revealed.winners).size, 3);

  // 重复揭示：409（nonce 只能提交一次）
  const againRes = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'another-nonce' },
  });
  assert.equal(againRes.statusCode, 409);

  // 服务端校验：全部通过
  const verifyRes = await app.inject({
    method: 'GET',
    url: `/draws/${created.drawId}/verify`,
  });
  assert.equal(verifyRes.statusCode, 200);
  const verify = verifyRes.json();
  assert.equal(verify.valid, true);
  assert.deepEqual(verify.tampered, []);

  // 独立校验：凭公开工件复算通过
  const independent = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: {
      commitment: revealed.commitment,
      seed: revealed.seed,
      nonce: revealed.nonce,
      candidates: CANDIDATES,
      pickCount: 3,
      winners: revealed.winners,
    },
  });
  assert.equal(independent.statusCode, 200);
  assert.equal(independent.json().valid, true);

  // 独立校验：换 seed -> 承诺不匹配
  const forged = await app.inject({
    method: 'POST',
    url: '/verify',
    payload: {
      commitment: revealed.commitment,
      seed: '0'.repeat(64),
      nonce: revealed.nonce,
      candidates: CANDIDATES,
      pickCount: 3,
    },
  });
  assert.equal(forged.statusCode, 200);
  assert.equal(forged.json().valid, false);
  assert.equal(forged.json().checks.commitment.ok, false);
});

test('篡改检测结果：结果被改动时 valid=false 且指出 result', async (t) => {
  const app = buildApp();
  await t.after(() => app.close());

  const created = (await createDraw(app)).json();
  await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'n' },
  });

  // 直接改库模拟篡改中奖结果
  db.prepare('UPDATE draws SET result = ? WHERE id = ?').run(
    JSON.stringify(['mallory', 'mallory2', 'mallory3']),
    created.drawId
  );

  const verify = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(verify.valid, false);
  assert.deepEqual(verify.tampered, ['result']);
  assert.equal(verify.checks.result.ok, false);
  assert.equal(verify.checks.commitment.ok, true);
});

test('篡改检测结果：候选快照被改动时指出 candidates', async (t) => {
  const app = buildApp();
  await t.after(() => app.close());

  const created = (await createDraw(app)).json();
  await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: 'n' },
  });

  db.prepare('UPDATE draws SET candidates = ? WHERE id = ?').run(
    JSON.stringify(['alice', 'bob', 'carol', 'dave', 'erin', 'mallory']),
    created.drawId
  );

  const verify = (await app.inject({ method: 'GET', url: `/draws/${created.drawId}/verify` })).json();
  assert.equal(verify.valid, false);
  assert.ok(verify.tampered.includes('candidates'));
  assert.equal(verify.checks.candidates.ok, false);
  // 注：result 是否同时被标记取决于被换元素洗牌后是否进入前 3 名，此处不做断言
});

test('入参校验', async (t) => {
  const app = buildApp();
  await t.after(() => app.close());

  // 重复候选
  let res = await createDraw(app, { candidates: ['a', 'a'] });
  assert.equal(res.statusCode, 422);

  // pickCount 超过候选数
  res = await createDraw(app, { pickCount: 99 });
  assert.equal(res.statusCode, 422);

  // 缺字段
  res = await app.inject({ method: 'POST', url: '/draws', payload: { candidates: ['a'] } });
  assert.equal(res.statusCode, 400);

  // 空 nonce
  const created = (await createDraw(app)).json();
  res = await app.inject({
    method: 'POST',
    url: `/draws/${created.drawId}/reveal`,
    payload: { nonce: '' },
  });
  assert.equal(res.statusCode, 400);

  // 不存在的抽签
  res = await app.inject({
    method: 'POST',
    url: '/draws/does-not-exist/reveal',
    payload: { nonce: 'n' },
  });
  assert.equal(res.statusCode, 404);
});
