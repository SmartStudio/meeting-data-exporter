# mde：Meeting Data Exporter CLI

`mde` 是会议数据导出网关的命令行客户端。它按时间范围或会议号/ID 发现会议，把想要的
资产（录像、录音、逐字稿、AI 智能纪要、章节）落到本地磁盘，支持断点续传与崩溃恢复，
对暂未生成的资产自动轮询直到就绪或超时放弃。

本文是命令与参数的参考。整条链路怎么跑（数据从哪来、凭证怎么放、第一次全量与历史
补跑、日常 cron、排错、网关接口契约）见 [`docs/collector.md`](../docs/collector.md)。

## 安装

```bash
bun install
bun bin/mde.ts <command> [flags]
# 或
bun link   # 之后可用 `mde <command> [flags]`
```

## 配置

`mde` 不读取也不写入任何本地凭据文件。每次调用都从进程环境变量取三项必填配置，
令牌只缓存在本次调用的内存里，进程退出即失效：

| 变量 | 说明 |
|---|---|
| `MDE_GATEWAY_URL` | 网关基地址，例如 `https://gateway.example.com` |
| `MDE_CLIENT_ID` | 网关签发的 service client id |
| `MDE_CLIENT_SECRET` | 对应的 client secret |

```bash
export MDE_GATEWAY_URL=https://gateway.example.com
export MDE_CLIENT_ID=<client id>
export MDE_CLIENT_SECRET=<secret>
```

还有一项可选变量 `MDE_LEASE_SEC`，即任务租约时长（秒），默认 900，取值范围 1 到 86400。
它只为核验崩溃恢复而存在（那条机制只能靠等租约过期来验），平时不要设：调小之后，
一轮跑得比租约久的大文件会被另一个执行体当成「租约过期」抢走，两个进程同时写同一个
`.part`。

### 通用参数

| 参数 | 适用命令 | 说明 |
|---|---|---|
| `--out <目录>` | 全部 | 导出根目录。没有配置文件读取这一路，`storageRoot` 只能来自这里，只读预览的 `list` 也要带，因为配置加载走的是同一段校验逻辑 |
| `--from <日期>` / `--to <日期>` | `run`、`discover`、`list`、`get` | `YYYY-MM-DD` 按 UTC 当天 0 点解析，也接受 Unix 秒。`run`/`discover` 必填 |
| `--assets <csv\|all>` | `run`、`discover`、`get` | 见下面「资产类型」，默认全五类 |
| `--concurrency <n>` | `run`、`get`、`execute` | 同时下载的任务数，默认 3 |
| `--code <会议号>` / `--meeting-id <id>` | `list`、`get` | 显式指定单场会议 |

## 命令

本地任务队列存放在 `<out>/.mde/queue.sqlite`，记录每个资产的下载状态
（pending/running/completed/failed/skipped/dead）与探测状态。它跨进程、跨次调用持续
有效：中途 Ctrl-C 或机器重启后重新执行同一条命令即可继续，不会重复下载已完成的资产。

一个任务失败后按退避重试，第一次等 5 分钟，之后逐次翻倍，上限 1 小时；第 5 次领取
仍失败就转 dead。平台确认没有这个文件（换过一条新链接仍 404）时直接记 skipped，
不占用重试次数。

> 2026-09-09 起场次 id 取腾讯的 `meeting_record_id`，周期会议的每一场各占一个目录。
> 旧的 `queue.sqlite` 不做迁移：换一个 `--out` 目录重新跑一遍即可，已经下载过的
> 文件仍在旧目录里，不会丢。继续用原来那个 `--out` 的话，每一场会议都会重新下载
> 到 `_2` 目录里：旧库里那些空串场次行的目录序号仍然占着 1，新拉到的场次行只能
> 顺次拿到 `_2`（目录序号按 `(created_at, sub_meeting_id)` 排，见
> `packages/engine/src/domain/dir-ordinal.ts`）。

### `run`：一次性完成发现加下载

按 `--from/--to` 时间范围发现会议、写入队列，紧接着补探测并排空队列，收尾写
`meeting.json` 与 `_manifest.json`。日常导出用这一条即够。

```bash
mde run --from 2026-07-01 --to 2026-07-31 --out ./export
mde run --from 2026-07-01 --to 2026-07-31 --out ./export --assets all --concurrency 5
```

### `discover`：只发现，不下载

只按时间范围发现会议、把资产写入队列（就绪的进 pending，延迟的进探测），不触发下载。
适合先摸底再决定何时执行。

```bash
mde discover --from 2026-07-01 --to 2026-07-31 --out ./export
```

### `list`：只预览，不写队列

调用网关列会议接口并打印，既不写本地队列也不下载，用于核对某段时间或某场会议是否
存在。接受时间范围、`--code`/`--meeting-id`，或一个位置参数。每行是
`meeting_id`、会议号、主题、`start=`、`end=`，翻完所有页后打一行 `total=`。

```bash
mde list --from 2026-07-01 --to 2026-07-31 --out ./export
mde list 88123456 --out ./export
```

### `get`：按会议号/ID 单场拉取

针对单场会议做发现加下载。位置参数为纯数字时视为会议号，否则视为会议 ID；也可显式
传 `--code`/`--meeting-id`。这条命令不写 `meeting.json` 与 `_manifest.json`，要补清单
就在之后跑一次 `execute`。

```bash
mde get 88123456 --out ./export
mde get --meeting-id abcd1234 --out ./export --assets video,transcript
```

### `execute`：排空队列，不重新发现

只处理已在队列里的任务：先重查到期的探测（延迟资产就绪则补建下载任务），再并发下载
所有 pending 与租约过期的 running 资产，收尾写清单。用于恢复中断的下载，或配合 cron
周期性追赶探测结果。

如果这一轮一个任务都没领到，而队列里还有 running 的行，它会提示租约未到期并给出还要
等多久。那是上一次中断留下的行，等租约过期才会被重新领取。

```bash
mde execute --out ./export --concurrency 5
```

### `status`：查看队列状态

打印各状态计数（pending/running/completed/failed/skipped/dead），并逐条列出 failed
与 dead 资产及其最后一次错误信息。

```bash
mde status --out ./export
```

### `retry`：重置失败任务

把 failed/dead 状态的资产重置回 pending，供下一次 `execute` 拾取，打印 `reset=<n>`。
本身不触发下载。

```bash
mde retry --out ./export
mde execute --out ./export   # 紧接着排空
```

### 退出码

会触发下载的命令（`run`/`get`/`execute`）在本轮有任务转入 failed 或 dead 时以退出码
`1` 结束，其余情况为 `0`。`discover`/`list`/`status`/`retry` 正常完成时恒为 `0`。
参数或配置有误时命令直接以 `1` 退出并在 stderr 打出原因。

## 资产类型与 `--assets`

不传 `--assets` 时默认取全部五类（纪要与章节走网关的 `/v1/smart/*` 链路，不依赖 STS）。
下表右侧是网关 `asset_type` 字段的取值，也就是接口响应和 `_manifest.json` 里看到的名字。

| key | 网关 `asset_type` | 说明 |
|---|---|---|
| `video` | `video` | 录像，文件名 `recording_<remoteId>.<ext>` |
| `audio` | `audio` | 录音，文件名 `recording_<remoteId>.<ext>` |
| `transcript` | `meeting_summary` | 逐字稿 |
| `ai_minutes` | `ai_minutes` | 纪要 |
| `chapters` | `chapters` | 章节 |

`--assets` 接受逗号分隔的 key 列表，或特殊值 `all`（等价全部 5 类）：

```bash
mde run --from 2026-07-01 --to 2026-07-31 --out ./export --assets all
mde run --from 2026-07-01 --to 2026-07-31 --out ./export --assets video,ai_minutes,chapters
```

导出目录结构：

```
<out>/<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<会议号>/
  recording_<remoteId>.mp4        video
  transcript.txt / .docx / .pdf   transcript，平台给几种格式就各存一份
  minutes.md                      ai_minutes
  chapters.json                   chapters
  meeting.json                    会议元数据
  _manifest.json                  文件清单与哈希
<out>/.mde/queue.sqlite           # 本地任务队列/状态库
```

扩展名取平台给的 `file_type`，`docs` 归一成 `docx`、`htm` 归一成 `html`，取不到时落
`bin`。`_manifest.json` 里录像与录音的 `sha256` 恒为 null，因为整文件哈希只对文本类
小文件算，几个 GB 的录制全量读进内存会吃爆内存。

目录名不含会议主题。周期会议每一场各占一个目录，同一分钟的第二场以 `_2` 结尾。
腾讯普通云录制从不产出 `audio`，实际很少见到。转写类录制（`record_type` 为 3）只有
逐字稿和纪要，其余三类既不建任务也不建探测。

## 延迟资产与探测机制

录像、录音、逐字稿通常在会议结束后很快生成，等待上限 6 小时；智能类资产
（`ai_minutes`/`chapters`）生成较慢，等待上限 48 小时。两个上限都从会议结束时间起算。

发现阶段如果这些资产还不存在或未就绪，会进入探测状态，不直接判失败。此后每次
`execute`（`run`/`get` 内部也会先跑一次探测）都会重查到期的探测，网关侧就绪就自动补建
下载任务并完成下载，超过等待上限则记为 abandoned 放弃。探测本身按退避重查，间隔从
5 分钟逐次翻倍，上限 1 小时。

有一个例外：录像已就绪而录音缺席时，这场的音频判定为根本没生成，不再建探测，已有的
探测行就地放弃（原因记 `not_generated`）。

所以对同一批会议反复调用 `execute`（或再次 `run` 覆盖同一时间范围）就能自动追上延迟
出现的 AI 纪要，无需手动重跑。典型做法是配 cron 周期性执行，凭证放在只有自己可读的
env 文件里（见 [`docs/collector.md`](../docs/collector.md) 第 3 节）：

```cron
# 每 15 分钟排空一次队列：追赶探测中的延迟 AI 纪要，并重试上次中断的下载
*/15 * * * * set -a; . /home/collector/.mde-prod.env; set +a; cd /opt/mde && \
  bun bin/mde.ts execute --out /data/meetings >> /var/log/mde.log 2>&1

# 每天凌晨用滚动窗口重新发现最近两天的会议，覆盖跨天延迟发生的新会议与新资产
0 2 * * * set -a; . /home/collector/.mde-prod.env; set +a; cd /opt/mde && \
  bun bin/mde.ts run --from "$(date -u -d '2 days ago' +%F)" --to "$(date -u +%F)" \
  --out /data/meetings >> /var/log/mde.log 2>&1
```

`run`/`discover`/`list` 的 `--from/--to` 若跨度超过 31 天，会自动按不超过 31 天的窗口
切分成多次网关请求，无需调用方拆分。

## 测试

```bash
bun test          # 单元测试 + tests/e2e 端到端测试（假网关 + 真实文件系统）
bun run typecheck
```
