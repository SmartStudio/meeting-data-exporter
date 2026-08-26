# T1 · 会议查询 store（A2 的数据底座）—— 交付报告

- 日期：2026-08-26
- 计划：`docs/superpowers/plans/2026-08-26-console-stage4-api-and-scheduler.md` §3 T1
- 落点：`src/store/console-meetings.ts`（新）· `tests/store/console-meetings.test.ts`（新）
- 状态：**DONE_WITH_CONCERNS**（功能完整、验收逐条落地；有 3 处计划与代码现实的矛盾我自己裁定了，见 §3）

---

## 1. 交付了什么

```ts
export interface ConsoleMeetingsStore {
  list(q: MeetingQuery): Promise<{ rows: ConsoleMeetingRow[]; total: number }>
  triage(now: number): Promise<Triage>
  get(meetingId: string, subMeetingId: string, now: number): Promise<ConsoleMeetingRow | null>
  getMeetings(keys: readonly MeetingKey[]): Promise<readonly Meeting[]>
}
export function createConsoleMeetingsStore(pool: Pool, deps?: { policy?: PolicyStore }): ConsoleMeetingsStore
export function consoleMeetingId(meetingId: string, subMeetingId: string): string
export function parseConsoleMeetingId(id: string): MeetingKey
export const ARCHIVE_GRACE_SEC: number
```

`MeetingQuery`：`now`（必填）· `search` · `triage` · `hasGrant` · `hasOverride` ·
`inRetention` · `limit` / `offset`。

`ConsoleMeetingRow` 的字段名与 `console/src/api/types.ts` 的 `Meeting` 对齐，
另加四个后端事实字段：`meetingId` / `subMeetingId` / `missing` / `unknownAssetTypes`，
`keep` 里另加 `extendedDays` / `retentionDays`。多出来的字段前端会忽略，少一个字段前端会崩。

**没有产出的契约字段**（都不是遗漏，是分层）：

| 契约字段 | 谁给 | 为什么不在 store |
| --- | --- | --- |
| `allow` / `why.allow` | T5，走 `explainMeetingAccess` | allow 栈主体是采集程序，两处各判一遍必然分叉，分叉的表现是「详情抽屉说准许、程序取的时候被拒」（T5 验收 #2 已经明写这一条） |
| `why.fetch` | T5，按 E-c 报 `na` | 拉取规则栈零调用点 |
| `why.archive` | T5，走 `evaluateArchiveStack` | 与 `src/worker/archive.ts` 同源 |
| `history` | T3 的 `audit.ts` | `audit_log.meeting_id` 双语义，那条读法只该有一份实现 |

因此 `fetch` / `archive` 两个阶段状态给的是**库里看得见的那一半**：`'off'`（人工改写关掉）
给得出来，`'blocked'`（规则做的决定）永远不会返回——契约对这两个取值的分工是明写的。

---

## 2. 验收逐条对照

### 2.1 分诊条五格

| 格 | 实现的判据 | 测试 |
| --- | --- | --- |
| `archiveFailed` | 有 completed 资产 · `meeting_archives` 无行 · 无 `kind='archive'` 的生效 skip 改写 · **最后一个 completed 资产完成时刻 + 6 小时 < now** | 4 条（超宽限 / 宽限内 / 已归档 / 没有 completed），另 1 条钉「被人工关掉归档的不算失败」 |
| `expiringIn7d` | `local_purged_at IS NULL` 且 `expiresAt - now <= 7 天`（含边界、含已过期未清理） | 1 条，**拿 `retention.ts` 的 `expiresAt()` 算出期望值再对 SQL 计数**，两边漂了当场红 |
| `awaitingGrant` | 至少一个采集程序被 allow 栈（含人工改写）判 `isVisible`，且一条生效授权都没有 | 6 条（基本 / 无规则 / 停用与 deny 规则 / 改写翻 deny / 只有改写没有规则 / asset_types 无合法键） |
| `inProgress` | `meeting_assets` 有 `pending` / `running` | 1 条 |
| `nasOnly` | `local_purged_at IS NOT NULL` | 1 条 |

**`ARCHIVE_GRACE_SEC = 6 小时` 的依据写在常量的注释里**（这是最高级别告警，判据必须写清楚）：
归档任务每小时整点跑一次（spec §4.8），6 小时 = 连续 6 轮都没归进去，已经不是「还没轮到」；
单次归档上界是 `NAS_WRITE_TIMEOUT_MS`（10 分钟），一场会议再大也跨不过 6 小时，
所以宽限内不会把一场「正在搬」的会议误报成失败。起算点取**最后一个 completed 资产的完成时刻**
而不是会议时间——`meeting_archives` 只在全部资产归档后才建行，从会议时间起算会把一场
刚拉完的老会议立刻判成失败。

`sk`（人工关掉归档）这条排除同时作用在**计数**和**行状态**上，测试里有一条同时断言两侧，
钉的就是「分诊条数出来的 0 和列表里显示的状态不许打架」。

### 2.2 `assets` 是 `Partial<Record<AssetKey, {got,total}>>`

- 按 `asset_type` 分组数 `status='completed'` 与总行数；
- **不适用的类不出现在对象里**，不是 `{got:0,total:0}`（后者会渲染成「0/0」，看起来像一次失败的拉取）；
- 库里存的是**网关的 `asset_type`**（`meeting_summary` / `ai_meeting_transcripts`），
  经 `GATEWAY_TYPE_TO_ASSET_KEY` 换算成契约的 `AssetKey`，不另抄一份映射表（M3.5 为此吃过亏）；
- 认不出的 `asset_type`（将来接新纪要引擎）**不静默丢掉**，单列在 `unknownAssetTypes` 里。

### 2.3 N+1 不许有

列一页发出去的查询是**固定 5 条**：计数 1 · 分页 1 · 资产聚合 1 · 授权 1 · 改写 1，
后三条并发。测试用一个数 `execute` / `query` 次数的 pool 代理，断言**列 3 行与列 30 行
的查询数完全相同**，并顺带钉住量级 `<= 6`。`triage` 同理（`<= 5`，实际 4 条）。

### 2.4 `getMeetings` 不造空壳

查不到的会议**不出现在返回数组里**。测试直接断言 `got.some(m => m.meetingId === 'ghost') === false`。
查得到但列是 NULL 的行照样返回（那场会议真的存在，只是元数据不全），空值按仓库既有口径
补成空串 / 0，与 `src/worker/archive.ts` 的 `factsFor` 同一先例。

### 2.5 两个坑

- **NULL 不许悄悄变成空串**：`ConsoleMeetingRow.missing` 逐列记账
  （`title` / `code` / `host` / `startAt` / `endAt`）。测试里播两场会议——一场全 NULL、
  一场值真的是空串——断言 `title` 都是 `''` 而 `missing` 把它们区分开。
- **`durationSec = end - start`，两者都可能 NULL**：任一为 NULL 或 `end <= start` 时算 0，
  与 `domain/types.ts` 对「`record_files` 缺 `record_end_time` 的回落路径」的口径一致
  （照直算会得到负时长，界面上显示成「-1:02」）。

### 2.6 复用了既有读法

- 保留窗口到期时刻走 `src/worker/retention.ts` 的 `expiresAt()`，公式只有那一处；
- 人工改写的批量读法直接用 `grants.ts` 的 `listActiveOverridesForMeetings`；
- 行构造器 IN 的批量键写法跟 `archives.ts` 那一族一致（含「传空数组不查库」）；
- 规则读侧用 `policy.ts` 的 `listEnabledStackRules('allow')`；
- 求值走 `policy/stacks.ts` + `policy/override.ts` + `policy/access.ts` 的既有纯函数，
  与 `src/worker/visibility.ts` 的 `evaluateInventory` 逐句同构，不另写一套判定。

---

## 3. 计划与代码现实矛盾的地方（自行裁定）

### 3.1 `keep.extended` 契约要「次数」，库里只有「天数」

契约 `KeepWindow.extended` 是「被人工延长过**几次**」，前端渲染成「（已延长 N 次）」；
而 `meeting_archives` 只有 `extended_days`（`extendRetention` 是**累加天数**，003 建表如此）。

- 天数当次数报 → 一次「+30 天」会渲染成「已延长 30 次」，**比不报更糟**；
- 一律报 0 → 一场确实被延长过的会议看起来没被动过，是静默丢信息。

**裁定**：新增 `keep.extendedDays`（真实事实，永远可信），`keep.extended` 取
`extendedDays > 0 ? 1 : 0`——一个**下界**，只保证「延长过」这件事不丢。
准确次数只能去 `audit_log` 数「延长保留」那个动作（全局约束 6 要求管理员每次写操作都进审计），
那是 **T3 的读法 + T8 的写入点**的组合，store 单独答不了。理由写在 `ConsoleKeepWindow` 的注释里。

**给 T5/T8 的建议**：T8 落地「延长保留」时把 action 命名固定下来并写进审计，
之后 T5 可以用 T3 的读法把真实次数覆盖到 `extended` 上，本模块的字段一个都不用改。

### 3.2 `awaitingGrant` 的「规则判 allow」离开采集程序没有意义

验收写的是「采集权限规则判 allow、但 `meeting_grants` 里一条生效授权都没有」，
但 allow 栈的主体是**采集程序**：一条规则只对它 `subject_value` 指的那个程序生效
（`policy/stacks.ts` 的 `checkSubject`）。没有程序，就没有 allow 判定。

**裁定**：「准许采集」= **至少有一个采集程序会被判 allow**。候选程序取「启用的 allow 规则上
出现过的 `subject_value`」——没有规则指向的程序永远走兜底 deny，算进来也不改变任何结论。
人工改写优先于所有规则，所以「一条规则都没有」时仍要跑一轮（`programId: ''`），
让改写套得上去；两边都空才真的早退回 0。

**为什么不退回纯 SQL 的近似**（「有东西可取但没授权」）：现在这个部署的 `policy_rules` 是空的
（004 把旧规则备份后清空了），近似版会报「全部会议待授权」，而管理员就算真去授权了，
allow 栈照样兜底 deny、程序还是取不到。那不是一个偏大的数，是一个**方向就错的数**。

**代价（这是 DONE_WITH_CONCERNS 的主要来源）**：
1. 验收里「一次查询算完五个数」没做到——`triage()` 是 **4 条查询**（四格 SQL 1 条 +
   规则 1 条 + allow 改写 1 条 + 候选会议 1 条），仍然**与会议数无关**，测试钉住 `<= 5`。
2. `awaitingGrantKeys` 会把「没有生效授权的会议」整批读进内存求值。规模判断与计划 §0 E-e
   「不开缓存表、A2/A3 现算」同一笔账（1–3 个采集程序、几百场会议，纯函数求值毫秒级），
   但**会议量上到几万行时这一格会变慢**。届时的增量修法是给候选查询加时间窗或分片，
   调用点不变；先开缓存表才是不可逆的那个方向。

### 3.3 `get()` 不返回操作历史

计划的接口草图写着「单场，详情抽屉用。**比 list 多返回操作历史**」，但操作历史来自
`audit_log`，而 **T3 明确交付**「按 `meetingId` 查单场会议的操作历史（详情抽屉底部要用）」，
并且那张表的 `meeting_id` 列有两种语义（`issue_download_url` 存的是 `meeting_record_id`，
其余存 `meeting_id`，见 001 的注释），T3 的验收 #2 专门要求「按会议查历史时必须同时匹配两者」。

**裁定**：`get()` 只按真实主键取一行，不查 `audit_log`。在这里再写一遍那条读法，
就是同一列的两种语义有两份实现——一定会分叉，而分叉的表现是「详情抽屉里那场会议的下载记录
一条都不显示」。历史由 **T5 把 T3 的读法组合进详情响应**。

`get()` 相对 `list()` 的价值仍在：它按 `(meeting_id, sub_meeting_id)` 精确取，
周期性会议的两个场次不会互相顶替（`store-mysql.ts` 的 `meetingsForPaths` 踩过这个坑）。

### 3.4 其余若干处（已在代码注释里就地说明）

- **契约的 `FetchState` 没有 `'failed'`**。全部资产都终结但一个都没拿到的会议报 `'done'`，
  「一个都没拿到」由 `assets` 的 `0/N` 说出来（那也是 spec §4.2 表格列里写的「`0/19`（部分失败）」）。
  报 `'none'`（无录制）是错的——明明有录制。
- **spec §4.2 的 `inProgress` 说「拉取或归档进行中」，归档那一半观测不到**：归档侧没有租约、
  没有 running 状态列，库里只有「归了 / 没归」。编一个「归档进行中」出来，等于把
  「归档卡住了」显示成「正在处理」——那正是 `archiveFailed` 要抓的东西。按验收原文只数拉取那一半。
- **`meetings` 表没有 `state` / `meeting_record_id` 两列**（E-a 已点名）。`getMeetings` 填
  `state: 'completed'` / `meetingRecordId: ''`，与 `src/worker/archive.ts` 的 `factsFor` 同一裁定，
  且 `policy/conds.ts` 的 `MeetingFacts` 压根不读这两个字段，不参与任何判定。
- **`GrantsStore` 没有批量的授权读法**（只有 `listActiveOverridesForMeetings` 是批量的），
  逐场 `listActiveGrantsForMeeting` 列一页就是 50 次往返。本文件自建了一条**只取 `program_id`**
  的批量读法，并在注释里写死「它不能被当成判定路径上的授权读法用」——判定要三态的
  `asset_types`，一个都不能少（005 的表头解释了为什么空数组不是「不限制」）。
  将来若要把它搬进 `grants.ts`，是纯移动，调用点不变。
- **`meeting_assets` 里有资产而 `meetings` 表里没有行的会议**（采集侧数据不一致，
  `archive.ts` 的 undecidable 分支处理它）在控制台里整个不可见，因此也数不进 `archiveFailed`。
  它由归档流水线自己报，不是这一格的活。已在 `triageFragment` 里注明。

---

## 4. 几个实现细节，写下来免得被「修」回去

- **行 id**：`encodeURIComponent(meetingId)[,encodeURIComponent(subMeetingId)]`。
  `encodeURIComponent` 把逗号转成 `%2C`，所以字符串里的**字面逗号只可能是分隔符**，
  `("a,b","")` 与 `("a","b")` 编不出同一个 id。`archiveStateKey` 那个 NUL 分隔符进不了 URL，
  所以这里另编一套，但防的是同一件事。测试里有一条专门钉这个碰撞。
- **`LIKE` 转义**：`search` 里的 `%` 与 `_` 按字面量处理。不转义的话管理员搜「进度_周会」
  会搜出「进度X周会」，他会以为搜索坏了，或者更糟——以为那就是全部结果。
- **排序必须带确定的第二、第三键**：`ORDER BY start_time DESC, meeting_id, sub_meeting_id`。
  `start_time` 有大量并列（周期性会议的各场次 + NULL 那一堆），只按它排会让行在页与页之间
  来回跳，同一场会议出现两次、另一场一次都不出现。NULL 在 DESC 里排最后，正是要的。
- **`LIMIT` / `OFFSET` 收敛成整数后拼进 SQL**，不走占位符：避开 mysql2 各版本对 `LIMIT ?`
  参数类型处理的差异；收敛本身也挡住「一次拉全表」（上限 500）。
- **`SUM()` 的返回值必须 `Number()`**：mysql2 把 DECIMAL 按字符串返回，不转的话
  `got + 1` 会拼出 `"11"`，而这个值最终会进 JSON——前端拿到的是另一种类型，
  而且是间歇性的（数小才不出事）。
- **改写是否「把阶段关掉」走 `normalizeEffect`**，不是直接比 `effect === 'skip'`：
  改写的 effect 是自由文本，认不出的取值在求值器里落到本栈安全侧。界面必须显示求值器
  **真正会做的那件事**，否则一条填错了的改写在列表里看起来什么都没发生，而实际上
  它已经把这个阶段关掉了。

---

## 5. 验证

```
bun test tests/store/        169 pass · 0 fail（其中本次新增 33 条）
bun run typecheck            干净
```

另外做过一次**变异测试**确认用例有牙：把 ①「排除人工关掉归档」②「LIKE 转义」
③「`isVisible` 换成 `effect === 'allow'`」三处分别改坏，对应的 3 条用例各自变红，
其余 30 条不受影响。

---

## 6. 给下游任务的接口备忘

- **T5（A2 会议查询 API）**：`list` / `triage` / `get` 直接可用；需要自己叠加
  `allow` + `why` 三段（`explainMeetingAccess` / E-c 的 `na` / `evaluateArchiveStack`）
  与 `history`（T3 的读法）。`fetch` / `archive` 若要出现 `'blocked'`，也在这一层用
  同一套 `evaluate*Stack` 叠——store 给的是库里看得见的那一半。
  路由 `GET /api/v1/admin/meetings/:meetingId` 的路径段用 `parseConsoleMeetingId` 解，
  它与 `ConsoleMeetingRow.id` 是一对。
- **接 `visibility.ts`**：`VisibilityDeps.getMeetings` 可以直接接
  `createConsoleMeetingsStore(pool).getMeetings`，签名与语义（含「查不到不造空壳」）都对得上。
