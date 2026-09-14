# meeting-data-exporter

把腾讯会议企业版的录制、逐字稿与 AI 纪要**收进来、归档进企业自有的 NAS，并按规则和授权让外部程序受控地取走**。

一句话：腾讯会议 → 本地 → NAS（主存储）→ 本地保留一个窗口期供程序取用 → 到期删本地、只留记录与 NAS 路径。

---

## 目录

- [为什么做这个项目](#为什么做这个项目)
- [解决了什么问题](#解决了什么问题)
- [是怎么解决的](#是怎么解决的)
- [快速开始（Docker Compose）](#快速开始docker-compose)
- [配置与外部依赖](#配置与外部依赖)
- [仓库结构](#仓库结构)
- [文档索引](#文档索引)
- [已知边界](#已知边界)

---

## 为什么做这个项目

企业把大量会议开在腾讯会议上，录制、逐字稿、AI 纪要都留在腾讯云端。这带来三个问题，任何一个单独看都不致命，合起来就必须自建一套东西：

1. **留存不由企业控制。** 腾讯侧的录制有自己的留存策略，会议资产是企业的知识资产，不能假定它一直在。
2. **导出需要被管住。** 一旦资产落到企业内部，「谁能拿走哪场会议的哪类内容」必须由管理员决定、可解释、可审计，而不是谁有账号谁就能全量拉走。
3. **高权限凭证不能下发到终端。** 腾讯会议企业自建应用的 AK/SK 能读、也能删全公司的录制。把它发到每一台要导数据的机器上，等于把整个企业的会议库交给每一个终端。

所以这不是一个「下载脚本」，而是一条从腾讯会议到企业存储的、带闸门的数据通道。

## 解决了什么问题

### 1. 会议资产完整、可重复地落到企业自有存储

五类资产（录像 `video`、录音 `audio`、逐字稿 `meeting_summary`、AI 纪要 `ai_minutes`、章节 `chapters`）按拉取规则自动从腾讯会议拉到本地，再按归档规则写进 NAS 并校验哈希。**NAS 是主存储，不是备份**——没有归档成功的会议，本地保留期一到就彻底没有了，所以归档失败是整套系统最高级别的告警。

### 2. 「谁能取走什么」变成一个能回答的问题

外部程序真能取到一场会议的资产，要同时满足三个条件：

```
有授权（这场会议授权给了这个程序）
  且  在保留期内（本地文件还没被删）
  且  规则允许采集（权限规则栈判定 allow）
```

三个条件由不同的人在不同的页面维护，界面随时能回答「为什么这场会议这个程序取不到」——每场会议的详情里都有逐阶段的判定理由。**采集权限规则是数据离开企业边界的唯一闸门**，任何新增的出境路径都必须走同一道门。

### 3. 凭证留在服务端，终端只拿到临时地址

AK/SK 只存在于网关进程里。客户端用自己的 service account 向网关认证，网关做鉴权、策略判定、审计，然后返回一个临时下载地址。终端永远不持有能删录制的凭证。

### 4. 全程留痕

登录、拉取、归档、授权、取用都进操作审计，且**只做分组不做折叠**，一条不少。

## 是怎么解决的

### 总体架构：控制面与数据面分离

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
      │  │ 多实例可扩展   │   │ 调度器·单实例  │   │ 任务队列+记录 │ │
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
| **网关** `gateway` | `src/` | 唯一持有腾讯 AK/SK。JWT 鉴权、企微设备授权登录、身份映射、采集权限判定（默认 deny，deny 优先）、临时下载地址、审计。同时托管管理控制台的静态页。可多实例。 |
| **调度器** `scheduler` | `src/worker/scheduler.ts` | 五个定时任务：拉取新录制（15 分钟）→ 归档到 NAS（每小时）→ 自动授权（5 分钟）为主链路，上一步有产出下一步立刻接着跑；清理到期文件（每天 03:00）与刷新采集清单（5 分钟）独立运行。**全系统只能有一份**，否则并发归档与不可逆删除会互相踩。 |
| **管理控制台** | `console/` | React 单页应用，六个页面：会议记录、采集授权、自动规则、定时任务、归档存储、操作审计，另有内容预览（播放录像、看逐字稿与纪要）。角色 admin / readonly。 |
| **mde CLI** | `client/` + `packages/engine` | 外部采集程序的参考实现。通过网关发现会议、把资产落到本地磁盘，断点续传、崩溃可恢复。 |

### 关键设计决策

**规则引擎是三个独立的栈。** 拉取栈决定「拉哪些会议、拉哪几类资产」，归档栈决定「进 NAS 的哪个目录」，allow 栈决定「哪个采集程序能取走什么」。前两栈只有 worker 读，第三栈只有网关读，谁按什么判的一句话就说得清。所有栈默认 deny；规则条件支持主题、主持人、时间、时长、资产类型等字段。管理员可以对单场会议做人工改写，改写替换的是「规则怎么判」，授权是另一个独立的「与」。

**采集权限的主体是程序，不是人。** 企微用户走设备授权登录控制台，但他不是 service account，取数时被显式拒绝并说明原因；这避免管理员看到「没有规则匹配」就去再建一条永远不会生效的规则。

**调度靠时间片，不补跑错过的。** 每个任务的频率把时间轴切成等长的片，每个 tick 比较「此刻这一片」与「上次触发的那一片」。停机期间错过的片不会被枚举出来——补跑一次错过的「每天 03:00 清理」意味着在早上九点执行一批不可逆删除。上一轮没跑完时不起新的，但留一行 `skipped`，让运维分得清「跳过了」和「调度器死了」。

**失败分两层，告警不天天红。** 整轮抛出（腾讯 502、数据库断连）才把这一轮标 failed；轮内某场会议归不上，轮次照样 succeeded，那场会议进失败项表，带一句人话原因和「如果不处理」的影响，等重试。

**CLI 侧「数据库即任务队列」。** `mde` 把每个资产的下载状态记在 `<out>/.mde/queue.sqlite` 里，跨进程、跨次调用持续有效。中途 Ctrl-C 或重启后重新执行同一条命令即可继续，不重复下载已完成的资产；Range 续传，有界并发；暂未生成的资产自动轮询直到就绪或超时放弃。

**周期会议按录制记录拆场次。** 场次 id 取腾讯的 `meeting_record_id`，周期会议的每一场各占一个目录。

### 技术栈

Bun + TypeScript（服务端、CLI、引擎）· MySQL 8.0（JSON 列、`SKIP LOCKED` 队列、`GET_LOCK` 迁移互斥，必须 utf8mb4）· React 19 + Vite（控制台）· Docker Compose（单机整套部署）。

## 快速开始（Docker Compose）

一条命令起 MySQL + 网关 + 调度器。需要 Docker 与 Docker Compose v2。

```bash
git clone https://github.com/joesmart/meeting-data-exporter.git
cd meeting-data-exporter

# 1. 准备配置。至少填腾讯会议五项凭证、JWT_SECRET、GATEWAY_BASE_URL、
#    IDENTITY_STRATEGY，以及两个宿主机目录 MDE_ARCHIVE_ROOT / MDE_NAS_ROOT。
#    DATABASE_URL 留空即使用 compose 自带的 MySQL。
cp .env.example .env
$EDITOR .env

# 2. 构建并启动（镜像里已包含编译好的控制台）
docker compose up -d --build

# 3. 自检：凭证、数据库、目录、企微配置是否都对
docker compose exec gateway bun scripts/preflight.ts

# 4. 创建第一个管理员账号（密码至少 8 位；前面加一个空格可让 shell 不记历史）
 docker compose exec gateway bun scripts/admin-bootstrap.ts --username admin --password '<密码>'

# 5. 打开控制台
open http://localhost:3000
```

`.env` 里放的是真实凭证，已被 `.gitignore` 与 `.dockerignore` 排除，**不要提交，也不要贴进任何聊天或工单**。

外部采集程序在控制台「采集授权」页创建 service account 后，用 `mde` 取数：

```bash
export MDE_GATEWAY_URL=http://localhost:3000
export MDE_CLIENT_ID=...       # 控制台签发
export MDE_CLIENT_SECRET=...   # 只展示一次，服务端只存哈希
bun client/bin/mde.ts run --from 2026-09-01 --to 2026-09-14 --out ./export
```

不用 Docker 的本地开发方式、阿里云 RDS 的注意事项、以及 `preflight` 的完整说明见 [`docs/deploy.md`](docs/deploy.md)。

## 配置与外部依赖

所有配置通过环境变量注入，`src/config.ts` 启动时统一校验，缺一项直接拒绝启动。完整清单与每一项的含义见 [`.env.example`](.env.example)，这里只列外部依赖：

| 依赖 | 变量 | 说明 |
| --- | --- | --- |
| 腾讯会议企业自建应用 | `TM_APP_ID` `TM_SDK_ID` `TM_SECRET_ID` `TM_SECRET_KEY` `TM_OPERATOR_ID` | 只在网关/调度器进程里，永不下发 |
| MySQL ≥ 8.0 | `DATABASE_URL` | 建库必须显式 utf8mb4。留空则用 compose 自带实例 |
| 本地归档目录 | `MDE_ARCHIVE_ROOT` | 拉取落盘与 30 天保留窗口所在，必须存在且可写 |
| NAS 挂载点 | `MDE_NAS_ROOT` | 主存储。compose 下填宿主机路径，会被挂进容器 |
| 企业微信自建应用（可选） | `WECOM_*` | 控制台的企微登录；要么全填要么全不填 |
| 身份映射策略 | `IDENTITY_STRATEGY` | `direct` / `email` / `table`，决定企微用户如何对应到腾讯会议 userid |
| 时区 | `MDE_SCHEDULER_TZ_OFFSET_MIN` | 决定「每天 03:00 清理」按哪个时区算；东八区填 `480` |

Docker Compose 额外变量（端口、运行用户 uid/gid、MySQL 密码与数据目录）也在 `.env.example` 末尾。

## 仓库结构

```
src/                 网关 + worker（同一份代码，两个入口）
  index.ts           网关进程入口
  worker/scheduler.ts  调度器进程入口（单实例）
  worker/index.ts    一次性 worker（排查用，勿与调度器同跑）
  auth/ policy/ catalog/ audit/ tencent/ store/ http/ domain/
migrations/          001..016，网关与调度器启动时自动执行
scripts/             preflight 自检、admin-bootstrap、密码重置、数据回填等运维脚本
console/             管理控制台（独立 npm 项目，构建产物由网关托管）
client/              mde CLI
packages/engine/     导出引擎（CLI 与服务端 worker 共用）
docs/                部署手册、产品说明书、各阶段设计文档
docker-compose.yml   单机整套部署
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
| [`docs/deploy.md`](docs/deploy.md) | 部署手册：MySQL 准备、腾讯会议与企微后台配置、身份映射策略选择、采集权限规则模板、Docker Compose、preflight、错误码对照 |
| [`docs/console/spec.md`](docs/console/spec.md) | 控制台功能说明书：产品模型、六个页面的行为、规则引擎语义、系统状态与降级、已知缺口 |
| [`docs/roadmap.md`](docs/roadmap.md) | 里程碑 M1–M6 与各阶段状态 |
| [`docs/superpowers/specs/2026-07-20-meeting-export-gateway-design.md`](docs/superpowers/specs/2026-07-20-meeting-export-gateway-design.md) | 网关设计：为什么要网关、AK/SK 为什么不能下发、安全模型 |
| [`docs/superpowers/specs/2026-07-23-export-engine-cli-design.md`](docs/superpowers/specs/2026-07-23-export-engine-cli-design.md) | 导出引擎与 CLI 设计：数据库即任务队列 |
| [`docs/superpowers/specs/2026-07-20-user-stories.md`](docs/superpowers/specs/2026-07-20-user-stories.md) | 用户故事 |
| [`client/README.md`](client/README.md) | `mde` CLI 命令与参数 |

## 已知边界

- **只做腾讯会议企业版、企业自建应用（AK/SK）模式。** 不做飞书 / Zoom / 钉钉抽象层，不做 OAuth 第三方应用模式。
- **调度器必须且只能有一个实例。** 网关可以横向扩展，调度器不行。
- **网关返回的临时下载地址指向腾讯云端的录制文件，不读本地目录。** 因此「在保留期内」这个条件目前只在控制台的采集清单里判定，网关侧尚未强制——本地已清理但腾讯侧仍在的会议，程序仍取得到。这是登记在案的产品决定待定项，见 `docs/console/spec.md` §11 第 10 行。
- 其余已知缺口与残留同样登记在 `docs/console/spec.md` §11，不藏在代码注释里。

## 许可证

[MIT](LICENSE)
