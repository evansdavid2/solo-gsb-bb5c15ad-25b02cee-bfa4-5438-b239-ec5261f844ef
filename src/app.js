'use strict';

const crypto = require('node:crypto');
const { generateSeed, commitmentFor, computeOrder } = require('./lottery');

const MAX_CANDIDATES = 10000;
const MAX_CANDIDATE_LENGTH = 128;
const MAX_NONCE_LENGTH = 256;

const candidateListSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_CANDIDATES,
  uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: MAX_CANDIDATE_LENGTH },
};

function publicView(row, { includeSecret = false } = {}) {
  const view = {
    drawId: row.id,
    status: row.status,
    commitment: row.commitment,
    candidates: JSON.parse(row.candidates),
    count: row.draw_count,
    createdAt: row.created_at,
  };
  if (row.status === 'revealed') {
    const result = JSON.parse(row.result);
    view.seed = row.seed;
    view.nonce = row.nonce;
    view.order = result.order;
    view.winners = result.winners;
    view.revealedAt = row.revealed_at;
  } else if (includeSecret) {
    view.seed = row.seed;
  }
  return view;
}

function buildApp(db, opts = {}) {
  const app = require('fastify')({ logger: opts.logger !== undefined ? opts.logger : true });

  const insertDraw = db.prepare(
    `INSERT INTO draws (id, status, commitment, seed, candidates, draw_count, created_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?)`
  );
  const getDraw = db.prepare('SELECT * FROM draws WHERE id = ?');
  const finalizeReveal = db.prepare(
    `UPDATE draws
        SET status = 'revealed', nonce = ?, result = ?, revealed_at = ?
      WHERE id = ? AND status = 'pending'`
  );

  app.get('/', async () => ({
    name: 'verifiable-draw',
    description: 'Commit-reveal public draw with SHA-256 rejection-sampling Fisher-Yates',
    endpoints: {
      create: 'POST /draws',
      reveal: 'POST /draws/:id/reveal',
      status: 'GET /draws/:id',
      verifyStored: 'GET /draws/:id/verify',
      verifyIndependent: 'POST /verify',
    },
  }));

  app.get('/health', async () => ({ status: 'ok' }));

  // ---- Create draw (commit phase) ---------------------------------------
  app.post('/draws', {
    schema: {
      body: {
        type: 'object',
        required: ['candidates', 'count'],
        additionalProperties: false,
        properties: {
          candidates: candidateListSchema,
          count: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { candidates, count } = request.body;
    if (count > candidates.length) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'count must not exceed the number of candidates',
      });
    }

    const id = crypto.randomUUID();
    const seed = generateSeed();
    const commitment = commitmentFor(seed);
    const createdAt = new Date().toISOString();
    insertDraw.run(id, commitment, seed, JSON.stringify(candidates), count, createdAt);

    // Only the commitment is returned; the seed stays server-side until reveal.
    return reply.code(201).send({
      drawId: id,
      status: 'pending',
      commitment,
      count,
      candidateCount: candidates.length,
      createdAt,
    });
  });

  // ---- Reveal (single-shot, transactional) ------------------------------
  app.post('/draws/:id/reveal', {
    schema: {
      body: {
        type: 'object',
        required: ['nonce'],
        additionalProperties: false,
        properties: {
          nonce: { type: 'string', minLength: 1, maxLength: MAX_NONCE_LENGTH },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { nonce } = request.body;

    // BEGIN IMMEDIATE takes the write lock up front; input locking, seed
    // reveal and result persistence all happen in this one transaction.
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = getDraw.get(id);
      if (!row) {
        db.exec('ROLLBACK');
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `draw ${id} not found`,
        });
      }
      if (row.status === 'revealed') {
        db.exec('ROLLBACK');
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'draw already revealed; a nonce can only be submitted once',
          draw: publicView(row),
        });
      }

      const candidates = JSON.parse(row.candidates);
      const order = computeOrder(row.seed, nonce, candidates);
      const winners = order.slice(0, row.draw_count);
      const revealedAt = new Date().toISOString();
      const changed = finalizeReveal.run(
        nonce,
        JSON.stringify({ order, winners }),
        revealedAt,
        id
      );
      if (Number(changed.changes) !== 1) {
        db.exec('ROLLBACK');
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'draw already revealed; a nonce can only be submitted once',
        });
      }
      db.exec('COMMIT');

      return reply.send({
        drawId: row.id,
        status: 'revealed',
        commitment: row.commitment,
        seed: row.seed,
        nonce,
        candidates,
        count: row.draw_count,
        order,
        winners,
        createdAt: row.created_at,
        revealedAt,
      });
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw err;
    }
  });

  // ---- Draw status --------------------------------------------------------
  app.get('/draws/:id', async (request, reply) => {
    const row = getDraw.get(request.params.id);
    if (!row) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `draw ${request.params.id} not found`,
      });
    }
    return publicView(row);
  });

  // ---- Verify a stored draw (self-consistency recompute) -----------------
  app.get('/draws/:id/verify', async (request, reply) => {
    const row = getDraw.get(request.params.id);
    if (!row) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `draw ${request.params.id} not found`,
      });
    }
    if (row.status !== 'revealed') {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'draw is still pending; nothing to verify yet',
      });
    }
    const stored = JSON.parse(row.result);
    const report = verifyRecord({
      commitment: row.commitment,
      seed: row.seed,
      nonce: row.nonce,
      candidates: JSON.parse(row.candidates),
      count: row.draw_count,
      order: stored.order,
      winners: stored.winners,
    });
    return { drawId: row.id, ...report };
  });

  // ---- Independent verification ------------------------------------------
  // Recompute everything from the commitment, nonce and candidate snapshot;
  // any supplied field that disagrees with the recomputation is tampered.
  app.post('/verify', {
    schema: {
      body: {
        type: 'object',
        required: ['commitment', 'seed', 'nonce', 'candidates', 'count'],
        additionalProperties: false,
        properties: {
          commitment: { type: 'string', minLength: 1 },
          seed: { type: 'string', minLength: 1 },
          nonce: { type: 'string', minLength: 1, maxLength: MAX_NONCE_LENGTH },
          candidates: candidateListSchema,
          count: { type: 'integer', minimum: 1 },
          order: { ...candidateListSchema, uniqueItems: false, minItems: 0 },
          winners: { ...candidateListSchema, uniqueItems: false, minItems: 0 },
        },
      },
    },
  }, async (request) => verifyRecord(request.body));

  return app;
}

function verifyRecord({ commitment, seed, nonce, candidates, count, order, winners }) {
  const problems = [];
  const checks = {};

  // 1. Commitment must match the revealed seed.
  checks.commitmentMatch = commitmentFor(seed) === commitment;
  if (!checks.commitmentMatch) {
    problems.push('commitment mismatch: SHA-256(seed) != commitment — seed 或 commitment 已被篡改');
  }

  // 2. Candidate snapshot sanity: unique, and count within range.
  const seen = new Set(candidates);
  checks.candidatesUnique = seen.size === candidates.length;
  if (!checks.candidatesUnique) {
    problems.push('candidates mismatch: 候选快照存在重复项 — candidates 已被篡改');
  }
  checks.countInRange = Number.isInteger(count) && count >= 1 && count <= candidates.length;
  if (!checks.countInRange) {
    problems.push('count mismatch: 抽取数量超出候选范围 — count 已被篡改');
  }

  // 3. Recompute the winning order from (seed, nonce, candidates).
  const expectedOrder = computeOrder(seed, nonce, candidates);
  const expectedWinners = expectedOrder.slice(0, Math.min(count, expectedOrder.length));

  if (order !== undefined) {
    checks.orderMatch = Array.isArray(order) && order.length === expectedOrder.length
      && order.every((v, i) => v === expectedOrder[i]);
    if (!checks.orderMatch) {
      problems.push('order mismatch: 提供的中奖顺序与重算结果不一致 — order 或输入参数已被篡改');
    }
  }
  if (winners !== undefined) {
    checks.winnersMatch = Array.isArray(winners) && winners.length === expectedWinners.length
      && winners.every((v, i) => v === expectedWinners[i]);
    if (!checks.winnersMatch) {
      problems.push('winners mismatch: 提供的中奖名单与重算结果不一致 — winners 或输入参数已被篡改');
    }
  }

  return {
    valid: problems.length === 0,
    checks,
    expected: { order: expectedOrder, winners: expectedWinners },
    problems,
  };
}

module.exports = { buildApp };
