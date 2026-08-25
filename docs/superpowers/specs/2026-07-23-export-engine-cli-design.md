# 核心导出引擎 + 客户端 CLI 设计（meeting-data-exporter 子项目 2 / M3）

- 日期：2026-07-23
- 状态：设计已确认，待审阅 → writing-plans
- 前置：子项目 1（导出网关）+ M1 网关加固已合并 master、可投产。本子项目是**客户端**，只消费网关的对客户端 API 契约（网关 spec §5.2），**不直连腾讯 API**。

---

## 1. 背景与定位

M3 交付一个命令行工具 `mde`（meeting-data-exporter），连已投产的导出网关，把会议资产拉到本地并归档。所有平台细节（31 天切分、分页、AK/SK 签名、STS-Token 注入、时间戳归一）由网关吸收，客户端一概不可见——客户端只面对网关 §5.2 的统一契约（游标分页、Unix 秒、`meeting_not_found_in_range` 等）。

**心智**：可反复运行的**幂等命令**。断点续传、进度、去重、崩溃恢复都是同一套「数据库即任务队列」机制的副产品，而非独立功能。

## 2. 范围（Scope）

**做**：
- 客户端 CLI（归档模式 + 点选模式），连网关拉四类默认资产到本地文件系统。
- 数据库即任务队列（bun:sqlite）、租约状态机、断点续传、资产粒度去重、崩溃自愈。
- AI 延迟产出的探测模型（乐观等待 + 绝对 deadline）。
- 存储抽象接口（M3 只实现本地文件系统；M4 加 OSS/NAS 时 executor 不改）。

**不做（YAGNI / 后续子项目）**：
- 阿里云 OSS / NAS 存储实现 → M4。
- 桌面 GUI → M5。
- `mde login` 设备流程（认证已定为服务账号，见 §7）。
- `mde run --watch` 常驻轮询模式——默认靠 cron / 计划任务反复跑覆盖延迟产出；`--watch` 是日后在 `execute` 外套一层循环的便利项，不在 M3。

## 3. 代码落点

M3 客户端落在仓库子目录 **`client/`**，自带独立的 `package.json` / `tsconfig.json` / `bun.lock`，与根目录的网关（`@yaowu/meeting-export-gateway`）互不依赖、独立构建与测试。网关根目录零改动。

> **决策说明**：当前仓库是单包（网关占据根 `src/`）。把网关迁进 `packages/` 做成 monorepo 更"正统"，但会大面积扰动刚落地的 M1 成果（Dockerfile、scripts、测试路径）。M3 采用最小风险的子目录方案；monorepo 化留到 M4/M5 确有需要时再单独做。客户端包名 `@yaowu/meeting-exporter-cli`，CLI 可执行名 `mde`。

## 4. 依赖的网关契约（消费方，不实现）

客户端只调以下网关端点（详见网关 spec §5.2，此处列出客户端用到的子集）：

```
POST /api/v1/auth/service-token   服务账号 client_id/secret 换 access_token（无 refresh）
GET  /api/v1/meetings             列会议（游标分页，已过策略过滤）
     ?from=&to=&meeting_code=&meeting_id=&cursor=&limit=
GET  /api/v1/meetings/{id}         单会议详情（含资产清单）
GET  /api/v1/meetings/{id}/assets  列该会议资产清单（已过策略过滤）
POST /api/v1/assets/{asset_id}/download-url   换临时下载地址（含 url/expires_at/file_type/bytes_expected）
```

约束（网关已归一，客户端遵守）：
- 时间一律 **Unix 秒 + UTC**。
- 分页为**游标**，不暴露腾讯 page/page_size。
- 定点查询（meeting_id/meeting_code）仍需时间窗口；范围内未命中返回 `meeting_not_found_in_range`，客户端据此提示"扩大时间范围重试"。
- `meeting_code` **非唯一**：网关返回全部匹配项，客户端展示候选让用户选，不自动择一。

## 5. 资产类型与默认集

平台八类资产（网关 spec §3.2，来自 `GET /v1/addresses/{record_file_id}` 响应字段）：

| # | 平台字段 | 内容 | 格式 | 免 STS | 等待上限 |
| --- | --- | --- | --- | --- | --- |
| 1 | `download_address` | 录制视频 | mp4 | ✅ | 6h |
| 2 | `audio_address` | 录制音频 | m4a | ✅ | 6h |
| 3 | `meeting_summary` | 逐字稿（原始转写） | txt/pdf/docx | ✅ | 6h |
| 4 | `ai_meeting_transcripts` | 逐字稿（智能优化版） | txt/pdf/docx | ❌ | 48h |
| 5 | `ai_minutes` | 混元 章节纪要 | txt/pdf/docx | ❌ | 48h |
| 6 | `ai_topic_minutes` | 混元 主题纪要 | htm | ❌ | 48h |
| 7 | `ai_speaker_minutes` | 混元 发言人纪要 | htm | ❌ | 48h |
| 8 | `ai_ds_minutes` | DeepSeek 纪要 | htm | ❌ | 48h |

**设计约定**：
- **`asset_type` 由响应字段名派生，不硬编码为封闭联合**。腾讯随时可能新增纪要引擎（现已有混元、DeepSeek 两套），字段驱动使新引擎无需改代码。
- **默认想要集 = ①②③④**（录制视频、录制音频、逐字稿原始、逐字稿智能优化版）。这是未指定 `--assets` 时的默认。
- **⑤⑥⑦⑧（四种 AI 会议纪要）默认不拉，但 `--assets` 显式指定时可拉**——工具字段驱动，天然支持，保留立项时的会议纪要能力为 opt-in。
- **"时间轴"不是独立资产**：时间轴信息内嵌在 AI 纪要里（章节纪要按时间分段、发言人纪要为带时间的发言序列），随对应纪要一并得到，不单列一类。
- 默认集里 ①②③ 免 STS、走 6h 快档；仅 ④ 需 STS、走 48h 探测——常见归档路径因此以快档为主。

**`--assets` 取值（CLI 键 ↔ 资产类型，1:1）**：

| CLI 键 | 资产 | 默认集 |
| --- | --- | --- |
| `video` | ① 录制视频 | ✅ |
| `audio` | ② 录制音频 | ✅ |
| `transcript` | ③ 逐字稿（原始） | ✅ |
| `ai_transcript` | ④ 逐字稿（智能优化版） | ✅ |
| `ai_minutes` | ⑤ 章节纪要 | |
| `ai_topic_minutes` | ⑥ 主题纪要 | |
| `ai_speaker_minutes` | ⑦ 发言人纪要 | |
| `ai_ds_minutes` | ⑧ DeepSeek 纪要 | |

`--assets` 接受逗号分隔的键；缺省即 `video,audio,transcript,ai_transcript`，亦接受 `all` 拉全八类。未知键报错并列出合法键，不静默忽略。

## 6. 架构：数据库即任务队列

Discovery 与 Executor 两阶段解耦，**SQLite（WAL）为唯一事实源**。断点续传、进度查询、去重、崩溃恢复四件事出自同一机制。

```
Discovery ─→ 选择器取清单 ─→ UPSERT 为 pending 任务 + 建探测记录
                              ↓
                         [ SQLite/WAL ]  ← 各命令随时查询进度
                              ↓
Executor（有界并发池）─→ 领 pending（租约）─→ 下载（断点续传）─→ 更新状态
                              ↓
探测循环 ─→ 重查到期的 probing 资产 ─→ 就绪则补建下载任务
```

### 6.1 数据模型（bun:sqlite）

```sql
PRAGMA journal_mode = WAL;      -- 多命令/未来 GUI 并发读写
PRAGMA busy_timeout = 5000;

CREATE TABLE meetings (
  meeting_id     TEXT NOT NULL,
  sub_meeting_id TEXT NOT NULL DEFAULT '',
  meeting_code   TEXT,
  subject        TEXT,
  host_userid    TEXT,
  start_time     INTEGER,
  end_time       INTEGER,          -- 会议结束时间（秒），探测 deadline 的基准
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id)
);

CREATE TABLE assets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id       TEXT NOT NULL,
  sub_meeting_id   TEXT NOT NULL DEFAULT '',
  asset_type       TEXT NOT NULL,   -- 由响应字段名派生（§5）
  remote_id        TEXT NOT NULL,   -- record_file_id；文本类用 <record_file_id>:<字段名>:<索引>
  status           TEXT NOT NULL,   -- pending|running|completed|failed|skipped|dead
  storage_target   TEXT NOT NULL DEFAULT 'local',
  target_path      TEXT,            -- 相对路径，不含存储根
  file_type        TEXT,            -- 决定文件扩展名，来自 download-url 响应
  bytes_expected   INTEGER,
  bytes_written    INTEGER NOT NULL DEFAULT 0,   -- 仅供展示，续传以 .part 实际大小为准
  content_hash     TEXT,            -- 文本类校验用
  download_url     TEXT,            -- 仅缓存，非稳定标识
  download_url_expires_at INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  last_error       TEXT,
  completed_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (meeting_id, sub_meeting_id, asset_type, remote_id)
);
CREATE INDEX idx_assets_claimable ON assets (status, lease_expires_at);

CREATE TABLE asset_probes (
  meeting_id     TEXT NOT NULL,
  sub_meeting_id TEXT NOT NULL DEFAULT '',
  asset_type     TEXT NOT NULL,
  state          TEXT NOT NULL,          -- probing | resolved | abandoned
  attempts       INTEGER NOT NULL DEFAULT 0,
  probe_after    INTEGER NOT NULL DEFAULT 0,   -- 下次可重查的时间（退避）
  deadline_at    INTEGER NOT NULL,       -- 绝对时间 = 会议结束 + 每类上限
  last_reason    TEXT,
  PRIMARY KEY (meeting_id, sub_meeting_id, asset_type)
);

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  mode        TEXT NOT NULL,      -- run | discover | get | execute
  window_from INTEGER,
  window_to   INTEGER,
  summary     TEXT
);
```

**去重即 `UNIQUE` 约束 + `INSERT ... ON CONFLICT DO UPDATE`**，无需应用层查-插判重，也就无查插竞态。

### 6.2 状态机与租约

```
  (Discovery 写入)          租约超时
        ──→ pending ──→ running ────┐
              ▲            │        │
  attempts<上限│            ├──→ completed
              └── failed ←─┤
                    │      │
            attempts≥上限   │
                    ▼      │
                  dead     │
        ──→ skipped ←──────┘
              (策略拒绝 / 平台确认无此资产 / 超时)
```

领取任务为单条原子 UPDATE（无需事务或锁）：

```sql
UPDATE assets SET status='running', lease_expires_at = ?, attempts = attempts + 1
WHERE id = (SELECT id FROM assets
            WHERE status='pending' OR (status='running' AND lease_expires_at < ?)
            ORDER BY id LIMIT 1)
RETURNING *;
```

**租约（非锁）使崩溃自愈**：进程崩溃后 `running` 任务的租约到期即被重新领取，无需人工清理。有界并发池的每个 worker 独立领租约，天然并发安全。

## 7. 认证：服务账号，无状态

- 客户端从**环境变量**读 `MDE_GATEWAY_URL`、`MDE_CLIENT_ID`、`MDE_CLIENT_SECRET`。
- 每次运行（或 access_token 过期时）POST `/api/v1/auth/service-token` 换一个短时 access_token（网关侧 15min TTL），**仅在进程内存持有**。服务账号**无 refresh_token**，过期即重换。
- **本地不落任何凭证**。SQLite 只存任务状态，不含 secret / token。
- **令牌中途过期透明处理**：`gateway/` 层对任何 401 自动重取 service-token 后重试当次调用，`executor` / `downloader` 不感知——与换下载链是同一类"过期即续"处理。
- 服务账号身份是管理员在网关侧创建时指定的固定 `tmUserId`，与"仅管理员可导"（Q2）一致——`mde` 就是管理员工具。

## 8. 并发：有界并发池

Executor 用**有界并发池**下载，默认 **3-4** 路（`--concurrency` / 配置可调）。大文件 I/O 重叠 + 多个小文本资产并行拉，显著提升吞吐。WAL 支撑并发 SQLite 写；不同资产写不同文件，互不冲突。§6.2 的租约机制已为多 worker 预留，池只是并发领租约。

## 9. 探测模型：延迟 AI 产出

会议结束时录屏可能已就绪，但 AI 类（默认集里的 ④）往往会后数小时~48h 才异步产出。既不能死等（否则录屏也拿不到），也不能一次没看到就当不存在。

对每场会议、每个"想要"的资产类型，按其在网关资产清单里的表现判定：

| 资产清单中的表现 | 判定 |
| --- | --- |
| 存在 + 就绪（平台转码完成 state=3） | 建 `pending` 下载任务，探测 `resolved` |
| 存在 + 未就绪（录制中/转码中 state=1/2） | 探测 `probing`，`probe_after` 退避后重查 |
| 存在 + `allow_download=false` | 立即 `skipped(download_not_allowed)`，探测 `resolved`（平台明示不可得，不空等） |
| 完全不在清单里（AI 尚未生成） | 探测 `probing`，重查到 `deadline_at`（乐观等待） |
| 超过 `deadline_at` 仍未就绪 | `skipped(upstream_timeout)`，探测 `abandoned` |

**关键设计**：
- **`deadline_at` 用绝对时间** = `meetings.end_time` + 每类上限（①②③ = 6h、④及全部 AI = 48h，可配），**不是重试次数**——"等多久"不取决于运行了几次命令。
- **每类资产独立探测、互不牵连**：就绪的录屏当场下，不被未就绪的 ④ 拖住。
- **绝对 deadline 让乐观等待天然高效**：导老会议时 `end_time + 48h` 已是过去时 → 探测首次检查即判 `skipped(upstream_timeout)`，一次了结、零后续 churn；真正持续探测的只有"最近上限窗口内结束"的会议。
- **放弃时显式写 `skipped` 行**，不留空。归档中"确认缺失"与"不知有无"是两种状态，前者无歧义。
- **延迟资产如何被拿到**：`mde execute`（cron 反复跑）每轮重查到期的 `probing` 探测 → 重新 list-assets → 就绪则补建下载任务。

## 10. 下载与断点续传

写入一律先落 `<name>.part`，校验后原子 `rename` 为正式名。**正式文件名存在即内容完整**。

- **续传信任 `.part` 实际大小，不信数据库 `bytes_written`**（崩溃时数据可能已落盘而库未更新，文件系统是此处事实源）。
- `size := storage.writtenSize(relPath)`；`size > 0` 时带 `Range: bytes=<size>-`：
  - `206` → 正常续传
  - `200` → 服务端不支持 Range，丢弃 `.part` 重下
  - `416` → 本地比远端大（远端文件已变更），删除 `.part` 重下
- 下载中：`403/410`（链接过期）→ 向网关 `download-url` 换新地址，从当前 size 继续；`5xx`/中断 → `failed`，指数退避后回 `pending`，`.part` 保留；每 **8 MB** 更新 `bytes_written` 并**续租**（同时承担进度更新与续租两职责）。
- 完成：校验 `bytes_expected` → 计算 `content_hash`（文本类）→ `finalize()` → `completed`。

### 10.1 校验策略（有意的不对称）

| 资产 | 策略 | 理由 |
| --- | --- | --- |
| 文本类（逐字稿/纪要） | 拉取后算 `content_hash` 与已完成记录比对，不一致则重置 pending 重导 | 成本可忽略，可捕捉平台侧内容更新 |
| 视频 / 音频 | 用 `bytes_expected` 与文件实际大小比对 | 算 hash 需读完数 GB，收益仅为确认下载时就该确认的事 |

## 11. 存储布局与抽象接口

```
<storage_root>/
└── 2026/07/
    └── 2026-07-15_1430_季度产品评审_88123456/
        ├── meeting.json                    会议元数据
        ├── recording_<record_file_id>.mp4  录制视频
        ├── recording_<record_file_id>.m4a  录制音频
        ├── transcript.<ext>                逐字稿（原始）
        ├── ai_transcript.<ext>             逐字稿（智能优化版）
        └── _manifest.json                  资产清单 + 校验信息
```

- **文件扩展名不写死**——由 `download-url` 响应的 `file_type` 决定（文本类可能 txt/pdf/docx/htm）；同类资产在不同会议可能不同格式。
- **目录名**：`<日期>_<时分>_<清洗后主题>_<会议号>`。主题清洗必需（Windows 拒 `\ / : * ? " < > |`，中文主题含 `：`/`/` 极常见）：非法字符替换为 `-`，按**字素簇**截断 60 字符（避免切断 emoji/组合字），追加会议号保证唯一。
- **`target_path` 存相对路径**（存储根是配置项，可能从本地迁 NAS 迁 OSS 前缀，相对路径使库与物理位置解耦）。
- **`_manifest.json` 使导出结果脱离数据库自解释**——数年后在 NAS 翻到该目录，无需本工具即知内容、完整性与原始 ID。
- 默认集只落 ①②③④ 四个文件；`--assets` 拉了 AI 纪要时相应增加 `ai_minutes.<ext>` 等，仍一一对应字段名。

### 11.1 存储抽象

`storage/` 从第一天就是接口，M3 只实现 `LocalStorage`，M4 加 `OssStorage`/`NasStorage` 时 `executor`/`downloader` 一行不改：

```ts
interface Storage {
  writtenSize(relPath: string): Promise<number>          // .part 实际大小，续传用
  appendStream(relPath: string, from: number, stream: ReadableStream): Promise<number>
  finalize(relPath: string): Promise<void>               // .part 原子 rename 为正式名
  discardPart(relPath: string): Promise<void>            // 416/200 时丢弃重下
  writeMeta(relPath: string, data: unknown): Promise<void>  // meeting.json / _manifest.json
  ensureFreeSpace(bytes: number): Promise<boolean>       // 下载前磁盘预检
}
```

## 12. 两种使用模式与 CLI

Discovery 的输入从"时间窗口"泛化为**选择器**，Executor / 任务表 / 去重 / 断点续传全不受选择器类型影响（只消费队列）：

```ts
type MeetingSelector =
  | { kind: 'range'; from: number; to: number }                            // 归档模式
  | { kind: 'code'; meetingCode: string; from?: number; to?: number }       // 点选：会议号
  | { kind: 'id';   meetingId: string;   from?: number; to?: number }       // 点选：会议 ID
```

```bash
# 归档模式
mde run      --from 2026-07-01 --to 2026-07-31 --out ./meetings
mde discover --from ... --to ...                 只发现，不下载

# 点选模式
mde list     --from ... --to ...                 查看可导出会议（人读格式）
mde list     --code 88123456                     按会议号查找
mde get      88123456                            导出指定会议（会议号或会议 ID）
mde get      88123456 --assets video,transcript,ai_minutes   只导指定资产键（可含默认外的 ai_minutes）
mde get      88123456 --from 2026-04-01          会议较早时扩大搜索范围

# 通用
mde execute                                      只消费队列（可反复跑，天然续传 + 重查探测）
mde status                                       各状态计数与失败明细
mde retry    --failed                            failed/dead 重置为 pending
```

- **中断后重跑 `mde execute` 即为续传**——"继续上次"与"重新开始"在代码上是同一条路径。
- `mde get` 与 `mde run` 差别仅在写入队列的选择器，之后走同一执行路径；两种模式可混用（先批量归档整月，再补一场遗漏），队列正确合并且不重复下载。
- **会议号非唯一**：`mde get` 查到多场时列出全部候选，要求 `--meeting-id` 精确指定；非交互环境（cron）直接失败并给候选列表，绝不自动选错。
- **默认 `--assets` = 视频,音频,逐字稿(原始),逐字稿(优化)**（即 ①②③④）；`--assets` 可显式加 AI 会议纪要（`ai_minutes` 等）。
- CLI 跑完即退出，不在后台等 48h；延迟 AI 靠 cron 反复运行覆盖。

## 13. 错误处理

| 情况 | 处理 |
| --- | --- |
| access_token 中途过期（长任务） | `gateway/` 层对 401 透明重取 service-token 后重试当次调用 |
| 磁盘空间不足 | 下载前按 `bytes_expected` 预检；不足则整体暂停并告警，不写到一半失败 |
| 下载链接过期（403/410） | 向网关换新地址，从当前字节续 |
| 远端文件已变更（416） | 删除 `.part` 重下 |
| 网络中断 / 5xx | `failed`，指数退避后回 `pending`，`.part` 保留 |
| 重试超上限 | `dead`，`mde retry --failed` 可重置 |
| 策略拒绝 / 平台确认无此资产 | `skipped`（显式留痕） |
| 会议号非唯一且非交互 | 直接失败并给候选列表，不自动选择 |
| 会议不在默认 31 天窗口 | 网关返回 `meeting_not_found_in_range`，CLI 提示扩大 `--from` 重试 |
| 本机时钟偏移 | 客户端不签名，但首次异常时提示校时 |

## 14. 模块边界（每个可独立测试）

```
client/src/
├── config/       配置加载与校验（env + 文件 + CLI flag 优先级）
├── gateway/      网关 API 客户端：service-token 认证 + 会议/资产/下载地址；401 透明重取
├── store/        bun:sqlite 持久化：四表 + 领租约/更新/去重的原子 SQL
├── domain/       纯函数：MeetingSelector、31 天窗口切分、目录名清洗（字素簇）、就绪判定
├── discovery/    选择器 → 网关取清单 → UPSERT 任务 + 建探测记录
├── downloader/   单资产下载：Range 续传、换链、416、校验、finalize
├── executor/     有界并发池：领租约 → 调 downloader → 更新状态；探测循环
├── storage/      存储抽象接口（M3 只实现 LocalStorage）
└── cli/          命令解析与人读输出（run/discover/list/get/execute/status/retry）
```

## 15. 边界情况

| 情况 | 处理 |
| --- | --- |
| 跨 31 天窗口的重复会议 | 窗口按 `[from, from+31d)` 左闭右开切分；即便重复，`UNIQUE` 兜底 |
| 一个录制含多个文件 | `record_files` 为数组；主键含 `remote_id`，天然一对多 |
| 主题含非法字符/emoji/超长 | 按 §11 清洗规则 |
| CLI 多实例并发 | WAL + `busy_timeout` + 租约三者保证，无需额外 IPC |

## 16. 测试策略

分层 + 真实依赖，不 mock 掉本质：

```
domain/       纯函数 → 单元测试（窗口切分、目录名清洗、就绪判定）
gateway/      网关响应 fixture → mock 回放（含 401 重取、meeting_not_found_in_range）
store/        bun:sqlite :memory: → 真实 SQL（去重、领租约、状态流转、探测）
downloader/   本地 HTTP server → 真实 Range / 403 / 416 / 断连
executor/     假网关 + 临时目录 → 端到端（含有界并发池）
```

**必须存在的用例**：
```
✓ 断点续传   下到一半杀进程 → 重启从断点继续，最终文件完整
✓ 链接过期   mock 403 → 换链后从当前字节继续，最终文件完整
✓ 416 分支   本地 .part 大于远端 → 删除重下
✓ 幂等       连跑两次 → 第二次零下载
✓ 崩溃恢复   running 租约过期 → 被重新领取
✓ 31 天切分  传入 90 天 → 恰好 3 个窗口，无重叠无遗漏
✓ 探测超时   过 deadline 的未就绪资产 → skipped(upstream_timeout)
✓ 探测就绪   probing 资产在重查时出现 → 补建下载任务并完成
✓ 令牌过期   长任务中途 401 → 透明重取 service-token 后续传成功
✓ 默认资产集 未指定 --assets → 只拉 ①②③④；--assets 加 ai_minutes 才拉纪要
```

## 17. 实现前必须确认的事项（已知未知）

1. **"AI 待产"的真实表现**：待产的 AI 纪要在网关 `list-assets` 响应里表现为"存在但 state=1/2"还是"完全不在清单里"，取决于腾讯 51180 的真实响应语义（网关 spec deploy.md §11 已记这类字段推断需真实环境核实）。§9 判定表对两种表现都安全（都走 probing），接真实环境时只需校准阈值，不影响架构。
2. **`allow_download=false` 的粒度**：平台文档称 `allow_download=false` 时"全部 `ai_*` 字段返回空"——需确认这是整条记录级还是单字段级，以正确区分"整场 AI 不可得"与"某类纪要不可得"。
3. **网关 download-url 响应字段**：`file_type` / `bytes_expected` 是否对全部资产类型都提供（文本类可能缺 `bytes_expected`）；缺失时视频/音频退化为"下完即完成"、文本类靠 hash 兜底。
4. **服务账号 access_token 的确切 TTL 与 401 响应形状**：客户端透明重取依赖能从 401 响应稳定识别"令牌过期"，需与网关实际返回对齐。

以上均可在与网关联调时确认，不阻塞 M3 编码起步（架构对这些取值不敏感）。

### 17.1 M3.5 联调回填（2026-08-25 补记，联调发生在 2026-08-21～08-22）

只回填**有提交为证**的部分。没跑到的仍标未知——把推断写成结论正是本节存在的理由。

| # | 状态 | 结论 |
| --- | --- | --- |
| 1 | ⬜ **仍未知** | AI 待产的真实表现要靠 runbook Stage 9.4（找一场刚结束的会议跑 `run`）验证，那一步从未跑过。§9 判定表对两种表现都安全，架构不受影响 |
| 2 | ⬜ **仍未知** | `allow_download=false` 是记录级还是单字段级，没有实测记录 |
| 3 | ✅ **已知** | `file_type` 对文本类资产确实提供，但**会给出 `docs` 这类非常规值**（实测魔数为 ZIP/OOXML，确系标准 docx）、**也会为空**（导致尾点文件名）——已在 `e02b0aa` 归一化。另外**同一资产存在多种格式**，唯一键与 `assetId` 末段都必须带 `file_type`（`90ad4ca` · `d1d4f10`） |
| 4 | ⬜ **仍未知** | access_token 的确切 TTL 与 401 响应形状没有实测记录 |

**本节之外、联调查出的最大一处**（原本不在「已知未知」清单里，因此更值得记）：
`asset_type` 发的**不是**腾讯平台字段名，而是网关自己的领域词汇 `ASSET_TYPES`。
本文 §5 当时推断网关会原样透出平台字段名——**只有 video/audio 两项不同**，这种部分重合
让故障伪装成了「视频资产没产出」：转写照常下载、视频音频永远匹配不上，最后按 deadline
静默放弃。已在 `ae5d7c9` 改正，判据与教训写在 `packages/engine/src/domain/types.ts` 的
`ASSET_KEY_TO_GATEWAY_TYPE` 注释里。

**未被真实验证的仍然是投产门槛**：runbook 的 Stage 8（完整闭环）与 Stage 9（幂等 /
断点续传 / 崩溃恢复 / AI 延迟探测）从未跑过。§10 的断点续传全靠对象存储支持 Range，
那一条至今没有真实证据。
