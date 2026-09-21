# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

腾讯会议企业版的会议数据导出网关。调度器定时从腾讯拉录制、逐字稿、纪要到本地归档和 NAS，网关按规则向采集程序签发受控的下载地址，管理控制台管规则与授权。README 的「架构」「仓库结构」两节是组件总览，docs/deploy.md 是部署手册，docs/collector.md 是采集程序调用手册。

代码注释、提交信息、文档全部用中文。

## 常用命令

根目录是 Bun workspace（`client`、`packages/*`）。`console/` 是独立 npm 工程，不在 workspace 里。

```bash
bun install
bun run dev            # 网关，热重载（src/index.ts）
bun run scheduler      # 调度器（src/worker/scheduler.ts），全系统只能跑一个实例
bun run worker -- --from 2026-01-01 --to 2026-01-31   # 一次性 worker，补历史窗口
bun run preflight      # 部署前检查
bun run typecheck      # tsc --noEmit，覆盖 src/ tests/ scripts/
bun test               # 网关 + worker 测试
bun test tests/worker/scheduler.test.ts      # 单个文件
bun test -t "关键字"                          # 按用例名过滤

cd client && bun test && bun run typecheck    # CLI
cd packages/engine && bun test                # 引擎
cd console && npm ci && npm run dev           # 控制台开发
cd console && npm run test                    # 控制台测试是 vitest，不能用 bun test 跑
cd console && npm run build                   # 产物由网关托管
```

CLI 本地运行：`cd client && bun bin/mde.ts <cmd> --out <dir>`。所有子命令包括只读的 `list` 都要 `--out`。纯数字位置参数当会议号，会议 id 用 `--meeting-id`。

## 测试环境

- store 层测试不 mock 数据库。`tests/helpers/testdb.ts` 的 `withTestDb()` 对每个用例建一个独立 MySQL 库并跑完所有迁移，需要 `TEST_DATABASE_URL` 指向有 `CREATE DATABASE` 权限的 MySQL 8（utf8mb4）。Bun 会自动读 `.env.test`。未设置时约 28 个网关测试文件失败，报 `TEST_DATABASE_URL not set`。
- `bunfig.toml` 把测试超时提到 15 秒（建库一次 2.6 到 6.8 秒），并用 `pathIgnorePatterns` 把 `console/**` 排除出根 `bun test`。键名必须是 `pathIgnorePatterns`，`testPathIgnorePatterns` 在 Bun 里静默无效。
- 腾讯接口用 `tests/fake-tencent/server.ts` 假服务。fixture 字段名故意与 wire 形状不同（`host_user_id` 对 `userid`），照搬字段名的实现会在假服务这边露馅。
- CLI 端到端用 `client/tests/e2e/fixture.ts` 的假网关加字节服务器（支持 Range，可注入 403 模拟链接过期）。

## 架构要点

**同一份 `src/` 两个进程入口。** `src/index.ts` 是网关，多实例；`src/worker/scheduler.ts` 是调度器，单实例。调度器绝不能装进网关进程：归档和到期清理是不可逆的文件操作，N 份实例同时跑等于数据损坏。网关侧对任务只有读 API 和手动排队（写一行 `job_runs.status='queued'`，由调度器下个 tick 认领）。

**网关不调腾讯接口。** 采集程序看到的会议来自 `meeting_cache`，文件来自 `meeting_assets` 中 status=completed 的行，下载走本地归档或 NAS 直出。腾讯凭证只在调度器和一次性 worker 进程里。

**调度按时间片，不补跑。** `src/store/jobs.ts` 的 `slotOf` / `nextDueAt` 把时间轴切片，每 tick 比对当前片与上次触发片。停机错过的片不补，上一轮没结束不开新一轮并写 skipped。要补历史只能用一次性 worker（`src/worker/index.ts`，`--from/--to` 是 UTC 日起点，整个范围先枚举完再一次性 upsert，所以枚举期间库和盘都看不到进展）。

**规则引擎三个栈，按优先级首条命中。** `src/policy/`。fetch、archive 两栈调度器读，allow 栈网关读。allow 栈兜底是 deny，另两栈兜底是 skip。fetch 栈一条启用规则都没有时走 `fetch-compat.ts` 的「时间窗内全拉」兼容规则，archive 栈为空则不归档。规则写坏（字段查不到、值非法）按该栈兜底处理，不往下找。管理员对单场会议的人工改写只替换规则判定结果，授权是独立条件。采集权限主体是 service account 程序，企微用户登录控制台也不能取数。

**引擎与 CLI 的分工。** `packages/engine` 是纯下载引擎（发现、探测、下载、manifest、SQLite 队列），定义 `AssetSource` 和 `Store` 接口。`client/` 通过网关 HTTP 实现 `AssetSource`；服务端 worker 用 `src/worker/source-inproc.ts` 直连腾讯并用 `src/worker/store-mysql.ts` 把 `Store` 落在 MySQL。改引擎接口要同时看这两个实现。

**幂等与延迟资产。** `upsertAsset` 的 ON DUPLICATE KEY 不改 status，重跑不会重下已完成资产。智能纪要和章节最多等 48 小时，录像最多 6 小时，未就绪进探测表而不是失败。普通云录制从不产出 audio，video 就绪而 audio 缺席直接判 not_generated。周期会议按 `meeting_record_id` 拆场次，目录名 `<yyyy-mm-dd>_<hhmm>_<会议号>`，同分钟第二场加 `_2`，不含主题。

**配置读取。** `src/config.ts` 的 `loadConfig` 在启动期强校验。环境变量空串与未设置等价（`.env.example` 留空即用默认值）。企微三项要么全填要么全不填，全不填是合法形态，设备授权路由回 501。`TRUSTED_PROXY_HOPS` 必须精确等于前置代理层数，填多了登录限流可被绕过。

**迁移。** `migrations/NNN_*.sql` 按文件名升序，网关和调度器启动时自动执行，用 `GET_LOCK` 互斥。新增迁移只追加编号。

## 部署相关

- Docker Compose 每条命令都带 `--env-file /opt/mde/.env`。跑一次性 worker 要加 `--no-deps`，否则 compose 会顺带起一个本地 mysql 容器（生产用的是 RDS）。见 docs/collector.md 第 4 节。
- `docs/prod-init-mysql.sql` 是生产初始化脚本，含真实凭据，永远不提交。
- 文档和截图里不能出现生产 IP、密码、`TM_*`、`JWT_SECRET`、client secret。

## 子任务怎么派

任务能拆出独立子任务时（并行的文件改动、独立的调查、一段可单独验证的实现），先用 Skill 工具加载 `herdr` skill，然后二选一。两条路都要自己审子任务的 diff 并写自己的总结，不要照抄它的汇报。

这一节只对最顶层的会话生效。被派出去的子任务（Codex 或 SubAgent）自己直接干活，不再往下派，也不运行 herdr 命令。派活时在任务描述里写明这一点，否则子任务读到本文会再开一层。

**派给 Codex（新开 herdr pane）。** 适合要在真实终端里长跑、需要独立进程的子任务。先确认 `HERDR_ENV=1`，再按 herdr skill 的流程切 pane、启动 codex、下发任务：

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
# 从返回 JSON 的 .result.pane.pane_id 取 pane id
herdr agent start <name> --kind codex --pane <pane-id> -- --yolo -m gpt-5.6-sol -c model_reasoning_effort=xhigh
herdr agent prompt <name> "<子任务描述>" --wait --timeout 600000
herdr agent read <name> --source recent-unwrapped --lines 200
```

模型固定 `gpt-5.6-sol`，推理强度 `xhigh`，`--yolo` 跳过审批。任务描述里写清改哪些文件、验收命令、不许碰哪些文件。多个 codex 共用一个工作树时，禁止让它跑 `git stash -u` 或 `git reset --hard`。用完的 pane 是自己开的才能关。

**派给 Claude SubAgent。** 适合读代码、跑测试、写一小段有明确规格的实现。用 Agent 工具，`model: "opus"`，`run_in_background: true`，任务描述给文件路径而不是贴文件内容。并行的子任务在同一条消息里一起派。

## 写代码时

- 注释只写代码看不出来的「为什么」。仓库里的长注释都是在解释一个曾经踩过的坑或一个反直觉的取值，新注释也按这个标准。
- 提交信息格式 `type(scope): 中文一句话`，scope 取 gateway / console / engine / client / docs / build。
