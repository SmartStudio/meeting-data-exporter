# 部署指南

本文档说明生产环境的配置、部署、迁移、初始规则和检查方法。网关、调度器和一次性 worker 使用同一份镜像与环境变量。网关可以运行多个实例，调度器只能运行一个实例。

代码与配置变更后，以 [`src/config.ts`](../src/config.ts)、[`.env.example`](../.env.example)、[`docker-compose.yml`](../docker-compose.yml)、[`Dockerfile`](../Dockerfile)、[`scripts/preflight.ts`](../scripts/preflight.ts) 和 [`migrations/`](../migrations/) 为准。采集程序的调用方法见[采集程序调用手册](collector.md)。旧部署记录见[历史文档索引](history/README.md)。

## 目录

1. [前置条件](#1-前置条件)
2. [MySQL 准备](#2-mysql-准备)
3. [腾讯会议企业管理后台配置](#3-腾讯会议企业管理后台配置)
4. [企业微信自建应用配置](#4-企业微信自建应用配置)
5. [环境变量](#5-环境变量)
6. [身份映射策略](#6-身份映射策略)
7. [规则与采集授权](#7-规则与采集授权)
8. [Docker Compose 部署](#8-docker-compose-部署)
9. [迁移与历史窗口补跑](#9-迁移与历史窗口补跑)
10. [preflight 检查](#10-preflight-检查)
11. [错误码](#11-错误码)
12. [上线检查与已知限制](#12-上线检查与已知限制)

## 1. 前置条件

部署前确认以下条件：

- 腾讯会议企业自建应用可以调用 `GET /v1/corp/records`，固定的 operator 账号有企业录制查看或管理权限。
- 服务器安装 Docker Engine 和 Docker Compose v2。
- 服务器能访问 `api.meeting.qq.com:443`。启用企业微信登录时，还要能访问 `qyapi.weixin.qq.com:443`。
- 使用 MySQL 8.0.19 或更高版本，并创建 `utf8mb4` 数据库。worker 使用 `SELECT ... FOR UPDATE SKIP LOCKED`，写入语句使用 MySQL 8.0.19 引入的 `VALUES (...) AS new` 行别名。
- 本地归档目录已经存在且可写。NAS 已挂载到宿主机，挂载目录已经存在且可写。
- 生产网关使用 HTTPS 域名。反向代理把请求转发到网关 HTTP 端口，默认是 `3000`。
- 部署人员能操作腾讯会议企业管理后台。启用企业微信登录时，还需要企业微信管理后台权限。

腾讯会议免费版和专业版不能完成 `preflight` 的企业录制列表检查。脚本通过真实调用判断当前账号与应用是否可用。

## 2. MySQL 准备

### 2.1 版本和字符集

生产环境使用 MySQL 8.0.19 或更高版本。Docker Compose 使用 `mysql:8.0`。

数据库字符集必须是 `utf8mb4`。排序规则可以使用任一 `utf8mb4_*` 变体。`preflight` 会读取 `@@character_set_database` 和 `@@collation_database`。

```sql
CREATE DATABASE meeting_gateway
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'gateway'@'%' IDENTIFIED BY '<数据库密码>';
GRANT ALL PRIVILEGES ON meeting_gateway.* TO 'gateway'@'%';
FLUSH PRIVILEGES;
```

网关、调度器和一次性 worker 启动时都会执行迁移。数据库账号需要执行 `CREATE TABLE`、`ALTER TABLE`、`DROP TABLE`、索引操作和数据读写。上面的库级授权覆盖这些操作。

阿里云 RDS 还要确认实例参数：

```text
character_set_server = utf8mb4
```

### 2.2 连接串

```text
DATABASE_URL=mysql://gateway:<URL编码后的密码>@<RDS内网地址>:3306/meeting_gateway?charset=utf8mb4
```

密码中的 `@`、`:`、`/`、`%` 等 URL 保留字符需要编码。`src/store/db.ts` 还会把连接字符集设置为 `utf8mb4`，数据库本身仍须按上一节创建为 `utf8mb4`。

生产环境使用 RDS 时，把 ECS 内网地址加入 RDS 白名单。不要向公网开放 MySQL 端口。

## 3. 腾讯会议企业管理后台配置

在腾讯会议企业管理后台创建企业自建应用，并记录以下五项：

| 后台字段 | 环境变量 |
| --- | --- |
| App ID | `TM_APP_ID` |
| SDK ID | `TM_SDK_ID` |
| Secret ID | `TM_SECRET_ID` |
| Secret Key | `TM_SECRET_KEY` |
| operator 的 userid | `TM_OPERATOR_ID` |

`src/config.ts` 把这五项都作为必填项。`TM_OPERATOR_ID` 对应的账号需要企业录制查看或管理权限。建议使用固定服务账号，避免人员离职或账号回收导致调用失败。

不要把这些值写入文档、截图、工单或镜像。生产 `.env` 只放在服务器上，并限制文件权限。

## 4. 企业微信自建应用配置

企业微信登录是可选功能。只使用服务账号采集时，可以不配置企业微信。

启用企业微信登录时，在企业微信管理后台创建自建应用，并配置以下三项：

| 后台字段 | 环境变量 |
| --- | --- |
| 企业 ID | `WECOM_CORP_ID` |
| AgentId | `WECOM_AGENT_ID` |
| Secret | `WECOM_SECRET` |

把 `GATEWAY_BASE_URL` 的域名加入网页授权可信域名，并把需要登录控制台的成员或部门加入应用可见范围。

三项必须全填或全不填。只填一部分时，`loadConfig` 会拒绝启动。三项全不填时，以下路由返回 `501 wecom_not_configured`：

- `POST /api/v1/auth/device/code`
- `POST /api/v1/auth/device/token`
- `GET /auth/wecom/callback`
- `GET /device`

服务账号认证 `POST /api/v1/auth/service-token` 不依赖企业微信。

## 5. 环境变量

### 5.1 网关、调度器和 worker 共用变量

`src/config.ts` 在三个进程启动时读取以下变量：

| 变量 | 要求 | 默认值 |
| --- | --- | --- |
| `TM_APP_ID` | 必填，非空 | 无 |
| `TM_SDK_ID` | 必填，非空 | 无 |
| `TM_SECRET_ID` | 必填，非空 | 无 |
| `TM_SECRET_KEY` | 必填，非空 | 无 |
| `TM_OPERATOR_ID` | 必填，非空 | 无 |
| `TM_BASE_URL` | 可选，空串按未设置处理 | `https://api.meeting.qq.com` |
| `TM_QPS` | 可选，必须是大于或等于 1 的整数 | `5` |
| `WECOM_CORP_ID` | 与另外两项全填或全不填，空串按未设置处理 | 不启用企微登录 |
| `WECOM_AGENT_ID` | 与另外两项全填或全不填，空串按未设置处理 | 不启用企微登录 |
| `WECOM_SECRET` | 与另外两项全填或全不填，空串按未设置处理 | 不启用企微登录 |
| `DATABASE_URL` | 必填，非空 | 无 |
| `JWT_SECRET` | 必填，长度至少 32 个字符 | 无 |
| `GATEWAY_BASE_URL` | 必填，必须能被 `new URL()` 解析 | 无 |
| `IDENTITY_STRATEGY` | 必填，只能是 `direct`、`email`、`table` | 无 |
| `TRUSTED_PROXY_HOPS` | 可选，必须是大于或等于 1 的整数 | `1` |

`TM_QPS`、`TM_BASE_URL`、`TRUSTED_PROXY_HOPS` 和企微三项把空串视为未设置。必填项的空串会触发 `missing required config`。

`TRUSTED_PROXY_HOPS` 必须等于网关前方追加 `X-Forwarded-For` 的可信代理层数。值大于实际层数时，网关可能读取客户端可伪造的前缀，登录限流可以被绕过。值小于实际层数时，多名客户端可能共用一个代理 IP 限流桶。

`GATEWAY_BASE_URL` 用于企微跳转、管理员 Cookie 属性和下载地址。生产值使用 `https://<网关域名>`，不要带结尾斜杠。

### 5.2 归档和调度变量

| 变量 | 使用进程 | 要求 | 默认值 |
| --- | --- | --- | --- |
| `MDE_ARCHIVE_ROOT` | 网关、调度器、worker | 调度器和 worker 要求目录已存在且可写。网关未配置时文件直出和清理接口会降级 | 无 |
| `MDE_NAS_ROOT` | 网关、调度器、worker | 调度器和 worker 要求非空。网关未配置时 NAS 探测和回退读取会降级 | 无 |
| `MDE_WORKER_CONCURRENCY` | 一次性 worker | 整数 `1..5` | `4` |
| `MDE_SCHEDULER_TZ_OFFSET_MIN` | 网关、调度器 | 整数，范围 `-840..840`。非法值会告警并回退为 `0` | `0` |
| `MDE_SCHEDULER_TICK_SEC` | 调度器 | 正整数 | `30` |
| `MDE_SCHEDULER_FETCH_LOOKBACK_HOURS` | 网关、调度器 | 正整数 | `24` |
| `MDE_SCHEDULER_FETCH_CONCURRENCY` | 调度器 | 整数 `1..3` | `2` |
| `MDE_CONSOLE_DIST` | 网关 | 控制台构建产物目录。没有 `index.html` 时网关只提供 API | `console/dist` |
| `PORT` | 网关 | 整数 `1..65535` | `3000` |
| `HOST` | 网关 | 监听地址 | `0.0.0.0` |

`MDE_ARCHIVE_ROOT` 的会议目录格式是 `<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<会议号>`。时间按 UTC 计算。同名的第二场起追加 `_2`。目录名不含会议标题。

`MDE_SCHEDULER_TZ_OFFSET_MIN` 只影响每天 `03:00` 的清理任务和控制台显示。东八区填 `480`。

### 5.3 Docker Compose 变量

以下变量由 `docker-compose.yml` 读取：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `MDE_GATEWAY_PORT` | 宿主机映射到容器 `3000` 的端口 | `3000` |
| `MDE_UID` | 网关、调度器和 worker 的运行 uid | `1000` |
| `MDE_GID` | 网关、调度器和 worker 的运行 gid | `1000` |
| `MYSQL_PASSWORD` | Compose 内置 MySQL 的 `mde` 用户密码 | `mde`，只适合本地试跑 |
| `MYSQL_ROOT_PASSWORD` | Compose 内置 MySQL 的 root 密码 | `mde-root`，只适合本地试跑 |
| `MYSQL_DATA_DIR` | 内置 MySQL 的宿主机数据目录 | Docker 卷 `mde-mysql-data` |
| `MYSQL_HOST_PORT` | 内置 MySQL 绑定到 `127.0.0.1` 的宿主机端口 | `33306` |
| `MDE_ENV_FILE` | Compose 传给容器的环境文件路径 | `.env` |

使用内置 MySQL 且密码含 URL 保留字符时，同时设置原始 `MYSQL_PASSWORD` 和带 URL 编码密码的 `DATABASE_URL`。生产环境优先使用 RDS。

## 6. 身份映射策略

`IDENTITY_STRATEGY` 只用于企微用户登录后的身份映射。服务账号认证不使用这项映射。即使关闭企微登录，`src/config.ts` 仍要求它取三个合法值之一。

### 6.1 direct

`direct` 直接把企业微信 userid 当作腾讯会议 userid。只在两边 userid 完全一致时使用。

### 6.2 table

`table` 按 `identity_map.wecom_userid` 查找腾讯会议 userid。管理员需要维护精确对照表。

```sql
INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at)
VALUES ('<企微 userid>', '<腾讯会议 userid>', NULL, UNIX_TIMESTAMP())
ON DUPLICATE KEY UPDATE
  tm_userid = VALUES(tm_userid),
  updated_at = VALUES(updated_at);
```

### 6.3 email

`email` 按 `identity_map.email` 查找，并按 `updated_at` 降序取最新一行。企业微信应用还需要读取用户邮箱的权限。

```sql
INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at)
VALUES ('<企微 userid>', '<腾讯会议 userid>', '<企业邮箱>', UNIX_TIMESTAMP())
ON DUPLICATE KEY UPDATE
  tm_userid = VALUES(tm_userid),
  email = VALUES(email),
  updated_at = VALUES(updated_at);
```

`email` 列只有普通索引，没有唯一约束。部署方需要避免邮箱重复和离职邮箱复用造成的错误映射。

### 6.4 验证映射

```bash
bun scripts/preflight.ts \
  --sample-user '<企微 userid>' \
  --sample-email '<企业邮箱>'
```

`direct` 和 `table` 不需要 `--sample-email`。使用多个真实账号验证，覆盖不同部门和不同开户批次。

## 7. 规则与采集授权

### 7.1 三个规则栈

`policy_rules.kind` 把规则分为三个栈：

| `kind` | 使用进程 | `effect` | 没有规则命中时 |
| --- | --- | --- | --- |
| `fetch` | 调度器、worker | `all` 或 `skip` | `skip` |
| `archive` | 调度器、worker | 相对 NAS 根目录的模板或 `skip` | `skip` |
| `allow` | 网关、调度器 | `allow` 或 `deny` | `deny` |

`fetch` 有兼容行为。数据库里没有任何启用的 `fetch` 规则时，worker 会合成一条全拉规则。创建第一条启用的 `fetch` 规则后，兼容行为停止，没有命中规则的会议会按 `skip` 处理。上线时先创建一条无条件全拉规则，再逐步增加限制规则。

`archive` 没有兼容行为。没有命中规则时不写 NAS。至少创建一条归档规则，例如 `meetings/{年}/{月}`。模板相对 `MDE_NAS_ROOT` 解析，可以使用 `{年}`、`{月}`、`{会议号}`、`{标题}`。绝对路径、空模板、未知占位符和含 `..` 的路径会被拒绝。

`allow` 默认拒绝。规则主体必须是 `program`，`subject_value` 填 `service_accounts.id`。

三个栈使用同一套顺序：`priority` 降序，同优先级按 `id` 升序，第一条匹配规则决定结果。`effect` 不参与平局排序。无效 `effect`、缺失的会议事实和无法判断的条件会落到该栈的安全值。`fetch` 和 `archive` 使用 `skip`，`allow` 使用 `deny`。

### 7.2 条件字段

一条规则只能选择一个 `join_op`，取值是 `and` 或 `or`。`conds=[]` 匹配全部会议。

| 字段 | 运算符 | 值 |
| --- | --- | --- |
| `title` | `has`、`nothas` | 逗号、中文逗号或空白分隔的关键词字符串，大小写敏感 |
| `host` | `is`、`isnot` | 非空腾讯会议 userid |
| `dur` | `gt`、`lt` | 分钟数，使用严格大于或严格小于 |
| `age` | `within`、`before` | 天数。`within` 包含边界，`before` 不包含边界 |
| `arch` | `isarch`、`notarch` | 不需要值 |
| `dept` | `in`、`notin` | 部门名数组。当前没有数据源，条件恒不成立 |

未知字段、未知运算符和错误值不会匹配。求值器会区分事实缺失与条件不匹配。缺失事实足以让整条规则无法判断时，栈不再考察低优先级规则，并使用该栈的安全值。

### 7.3 资产类型

规则中的 `asset_types` 使用以下五个客户端资产键：

```text
video, audio, transcript, ai_minutes, chapters
```

`['*']` 表示全部五类。网关字段 `meeting_summary` 对应规则键 `transcript`。

迁移 `015_drop_sts_and_ai_transcript.sql` 已删除 STS 链路和 `ai_transcript`。不要再写 `ai_transcript` 或 `ai_meeting_transcripts`。

### 7.4 采集程序还需要逐会议授权

`allow` 规则只给出规则判定。网关还会检查服务账号是否启用，以及 `meeting_grants` 中是否存在该会议对该程序的生效授权。授权的 `asset_types` 会与规则放行范围取交集。

生产环境通过控制台的「采集授权」页创建程序、配置自动授权和人工授权。新建程序的 secret 只显示一次，服务端只保存哈希。

开发或联调环境可以运行：

```bash
bun scripts/seed-dev.ts --client-id '<程序 id>' --tm-userid '<腾讯会议 userid>'
```

该脚本创建服务账号和一条无条件 `allow` 规则。它不会替所有会议创建 `meeting_grants`。需要在控制台启用自动授权，或逐场授权。

### 7.5 升级旧规则

迁移 `004_console_stage3.sql` 把旧 `policy_rules` 复制到 `policy_rules_legacy`，再创建三栈结构的空 `policy_rules`。旧规则主体是用户，新规则的 `allow` 主体是程序，迁移不会自动转换授权语义。升级后需要重新创建三栈规则。

## 8. Docker Compose 部署

以下步骤使用 `/opt/mde/app` 作为代码目录，使用 `/opt/mde/.env` 作为生产环境文件。Docker Compose 命令都显式传入该文件。

### 8.1 准备目录和配置

```bash
cd /opt/mde/app
cp .env.example /opt/mde/.env
chmod 600 /opt/mde/.env
```

至少填写以下内容。值使用部署环境的真实配置，不要把填写后的文件提交到仓库。

```dotenv
TM_APP_ID=<腾讯会议 App ID>
TM_SDK_ID=<腾讯会议 SDK ID>
TM_SECRET_ID=<腾讯会议 Secret ID>
TM_SECRET_KEY=<腾讯会议 Secret Key>
TM_OPERATOR_ID=<腾讯会议 operator userid>

DATABASE_URL=mysql://gateway:<URL编码后的密码>@<RDS内网地址>:3306/meeting_gateway?charset=utf8mb4
JWT_SECRET=<至少 32 个字符的随机字符串>
GATEWAY_BASE_URL=https://<网关域名>
IDENTITY_STRATEGY=direct
TRUSTED_PROXY_HOPS=1

MDE_ARCHIVE_ROOT=<宿主机本地归档目录>
MDE_NAS_ROOT=<宿主机 NAS 挂载目录>
MDE_SCHEDULER_TZ_OFFSET_MIN=480
MDE_ENV_FILE=/opt/mde/.env
```

关闭企微登录时，让 `WECOM_CORP_ID`、`WECOM_AGENT_ID` 和 `WECOM_SECRET` 保持为空。启用时填写全部三项。

确保 `MDE_ARCHIVE_ROOT` 和 `MDE_NAS_ROOT` 已存在。Compose 把它们挂载为容器内的 `/data/archive` 和 `/data/nas`。目录属主需要与 `MDE_UID:MDE_GID` 一致，默认是 `1000:1000`。

### 8.2 构建并启动网关

生产使用 RDS 时，不启动 Compose 内置 MySQL：

```bash
docker compose --env-file /opt/mde/.env build gateway scheduler worker
docker compose --env-file /opt/mde/.env up -d --no-deps gateway
```

网关启动前执行全部迁移。确认健康检查：

```bash
docker compose --env-file /opt/mde/.env ps
curl -fsS https://<网关域名>/healthz
```

`/healthz` 成功响应为：

```json
{"status":"ok"}
```

### 8.3 创建首个管理员

```bash
docker compose --env-file /opt/mde/.env exec gateway \
  bun scripts/admin-bootstrap.ts --username '<管理员用户名>' --password '<管理员密码>'
```

密码至少 8 个字符。脚本只在 `admin_accounts` 为空时执行成功。

### 8.4 配置规则和采集程序

先登录控制台完成以下配置：

1. 创建无条件全拉的 `fetch` 规则，明确当前拉取行为。
2. 创建归档规则，指定相对 `MDE_NAS_ROOT` 的目录模板。
3. 创建采集程序和 `allow` 规则。
4. 为采集程序启用自动授权，或创建逐会议授权。

完成这些配置后再启动调度器，避免空规则状态下全量下载到本地但不归档到 NAS。

### 8.5 启动单实例调度器

```bash
docker compose --env-file /opt/mde/.env up -d --no-deps scheduler
```

不要使用 `--scale scheduler=2`。调度器会执行归档和本地文件清理。多个实例会同时操作同一批文件，`job_runs` 的中断记录也会互相影响。

调度器的五个任务如下：

| 任务 | 频率 |
| --- | --- |
| `fetch_recordings` | 每 15 分钟 |
| `archive_nas` | 每小时整点 |
| `cleanup_expired` | 每天 `03:00`，时区由 `MDE_SCHEDULER_TZ_OFFSET_MIN` 决定 |
| `refresh_inventory` | 每 5 分钟 |
| `auto_grant` | 每 5 分钟 |

调度器按时间片触发。启动时把当前时间片记为已触发，停机期间错过的时间片不会补跑。上一轮未结束时不会启动同任务的新一轮，并写入一行 `job_runs.status='skipped'`。

### 8.6 配置反向代理

网关在容器内监听 `0.0.0.0:3000`。Compose 默认把宿主机 `MDE_GATEWAY_PORT` 映射到容器 `3000`。反向代理负责 TLS 终止，并设置 `X-Forwarded-For` 和 `X-Forwarded-Proto`。

网关端口只对反向代理开放。安全组出站允许访问腾讯会议、企业微信和 RDS。`TRUSTED_PROXY_HOPS` 按实际代理层数设置。

### 8.7 本地整套试跑

本地使用 Compose 内置 MySQL 时：

```bash
docker compose --env-file /opt/mde/.env up -d --build
```

内置 MySQL 的容器端口是 `3306`，宿主机只绑定 `127.0.0.1:${MYSQL_HOST_PORT}`，默认是 `127.0.0.1:33306`。

## 9. 迁移与历史窗口补跑

### 9.1 迁移行为

`runMigrations` 按文件名升序执行 `migrations/*.sql`。当前迁移范围是 `001_init.sql` 到 `016_record_type.sql`。

网关、调度器和一次性 worker 都会执行迁移。迁移使用同一条数据库连接，并通过基于当前数据库名的 `GET_LOCK` 互斥。默认等待迁移锁 120 秒。仓库没有迁移版本表，每个迁移文件都必须可以重复执行。

升级时关注以下迁移：

| 迁移 | 行为 |
| --- | --- |
| `004_console_stage3.sql` | 备份旧 `policy_rules` 到 `policy_rules_legacy`，创建三栈规则表，旧规则不自动转换 |
| `015_drop_sts_and_ai_transcript.sql` | 删除 `sts_token_requests`，删除智能优化版逐字稿资产行，从规则、授权、改写和程序自动授权范围中移除 `ai_transcript` |
| `016_record_type.sql` | 给 `meetings` 和 `meeting_cache` 增加 `record_type`，回填旧转写记录，删除转写记录下无文件的 `video`、`audio`、`chapters` 任务和探测行 |

迁移只追加新编号。不要修改已经发布的迁移文件。

### 9.2 补跑历史窗口

调度器只查看最近 `MDE_SCHEDULER_FETCH_LOOKBACK_HOURS`，默认 24 小时。补历史数据时运行一次性 worker：

```bash
docker compose --env-file /opt/mde/.env run --rm --no-deps \
  worker --from 2026-01-01 --to 2026-01-31
```

`--from` 和 `--to` 的日期按 UTC 零点解析，区间右端不包含在内。要包含 1 月 31 日全天，`--to` 写 `2026-02-01`。

worker 会先枚举完整范围，再一次性写入会议和资产任务。枚举期间数据库和归档目录可能没有进度变化。运行完成后输出发现、探测、下载、清单和归档统计。下载失败或归档失败时退出码为 `1`。

还可以按会议号或会议 ID 补跑：

```bash
docker compose --env-file /opt/mde/.env run --rm --no-deps \
  worker --code '<会议号>'

docker compose --env-file /opt/mde/.env run --rm --no-deps \
  worker --meeting-id '<meeting_id>'
```

`--code` 和 `--meeting-id` 互斥。资产类型由 `--assets` 指定，默认是五类全部。

## 10. preflight 检查

### 10.1 运行方法

本地运行：

```bash
bun run preflight
```

生产容器内运行：

```bash
docker compose --env-file /opt/mde/.env exec gateway bun run preflight
```

验证身份映射时：

```bash
docker compose --env-file /opt/mde/.env exec gateway \
  bun scripts/preflight.ts --sample-user '<企微 userid>' --sample-email '<企业邮箱>'
```

### 10.2 检查项和退出码

脚本输出 8 个结果，编号是 `1`、`2`、`2b`、`2c`、`3`、`4`、`5`、`6`：

| 编号 | 检查 |
| --- | --- |
| `1` | `loadConfig` 配置完整性 |
| `2` | 数据库执行 `SELECT 1` |
| `2b` | 数据库字符集与排序规则 |
| `2c` | 数据库版本 |
| `3` | 腾讯凭证、签名和企业录制权限，调用最近 1 天的 `GET /v1/corp/records` |
| `4` | 根据第 3 项结果判断账号版本 |
| `5` | 企业微信 `gettoken`。企微未配置时为 `SKIP` |
| `6` | 身份映射。未提供 `--sample-user` 时为 `SKIP` |

状态含义：

- `PASS` 表示脚本完成了对应检查。
- `FAIL` 表示检查失败。
- `SKIP` 表示当前条件不足，不能视为通过。

只要存在 `FAIL`，退出码就是 `1`。只有 `PASS` 和 `SKIP` 时退出码仍是 `0`。部署流水线不能只看退出码，还要确认没有 `SKIP`。

`2c` 要求 MySQL 8.0.19 或更高版本，与 worker 的语法依赖一致。

脚本不检查 `MDE_ARCHIVE_ROOT`、`MDE_NAS_ROOT`、反向代理、调度器单实例或规则配置。这些项目按第 12 节人工确认。

## 11. 错误码

### 11.1 腾讯会议 API

腾讯错误分类读取响应体的 `error_info.error_code`。HTTP 状态码不用于分类。

| `error_code` | 代码行为 |
| --- | --- |
| `9042`、`500014`、`190004`、`200001`、`202004`、`500063` | `fatal`，立即失败，不重试 |
| `4051`、`4049`、`500182` | `asset_permanent`，该资产永久不可用，跳过该资产 |
| `500051` | `asset_pending`，资产仍在生成，交给探测队列稍后再查 |
| `190301` | `transient`，重试时重新生成 nonce 和 timestamp |
| `190310` | `transient`，退避重试并降低令牌桶速率 |
| 其他错误码 | `transient`，按重试策略处理 |

`preflight` 对常见错误给出附加提示：`9042` 检查 Secret 和应用权限，`500014` 检查 operator 权限，`190301` 检查系统时钟，`190303` 检查 App ID、Secret ID 和 SDK ID（运行时该码不在 `fatal` 名单里，按 `transient` 重试），`190310` 检查限流配置。

### 11.2 采集 API

| HTTP 状态 | `error` | 含义 |
| --- | --- | --- |
| `400` | `invalid_request` | 请求缺少必填字段 |
| `400` | `authorization_pending`、`slow_down`、`expired_token` | 设备授权轮询状态 |
| `400` | `invalid_asset_id` | `assetId` 格式错误 |
| `401` | `missing_token`、`invalid_token`、`token_expired` | Bearer 访问令牌缺失、无效或过期 |
| `401` | `invalid_credentials` | 服务账号不存在、secret 错误、账号停用或账号过期。响应不区分具体原因 |
| `401` | `invalid_refresh_token`、`refresh_token_reused`、`refresh_token_expired` | 企微会话刷新失败 |
| `403` | `forbidden` | 当前身份、规则、授权或资产范围不允许下载，或下载令牌无效、过期 |
| `404` | `meeting_not_found_in_range` | 网关存储中没有命中会议，或会议对当前程序不可见 |
| `404` | `asset_not_found` | 已通过权限判定，但没有找到已完成资产或盘上文件 |
| `404` | `not_found` | 路由不存在 |
| `429` | `rate_limited` | 登录端点的 IP 或账号限流 |
| `500` | `internal_error` | 未处理的网关异常，查看网关日志 |
| `501` | `wecom_not_configured` | 当前部署未启用企微登录 |
| `502` | `upstream_config_error` | 腾讯接口返回配置或权限类致命错误，响应带 `tencent_code` |
| `503` | `archive_root_unconfigured` | 网关未配置 `MDE_ARCHIVE_ROOT`，不能直出文件 |
| `503` | `upstream_unavailable` | 腾讯接口的瞬时错误在重试后仍未恢复，响应带 `tencent_code` |

`GET /auth/wecom/callback` 返回 HTML。身份映射失败时 HTTP 状态是 `403`，页面包含 `account_not_provisioned`，该值不是 JSON `error` 字段。

`POST /api/v1/assets/:assetId/download-url` 成功响应只有 `url` 和 `expires_at`。`file_type` 和 `bytes_expected` 从列资产响应读取。下载地址有效期是 15 分钟，文件端点支持 `Range`，范围起点越界时返回 `416`。

## 12. 上线检查与已知限制

### 12.1 上线检查

上线前逐项确认：

- MySQL 版本至少是 8.0.19，数据库字符集是 `utf8mb4`。
- `/opt/mde/.env` 权限为 `600`，文件内没有占位符。
- 文档、截图、日志和工单没有真实生产 IP、密码、`TM_*`、`JWT_SECRET` 或 client secret。
- `MDE_ARCHIVE_ROOT` 和 `MDE_NAS_ROOT` 已挂载到 gateway 与 scheduler 容器，容器 uid 和 gid 有写权限。
- NAS 探测在控制台显示可达，并能返回容量。
- `TRUSTED_PROXY_HOPS` 等于实际可信代理层数。
- 网关 `/healthz` 返回 `200`。
- `preflight` 的必需检查全部是 `PASS`。关闭企微登录时，第 5 项和第 6 项允许为 `SKIP`。
- 已创建首个管理员、拉取规则、归档规则、采集权限规则、采集程序和授权方式。
- `scheduler` 只有一个实例。
- 首次历史窗口已经用一次性 worker 补跑。
- 采集程序能完成取令牌、列会议、列资产、申请下载地址和 Range 下载。

### 12.2 已知限制

- `src/index.ts` 也调用 `loadConfig`，`docker-compose.yml` 会把 `TM_*` 注入 gateway。当前实现仍要求网关容器持有腾讯凭证。
- 登录限流器保存在单个网关进程的内存中，不在多个网关实例之间共享。多实例部署还要在反向代理或 WAF 层设置限流。
- 调度器和一次性 worker 启动时只检查 `MDE_NAS_ROOT` 非空，不检查目录存在、可写和容量。控制台的 NAS 探测会执行目录、写入和容量检查。
- `dept` 规则条件没有企业微信通讯录数据源，`in` 和 `notin` 都不会命中。
- `meeting_cache` 没有 TTL 或自动清理。调度器每轮把窗口内的企业会议写入该表。
- 本地文件到期清理后会议仍可被采集。控制台的「在保留期内」和采集清单按 `meeting_archives.local_purged_at IS NULL` 判断，网关的 `AccessGate` 不读该字段，文件端点在本地文件缺失时改从 `archived_assets.nas_path` 读 NAS。只要规则和授权仍放行，清理后的会议照样能下载。见 `docs/console/spec.md` §11 第 10 条。
- `download-url` 不返回 `file_type` 和 `bytes_expected`。采集程序需要先读取资产清单。

历史状态、旧服务器步骤和已完成的上线事项只保存在[历史文档索引](history/README.md)中，不作为当前部署依据。
