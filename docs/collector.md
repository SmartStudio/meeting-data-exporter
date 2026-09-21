# 采集程序调用手册

面向拿到 service account、要把会议资产取到自己机器上的人。`mde` 命令的逐条参数见
[`client/README.md`](../client/README.md)，本文讲整条链路怎么跑：数据从哪来、
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

采集程序只和网关说话，不碰腾讯会议接口。链路是：

```
腾讯会议 --(调度器，每 15 分钟拉最近 24 小时)--> 网关的库 + 本地归档目录 --> NAS
                                                        |
                                    采集程序 --(service account)--> 网关 --> 文件直出
```

由此有三条口径，接入前先记住：

- **看到的是调度器已经下载完成的会议和资产**，不是腾讯此刻有的。会议出现在
  列表里，但某类资产（比如 AI 纪要）还没生成或还没下完，就先不在清单里，下一轮
  再来就有了。
- **调度器只向前看 24 小时**（`MDE_SCHEDULER_FETCH_LOOKBACK_HOURS`），不回头补。
  上线前的历史会议、调度器停机期间的会议，要先在服务器上跑一次性 worker 补窗口
  （第 4 节），采集程序才能看到。
- **看不到的会议一律 404**，不区分「没有」和「无权」。一场会议要对某个采集程序
  可见，得同时满足：规则栈放行（`docs/deploy.md` 第 7 节）、会议已授权给该程序
  （调度器每 5 分钟自动授权一次）、该 service account 未停用。命中敏感词的会议
  （规则里的 deny 条件）在列表、详情、资产清单三处都不出现。

## 2. 接入前要备好的东西

| 项 | 谁做 | 在哪 |
| --- | --- | --- |
| service account（client id + secret） | 管理员 | 控制台「采集授权」页新建。secret 只展示一次，服务端只存哈希 |
| 至少一条放行规则 | 管理员 | `policy_rules` 初始为空，不插规则任何程序都取不到东西。模板见 `docs/deploy.md` 第 7 节 |
| 历史窗口已补跑 | 运维 | 第 4 节 |
| 本机有 bun，且能访问网关地址 | 采集方 | `bun install` 后 `bun client/bin/mde.ts`，或在 `client/` 下 `bun link` 得到 `mde` 命令 |

## 3. 凭证怎么放

`mde` 只从三个环境变量取配置，不读也不写任何本地凭据文件：

| 变量 | 含义 |
| --- | --- |
| `MDE_GATEWAY_URL` | 网关基地址，例如 `http://<网关地址>:3000` |
| `MDE_CLIENT_ID` | service account 的 client id |
| `MDE_CLIENT_SECRET` | 对应 secret |

推荐做法是放进一个只有自己可读的文件，每次用时装载，不写进 shell 历史、不提交进仓库：

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

不要 `cat` 这个文件到终端或聊天里，不要把它放进项目目录。

## 4. 第一次全量拉取

分两步。先让服务器把历史窗口补进网关，再从本机拉。

### 4.1 服务器端补窗口（运维）

在生产机上用一次性 worker 跑目标区间。它与调度器共用发现和下载逻辑、同一张
`meeting_assets` 表、同一个归档目录，只是手动触发、跑完退出：

```bash
cd /opt/mde/app && nohup docker compose --env-file /opt/mde/.env run --rm --no-deps \
  worker --from 2026-01-01 --to 2026-09-21 > /opt/mde/backfill-2026.log 2>&1 &
```

要点：

- `--no-deps` 不能少，否则 compose 会顺手拉起一个用不到的本地 MySQL 容器。
- `--to` 解析为当天 0 点 UTC，要包含 9 月 20 日全天就写 `09-21`。
- **已经下载完成的资产不会重下。** 发现阶段的 upsert 只补 `asset_id` 和大小，
  不动 `status`，`completed` 的行原样留着。所以区间和最近两天重叠没关系。
- **中途没有日志是正常的。** worker 先把整个区间按 31 天切窗口、逐页把腾讯的
  会议列表枚举完（`corp/records` 配额 10 次/分、每页 20 场，全年量级要一两个小时），
  一次性写库后才开始下载，最后只打两行汇总：

  ```
  discovered meetings=<n> tasks=<n>
  completed=<n> failed=<n> skipped=<n> lost=<n>
  ```

  看它是否在动，看容器和归档目录，不要看日志：

  ```bash
  docker ps --filter name=worker-run
  docker stats --no-stream $(docker ps -q --filter name=worker-run)   # NET I/O 在涨就是在枚举
  find /opt/data/mde/archive -type f -mmin -30 | wc -l                 # 下载阶段开始后有值
  ```

- 调度器可以不停。但同跑期间刚结束的新会议可能被 worker 标成 `skipped`，跑完后查一遍并放回队列：

  ```sql
  select count(*) from meeting_assets where status='skipped' and last_error='meeting_meta_missing';
  update meeting_assets set status='pending', last_error=null, lease_expires_at=null, attempts=0
   where status='skipped' and last_error='meeting_meta_missing';
  ```

- 想快一点在命令前加 `MDE_WORKER_CONCURRENCY=5`，上限 5，默认 4。

### 4.2 本机拉取（采集方）

```bash
set -a; . ~/.mde-prod.env; set +a
bun client/bin/mde.ts run --from 2026-01-01 --to 2026-09-21 --out /data/meetings
```

- `--out` 是导出根目录，几乎每条命令都要带，包括只读的 `list`。
- 跨度超过 31 天会自动切成多次请求，不用自己拆。
- 队列在 `<out>/.mde/queue.sqlite`。Ctrl-C 或断电后重跑同一条命令即可续传，
  已完成的资产不会重下。**不要换 `--out`**，换了等于从零开始。
- 结束时打印与 worker 相同的两行汇总，外加一行 manifest 统计。有任务进入
  failed 或 dead 时退出码为 1。

导出目录长这样：

```
<out>/<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<会议号>/
  recording_<remoteId>.mp4      video。转写类录制（主题以「转写_」开头）没有这一项
  transcript.txt / .docx / .pdf transcript，三种格式各一份
  minutes.md                    ai_minutes
  chapters.json                 chapters
  meeting.json                  会议元数据
  _manifest.json                这个目录里每个文件的大小与哈希，以及缺席资产的原因
<out>/.mde/queue.sqlite
```

`audio` 这一类腾讯普通云录制从不产出，清单里通常见不到。周期会议每一场各占
一个目录，同一分钟的第二场目录名以 `_2` 结尾。

## 5. 日常增量

两条 cron 就够：一条追延迟资产和中断的下载，一条用滚动窗口补新会议。

```cron
*/15 * * * * set -a; . /home/collector/.mde-prod.env; set +a; cd /opt/mde-client && \
  bun client/bin/mde.ts execute --out /data/meetings >> /var/log/mde.log 2>&1

0 2 * * * set -a; . /home/collector/.mde-prod.env; set +a; cd /opt/mde-client && \
  bun client/bin/mde.ts run --from "$(date -u -d '2 days ago' +%F)" --to "$(date -u +%F)" \
  --out /data/meetings >> /var/log/mde.log 2>&1
```

为什么是这两条：

- AI 纪要和章节比录像慢，网关侧要等调度器下完才出现在清单里。`mde` 在发现阶段
  把缺席的资产记成「探测」而不是失败，录像类最多等 6 小时、智能类最多等 48 小时，
  每次 `execute` 都会重查到期的探测，就绪就补下，超时才放弃。
- 滚动两天是因为跨天结束的会议和延迟生成的资产可能落在前一天的窗口里。
  重叠区间不会重下，见第 4 节。

只要发现不下载用 `discover`，只看队列用 `status`，把 failed/dead 放回队列用
`retry` 再 `execute`。

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
| `mde get 1234567890` 返回 404 | 纯数字位置参数按**会议号**解释，不是 meeting_id | 用 `--meeting-id <id>` |
| `meeting_not_found_in_range` | 网关的库里没有这场会议，或这场会议对你不可见，两者不区分。加宽 `--from/--to` 没用 | 会议时间在调度器窗口之外就让运维补跑（4.1）；在窗口内还 404 就找管理员看规则和授权 |
| 会议在列表里，`assets` 少了某一类 | 调度器还没下完，或腾讯还没生成 | 等下一轮 `execute`；48 小时后仍没有就是没生成 |
| `invalid_credentials` | client id/secret 不对，或该 service account 已停用 | 控制台核对；secret 丢了只能轮换 |
| `forbidden` on download-url | 规则放行了会议但没放行这类资产 | 管理员改规则的 `assets` 条件 |
| `rate_limited` | 取令牌太频繁（只有令牌端点限流，按来源 IP） | 令牌拿到后复用到 401 再换，别每个请求都取；多台机器别共用出口同时启动 |
| 下载到一半网关重启 | 下载地址 15 分钟有效，续传按 Range 断点接 | 重跑同一条命令即可 |

## 7. 网关接口契约

自己写采集程序而不用 `mde` 时，需要的只有下面五个端点。所有时间戳都是 Unix 秒。

**取令牌**

```
POST /api/v1/auth/service-token
{"client_id": "...", "client_secret": "..."}
-> 200 {"access_token": "...", "expires_in": <秒>}
```

之后每个请求带 `Authorization: Bearer <access_token>`，401 时重新取一次。

**列会议**

```
GET /api/v1/meetings?from=<秒>&to=<秒>&cursor=&limit=
GET /api/v1/meetings?meeting_code=<会议号>[&from&to]
GET /api/v1/meetings?meeting_id=<id>[&from&to]
-> 200 {"meetings": [{meeting_id, sub_meeting_id, meeting_code, subject, record_type,
                      host_user_id, start_time, end_time}], "next_cursor": "..."|null}
```

`from` 到 `to` 单次不要超过 31 天。`sub_meeting_id` 是这一场录制的记录 id，
周期会议每场不同，后面列资产要带上。

**列资产**

```
GET /api/v1/meetings/:meetingId/assets?sub_meeting_id=<id>
-> 200 {"assets": [{asset_id, asset_type, remote_id, state, allow_download, file_type, bytes_expected}]}
-> 404 meeting_not_found_in_range   会议不存在或对你不可见，两者不区分
```

`asset_type` 取值 `video` / `audio` / `transcript` / `ai_minutes` / `chapters`。
只列已经下载完成的资产。

**取下载地址**

```
POST /api/v1/assets/:assetId/download-url
-> 200 {"url": "<网关自己的 content 地址>", "expires_at": <秒>, "file_type": ..., "bytes_expected": ...}
-> 403 forbidden   规则不放行这类资产
-> 404 asset_not_found
```

**下载文件**

```
GET <url>                      整个文件，200
GET <url>  Range: bytes=N-     从 N 续传，206 + Content-Range
```

这一步不带 Bearer，`url` 里的 token 15 分钟有效，过期重新申请一次 download-url。
文件由网关从本地归档直出，本地被保留策略清掉后自动改从 NAS 直出，调用方无感。

网关错误统一是 `{"error": "<code>", "message": "<给人看的原因>"}`。`message` 要
打出来，`meeting_not_found_in_range` 的 message 里写明网关只查自己的库、不问腾讯，
省得往加宽时间范围的方向排查。
