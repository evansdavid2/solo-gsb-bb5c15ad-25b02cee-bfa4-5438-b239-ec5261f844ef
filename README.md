# 可验证公开抽签 API（Commit–Reveal）

基于 **Node.js + Fastify + SQLite** 的公开抽签服务：创建时只公开 SHA-256 承诺，揭示时提交 nonce，用**基于 SHA-256 拒绝采样的 Fisher-Yates** 生成无偏、可公开复算的中奖顺序。

## 快速开始

```bash
docker compose up --build
```

服务地址：**http://localhost:3000**（首次启动自动建表，无需手动迁移）。

## 配置

通过环境变量配置（均有默认值，docker-compose 中已设好，通常无需修改）：

| 变量      | 默认值              | 说明                          |
| --------- | ------------------- | ----------------------------- |
| `PORT`    | `3000`              | 监听端口                      |
| `HOST`    | `0.0.0.0`           | 监听地址                      |
| `DB_PATH` | 容器内 `/data/draws.db`（本地运行为 `./data/draws.db`） | SQLite 文件路径，`:memory:` 为内存库 |

## 抽签流程

1. **承诺**：`POST /draws` 提交唯一候选与抽取数量 → 服务端生成随机 seed，**只返回承诺** `commitment = SHA-256(seed)`，seed 保密。
2. **揭示**：`POST /draws/:id/reveal` 提交 nonce（**仅可提交一次**，重复返回 `409`）→ 服务端在**同一事务**中锁定输入、落库 nonce 与结果，返回 seed 与中奖顺序。
3. **校验**：任何人凭公开的 commitment / seed / nonce / 候选快照即可复算，篡改会被定位到具体环节。

## API

### `POST /draws` — 创建抽签（承诺）

```bash
curl -s -X POST http://localhost:3000/draws \
  -H 'Content-Type: application/json' \
  -d '{"candidates":["alice","bob","carol","dave","erin"],"pickCount":2}'
```

```json
{
  "drawId": "e5403427-…",
  "status": "committed",
  "commitment": "5ffbc2fe…",
  "candidateHash": "28a6e64f…",
  "pickCount": 2,
  "candidateCount": 5
}
```

候选必须唯一（否则 `422`）；`pickCount` 不能超过候选数。

### `POST /draws/:id/reveal` — 揭示（nonce 仅一次）

```bash
curl -s -X POST http://localhost:3000/draws/<drawId>/reveal \
  -H 'Content-Type: application/json' \
  -d '{"nonce":"public-stream-2026-09-20"}'
```

```json
{
  "drawId": "e5403427-…",
  "status": "revealed",
  "commitment": "5ffbc2fe…",
  "seed": "a24a05cf…",
  "nonce": "public-stream-2026-09-20",
  "pickCount": 2,
  "winners": ["carol", "erin"]
}
```

重复揭示返回 `409`。nonce 建议公开可预期（如直播场次号），它与保密的 seed 共同决定结果，任何一方都无法单独操控。

### `GET /draws/:id` — 查询状态

揭示前响应不含 `seed`；揭示后包含 `seed`、`nonce`、`winners`。

### `GET /draws/:id/verify` — 校验已揭示的抽签

按库存的承诺、nonce、候选快照重算，**指出被篡改的环节**：

```json
{
  "drawId": "e5403427-…",
  "valid": false,
  "tampered": ["result"],
  "checks": {
    "commitment": { "ok": true,  "stored": "…", "recomputed": "…" },
    "candidates": { "ok": true,  "stored": "…", "recomputed": "…" },
    "result":     { "ok": false, "stored": ["…"], "recomputed": ["…"] }
  }
}
```

### `POST /verify` — 独立校验（不依赖数据库）

第三方凭公开工件复算：

```bash
curl -s -X POST http://localhost:3000/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "commitment": "5ffbc2fe…",
    "seed": "a24a05cf…",
    "nonce": "public-stream-2026-09-20",
    "candidates": ["alice","bob","carol","dave","erin"],
    "pickCount": 2,
    "winners": ["carol","erin"]
  }'
```

返回 `valid`、逐项 `checks` 与 `computedWinners`。`winners` 可省略，此时只校验承诺并返回复算结果。

### `GET /health` — 健康检查

## 可复算算法规范

任何语言都可据此独立复算中奖顺序：

- `seed`：32 字节随机数的 64 位小写 hex 字符串
- `commitment = SHA-256(seed 的 UTF-8 字节)`
- `candidateHash = SHA-256(JSON.stringify(candidates) 的 UTF-8 字节)`
- 随机流：第 `k` 块（`k` 从 0 起，十进制）= `SHA-256("draw-v1|<seed>|<nonce>|<k>")`；每块 32 字节按大端序依次读出 8 个 uint32，用完取下一块
- `uniform(n)`：`limit = floor(2^32 / n) * n`；重复取 `x` 直到 `x < limit`；返回 `x mod n`（**拒绝采样**，消除模偏置，严格均匀）
- 洗牌：Fisher-Yates，`i` 从 `length-1` 递减到 `1`，`j = uniform(i+1)`，交换 `i`、`j`
- 中奖顺序 = 洗牌后数组的前 `pickCount` 个

### 用 shell 验证承诺

```bash
printf '%s' "$SEED" | sha256sum   # 应等于 commitment
```

## 本地开发

```bash
npm ci        # 安装依赖
npm test      # 运行测试（算法单测 + 端到端 API 测试）
npm start     # 启动服务，默认 http://localhost:3000
```

## 项目结构

```
src/
  draw.js   # 纯函数核心：承诺、SHA-256 随机流、拒绝采样、Fisher-Yates
  db.js     # SQLite 连接与自动建表
  app.js    # Fastify 路由与事务逻辑
  index.js  # 启动入口
test/       # node:test 测试
Dockerfile / docker-compose.yml
```
