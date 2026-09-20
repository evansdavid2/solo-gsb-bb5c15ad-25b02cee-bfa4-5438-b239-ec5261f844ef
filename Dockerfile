# ---- 依赖层：安装生产依赖（better-sqlite3 使用官方预编译二进制）----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 运行层 ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 3000
# 首次启动自动建表（见 src/db.js）
CMD ["node", "src/index.js"]
