# mde — Meeting Data Exporter CLI

`mde` 是会议数据导出网关（M2 网关）的命令行客户端：按时间范围或会议号/ID 发现会议、把想要的资产（录像/录音/文字记录/AI 智能纪要）落到本地磁盘，断点续传、崩溃可恢复、对暂未生成的资产自动轮询直到就绪或超时放弃。

## 安装

```bash
bun install
bun bin/mde.ts <command> [flags]
# 或
bun link   # 之后可用 `mde <command> [flags]`
```

## 配置：三个环境变量

`mde` 不读取也不写入任何本地凭据文件——每次调用都从进程环境变量取三项必填配置，令牌只缓存在本次调用的内存里，进程退出即失效：

| 变量 | 说明 |
|---|---|
| `MDE_GATEWAY_URL` | 网关基地址，例如 `https://gateway.example.com` |
| `MDE_CLIENT_ID` | 网关签发的 service client id |
| `MDE_CLIENT_SECRET` | 对应的 client secret |

```bash
export MDE_GATEWAY_URL=https://gateway.example.com
export MDE_CLIENT_ID=xxxx
export MDE_CLIENT_SECRET=xxxx
```

另外几乎每个命令都需要 `--out <目录>` 指定导出根目录（目前没有接读取配置文件，`storageRoot` 只能来自 `--out`；即使是只读预览的 `list` 命令也需要它，因为配置加载是统一走的同一段校验逻辑）。

## 命令

本地任务队列存放在 `<out>/.mde/queue.sqlite`，记录每个资产的下载状态（pending/running/completed/failed/skipped/dead）与探测状态，跨进程、跨次调用持续有效——中途 Ctrl-C 或机器重启后重新执行同一条命令即可继续，不会重复下载已完成的资产。

### `run` — 一次性完成「发现 + 下载」

按 `--from/--to` 时间范围发现会议、写入队列，紧接着排空队列（下载全部待办资产）。日常导出用这一条即够。

```bash
mde run --from 2026-07-01 --to 2026-07-31 --out ./export
mde run --from 2026-07-01 --to 2026-07-31 --out ./export --assets all --concurrency 5
```

### `discover` — 只发现，不下载

只按时间范围发现会议、把资产写入队列（就绪的进 pending，延迟的进探测），不触发下载。适合先摸底再决定何时执行。

```bash
mde discover --from 2026-07-01 --to 2026-07-31 --out ./export
```

### `list` — 只预览，不写队列

调用网关列会议接口并打印，既不写本地队列也不下载，用于核对某段时间/某场会议是否存在。支持时间范围或会议号/ID。

```bash
mde list --from 2026-07-01 --to 2026-07-31 --out ./export
mde list 88123456 --out ./export
```

### `get` — 按会议号/ID 单场拉取

针对单场会议做「发现 + 下载」，位置参数为纯数字视为会议号，否则视为会议 ID；也可显式传 `--code`/`--meeting-id`。

```bash
mde get 88123456 --out ./export
mde get --meeting-id abcd1234 --out ./export --assets video,transcript
```

### `execute` — 排空队列（不重新发现）

只处理已在队列里的任务：先重查到期的探测（延迟资产就绪则补建下载任务），再并发下载所有 pending/租约过期的 running 资产。用于恢复中断的下载、或配合 cron 周期性追赶探测结果。

```bash
mde execute --out ./export --concurrency 5
```

### `status` — 查看队列状态

打印各状态计数（pending/running/completed/failed/skipped/dead），并逐条列出 failed/dead 资产及其最后一次错误信息。

```bash
mde status --out ./export
```

### `retry` — 重置失败任务

把 failed/dead 状态的资产重置回 pending，供下一次 `execute` 拾取；本身不触发下载。

```bash
mde retry --out ./export
mde execute --out ./export   # 紧接着排空
```

所有会触发下载的命令（`run`/`get`/`execute`）在有任务最终失败（进入 failed/dead）时以退出码 `1` 结束，其余情况为 `0`。

## 资产类型与 `--assets`

不传 `--assets` 时使用默认集合：`video,audio,transcript,ai_transcript`（录像、录音、文字记录、AI 会议转录）。

| key | 对应平台字段 | 说明 |
|---|---|---|
| `video` | `download_address` | 录像，文件名 `recording_<remoteId>.<ext>` |
| `audio` | `audio_address` | 录音，文件名 `recording_<remoteId>.<ext>` |
| `transcript` | `meeting_summary` | 文字记录 |
| `ai_transcript` | `ai_meeting_transcripts` | AI 会议转录 |
| `ai_minutes` | `ai_minutes` | AI 智能纪要 |
| `ai_topic_minutes` | `ai_topic_minutes` | AI 分主题纪要 |
| `ai_speaker_minutes` | `ai_speaker_minutes` | AI 按发言人纪要 |
| `ai_ds_minutes` | `ai_ds_minutes` | AI 决策/待办纪要 |

`--assets` 接受逗号分隔的 key 列表，或特殊值 `all`（等价全部 8 类）：

```bash
mde run --from 2026-07-01 --to 2026-07-31 --out ./export --assets all
mde run --from 2026-07-01 --to 2026-07-31 --out ./export --assets video,ai_minutes,ai_topic_minutes
```

导出目录结构：

```
<out>/<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<清洗后的会议主题>_<会议号或ID>/
  recording_<remoteId>.mp4
  recording_<remoteId>.m4a
  transcript.txt
  ai_transcript.txt
  ai_minutes.txt
<out>/.mde/queue.sqlite     # 本地任务队列/状态库
```

## 延迟资产（AI 智能纪要）与探测机制

录像/录音/文字记录通常在会议结束后很快生成，最多等 6 小时；AI 类纪要（`ai_transcript`/`ai_minutes`/`ai_topic_minutes`/`ai_speaker_minutes`/`ai_ds_minutes`）生成较慢，最多等 48 小时。发现阶段如果这些资产还不存在或未就绪，会进入「探测」状态而不是直接失败；此后每次 `execute`（`run`/`get` 内部也会先跑一次探测）都会重查到期的探测——一旦网关侧就绪就自动补建下载任务并完成下载，超过等待上限则放弃（记为 abandoned，不会无限空等，也不会崩溃）。

因此对同一批会议**反复调用 `execute`（或再次 `run` 覆盖同一时间范围）就能自动追上延迟出现的 AI 纪要**，无需手动重跑。典型做法是配 cron 周期性执行：

```cron
# 每 15 分钟排空一次队列：追赶探测中的延迟 AI 纪要、并重试上次中断的下载
*/15 * * * * cd /opt/mde && MDE_GATEWAY_URL=https://gateway.example.com MDE_CLIENT_ID=xxx MDE_CLIENT_SECRET=xxx \
  bun bin/mde.ts execute --out /data/meetings >> /var/log/mde.log 2>&1

# 每天凌晨用滚动窗口重新发现最近两天的会议（覆盖跨天延迟发生的新会议/新资产）
0 2 * * * cd /opt/mde && MDE_GATEWAY_URL=https://gateway.example.com MDE_CLIENT_ID=xxx MDE_CLIENT_SECRET=xxx \
  bun bin/mde.ts run --from "$(date -u -d '2 days ago' +%F)" --to "$(date -u +%F)" --out /data/meetings >> /var/log/mde.log 2>&1
```

`run`/`discover` 的 `--from/--to` 若跨度超过 31 天，会自动按 ≤31 天的窗口切分成多次网关请求，无需调用方拆分。

## 测试

```bash
bun test          # 单元测试 + tests/e2e 端到端测试（假网关 + 真实文件系统）
bun run typecheck
```
