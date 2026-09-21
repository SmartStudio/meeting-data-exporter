# 采集程序调用手册

面向拿到 service account、要把会议资产取到自己机器上的人。`mde` 命令的逐条参数见
[`client/README.md`](../client/README.md)。本文讲整条链路怎么跑：数据从哪来、
第一次全量怎么拉、日常怎么追、出了问题看哪里。

## 目录

1. [数据从哪来](#1-数据从哪来)
2. [接入前要备好的东西](#2-接入前要备好的东西)
3. [凭证怎么放](#3-凭证怎么放)
4. [第一次全量拉取](#4-第一次全量拉取)
5. [日常增量](#5-日常增量)
6. [核对与排错](#6-核对与排错)
7. [网关接口契约（自己写采集程序时看）](#7-网关接口契约)

## 1. 数据从哪来

采集程序只和网关说话，不调腾讯会议接口。链路是：

```
腾讯会议 --(调度器，每 15 分钟拉最近 24 小时)--> 网关的库 + 本地归档目录 --> NAS
                                                        |
                                    采集程序 --(service account)--> 网关 --> 文件直出
```

接入前先记住下面几条口径：

- 采集程序看到的是调度器已经下载完成的会议和资产。腾讯此刻有、调度器还没下完的
  不在清单里。一场会议可以已经出现在列表里，而某类资产（比如 AI 纪要）还没生成
  或还没下完，下一轮再查就有了。
- 调度器每轮只回看最近 24 小时（`MDE_SCHEDULER_FETCH_LOOKBACK_HOURS`，默认 24），
  错过的时间片不补跑。上线前的历史会议、调度器停机期间的会议，要先在服务器上跑
  一次性 worker 补窗口（第 4 节），采集程序才能看到。
- 看不到的会议一律回 404。「库里没有」与「无权看」用同一个响应，不作区分。一场
  会议要对某个采集程序可见，得同时满足：规则栈放行（`docs/deploy.md` 第 7 节）、
  会议已授权给该程序（调度器每 5 分钟自动授权一轮）、该 service account 未停用。
  命中规则里 deny 条件的会议，在列会议、会议详情、资产清单三处都不出现。

## 2. 接入前要备好的东西

| 项 | 谁做 | 在哪 |
| --- | --- | --- |
| service account（client id + secret） | 管理员 | 控制台「采集授权」页新建。secret 只展示一次，服务端只存哈希 |
| 至少一条放行规则 | 管理员 | `policy_rules` 初始为空，不插规则任何程序都取不到东西。模板见 `docs/deploy.md` 第 7 节 |
| 历史窗口已补跑 | 运维 | 第 4 节 |
| 本机有 bun，且能访问网关地址 | 采集方 | `bun install` 后 `bun client/bin/mde.ts`，或在 `client/` 下 `bun link` 得到 `mde` 命令 |

## 3. 凭证怎么放

`mde` 从环境变量取配置，不读也不写任何本地凭据文件。必填三项：

| 变量 | 含义 |
| --- | --- |
| `MDE_GATEWAY_URL` | 网关基地址，例如 `http://<网关地址>:3000` |
| `MDE_CLIENT_ID` | service account 的 client id |
| `MDE_CLIENT_SECRET` | 对应 secret |

令牌只缓存在本次调用的进程内存里，进程退出即失效。

推荐把这三项放进一个只有自己可读的文件，每次用时装载，不写进 shell 历史、不提交进仓库：

```bash
# 只做一次
cat > ~/.mde-prod.env <<'EOF'
MDE_GATEWAY_URL=http://<网关地址>:3000
MDE_CLIENT_ID=<client id>
MDE_CLIENT_SECRET=<secret>
EOF
chmod 600 ~/.mde-prod.env

# 每次用之前
set -a; . ~/.mde-prod.env; set +a
```

不要把这个文件的内容打到终端或聊天里，也不要把它放进项目目录。

## 4. 第一次全量拉取

分两步。先让服务器把历史窗口补进网关，再从本机拉。

### 4.1 服务器端补窗口（运维）

在生产机上用一次性 worker 跑目标区间。它与调度器共用发现和下载逻辑、同一张
`meeting_assets` 表、同一个归档目录，区别是手动触发、跑完退出：

```bash
cd /opt/mde/app && nohup docker compose --env-file /opt/mde/.env run --rm --no-deps \
  worker --from 2026-01-01 --to 2026-09-21 > /opt/mde/backfill-2026.log 2>&1 &
```

要点：

- `--no-deps` 不能少，否则 compose 会顺手拉起一个用不到的本地 MySQL 容器。
- `--from` 与 `--to` 都解析为当天 0 点 UTC。要包含 9 月 20 日全天就写 `09-21`。
- 已经下载完成的资产不会重下。发现阶段的 upsert 只补 `asset_id` 和大小，不动
  `status`，`completed` 的行原样留着。区间和最近两天重叠没有影响。
- 中途没有日志是正常的。worker 先把整个区间按 31 天切窗口、逐页把腾讯的会议列表
  枚举完（`corp/records` 配额 10 次/分、每页 20 场，全年量级要一两个小时），一次性
  写库后才开始下载，跑完才打这五行汇总：

  ```
  discovered meetings=<n> tasks=<n>
  probes resolved=<n> abandoned=<n> new=<n>
  completed=<n> failed=<n> skipped=<n> lost=<n>
  manifests written=<n> unchanged=<n> skipped=<n> failed=<n>
  archived newlyArchived=<n> verificationFailed=<n> failed=<n> sidecarFailed=<n> skipped=<n> undecidable=<n>
  ```

  枚举阶段要判断它是否还在动，看容器和归档目录：

  ```bash
  docker ps --filter name=worker-run
  docker stats --no-stream $(docker ps -q --filter name=worker-run)   # NET I/O 在涨就是在枚举
  find /opt/data/mde/archive -type f -mmin -30 | wc -l                 # 下载阶段开始后有值
  ```

- 调度器可以不停。同跑期间刚结束的新会议可能被 worker 标成 `skipped`，跑完后查一遍
  并放回队列：

  ```sql
  select count(*) from meeting_assets where status='skipped' and last_error='meeting_meta_missing';
  update meeting_assets set status='pending', last_error=null, lease_expires_at=null, attempts=0
   where status='skipped' and last_error='meeting_meta_missing';
  ```

- 想快一点，在命令前加 `MDE_WORKER_CONCURRENCY=5`，或者给 worker 传 `--concurrency 5`。
  默认 4，上限 5（连接池 10 条，每个执行体按 2 条算）。
- 只补单场时用 `--code <会议号>` 或 `--meeting-id <id>` 代替 `--from/--to`，两者互斥。

### 4.2 本机拉取（采集方）

```bash
set -a; . ~/.mde-prod.env; set +a
bun client/bin/mde.ts run --from 2026-01-01 --to 2026-09-21 --out /data/meetings
```

- `--out` 是导出根目录，每条命令都要带，包括只读的 `list`。
- 跨度超过 31 天会自动切成多次请求，不用自己拆。
- 队列在 `<out>/.mde/queue.sqlite`。Ctrl-C 或断电后重跑同一条命令即可续传，已完成的
  资产不会重下。换一个 `--out` 等于从零开始，不要换。
- 结束时打印三行：

  ```
  discovered meetings=<n> tasks=<n>
  completed=<n> failed=<n> skipped=<n>
  manifests written=<n> unchanged=<n> skipped=<n> failed=<n>
  ```

  本轮有任务转入 failed 或 dead 时退出码为 1，其余情况为 0。

导出目录长这样：

```
<out>/<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<会议号>/
  recording_<remoteId>.mp4      video。转写类录制（record_type=3）没有这一项
  transcript.txt / .docx / .pdf transcript，平台给几种格式就各存一份
  minutes.md                    ai_minutes
  chapters.json                 chapters
  meeting.json                  会议元数据
  _manifest.json                这个目录里每个文件的大小与哈希，以及缺席资产的原因
<out>/.mde/queue.sqlite
```

`meeting.json` 与 `_manifest.json` 由 `run` 和 `execute` 在一轮收尾时写，`get` 不写。

目录名不含会议主题。周期会议每一场各占一个目录，同一分钟的第二场目录名以 `_2`
结尾。腾讯普通云录制从不产出 `audio`，这一类在清单里通常见不到。

## 5. 日常增量

两条 cron 就够：一条追延迟资产和中断的下载，一条用滚动窗口补新会议。

```cron
*/15 * * * * set -a; . /home/collector/.mde-prod.env; set +a; cd /opt/mde-client && \
  bun client/bin/mde.ts execute --out /data/meetings >> /var/log/mde.log 2>&1

0 2 * * * set -a; . /home/collector/.mde-prod.env; set +a; cd /opt/mde-client && \
  bun client/bin/mde.ts run --from "$(date -u -d '2 days ago' +%F)" --to "$(date -u +%F)" \
  --out /data/meetings >> /var/log/mde.log 2>&1
```

这两条各自的作用：

- AI 纪要和章节比录像慢，网关侧要等调度器下完才出现在清单里。`mde` 在发现阶段把
  缺席的资产记成探测状态，不计入失败。等待上限从会议结束时间起算，录像类 6 小时，
  智能类 48 小时。每次 `execute` 都会重查到期的探测，就绪就补下，超时才放弃。
- 滚动两天，是因为跨天结束的会议和延迟生成的资产可能落在前一天的窗口里。重叠区间
  不会重下，见第 4 节。

只要发现不下载用 `discover`，只看队列用 `status`，把 failed/dead 放回队列用 `retry`
再 `execute`。

## 6. 核对与排错

先看这几条：

```bash
mde list --from 2026-09-18 --to 2026-09-21 --out /data/meetings   # 网关里有哪些会议
mde list --meeting-id <meeting_id> --out /data/meetings            # 单场是否可见
mde status --out /data/meetings                                    # 队列各状态计数与失败原因
```

`list` 翻完所有页后打一行 `total=`，是这段时间可见会议的总数。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `mde get 1234567890` 返回 404 | 纯数字位置参数按会议号解释。meeting_id 走的是另一个参数 | 用 `--meeting-id <id>` |
| `meeting_not_found_in_range` | 网关的库里没有这场会议，或这场会议对你不可见，两者同一响应。加宽 `--from/--to` 没用 | 会议时间在调度器窗口之外就让运维补跑（4.1）；在窗口内还 404 就找管理员看规则和授权 |
| 会议在列表里，`assets` 少了某一类 | 调度器还没下完，或腾讯还没生成 | 等下一轮 `execute`；48 小时后仍没有就是没生成 |
| `invalid_credentials` | client id/secret 不对，或该 service account 已停用 | 控制台核对；secret 丢了只能轮换 |
| `forbidden` on download-url | 规则放行了会议但没放行这类资产，或这个 assetId 网关从没见过 | 管理员改规则的 `assets` 条件；assetId 从列资产的响应里取，不要自己拼 |
| `rate_limited` | 取令牌太频繁。令牌端点按来源 IP 和 client_id 两个维度各限一道 | 令牌拿到后复用到 401 再换，别每个请求都取；多台机器别共用出口同时启动 |
| 下载到一半网关重启 | 下载地址 15 分钟有效，续传按 Range 断点接 | 重跑同一条命令即可 |

## 7. 网关接口契约

自己写采集程序而不用 `mde` 时，需要的只有下面五个端点。所有时间戳都是 Unix 秒。

**取令牌**

```
POST /api/v1/auth/service-token
{"client_id": "...", "client_secret": "..."}
-> 200 {"access_token": "...", "expires_in": 900}
-> 400 invalid_request       少了 client_id 或 client_secret
-> 401 invalid_credentials   账号不存在、密钥错误、已禁用、已过期，四者同一响应
-> 429 rate_limited
```

access_token 15 分钟有效，没有 refresh，到期重新取。之后每个请求带
`Authorization: Bearer <access_token>`，401 时重新取一次。

**列会议**

```
GET /api/v1/meetings?from=<秒>&to=<秒>&cursor=&limit=
GET /api/v1/meetings?meeting_code=<会议号>[&from&to]
GET /api/v1/meetings?meeting_id=<id>[&from&to]
-> 200 {"meetings": [{meeting_id, sub_meeting_id, meeting_code, subject, record_type,
                      host_user_id, start_time, end_time, state}], "next_cursor": "..."|null}
```

`from` 到 `to` 单次不要超过 31 天。缺省时 `from` 取 31 天前、`to` 取当前时刻。`limit` 默认 50、
上限 100；`cursor` 是下一页的起始序号，从 `next_cursor` 原样回传。

`sub_meeting_id` 是这一场录制的记录 id（腾讯的 `meeting_record_id`），周期会议每场
不同，后面列资产要带上。`record_type` 为 3 表示转写记录，这类记录只有逐字稿和纪要。

**列资产**

```
GET /api/v1/meetings/:meetingId/assets?sub_meeting_id=<id>[&from&to]
-> 200 {"assets": [{asset_id, meeting_id, sub_meeting_id, asset_type, remote_id,
                    file_type, bytes_expected, allow_download}]}
-> 404 meeting_not_found_in_range   会议不存在或对你不可见，两者同一响应
```

`asset_type` 取值 `video` / `audio` / `meeting_summary` / `ai_minutes` / `chapters`，
其中 `meeting_summary` 是逐字稿。不给 `sub_meeting_id` 时取 `start_time` 最新的那条
录制记录。这里只列已经下载完成的资产，响应里没有平台转码状态字段。

**取下载地址**

```
POST /api/v1/assets/:assetId/download-url
-> 200 {"url": "<网关自己的 content 地址>", "expires_at": <秒>}
-> 400 invalid_asset_id   assetId 格式不对
-> 403 forbidden          规则不放行这类资产，或这个 assetId 网关从没见过
-> 404 asset_not_found    判定放行了，但盘上没有这个文件
```

**下载文件**

```
GET <url>                      整个文件，200
GET <url>  Range: bytes=N-     从 N 续传，206 + Content-Range
```

这一步不带 Bearer。`url` 里的 token 15 分钟有效，过期重新申请一次 download-url；
token 与路径上的 assetId 对不上回 403。起点超过文件长度回 416，带
`Content-Range: bytes */<size>`，调用方应丢掉本地 `.part` 重下。文件由网关从本地归档
直出，本地被保留策略清掉后自动改从 NAS 直出，调用方无感。

网关的错误体至少有一段机器码 `{"error": "<code>"}`，`meeting_not_found_in_range`
这类还带一段给人看的 `message`。`message` 要打出来：它写明网关只查自己的库、不问
腾讯，省得往加宽时间范围的方向排查。
