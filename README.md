# verifiable-draw

可验证的公开抽签 API：承诺-揭示（commit-reveal）协议 + 基于 SHA-256 拒绝采样的 Fisher-Yates 洗牌，保证中奖顺序**无偏、可复算、可审计**。

技术栈：Node.js 24 + Fastify 5 + SQLite（Node 内置 `node:sqlite`，零原生依赖）。

## 一键启动

```bash
docker compose up --build
```

服务地址：**http://localhost:3000** （首次启动自动建表，无需手动迁移）

## 配置（环境变量，均有默认值）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATABASE_PATH` | 容器内 `/app/data/draws.db`，本地 `./data/draws.db` | SQLite 文件路径 |

SQLite 数据通过 compose 的命名卷 `draw-data` 持久化。

## 抽签流程

1. **创建（承诺）**：提交去重后的候选项与抽取数量。服务端生成 32 字节随机 seed，**只返回** `commitment = SHA-256(seed)`，seed 在揭示前不会出现在任何响应中。
2. **揭示**：调用方提交一次 `nonce`（仅一次，重复提交返回 409）。服务端在**同一事务**（`BEGIN IMMEDIATE`）中锁定该抽签、落库 nonce、揭示 seed 并持久化中奖顺序。
3. **校验**：任何人用「承诺 + seed + nonce + 候选快照」即可独立重算中奖顺序，比对是否被篡改。

## API

### 1. 创建抽签

```bash
curl -X POST http://localhost:3000/draws \
  -H 'content-type: application/json' \
  -d '{"candidates":["alice","bob","carol","dave","erin"],"count":2}'
```

```json
{ "drawId": "bde4b5b9-…", "status": "pending", "commitment": "a5b10695…", "count": 2, "candidateCount": 5, "createdAt": "…" }
```

### 2. 揭示（nonce 只能提交一次）

```bash
curl -X POST http://localhost:3000/draws/<drawId>/reveal \
  -H 'content-type: application/json' \
  -d '{"nonce":"public-input-2026-09-20"}'
```

```json
{ "drawId": "…", "status": "revealed", "commitment": "a5b10695…", "seed": "a196a11e…",
  "nonce": "public-input-2026-09-20", "candidates": ["alice", "…"],
  "order": ["grace", "bob", "…"], "winners": ["grace", "bob"], "revealedAt": "…" }
```

`order` 为全量中奖顺序，`winners` 为前 `count` 名。重复揭示返回 `409` 及首次揭示结果。

### 3. 查询状态

```bash
curl http://localhost:3000/draws/<drawId>
```

### 4. 独立校验（核心）

提交承诺、seed、nonce 与候选快照，服务端重算并逐项指出篡改：

```bash
curl -X POST http://localhost:3000/verify \
  -H 'content-type: application/json' \
  -d '{"commitment":"a5b10695…","seed":"a196a11e…","nonce":"public-input-2026-09-20",
       "candidates":["alice","bob","carol","dave","erin"],"count":2,
       "order":["grace","bob","…"],"winners":["grace","bob"]}'
```

```json
{ "valid": true,
  "checks": { "commitmentMatch": true, "candidatesUnique": true, "countInRange": true,
              "orderMatch": true, "winnersMatch": true },
  "expected": { "order": ["…"], "winners": ["…"] },
  "problems": [] }
```

任一字段被篡改时 `valid=false`，`problems` 会指明哪一项不一致（如 `commitment mismatch` / `order mismatch`）。`order`、`winners` 为可选，不传则只校验承诺并重算期望值。

另外 `GET /draws/:id/verify` 可对服务端存储的记录做一致性重算。

## 算法规范（第三方可独立复算）

- **seed**：32 字节加密随机数，hex 编码（64 字符）。
- **承诺**：`commitment = SHA-256(seed)`（对 hex 字符串的 UTF-8 字节求哈希）。
- **随机流**：第 `i` 块（`i = 0, 1, 2, …`）为 `SHA-256("{seed}:{nonce}:{i}")`，每块 32 字节按大端序切成 8 个 uint32，依次消费。
- **拒绝采样**：取 `[0, n)` 均匀整数时，令 `limit = floor(2^32 / n) * n`，丢弃 `x >= limit` 的样本，返回 `x % n`，消除模偏差。
- **Fisher-Yates**：对候选副本从末尾向前，`j = uniform(i + 1)` 交换，得到全量中奖顺序；前 `count` 个为中奖者。

## 本地开发（可选）

需要 Node.js ≥ 22.13（内置 `node:sqlite`）：

```bash
npm ci
npm start     # http://localhost:3000
npm test      # node:test 测试套件（含无偏性统计检验）
```

## 项目结构

```
src/lottery.js   承诺生成、SHA-256 随机流、拒绝采样、Fisher-Yates
src/db.js        SQLite 连接与自动建表
src/app.js       Fastify 路由（创建 / 揭示 / 查询 / 校验）
src/index.js     入口：配置、启动、优雅退出
test/api.test.js 端到端与篡改检测测试
```
