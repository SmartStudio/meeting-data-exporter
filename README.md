# meeting-data-exporter

将腾讯会议企业版的录制、逐字稿与 AI 纪要导出到企业自有存储，归档到 NAS，并按规则与授权向外部程序提供受控访问。

数据流：腾讯会议 → 本地 → NAS（主存储）→ 本地保留 30 天供程序取用 → 到期删除本地文件，保留数据库记录与 NAS 路径。

---

## 目录

- [背景](#背景)
- [解决的问题](#解决的问题)
- [实现方式](#实现方式)
- [快速开始（Docker Compose）](#快速开始docker-compose)
- [配置与外部依赖](#配置与外部依赖)
- [仓库结构](#仓库结构)
- [文档索引](#文档索引)
- [已知限制](#已知限制)

---

## 背景

企业会议开在腾讯会议上，录制、逐字稿、AI 纪要存放在腾讯云端。直接使用存在三个问题：

1. **留存不受企业控制。** 腾讯侧有独立的留存策略，资产可能被清理。
2. **导出缺少管控。** 资产落到企业内部后，需要由管理员决定谁能获取哪场会议的哪类内容，并可解释、可审计。
3. **凭证不能下发到终端。** 腾讯会议企业自建应用的 AK/SK 具有读取和删除全公司录制的权限，不能分发到每台需要导出数据的机器。

本项目提供一条从腾讯会议到企业存储的数据通道，并在数据出口设置统一的权限闸门。

## 解决的问题

### 1. 资产完整、幂等地落到企业存储

五类资产（录像 `video`、录音 `audio`、逐字稿 `meeting_summary`、AI 纪要 `ai_minutes`、章节 `chapters`）按拉取规则从腾讯会议下载到本地，再按归档规则写入 NAS 并校验哈希。已导出的资产不重复拉取。

NAS 是主存储，不是备份。未归档成功的会议在本地保留期结束后即丢失，因此归档失败是最高级别告警。

### 2. 访问权限可判定、可解释

外部程序能取到一场会议的资产，需同时满足三个条件：

```
有授权（这场会议授权给了这个程序）
  且  在保留期内（本地文件尚未删除）
  且  规则允许采集（权限规则栈判定 allow）
```

三个条件由不同页面分别维护。每场会议的详情页给出逐阶段的判定理由（`why.fetch` / `why.archive` / `why.allow`）。采集权限规则是数据离开企业边界的唯一出口，新增的出境路径必须经过同一判定。

### 3. 凭证留在服务端

AK/SK 仅存在于网关进程。客户端使用 service account 向网关认证，网关完成鉴权、策略判定与审计后返回临时下载地址。

### 4. 操作审计

登录、拉取、归档、授权、取用均写入审计表。审计页按天分组展示，不合并记录。

## 实现方式

### 架构

```
                    ┌──────────────────────────────────────────┐
                    │              腾讯会议 企业版 API            │
                    └───────────────┬──────────────────────────┘
                                    │ AK/SK 签名 · 限流 · 重试
      ┌─────────────────────────────┼─────────────────────────────┐
      │  服务端（一份镜像，两个进程）  │                             │
      │                             │                             │
      │  ┌───────────────┐   ┌──────┴───────┐   ┌──────────────┐ │
      │  │ gateway 网关   │   │ scheduler    │   │ MySQL ≥ 8.0  │ │
      │  │ 多实例         │   │ 调度器·单实例  │   │ 任务队列+记录 │ │
      │  │ 鉴权/策略/审计 │   │ 拉取→归档→授权 │   │ 规则/授权/审计│ │
      │  │ 控制台静态页   │   │ 清理·刷新清单  │   └──────────────┘ │
      │  └──┬─────────┬──┘   └──────┬───────┘                     │
      │     │         │             │                             │
      │     │         │      ┌──────┴───────┐    ┌─────────────┐  │
      │     │         │      │ 本地归档目录   │───▶│ NAS（主存储） │  │
      │     │         │      │ 保留 30 天     │    └─────────────┘  │
      │     │         │      └──────────────┘                      │
      └─────┼─────────┼──────────────────────────────────────────┘
            │         │
   ┌────────┴──┐  ┌───┴──────────────────┐
   │ 管理控制台  │  │ mde CLI / 外部采集程序 │
   │ 浏览器      │  │ service account 认证   │
   └───────────┘  └──────────────────────┘
```

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 网关 `gateway` | `src/` | 持有腾讯 AK/SK。JWT 鉴权、企微设备授权登录、身份映射、采集权限判定、签发临时下载地址、写审计。托管控制台静态页。支持多实例。 |
| 调度器 `scheduler` | `src/worker/scheduler.ts` | 五个定时任务。主链路：拉取新录制（每 15 分钟）→ 归档到 NAS（每小时）→ 自动授权（每 5 分钟），上一步有新产出时下一步立即执行。独立任务：清理到期文件（每天 03:00）、刷新采集清单（每 5 分钟）。全系统只能运行一个实例。 |
| 管理控制台 | `console/` | React 单页应用。页面：会议记录、采集授权、自动规则、定时任务、归档存储、操作审计、内容预览。角色：admin / readonly。 |
| mde CLI | `client/` + `packages/engine` | 外部采集程序的参考实现。通过网关发现会议并下载资产到本地，支持断点续传与崩溃恢复。 |

### 设计要点

**规则引擎分三个栈。** 拉取栈决定拉哪些会议和哪几类资产；归档栈决定写入 NAS 的目录；allow 栈决定哪个采集程序能取走什么。前两栈由 worker 读取，第三栈由网关读取。所有栈默认 deny，deny 优先。规则条件支持主题、主持人、时间、时长、资产类型等字段。管理员可对单场会议做人工改写；改写只替换规则判定结果，授权是独立条件。

**采集权限的主体是程序，不是人。** 企微用户通过设备授权登录控制台，但不是 service account。企微用户请求取数时直接拒绝，理由标明身份类型不匹配。

**调度按时间片，不补跑。** 每个任务的频率将时间轴切成等长的时间片，每个 tick 比较当前时间片与上次触发的时间片，不同则执行。停机期间错过的时间片不补跑。上一轮未结束时不启动新一轮，并写入一行 `skipped` 记录。

**失败分两层。** 整轮抛出异常（如腾讯接口 502、数据库断连）时该轮标记 failed。轮内单个对象失败时该轮仍为 succeeded，失败对象进入失败项表，附带原因说明、影响说明和重试次数。

**CLI 以 SQLite 作为任务队列。** `mde` 将每个资产的下载状态记录在 `<out>/.mde/queue.sqlite`，跨进程、跨次调用有效。中断后重新执行同一命令即可继续，已完成资产不重复下载。支持 Range 续传与并发上限。未生成的资产自动轮询，直至就绪或超时。

**周期会议按录制记录拆分场次。** 场次 id 取腾讯的 `meeting_record_id`，每场占一个目录。

### 技术栈

- 服务端、CLI、引擎：Bun + TypeScript
- 数据库：MySQL 8.0（JSON 列、`SKIP LOCKED` 队列、`GET_LOCK` 迁移互斥，必须 utf8mb4）
- 控制台：React 19 + Vite
- 部署：Docker Compose

## 快速开始（Docker Compose）

需要 Docker 与 Docker Compose v2。

```bash
git clone https://github.com/joesmart/meeting-data-exporter.git
cd meeting-data-exporter

# 1. 准备配置。必填：腾讯会议五项凭证、JWT_SECRET、GATEWAY_BASE_URL、
#    IDENTITY_STRATEGY、宿主机目录 MDE_ARCHIVE_ROOT 与 MDE_NAS_ROOT。
#    DATABASE_URL 留空则使用 compose 自带的 MySQL。
cp .env.example .env
$EDITOR .env

# 2. 构建并启动（镜像包含已编译的控制台）
docker compose up -d --build

# 3. 自检凭证、数据库、目录、企微配置
docker compose exec gateway bun scripts/preflight.ts

# 4. 创建管理员账号（密码至少 8 位；命令前加空格可避免写入 shell 历史）
 docker compose exec gateway bun scripts/admin-bootstrap.ts --username admin --password '<密码>'

# 5. 访问控制台
open http://localhost:3000
```

`.env` 包含真实凭证，已被 `.gitignore` 与 `.dockerignore` 排除。不要提交，不要粘贴到聊天或工单。

外部采集程序在控制台「采集授权」页创建 service account 后，使用 `mde` 取数：

```bash
export MDE_GATEWAY_URL=http://localhost:3000
export MDE_CLIENT_ID=...       # 控制台签发
export MDE_CLIENT_SECRET=...   # 仅展示一次，服务端只存哈希
bun client/bin/mde.ts run --from 2026-09-01 --to 2026-09-14 --out ./export
```

非 Docker 部署、阿里云 RDS 注意事项、`preflight` 完整说明见 [`docs/deploy.md`](docs/deploy.md)。

## 配置与外部依赖

配置通过环境变量注入，`src/config.ts` 在启动时校验，缺项则拒绝启动。完整清单见 [`.env.example`](.env.example)。外部依赖如下：

| 依赖 | 变量 | 说明 |
| --- | --- | --- |
| 腾讯会议企业自建应用 | `TM_APP_ID` `TM_SDK_ID` `TM_SECRET_ID` `TM_SECRET_KEY` `TM_OPERATOR_ID` | 仅网关与调度器进程持有 |
| MySQL ≥ 8.0 | `DATABASE_URL` | 建库必须显式指定 utf8mb4。留空则使用 compose 自带实例 |
| 本地归档目录 | `MDE_ARCHIVE_ROOT` | 下载落盘与 30 天保留窗口所在目录，必须存在且可写 |
| NAS 挂载点 | `MDE_NAS_ROOT` | 主存储。compose 下填宿主机路径，挂载进容器 |
| 企业微信自建应用（可选） | `WECOM_*` | 控制台企微登录。全填或全不填 |
| 身份映射策略 | `IDENTITY_STRATEGY` | `direct` / `email` / `table`，企微用户到腾讯会议 userid 的映射方式 |
| 时区 | `MDE_SCHEDULER_TZ_OFFSET_MIN` | 决定「每天 03:00 清理」的时区。东八区填 `480` |

Docker Compose 相关变量（端口、运行用户 uid/gid、MySQL 密码与数据目录）见 `.env.example` 末尾。

## 仓库结构

```
src/                 网关 + worker（同一份代码，两个入口）
  index.ts           网关进程入口
  worker/scheduler.ts  调度器进程入口（单实例）
  worker/index.ts    一次性 worker（排查用，不与调度器同时运行）
  auth/ policy/ catalog/ audit/ tencent/ store/ http/ domain/
migrations/          001..016，网关与调度器启动时自动执行
scripts/             preflight、admin-bootstrap、密码重置、数据回填等运维脚本
console/             管理控制台（独立 npm 项目，构建产物由网关托管）
client/              mde CLI
packages/engine/     导出引擎（CLI 与服务端 worker 共用）
docs/                部署手册、产品说明书、设计文档
docker-compose.yml   单机部署
```

常用命令：

```bash
bun install
bun run dev          # 网关，热重载
bun run scheduler    # 调度器
bun test             # 服务端测试
bun run typecheck
cd console && npm ci && npm run dev    # 控制台开发
```

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/deploy.md`](docs/deploy.md) | 部署手册：MySQL 准备、腾讯会议与企微后台配置、身份映射策略、采集权限规则模板、Docker Compose、preflight、错误码对照 |
| [`docs/console/spec.md`](docs/console/spec.md) | 控制台功能说明书：产品模型、页面行为、规则引擎语义、系统状态与降级、已知缺口 |
| [`docs/roadmap.md`](docs/roadmap.md) | 里程碑 M1–M6 与状态 |
| [`docs/superpowers/specs/2026-07-20-meeting-export-gateway-design.md`](docs/superpowers/specs/2026-07-20-meeting-export-gateway-design.md) | 网关设计与安全模型 |
| [`docs/superpowers/specs/2026-07-23-export-engine-cli-design.md`](docs/superpowers/specs/2026-07-23-export-engine-cli-design.md) | 导出引擎与 CLI 设计 |
| [`docs/superpowers/specs/2026-07-20-user-stories.md`](docs/superpowers/specs/2026-07-20-user-stories.md) | 用户故事 |
| [`client/README.md`](client/README.md) | `mde` CLI 命令与参数 |

## 已知限制

- 仅支持腾讯会议企业版的企业自建应用（AK/SK）模式。不支持其他会议平台，不支持 OAuth 第三方应用模式。
- 调度器只能运行一个实例。网关可横向扩展。
- 网关签发的临时下载地址指向腾讯云端文件，不读取本地目录。「在保留期内」这一条件目前仅在控制台的采集清单中判定，网关侧未强制。本地已清理但腾讯侧仍存在的会议，程序仍可获取。详见 `docs/console/spec.md` §11 第 10 行。
- 其他已知缺口见 `docs/console/spec.md` §11。

## 许可证

[MIT](LICENSE)
