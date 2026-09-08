# 资产分类对齐腾讯产品 + 归档目录去中文 — 设计裁定

日期：2026-09-08。依据：腾讯文档 + 2026-09-08 对生产租户的实调。

## 1. 事实

- 生产库 `meeting_assets` / `archived_assets` / `asset_contents` 只有两类：`meeting_summary`（txt/docx/pdf）与 `video`。五类 `ai_*` **零行**。`sts_token_requests` 200 条 expired、1 条 pending。
- 本地落盘的 `transcript.txt` 格式是「发言人(00:01:45): 正文」——这是腾讯菜单里的**逐字稿文本**。
- 腾讯录制页的下载菜单只有三种文本：**逐字稿文本 / 时间轴文本 / 纪要文本**。纪要是一份，用户切换模板（混元按章节/主题/发言人、DeepSeek、元宝）重新生成；不是四份并列产品。（[智能录制指南](https://cloud.tencent.com/document/product/1095/94172)、[新版智能录制](https://meeting.tencent.com/support/topic/2228/index.html)）
- `GET /v1/addresses/{record_file_id}`（51180）是唯一给出 `ai_*` 文件链接的接口，**要 STS-Token**，STS 是异步回调、本机网关收不到。
- **`GET /v1/smart/minutes/{record_file_id}`**（109458）与 **`GET /v1/smart/chapters?record_file_id=`**（105658）走 AK/SK，**不要 STS**。STS 文档（127651）列的「数据敏感」接口只有「查询单个录制详情」「查询录制转写详情」两个。
- 2026-09-08 实调三个 record_file_id（含 9 月 2 日的会议）：
  - `smart/minutes` 全部返回 markdown（`{meeting_minute:{minute, todo}}`），**历史会议也取得到**。
  - `smart/chapters` 对开了智能录制的返回 `chapter_list[]`（`chapter_name` 是 base64 UTF-8，`start_time` 毫秒字符串，`pic_url` 带签名会变）；没开的返回 **error_code 500182**「该文件未打开智能录制开关，请联系文件所有者」。目前 `errors.ts` 把它当 transient 重试 5 次。
- 规则表 `policy_rules.asset_types` 全部是 `["*"]` 或 `[]`，没有任何规则点名 `ai_topic_minutes` / `ai_speaker_minutes` / `ai_ds_minutes`。

## 2. 裁定

### 2.1 资产分类：8 → 6，与腾讯菜单一一对应

| 腾讯菜单 | AssetKey（引擎） | 网关 asset_type | 来源 | 落盘 | 中文名 |
| --- | --- | --- | --- | --- | --- |
| 视频内容 | `video` | `video` | `/v1/addresses` | `recording_<id>.mp4` | 录像 |
| （音频） | `audio` | `audio` | `/v1/addresses` | `recording_<id>.m4a` | 音频 |
| 逐字稿文本 | `transcript` | `meeting_summary` | `/v1/addresses` | `transcript.{txt,docx,pdf}` | 逐字稿 |
| 逐字稿（智能优化版） | `ai_transcript` | `ai_meeting_transcripts` | 51180（仍要 STS） | `ai_transcript.*` | 逐字稿（智能优化版） |
| 纪要文本 | `ai_minutes` | `ai_minutes` | `/v1/smart/minutes` 默认模板 | `minutes.md` | 纪要 |
| 时间轴文本 | `chapters`（新） | `chapters` | `/v1/smart/chapters` | `chapters.json` | 时间轴 |

**删除** `ai_topic_minutes` / `ai_speaker_minutes` / `ai_ds_minutes`：库里零行、规则零引用，纯代码删除，无迁移。

`ai_minutes` 的中文名从「AI 纪要」改「纪要」，`transcript` 从「完整转写」改「逐字稿」——与腾讯菜单同词，管理员看腾讯页面和看控制台是同一套词。

### 2.2 取数路径

- 引擎 downloader 只认「一个 URL」（`fetch(url)` 流式写盘）。智能接口返回的是正文 JSON，不是链接。**网关把正文编成 `data:` URL 返回**（`data:text/markdown;charset=utf-8;base64,…` / `data:application/json;…`）。Bun 的 `fetch` 已验证可读 `data:` URL。引擎、进程内 worker、CLI 三个宿主零改动。
- `listAssets` 阶段对每个 `allow_download !== false` 的 record_file 各调一次 minutes、一次 chapters，判「有没有」；`resolveDownloadUrl` 阶段再调一次拿正文。每个 record_file 每轮 2 次调用，走全局令牌桶。
- `chapters.json` 里**不存 `pic_url`**（签名随时间变，两次调用字节不同）。`bytesExpected` 对这两类填 null——正文两次调用之间可能被平台重新生成，不能拿列资产时的长度去卡下载。
- 错误码 500182 归入 `ASSET_PERMANENT`：smart 接口抛 `asset_permanent` 时视为「这一类不存在」，不重试、不报错。其余错误照旧向上抛（client 已重试 5 次）。
- 没开智能录制的历史会议：`listAssets` 不列 `chapters`，引擎 `judgeReadiness` 对「不在清单 + 已过 48h deadline」判 `skip_timeout`，探测一轮即收敛。48h 内的会议按既有探测退避等待。

### 2.3 正文入库与控制台

- `asset_contents` 可解析扩展名从 `txt` 扩到 `txt / md / json`。
- 纪要 tab：**一个类型、无模板切换、无格式切换**；正文仍用 `<pre>` 直出 markdown 源文（富文本渲染不在本次范围）。
- 时间轴 tab：`GET …/content/chapters` 的 `chapters` 从恒空改为读 `chapters` 类正文（JSON）解析出 `{id, name, at}`；`source` 为 `'tencent'` 或 `'none'`。转写分段 `cues` 保留不变。

### 2.4 归档目录去中文

现状：`<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<清洗主题>_<会议号>/`，中间层带中文主题。

裁定：目录名去掉主题段，变成 **`<yyyy>/<mm>/<yyyy-mm-dd>_<hhmm>_<会议号>/`**。会议号缺失时顶 meeting_id（既有口径）。主题在同目录 `meeting.json` 的 `subject` 里，不丢信息。时间仍按 UTC 拆（既有口径，不在本次改）。

`cleanSubjectSegment` 保留：归档目录模板的 `{标题}` 占位符仍可用，是否用由管理员决定；`.env.example` 与规则编辑器示例不推荐它。

存量目录（本地归档区 + NAS）用一次性脚本 `scripts/rename-archive-dirs.ts` 改名，同事务改 `meeting_assets.target_path`、`archived_assets.local_path`、`archived_assets.nas_path`，并重写 NAS 目录里 `_manifest.json` 的 `nasPath`。默认 dry-run，`--apply` 才动手，可重复跑。

### 2.5 上线顺序

1. 停本机与服务器的定时任务。
2. 部署新代码；跑改名脚本 dry-run → `--apply`。
3. 起网关与定时任务。
4. 回填：`bun src/worker/index.ts --from 2026-09-01 --to <今天>` 跑一次——discovery 会给已归档的会议补出 `ai_minutes` / `chapters` 两类，`listMeetingsNeedingArchive` 按「completed 数 > archived 数」把它们再归一次档，正文入库随归档发生。
5. 验收：`archived_assets` 按类型计数出现 `ai_minutes` / `chapters`；控制台三个 tab 都有内容。

## 3. 不做

- 不渲染 markdown 富文本。
- 不加「纪要模板」配置项（固定用腾讯默认模板，即元宝）。
- 不改 UTC 目录时间。
- 不回填 `ai_transcript`（仍卡 STS）。
- 不删 `{标题}` 占位符。

## 4. Entity delta

-3 资产类型 / +1 资产类型（`chapters`）/ +1 腾讯客户端模块（`src/tencent/smart.ts`）/ +1 一次性脚本。不加配置、不加端点、不加 schema、不加依赖。
