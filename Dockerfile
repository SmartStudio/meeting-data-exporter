# 多阶段构建，产出一个镜像、三种用法（见 docker-compose.yml）：
#
#   bun src/index.ts            网关（含控制台静态页）
#   bun src/worker/scheduler.ts 调度器（常驻，只能一份）
#   bun src/worker/index.ts     一次性 worker（人工补跑）
#
# 本仓库的锁文件是 Bun 1.1+ 的文本格式 bun.lock（不是旧版二进制 bun.lockb），
# 两者不可混淆——COPY 语句写错文件名会导致 --frozen-lockfile 直接构建失败。
#
# 根 package.json 声明了 workspaces（client、packages/*），bun install 会去读每个
# workspace 的 package.json；缺一个就报 "Workspace not found"，所以 deps 阶段要把
# 它们的 package.json 一并拷进去。运行期真正用到的只有 packages/engine
# （@yaowu/mde-engine，main 指向 ./src/index.ts，没有构建产物）；client 是命令行
# 工具，镜像里不需要。

FROM oven/bun:1-alpine AS base
WORKDIR /app

# ── 后端依赖 ────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json bun.lock ./
COPY client/package.json ./client/
COPY packages/engine/package.json ./packages/engine/
RUN bun install --frozen-lockfile --production

# ── 控制台前端（console/ 是独立的 npm 工程，用 Node 构建）────────────────────
# playwright 是 devDependency，npm ci 默认会顺手下载几百 MB 浏览器——构建产物
# 用不到它，跳过。
FROM node:22-alpine AS console
WORKDIR /console
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY console/package.json console/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY console/ ./
RUN npm run build

# ── 运行镜像 ────────────────────────────────────────────────────────────────
FROM base AS release
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/engine/src ./packages/engine/src
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY --from=console /console/dist ./console/dist

ENV NODE_ENV=production
# 网关在 main() 里按这个路径找 index.html，找到就把控制台挂在根路径。
ENV MDE_CONSOLE_DIST=/app/console/dist

# 真实监听端口由 src/index.ts 决定：Number(process.env.PORT ?? 3000)。
EXPOSE 3000

# 启动时会先跑 migrations/*.sql（src/index.ts 与 scheduler.ts 的 main() 都调用
# runMigrations，靠 GET_LOCK 互斥），因此镜像里必须带上 migrations 目录，且数据库
# 账号需要建表权限。
CMD ["bun", "src/index.ts"]
