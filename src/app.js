'use strict';

const crypto = require('node:crypto');
const Fastify = require('fastify');
const db = require('./db');
const {
  generateSeed,
  commitmentFor,
  candidateHashFor,
  computeWinners,
} = require('./draw');

const candidatesSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 100000,
  items: { type: 'string', minLength: 1, maxLength: 200 },
};

const createDrawSchema = {
  body: {
    type: 'object',
    required: ['candidates', 'pickCount'],
    additionalProperties: false,
    properties: {
      candidates: candidatesSchema,
      pickCount: { type: 'integer', minimum: 1 },
    },
  },
};

const revealSchema = {
  body: {
    type: 'object',
    required: ['nonce'],
    additionalProperties: false,
    properties: {
      nonce: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
};

const verifySchema = {
  body: {
    type: 'object',
    required: ['commitment', 'seed', 'nonce', 'candidates', 'pickCount'],
    additionalProperties: false,
    properties: {
      commitment: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      seed: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      nonce: { type: 'string', minLength: 1, maxLength: 200 },
      candidates: candidatesSchema,
      pickCount: { type: 'integer', minimum: 1 },
      winners: { type: 'array', items: { type: 'string' } },
    },
  },
};

function serializeDraw(draw) {
  const out = {
    drawId: draw.id,
    status: draw.status,
    commitment: draw.commitment,
    candidateHash: draw.candidate_hash,
    candidates: JSON.parse(draw.candidates),
    pickCount: draw.pick_count,
    createdAt: draw.created_at,
  };
  if (draw.status === 'revealed') {
    out.seed = draw.seed;
    out.nonce = draw.nonce;
    out.winners = JSON.parse(draw.result);
    out.revealedAt = draw.revealed_at;
  }
  return out;
}

function buildApp() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  // 1) 创建抽签：锁定候选快照与抽取数量，只返回承诺（seed 保密）
  app.post('/draws', { schema: createDrawSchema }, async (req, reply) => {
    const { candidates, pickCount } = req.body;

    if (new Set(candidates).size !== candidates.length) {
      return reply.code(422).send({ error: 'candidates must be unique' });
    }
    if (pickCount > candidates.length) {
      return reply
        .code(422)
        .send({ error: 'pickCount must not exceed candidates.length' });
    }

    const id = crypto.randomUUID();
    const seed = generateSeed();
    const commitment = commitmentFor(seed);
    const candidateHash = candidateHashFor(candidates);

    db.prepare(
      `INSERT INTO draws (id, status, candidates, candidate_hash, pick_count, seed, commitment)
       VALUES (?, 'committed', ?, ?, ?, ?, ?)`
    ).run(id, JSON.stringify(candidates), candidateHash, pickCount, seed, commitment);

    return reply.code(201).send({
      drawId: id,
      status: 'committed',
      commitment,
      candidateHash,
      pickCount,
      candidateCount: candidates.length,
    });
  });

  // 2) 揭示：nonce 仅可提交一次；同一事务内锁定输入、落库 nonce 与结果
  app.post('/draws/:id/reveal', { schema: revealSchema }, async (req, reply) => {
    const { id } = req.params;
    const { nonce } = req.body;

    const revealTx = db.transaction(() => {
      const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(id);
      if (!draw) {
        return { status: 404, body: { error: 'draw not found' } };
      }
      if (draw.status !== 'committed') {
        return {
          status: 409,
          body: { error: 'draw already revealed', revealedAt: draw.revealed_at },
        };
      }
      const candidates = JSON.parse(draw.candidates);
      const winners = computeWinners(draw.seed, nonce, candidates, draw.pick_count);
      // 条件更新保证并发下也只有一次揭示能成功
      const { changes } = db
        .prepare(
          `UPDATE draws
             SET status = 'revealed', nonce = ?, result = ?,
                 revealed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ? AND status = 'committed'`
        )
        .run(nonce, JSON.stringify(winners), id);
      if (changes !== 1) {
        return { status: 409, body: { error: 'draw already revealed' } };
      }
      return { status: 200, draw, winners };
    });

    const out = revealTx.immediate();
    if (out.status !== 200) {
      return reply.code(out.status).send(out.body);
    }
    return reply.send({
      drawId: id,
      status: 'revealed',
      commitment: out.draw.commitment,
      candidateHash: out.draw.candidate_hash,
      seed: out.draw.seed,
      nonce,
      pickCount: out.draw.pick_count,
      winners: out.winners,
    });
  });

  // 3) 查询抽签状态（揭示前不含 seed）
  app.get('/draws/:id', async (req, reply) => {
    const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(req.params.id);
    if (!draw) {
      return reply.code(404).send({ error: 'draw not found' });
    }
    return reply.send(serializeDraw(draw));
  });

  // 4) 校验已揭示的抽签：按承诺、nonce、候选快照重算并指出篡改位置
  app.get('/draws/:id/verify', async (req, reply) => {
    const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(req.params.id);
    if (!draw) {
      return reply.code(404).send({ error: 'draw not found' });
    }
    if (draw.status !== 'revealed') {
      return reply
        .code(409)
        .send({ error: 'draw not revealed yet', drawId: draw.id, status: draw.status });
    }

    const candidates = JSON.parse(draw.candidates);
    const storedWinners = JSON.parse(draw.result);
    const recomputedWinners = computeWinners(
      draw.seed,
      draw.nonce,
      candidates,
      draw.pick_count
    );
    const recomputedCommitment = commitmentFor(draw.seed);
    const recomputedCandidateHash = candidateHashFor(candidates);

    const checks = {
      commitment: {
        ok: recomputedCommitment === draw.commitment,
        stored: draw.commitment,
        recomputed: recomputedCommitment,
      },
      candidates: {
        ok: recomputedCandidateHash === draw.candidate_hash,
        stored: draw.candidate_hash,
        recomputed: recomputedCandidateHash,
      },
      result: {
        ok:
          JSON.stringify(recomputedWinners) === JSON.stringify(storedWinners),
        stored: storedWinners,
        recomputed: recomputedWinners,
      },
    };
    const tampered = Object.keys(checks).filter((k) => !checks[k].ok);

    return reply.send({
      drawId: draw.id,
      valid: tampered.length === 0,
      tampered,
      checks,
    });
  });

  // 5) 独立校验：无需数据库，第三方凭公开工件（承诺/seed/nonce/候选）复算
  app.post('/verify', { schema: verifySchema }, async (req, reply) => {
    const { commitment, seed, nonce, candidates, pickCount, winners } = req.body;

    if (pickCount > candidates.length) {
      return reply
        .code(422)
        .send({ error: 'pickCount must not exceed candidates.length' });
    }

    const computedWinners = computeWinners(seed, nonce, candidates, pickCount);
    const checks = {
      commitment: {
        ok: commitmentFor(seed) === commitment,
        provided: commitment,
        recomputed: commitmentFor(seed),
      },
    };
    if (Array.isArray(winners)) {
      checks.winners = {
        ok: JSON.stringify(computedWinners) === JSON.stringify(winners),
        provided: winners,
        recomputed: computedWinners,
      };
    }

    return reply.send({
      valid: Object.values(checks).every((c) => c.ok),
      checks,
      computedWinners,
    });
  });

  return app;
}

module.exports = buildApp;
