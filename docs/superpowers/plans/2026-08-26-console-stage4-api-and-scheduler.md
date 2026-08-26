# 控制台阶段 4 · API 与调度 —— 逐任务计划

- 日期：2026-08-26
- 上游：[`dev-plan.md`](../../console/dev-plan.md) §3 阶段 4（A1–A6）·
  [`spec.md`](../../console/spec.md) §4.2–§4.10 · [`backend-gap.md`](../../console/backend-gap.md) §4
- 前置：阶段 3 已完成（T1–T9：三栈引擎 · 影响预览 · 逐会议授权 · 人工改写覆盖层 · 采集清单）
- 产出：A2–A6 五个 API 面 + A4 调度器 + **A7**（dev-plan 未列的一处接线缺口，见 E-c）

---

## 0. 开工前必须消解的冲突

阶段 3 开工前消解了七处规格与实现互相矛盾的地方（dev-plan §5）。本阶段同样先做这一步：
下面七条**在写第一行代码之前就已经裁定**，每条都写明了「按裁定做错了会怎样」。

### E-a · 两张会议表，A2 读哪张

| 表 | 建于 | 谁写 | 主键 |
| --- | --- | --- | --- |
| `meetings` | `002_worker_queue.sql` | worker 的 discovery | `(meeting_id, sub_meeting_id)` |
| `meeting_cache` | `001_init.sql` | 网关列会议时机会性 upsert | `(meeting_record_id)` |

**裁定：`meetings` 是控制台主表。** 它与 `meeting_assets` / `meeting_archives` /
`meeting_grants` / `meeting_overrides` 同键，是唯一能和这四张表 JOIN 的一张；
`meeting_cache` 的键是 record 维度，和谁都 JOIN 不上。

`meeting_cache` **保持它现在的单一用途**——download-url 端点按 `meetingRecordId`
反查会议属性做策略判定（见该文件的文件头）。**两张表不合并、不互相回写。**

代价写在这里免得以后当 bug 修：`meetings` 表的列全部 nullable，且**没有 `state` 列**
（录制状态只在 `meeting_cache` 里）。A2 需要的 `FetchState` 不从这两张表的任何一张来，
见 E-c。

### E-b · `Meeting.host` 要主持人姓名，库里只有 `host_userid`

前端契约（`console/src/api/types.ts`）的 `host: string` 在原型里是中文姓名。
库里只有 `meetings.host_userid`，取姓名要走企微通讯录，而**本部署企微未配置**
（四条设备流程路由统一返 501，见 `router.ts` 的 `WECOM_ROUTES`）。

**裁定：下发 `host_userid` 原值，前端照原样显示。不编占位名。**
显示一个查不到出处的中文名，比显示 userid 更难排查——管理员会以为那是真名，
拿着它去问人，问出来的会是另一个人。

响应字段仍叫 `host`：将来接上通讯录时只换来源，不换形状，前端一行不改。

### E-c · `why.fetch` 无处可取——拉取规则栈零调用点

**实测**：`evaluateFetchStack` 在全仓库只有一个引用点，是 `src/policy/preview.ts`
（影响预览）。`src/worker/index.ts` 的 discovery 走的仍是 CLI 那套「按时间窗发现」，
**没有任何一条拉取规则参与过真实的拉取决策**。

即：spec §4.6 第一组「拉取规则——去腾讯会议拉哪些会议、拉哪几类资产」，
管理员今天配了也不生效。这与阶段 3 收尾时发现的「网关的采集权限判定曾经完全绕过
人工改写」是同一类问题：**引擎交付了，接线漏了**，而两处都发生在「规则页看起来一切正常」
的前提下。

**裁定：**

1. **A2 不编 `why.fetch`。** 拉取规则未接线期间，如实报
   `{ by: 'na', text: '拉取阶段目前不由规则决定：discovery 按时间窗发现全部录制，拉取规则栈尚未接线（A7）' }`。
2. **接线单列为 A7**（T12），放在本阶段最后，**不阻塞 A2–A6**。

为什么不顺手给个 `{ by: 'rule', ruleId: 3 }`：那会让管理员在详情抽屉里读到
「由规则 #3 决定」，而 #3 从没跑过。**比不说更糟**——它把一个缺口伪装成一次判定。
这条是全局约束「不许静默放行」在展示侧的同一件事。

### E-d · 归档失败不落库

`archivePendingMeetings`（`src/worker/archive.ts`）的 `result.failed++` 只是**本轮内存计数**，
失败原因只走 `console.error`。spec §4.8 要求失败项「一直留在下方的『失败项 · 需要处理』
表里等重试，且明写影响（「未归档，到期会永久丢失」）和已重试次数（`2 / 5`）」。

**裁定：A4（T11）建 `job_runs` + `job_failures` 两张表，并在 `archiveMeeting` 的 catch 里落一行。**
这意味着 T11 **要改 `src/worker/archive.ts`**——这是 A4 的范围，不是顺手改。

拉取侧的失败项已经有地方了（`meeting_assets.attempts` + `last_error`），不必重复建表：
`job_failures` 只收「不属于某个具体资产行」的失败（归档、清理、清单重算）。

### E-e · A4 的采集清单重算无处可存（dev-plan 已点名待定）

spec §4.8 定时任务四是「刷新采集清单，每 5 分钟」，但**重算结果没有对应的表**。

**裁定：不开缓存表，A2/A3 现算。**

- `computeProgramInventory` 的**查询数与会议数无关**（规则 1 次、归档 1 次、改写 1 次、
  会议元数据 1 次，外加至多 1 次本地资产），1–3 个采集程序、几百场会议的规模，现算完全够。
- 开缓存表意味着「控制台显示的可取清单」与「网关 `AccessGate` 的实时判定」变成**两份真相**，
  而漂移的方向恰好是 §1.3 要防的那一件事：控制台说能取、实际取不到，或者反过来。
- 定时任务四**照跑**，但**产出是运行摘要，不是清单缓存**：逐程序算一遍，把
  `fetchable.length` / `blocked.length` 写进 `job_runs.summary`。§4.8 的 sparkline
  因此有东西显示，而清单本身仍然现算。它同时是一条巡检——某个程序的 `blocked` 数突增，
  在这条记录里看得见。

将来现算真慢了再加缓存表是**纯增量**改动：A2/A3 的调用点不变，换的是
`computeProgramInventory` 内部。**先开表才是不可逆的那个方向。**

### E-f · A6 的内容入库要改归档流水线，且有回填问题

dev-plan 定的方案是「worker 归档时把文本类资产的正文一并入库，预览页直接读库」。

**裁定：保持入库方案，不改成「预览时现解析」。** 理由不是性能，是 spec §4.9：
「到期只删本地文件，**数据库记录永久保留**」。**纪要正文属于「记录」**——本地文件
被清理之后还要能预览，现解析那一刻文件已经不在了。

**新增一件 dev-plan 没提的事：已归档会议的回填。**
裁定为**手动脚本** `scripts/backfill-contents.ts`，不做自动回填——自动回填会在每次
worker 启动时扫全表，而这是一件一次性的事。

### E-g · `PolicyStore` 只有读侧

`src/store/policy.ts` 现在只有 `listEnabledRules` / `listEnabledStackRules`。
A3 的规则页要 CRUD，写侧要新建（T2）。

**连带的硬要求**：改规则**必须记审计**。spec §4.10 是「人和程序混在同一条流里」，
而现在 `audit_log` 里只有程序取数据的记录，管理员改规则一条痕迹都没有——
那意味着「谁把这条规则从 deny 改成 allow」查不出来，而这是数据出境闸门的开关。

---

## 1. 全局约束

沿用阶段 3 的四条，逐字不变：

1. **TDD**：先写失败的测试，再写实现。
2. **不许静默放行**：任何「判不出来」的路径必须落到安全的一侧，**并留下可读的理由**。
   本阶段的展示侧版本见 E-c——不编一个没发生过的判定。
3. **判定理由必须可回溯**：界面上每一句「因为规则 #N」都要能对回一条真实跑过的判定。
4. **迁移不得静默改变判定**：`runMigrations` 每次启动都跑，DDL 必须 `IF NOT EXISTS`
   或用 `information_schema` + `PREPARE`/`EXECUTE` 守卫。

两条本阶段特有的：

5. **响应形状以 `console/src/api/types.ts` 为准。** 前端 F1 已经按它写完了整个页面
   （跑在 mock 上）。后端另发明一套形状，等于让 F2–F6 每接一个 API 就改两边。
   形状要改就改前端那份，并在计划里写明为什么——**不要两边各自演化**。
6. **管理员的每一次写操作都要进 `audit_log`。** 改规则、改授权、写改写、延长保留、
   暂停清理、手动触发任务，一条不落。`actor_type = 'admin'`。

---

## 2. 任务与波次

12 个任务，四个波次。波次内的任务**文件不相交**，可并行；
波次 2 起每个任务都要往 `src/http/router.ts` 追加自己的路由行与 `AppDeps` 字段，
**那是唯一会冲突的文件，且冲突都是追加型**。

```
波次 1（纯 store / worker 层，零 router 冲突，4 路并行）
  T1 会议查询 store      T2 规则写侧      T3 审计读侧      T4 文本内容入库
        │                     │                │                 │
        ▼                     ▼                ▼                 ▼
波次 2（handler 层，4 路并行开发，串行合并）
  T5 A2 会议查询 API    T6 A3 规则 API   T9 A5 审计 API   T10 A6 内容读取 API
        │
        ▼
波次 3（3 路并行）
  T7 A3 授权 API       T8 A3 存储/保留 API      T11 A4 调度器
        │
        ▼
波次 4
  T12 A7 拉取规则接线
```

| 任务 | 对应 | 内容 | 落点 |
| --- | --- | --- | --- |
| **T1** | A2 底座 | 会议列表查询：分页 / 搜索 / 筛选 / 分诊条五计数 / 批量拼装 | `src/store/console-meetings.ts`（新） |
| **T2** | A3 底座 | 规则 CRUD 写侧 + 规则列表读侧（含 disabled 的） | `src/store/policy.ts` |
| **T3** | A5 | 审计读侧：按操作者 / 类型 / 时间范围筛选 + 分页 | `src/store/audit.ts` |
| **T4** | A6 写侧 | 文本类资产正文入库 + 归档流水线接线 + 回填脚本 | `migrations/007` · `src/store/contents.ts`（新）· `src/worker/archive.ts` · `scripts/backfill-contents.ts` |
| **T5** | A2 | 会议查询 API | `src/http/handlers/console/meetings.ts`（新） |
| **T6** | A3 | 规则 API + 影响预览端点 | `src/http/handlers/console/rules.ts`（新） |
| **T7** | A3 | 授权 API + 采集清单（§4.5 那句话）+ 人工改写 | `src/http/handlers/console/grants.ts`（新） |
| **T8** | A3 | 归档存储页 + 保留窗口动作 | `src/http/handlers/console/storage.ts`（新） |
| **T9** | A5 | 审计 API | `src/http/handlers/console/audit.ts`（新） |
| **T10** | A6 | 内容读取 API | `src/http/handlers/console/content.ts`（新） |
| **T11** | A4 | 定时任务调度器 + 运行记录 + 失败项 | `migrations/008` · `src/worker/scheduler.ts`（新）· `src/worker/archive.ts` |
| **T12** | A7 | 拉取规则栈接线（E-c） | `src/worker/index.ts` · discovery 的触发源 |

---

## 3. 逐任务

### T1 · 会议查询 store（A2 底座）

**落点**：`src/store/console-meetings.ts`（新文件）+ 它的测试。
**不碰** `src/store/meetings.ts`（那是 `meeting_cache`，见 E-a）。

**要交付的接口**（形状按需要调整，但这四件事一件不能少）：

```ts
export interface ConsoleMeetingsStore {
  /** 分页列表。返回的是拼装好的行，不是四张表的原始行 */
  list(q: MeetingQuery): Promise<{ rows: ConsoleMeetingRow[]; total: number }>
  /** 分诊条五格。一次查询算完五个数，不是发五条 SQL */
  triage(now: number): Promise<Triage>
  /** 单场，详情抽屉用。比 list 多返回操作历史 */
  get(meetingId: string, subMeetingId: string): Promise<ConsoleMeetingRow | null>
  /** 批量拿会议元数据，给 visibility.ts 的 `VisibilityDeps.getMeetings` 用 */
  getMeetings(keys: readonly MeetingKey[]): Promise<readonly Meeting[]>
}
```

`MeetingQuery` 至少要有：`search`（标题 / 会议号 / 主持人）· `triage`（点分诊条某一格）·
`hasGrant` · `hasOverride` · `inRetention` · `limit` / `offset`。

**验收**：

1. **分诊条五格的定义逐条对上 spec §4.2**，且每格都有测试：
   - `archiveFailed` —— 有 completed 资产、但 `meeting_archives` 没有行且已过归档窗口的
     （具体判据由实现定，但**必须在代码注释里写清楚判据是什么**，因为这是最高级别的告警）
   - `expiringIn7d` —— `local_purged_at IS NULL` 且 `expiresAt - now <= 7 天`
   - `awaitingGrant` —— 采集权限规则判 allow、但 `meeting_grants` 里一条生效授权都没有
   - `inProgress` —— `meeting_assets` 里有 `pending` / `running` 的
   - `nasOnly` —— `local_purged_at IS NOT NULL`
2. **`assets` 字段是 `Partial<Record<AssetKey, {got, total}>>`**：按 `asset_type` 分组数
   `status='completed'` 与总行数。**不适用的类不出现在对象里**（不是 `{got:0,total:0}`）。
3. **N+1 是不许的**：列一页 50 行，发出去的查询数**与行数无关**。测试要能证明这一点
   （对 pool 计数，或把查询记在 fake 上）。
4. `getMeetings` 查不到的会议**不造空壳顶上**——`visibility.ts` 的文件头写明了原因：
   空壳会让一条 `title has 财务` 的规则对着空标题判不匹配，看起来一切正常。

**坑**：

- `meetings` 表的列**全部 nullable**（`subject` / `host_userid` / `start_time` 都可能是 NULL）。
  `Meeting` 的字段是必填的。**NULL 要有明确的表示**，不许悄悄变成空串——
  一场 `subject IS NULL` 的会议在列表里显示成空白，和一场标题真的是空串的会议
  在界面上无法区分。
- `durationSec = end_time - start_time`，两者都可能 NULL。

---

### T2 · 规则写侧（A3 底座）

**落点**：`src/store/policy.ts` 追加写侧 + 读侧的「列出全部规则（含 disabled）」。

现有的两个读方法**只返回 enabled 的**——规则页要显示停用的规则（不然管理员停用一条之后
它就从界面上消失了，再也开不回来）。

**要交付**：`createRule` / `updateRule` / `deleteRule` / `setEnabled` / `listAllRules(kind?)` /
`getRule(id)`。

**验收**：

1. **写入前校验**：`kind` ∈ `fetch|archive|allow`（与 `meeting_overrides.kind` 同样的道理，
   见阶段 3 的 D-u：填错没有安全侧可落）；`join_op` ∈ `and|or`；`conds` 必须是数组；
   `effect` 按 `normalizeEffect(kind, …)` 校验。**校验失败要 reject，不是同步 throw**
   （阶段 3 的 `putOverride` 踩过这个：同步抛会绕过调用方的 `.catch()`）。
2. **`conds` 为空数组要拒绝写入。** 空 conds 在求值器里是「匹配一切」——
   管理员建一条空条件的 allow 规则，就是一条放行全库的兜底规则。
   要建全放行规则得显式写一个恒真条件，不能靠「什么都不填」。
3. `describeStackRuleIssues`（`stacks.ts` 已有）的结果要能被读侧带出来，
   让规则页显示「这条规则不会命中任何会议」。

---

### T3 · 审计读侧（A5）

**落点**：`src/store/audit.ts` 追加 `AuditQueryStore`。写侧 `record` 一行不改。

**要交付**：按 `actorId` / `actorType` / `action` / 时间范围 / `decision` 筛选 + 分页 +
按 `meetingId` 查单场会议的操作历史（详情抽屉底部要用）。

**验收**：

1. `idx_audit_time (occurred_at DESC)` 与 `idx_audit_actor (actor_id, occurred_at)` 已存在，
   查询要**走得上索引**——不要在 `occurred_at` 上套函数。
2. **`audit_log.meeting_id` 这一列有两种语义**：`action='issue_download_url'` 的记录里
   存的是 `meeting_record_id`，其余存 `meeting_id`（见 `001_init.sql` 里那段注释）。
   按会议查历史时**必须同时匹配两者**，否则详情抽屉里那场会议的下载记录一条都不显示。
   这一条要有测试。
3. spec §4.10：**被拒绝的记录要能单独筛出来**（界面上是红的），且拒绝原因要带出来。
   现在 `audit_log` 没有「原因」列——**不要为此加列**，`matched_rule` + `decision`
   足够前端组织出那句话；真需要原因文本时再开迁移。

---

### T4 · 文本内容入库（A6 写侧）

**落点**：`migrations/007_asset_contents.sql` · `src/store/contents.ts`（新）·
`src/worker/archive.ts` 接线 · `scripts/backfill-contents.ts`。

**入库范围**：六类纪要 + 转写 = `transcript` / `ai_transcript` / `ai_minutes` /
`ai_topic_minutes` / `ai_speaker_minutes` / `ai_ds_minutes`。**录像与音频不入库**。

**表**：

```sql
asset_contents(
  meeting_id, sub_meeting_id, asset_type, file_type,   -- 与 archived_assets 同键的前四段
  content      MEDIUMTEXT,                              -- 正文
  content_hash VARCHAR(64),                             -- 与 archived_assets.nas_hash 对得上
  bytes        BIGINT,
  parsed_at    BIGINT,
  PRIMARY KEY (meeting_id, sub_meeting_id, asset_type, file_type)
)
```

**验收**：

1. **入库在归档成功之后、按 NAS 副本的哈希对齐**——入了一份和 NAS 上不一致的正文，
   比没入更糟。
2. **入库失败不让归档判为失败。** 与 sidecar 的处理同一口径（`ArchiveOutcome.sidecar`）：
   正文没解析出来是可以补的，归档失败是不可逆的，两者不能混成一个数字。
3. `MEDIUMTEXT` 装不下的（16MB）要**明确拒绝并留痕**，不是截断。截断过的纪要
   在预览页上看起来是完整的。
4. 回填脚本**只处理 `asset_contents` 里没有的**，可重复跑。

**坑**：`docx` / `pdf` 不是纯文本。**本任务只入 `txt`**，其余格式记一行「未解析」并说明原因
——装一个 docx 解析器是另一件事，不在本阶段。这一条要写进表注释。

---

### T5 · A2 会议查询 API

**落点**：`src/http/handlers/console/meetings.ts` + `router.ts` 的路由行与 `AppDeps` 字段。

**端点**：

```
GET  /api/v1/admin/meetings                       列表（分页 / 搜索 / 筛选）
GET  /api/v1/admin/meetings/triage                分诊条五计数
GET  /api/v1/admin/meetings/:meetingId            单场详情（含 why 三段 + 操作历史）
```

**验收**：

1. **响应形状逐字对上 `console/src/api/types.ts` 的 `Meeting`**。
2. **`why.allow` 走 `explainMeetingAccess`**（`src/worker/visibility.ts`），不自己再判一遍。
   两处各判一遍必然会分叉，而分叉的表现是「详情抽屉说准许、程序取的时候被拒」。
3. **`why.fetch` 按 E-c 报 `na`**，不编判定。
4. **`why.archive`** 走 `evaluateArchiveStack` + 人工改写，与 `src/worker/archive.ts` 同源。
5. 全部端点走 `requireAdminAuth`。

---

### T6 · A3 规则 API + 影响预览

**落点**：`src/http/handlers/console/rules.ts`。

```
GET    /api/v1/admin/rules              列出三栈（含 disabled）
POST   /api/v1/admin/rules              新建
PATCH  /api/v1/admin/rules/:id          改（含启用/停用）
DELETE /api/v1/admin/rules/:id          删
POST   /api/v1/admin/rules/preview      影响预览（不落库）
GET    /api/v1/admin/rules/:id/matches  这条规则命中哪几场（§4.7 的「命中数」可点）
```

**验收**：

1. **预览端点绝不落库**（spec §5.5 / `policy/preview.ts` 的设计前提）。
   它接收的是一份**候选**规则集。
2. **每一次写操作记审计**（约束 6）：`action` 至少区分 `rule_create` / `rule_update` /
   `rule_delete` / `rule_toggle`，且记下改的是哪一栈的哪一条。
3. §4.7：「有会议**从未对外开放过**却将被这条规则放行时，额外出一条琥珀警告」——
   `previewStackImpact` 已经给出了 `ImpactChange`，这一条是把它读出来，不是重算。

---

### T7 · A3 授权 API + 采集清单

**落点**：`src/http/handlers/console/grants.ts`。

```
GET    /api/v1/admin/programs                        采集程序列表（service_accounts）
GET    /api/v1/admin/programs/:id/inventory          §4.5 那句话：现在可取走 N 场
POST   /api/v1/admin/meetings/:meetingId/grants      授权给某程序
DELETE /api/v1/admin/meetings/:meetingId/grants/:programId
PUT    /api/v1/admin/meetings/:meetingId/override    写人工改写
DELETE /api/v1/admin/meetings/:meetingId/override/:kind
POST   /api/v1/admin/programs                        接入新程序（四步向导的落点）
```

**验收**：

1. **inventory 走 `computeProgramInventory`，现算**（E-e）。响应要同时给
   `fetchable.length`、`blocked`（各带 blockers）、`assetTypes`——
   §4.5 那句话的三个部分。**「7 天内到期」的阈值在这一层判**，`visibility.ts`
   刻意只给 `expiresAt`（D-v）。
2. **接入新程序：明文凭据只出现一次**（spec §4.5，与 `scripts/seed-dev.ts` 一致，
   库里只存 argon2id 哈希）。复用 `src/auth/service.ts`，**不要另写一套**。
3. **写改写时 `kind` 由路径/请求体给**，store 侧已有 `assertOverrideKind` + `migrations/006`
   的 CHECK 两道防线（阶段 3 D-u），handler 这一层不要绕过它们自己转换。
4. 每一次授权 / 撤销 / 改写都记审计。

---

### T8 · A3 存储与保留 API

**落点**：`src/http/handlers/console/storage.ts`。

```
GET  /api/v1/admin/storage                     NAS 状态 + 容量 + 保留窗口统计（§4.9 两块）
POST /api/v1/admin/storage/retention-days      改默认保留天数
POST /api/v1/admin/storage/cleanup-pause       暂停 / 恢复到期清理
POST /api/v1/admin/storage/cleanup-now         立即清理已到期
POST /api/v1/admin/meetings/:meetingId/extend  延长 30 天（§4.3）
```

**验收**：

1. NAS 状态走 `src/worker/nas-probe.ts`，容量走它的探测结果，**不在 handler 里另跑一次 statfs**。
2. `cleanup_paused` / `default_retention_days` 走 `ArchivesStore.getSetting` / `setSetting`
   （`system_settings` 表已在 003 建好）。
3. **暂停清理是「唯一能阻止不可逆损失的开关」**（spec §1.2 / §7.2）。它必须：
   持久化（进程重启后仍然暂停）· 记审计 · 在响应里回显当前状态。
4. `extendRetention` 已在 `ArchivesStore` 里，直接用。

---

### T9 · A5 审计 API

**落点**：`src/http/handlers/console/audit.ts`。

```
GET /api/v1/admin/audit                        筛选 + 分页
GET /api/v1/admin/meetings/:meetingId/history  单场会议的操作历史（详情抽屉底部）
```

**验收**：spec §4.10 的四个字段（时间 · 操作者 · 动作 · 对象 · 结果）+ 三种 actor 色块
（`prog` / `person` / `sys`）能分得开。`actor_type` 现在的取值要在响应里映射成这三类，
**映射表写在一处**，不要前后端各写一份。

---

### T10 · A6 内容读取 API

**落点**：`src/http/handlers/console/content.ts`。

```
GET /api/v1/admin/meetings/:meetingId/content            纪要 / 转写正文（按 asset_type）
GET /api/v1/admin/meetings/:meetingId/content/chapters   时间轴章节
```

**验收**：

1. **管理员查看被规则禁止采集的会议要留痕**（spec §2）：这次查看进 `audit_log`，
   且响应里带一个标记，让前端挂琥珀警示条。**这不是可选项**——它是「管理员仍然能看」
   这条豁免的对价。
2. 本地已清理的会议**照样能读正文**（这正是 E-f 选入库方案的理由），但要在响应里
   说明本地文件已不在、录像要去 NAS 取。
3. 录像仍走直链，**不代理内容**。

---

### T11 · A4 定时任务调度器

**落点**：`migrations/008_job_runs.sql` · `src/worker/scheduler.ts`（新）·
`src/worker/archive.ts`（落失败项）· `src/http/handlers/console/jobs.ts`。

**四个任务**（spec §4.8 逐字）：

| 任务 | 频率 | 干什么 |
| --- | --- | --- |
| 一、拉取新录制 | 每 15 分钟 | `discover` + 入队 |
| 二、归档到 NAS | 每小时整点 | `archivePendingMeetings` |
| 三、清理到期文件 | 每天 03:00 | `retention.ts` 的清理 |
| 四、刷新采集清单 | 每 5 分钟 | 逐程序 `computeProgramInventory`，**写摘要不写缓存**（E-e） |

**表**：`job_runs`（任务名 · 开始 · 结束 · 结果 · 摘要 JSON）+
`job_failures`（任务名 · 对象 · 原因 · 影响 · attempts · max_attempts · 首次/最近失败时间）。

**验收**：

1. **失败项不静默丢弃**（spec §4.8 硬要求）：留在 `job_failures` 里等重试，
   带 `attempts / max_attempts` 和一句「影响」（归档失败是「未归档，到期会永久丢失」）。
2. **重叠保护**：上一轮还没跑完时不许再起一轮。归档一轮可能跑几十分钟，
   每小时一次会叠上去。
3. **进程重启后不补跑错过的**，但要在 `job_runs` 里看得出中间断了。
4. 手动触发端点（`POST /api/v1/admin/jobs/:name/run`）记审计。
5. **调度器不进 `src/index.ts`（网关进程）**，它属于 worker 进程——网关是多实例的，
   四个任务各跑一份是灾难。这一条要写进文件头。

---

### T12 · A7 拉取规则栈接线（E-c）

**落点**：`src/worker/index.ts` 的 discovery 触发处。

把 `evaluateFetchStack` 接进真实的拉取决策：discovery 发现一场会议之后，
按拉取规则栈判定**拉不拉、拉哪几类资产**，兜底 `skip`。

**验收**：

1. **兜底是 `skip`**（spec §4.6）——判不出来不拉，且记录理由。
2. 人工改写（`kind='fetch'`）优先于所有规则，与归档那条路径同源（`applyOverride`）。
3. **接线之后 `why.fetch` 才有真实来源**，T5 里那句 `na` 文案要一并改掉——
   这是 T12 的收尾动作，不是「以后再说」。
4. **接线会改变现有行为**：现在是「时间窗内全拉」，接上之后规则集为空 = 一场都不拉。
   迁移或部署说明里要写明：**上线前必须先建一条兜底的拉取规则**，否则归档链路会静默停摆。
   这一条是本任务最危险的地方。

---

## 4. 完成的判据

- 根 `bun test` 全绿，`bun run typecheck` 干净
- `console/` 的 133 个测试不受影响
- 每个新端点都有：成功路径 · 未登录 401 · 参数非法 400 · 写操作留审计 四类测试
- E-a ~ E-g 七条裁定各自在代码注释里能找到对应的落点
