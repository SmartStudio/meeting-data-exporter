# 多阶段构建：deps 阶段用 --frozen-lockfile 保证依赖可复现，release 阶段只拷贝
# 运行所需的产物（不含开发依赖、测试、文档、.env）。
#
# 本仓库的锁文件是 Bun 1.1+ 的文本格式 bun.lock（不是旧版二进制 bun.lockb），
# 两者不可混淆——COPY 语句写错文件名会导致 --frozen-lockfile 直接构建失败。

FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY package.json ./

ENV NODE_ENV=production

# 真实监听端口由 src/index.ts 决定：Number(process.env.PORT ?? 3000)。
# 未设置 PORT 时默认为 3000；如需对外暴露其它端口，设置 PORT 环境变量并
# 相应调整反向代理 / 安全组配置（见 docs/deploy.md）。
EXPOSE 3000

# 启动时会先跑 migrations/001_init.sql（src/index.ts 的 main() 里调用
# runMigrations），因此镜像里必须带上 migrations 目录，且数据库账号需要
# 建表权限。
CMD ["bun", "src/index.ts"]
