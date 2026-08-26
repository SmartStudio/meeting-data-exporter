# T8 · 归档存储与保留窗口 API —— 完成报告

- 任务：控制台阶段 4 · A3 的一部分（计划 `docs/superpowers/plans/2026-08-26-console-stage4-api-and-scheduler.md` §3 T8）
- 日期：2026-08-26
- 结论：**DONE_WITH_CONCERNS**（功能与四条验收判据全部落地；两处"同一件事在两个文件里各存一份"的账记在 §5，其中一处已用测试钉住，另一处只能靠注释）

---

## 1. 交付了什么

### 五个端点（全部走 `requireAdminAuth`）

| 方法 | 路径 | 干什么 |
| --- | --- | --- |
| GET | `/api/v1/admin/storage` | NAS 连通/容量 + 保留窗口统计（spec §4.9 两块） |
| POST | `/api/v1/admin/storage/retention-days` | 改默认保留天数 |
| POST | `/api/v1/admin/storage/cleanup-pause` | 暂停 / 恢复到期清理 |
| POST | `/api/v1/admin/storage/cleanup-now` | 立即清理已到期（**默认 dry-run**） |
| POST | `/api/v1/admin/meetings/:meetingId/extend` | 延长这一场的保留窗口（§4.3） |

### 文件

| 文件 | 性质 |
| --- | --- |
| `src/http/handlers/console/storage.ts` | 新建，五个 handler |
| `src/store/console-storage.ts` | **新建（计划落点之外，理由见 §4.1）**，只读聚合 store |
| `tests/http/console-storage.test.ts` | 新建，31 条 handler / 路由用例 |
| `tests/store/console-storage.test.ts` | 新建，8 条真库 SQL 用例 |
| `src/http/router.ts` | **纯追加**：1 组 import、1 个 `AppDeps` 字段、5 行路由 |
| `src/index.ts` | **纯追加**：4 行 import、1 段装配、`deps` 里 1 行 |
| `tests/http/testApp.ts` · `tests/e2e/flow.test.ts` | **纯追加**：补上 `AppDeps.storage`（不补则全仓库 typecheck 红） |
| `.env.example` | 改了一行现在已经不成立的说明（见 §4.5） |

`git diff -U0 -- src/http/router.ts src/index.ts | grep -c '^-[^-]'` → **0**，两个并行冲突点上没有任何一行被删改。

---

## 2. 四条验收判据逐条对账

**1. NAS 状态走 `src/worker/nas-probe.ts`，容量走它的探测结果，不在 handler 里另跑一次 statfs**

`StorageDeps.probeNas` 由装配处绑定成 `() => probeNas(nasRoot, now)`（`src/index.ts`）。
handler 里没有 `statfs` / `node:fs` 的任何 import——整个文件只 import 了
`expiresAt` 这一个 worker 侧符号。容量三分（本系统 / 其他 / 剩余）里，"总"与"剩余"
原样来自探测结果，只有"本系统"来自数据库记账。

**2. `cleanup_paused` / `default_retention_days` 走 `getSetting` / `setSetting`**

两个键都只经 `ArchivesStore.getSetting` / `setSetting`，没有另写 SQL。
`cleanup_paused` 只写 `'1'` / `'0'` 两个值——retention.ts 的判定是"除了 `'0'` 和没写过
一律算暂停"，写 `'true'` 之类同样能生效，但会让库里出现第三种取值，下一个人得重新推一遍语义。

**3. 暂停清理：持久化 · 记审计 · 响应回显（三条缺一不可）**

- 持久化：写 `system_settings`，不是内存标志。
- 记审计：`action='set_cleanup_paused'`，`actor_type='admin'`。
- 回显：**写完之后重新 `getSetting` 再回显**，不是把请求体抄回去。
  有一条用例专门造了个"写进去和读出来不一样"的 store 来钉这一点——这条开关最不能出的错
  是"页面说已恢复、实际还停着"，而抄请求体正好挡不住这一类。

**4. `extendRetention` 直接用**

直接调 `ArchivesStore.extendRetention`。前面加了两道守卫，都不是可选的：
- 没有归档记录 → 404。`extendRetention` 是无条件 UPDATE，记录不存在时影响 0 行、不报错；
  不先查就发出去等于对着一个不存在的会议返回 200（界面显示"已延长 30 天"，库里什么都没发生）。
- `local_purged_at` 非空 → 409。本地文件已经删了，延长窗口延不回来。

---

## 3. 几个刻意的设计选择

**3.1 到期时刻只问 `retention.expiresAt`**

`GET` 里的"7 天内到期 / 已到期"和 `extend` 返回的新到期时刻，都调
`src/worker/retention.ts` 导出的 `expiresAt`，连"严格过期"的边界（`< now`，
正好到期那一秒不算）都照抄。handler 里没有 `archivedAt + ... * 86400` 这样的算式。

**3.2 归档失败数如实报 `null`**

spec §4.9 的 NAS 那块要"已归档 / 归档中 / 归档失败"三个数。前两个有数据源，
第三个没有——`archive.ts` 的失败计数只是本轮内存里的数字，原因只走 `console.error`
（计划 E-d 已经写明，`job_failures` 是 T11 才建）。所以响应里是：

```json
"failedMeetings": null,
"failedMeetingsNote": "归档失败项尚未落库：失败原因目前只写进 worker 日志……在那之前不编。"
```

理由与 E-c 让 `why.fetch` 报 `na` 是同一条：把一个缺口伪装成一次判定，比不说更糟。
T11 落地后把这两个字段换掉即可，前端形状不变。

**3.3 `cleanup-now` 默认 dry-run**

retention.ts 的硬要求 3 是"默认 dry-run，真删必须显式二次确认"。
不带 `confirm: true` 时走 `previewCleanup`，返回的正好是原型那个确认弹窗要列的内容
（哪些会议、多大）；`confirm: true` 才走 `executeCleanup`。
`confirm: true` 这个字面量**只出现在 `src/index.ts` 的装配那一行**——handler
拿不到它，用"调不调 execute"表达确认，不去伪造那个常量。

清理被暂停时返回 200 + `paused: true` 而不是 4xx：executeCleanup 本来就会如实回报，
前端据此显示"清理已暂停，没有删除任何文件"比一个 409 说得清；审计那边记成
`decision='deny'`，与 §4.10「被拒绝的记录是红的」对齐。

**3.4 清理审计逐场记一条，外加一条汇总**

删掉某场会议的本地文件是不可逆的，§4.3 详情抽屉底部那段"这场会议的操作历史"
按 `meeting_id` 查——只记一条汇总的话，这件事在那里根本不出现。
所以 `purge_local` / `purge_blocked` / `purge_failed` 各自逐场落行（后两者
`decision='deny'`），最后再落一条 `cleanup_now` 汇总。
`purge_blocked` 那一族在 `job_failures` 建出来之前，是这些"需要人工介入"的失败项
唯一能被看见的地方。

`audit_log` 没有 `sub_meeting_id` 列，周期性会议的场次写进 `asset_id`（`sub:<id>`）——
只写 `meeting_id` 会让同一 `meeting_id` 下的几场混成一条流。
自由文本统一裁到 64 字符（`asset_type` 是 `VARCHAR(64)`），末尾切在代理对中间时把
半个也去掉，免得一条过长的失败原因把"记账失败"变成"操作失败"。有用例钉这一条。

**3.5 「延长 30 天」就是 30 天，不跟随 `default_retention_days`**

原型里 `m.keep.daysLeft += KEEP_DAYS`（跟随默认天数），但 spec §4.3 的按钮写死是
「延长 30 天」。裁定按 spec：管理员把默认改成 90 之后，一个写着「延长 30 天」的按钮
静静地加 90 天，是按钮上的字与它做的事不一致。要加别的天数，请求体显式给 `days`。

**3.6 路径只有 `meetingId`，场次由请求体给**

保留窗口的键是 `(meeting_id, sub_meeting_id)`，周期性会议同一 `meeting_id` 下有多场。
`subMeetingId` 缺省空串，**不做"猜一场"的兜底**——猜错就是延长了另一场，
而被漏掉的那场照常到期删除，事后完全看不出来。

**3.7 网关不做 NAS 的启动期强校验**

worker 那边 `MDE_ARCHIVE_ROOT` 配错就拒绝启动。网关这边刻意不这么做：其余功能
（取数、授权、审计）与挂载无关，为一张页面拒绝整个网关启动是过度反应。代价被显式挡在两处，
都不静默：

- 没配 `MDE_NAS_ROOT` → `probeNas('')` 返回 `reachable:false` + 一句原因 → 页面显示"NAS 不可达"
- 没配 `MDE_ARCHIVE_ROOT` → `cleanup` 注入 `null` → 清理端点 **503**，
  文案明说是挂载/配置问题，**不是**"没有可清理的文件"

启动时打一条 warn 说明降级了哪两件事。

---

## 4. 与计划不一致 / 超出落点的地方

### 4.1 多建了一个文件：`src/store/console-storage.ts`（新建，非计划落点）

**为什么非建不可。** spec §4.9 要的十一个字段里有四个是整表聚合：
NAS 上"本系统占用"的字节数、已归档场次数、"其中已授权"、"本地占用"。
`ArchivesStore` 里没有对应读法，而它在本任务的禁改清单上。剩下两条路都更差：

- 在 handler 里循环 `listCompletedAssets` + `listArchivedAssetsForMeeting` 逐场累加：
  几百场会议 × 2 次往返的 N+1，而这一页会被反复刷新
- 干脆不报这四个数：那是 spec §4.9 明文要的两块面板里的一半

新建文件与并行任务零冲突（T1 建的是 `console-meetings.ts`），SQL 有 8 条真库用例。
四个数合成一条标量子查询、一次往返——分四条时，中间恰好跑完一轮清理会让"已归档"
与"本地占用"对不上账。

### 4.2 体积口径与 `retention.ts` 有意不同

`retention.ts` 的 `localBytesOf` 用 `meeting_assets.bytes_written` 算"本轮能腾出多少空间"。
但 `store/archives.ts` 自己已经写明 `bytes_written` 是下载器每 8MB 一次的**进度检查点**
——对小文件恒为 0、对大文件停在最后一个 8MB 边界上（写 NAS sidecar 的 `bytes`
用的是 `bytes_expected`，正是为了避开它）。

拿它去显示"本地占用 X GB"会让页面长期显示成接近 0，那是个假数字。所以聚合 store 取
`COALESCE(bytes_expected, bytes_written)`：优先平台声明的字节数，平台没给才回退。

**后果**：`GET /storage` 的 `retention.localBytes` 与 `cleanup-now` 预览里的
`totalBytes` 是两个口径，同一批文件可能报出不同的数。两者不在同一屏上出现，
但这是一笔明账，记在这里。真要统一，正确的方向是把 `retention.ts` 也改成
`bytes_expected` 优先——那是改阶段 2 已验证代码，不在本任务范围。

### 4.3 测试文件位置

计划落点写的是 `tests/http/console-storage.test.ts`（照做了），
但仓库既有约定是 `tests/http/console/auth.test.ts`（子目录）。阶段 4 的其它任务
若也按计划的扁平命名走，收尾时值得把 `console/auth.test.ts` 一起挪平或者反过来收进子目录，
现在两种并存。

### 4.4 `AppDeps` 上加的是 `storage` 一个字段，不是四五个

`AppDeps.archives` 现有那行被收窄成 `Pick<ArchivesStore, 'listArchivedMeetingKeys'>`，
放宽它就是改动现有行（本任务只许追加），所以本任务要的六个 `ArchivesStore` 方法
收在 `storage.archives` 里。合并时如果有别的任务也放宽了那个字段，这里可以顺手合并简化。

### 4.5 改了 `.env.example` 的一行

原文是「归档 worker（bun run worker）。**只有 worker 进程读这几项，网关进程不需要。**」
——本任务之后这句话不成立了（网关也读 `MDE_ARCHIVE_ROOT` / `MDE_NAS_ROOT`）。
留着一句现在是错的说明，比改它风险更大。改成了说清"哪两项网关也读、不配会降级成什么样"。

---

## 5. 两处"两份实现"的账（DONE_WITH_CONCERNS 的来源）

### 5.1 暂停判定的极性 —— 已用测试钉住

`isPaused`（"除了明确说没暂停，一律算暂停"）在 `retention.ts` 里是**私有**函数，
而本任务不改那个文件。响应要回显当前状态，就只能在 handler 里再写一份。
两份漂移的后果很重：页面说"清理正常运行"而清理其实停着（或者反过来），
而这是全系统唯一能拦住不可逆删除的开关。

**钉子**：`tests/http/console-storage.test.ts` 里有一条用例，拿同一批原始值
（`null` / `'0'` / `'1'` / `'true'` / `''` / `' 0'` / `'01'`）**同时**喂给真的
`executeCleanup` 和 handler，逐值比对 `paused`。改动 retention.ts 的极性会让它红。
靠注释叮嘱挡不住漂移，靠这条能。

**将来的正解**：把 `isPaused` 从 `retention.ts` 导出，两处共用一份。那是一个词的改动，
只是它落在本任务的禁改文件上。

### 5.2 `FALLBACK_DEFAULT_RETENTION_DAYS = 30` —— 只能靠注释

`default_retention_days` 没设过时，归档流水线用的是 `archive.ts` 里私有的
`DEFAULT_RETENTION_DAYS = 30`。页面要显示"默认 30 天"，就得在 handler 里再写一份。
它**没有**像 5.1 那样的钉子——那个常量没有导出，也没有一个便宜的行为入口能把它逼出来。

缓解：响应里带 `defaultDaysSource`（`setting` / `fallback` / `invalid`），
让"这是个回退值"这件事本身可见。两处的注释互相点名。
同样，正解是把 `archive.ts` 的常量导出。

**另外**：`archive.ts` 那边是 `retentionSetting ? Number(retentionSetting) : DEFAULT`，
一个 `'abc'` 会让它拿到 `NaN`（而不是回退到 30）。本任务的写端点校验 1..365 的整数，
写不进坏值；读端点遇到坏值报 `defaultDaysSource: 'invalid'` 并把原值一并回给前端，
不悄悄显示成 30 替一个坏掉的配置打掩护。

---

## 6. 验证

```
bun test            871 pass · 0 fail（77 个文件，103s）
bun run typecheck   干净（无输出，退出码 0）
```

本任务新增 39 条：`tests/http/console-storage.test.ts` 31 条（29 条 handler + 2 条路由接线）、
`tests/store/console-storage.test.ts` 8 条真库 SQL。接手时的基线是 832 pass / 0 fail。

路由接线那 2 条是刻意补的：其余用例全是直接调 handler 函数，
路径写错一个字它们照样全绿。那两条走真的 `createApp` 派发，
不带 cookie 时断言 401 而不是 404——401 说明请求确实落到了那个 handler 上。

---

## 7. 留给后续任务的接口

- **T11（调度器）**：`GET /storage` 的 `nas.failedMeetings` 现在恒为 `null`。
  `job_failures` 建好之后，把它换成真实计数、删掉 `failedMeetingsNote` 即可，前端形状不变。
  另外 T11 的"每天 03:00 清理"跑的是同一个 `executeCleanup`，但**不会**走本任务的审计路径
  ——定时任务的留痕归 `job_runs`，别重复记。
- **T9（审计 API）**：本任务写入的 `action` 取值是
  `set_retention_days` / `set_cleanup_paused` / `cleanup_now` / `purge_local` /
  `purge_blocked` / `purge_failed` / `extend_retention`，
  `actor_type='admin'`、`client_kind='console'`、场次在 `asset_id`（`sub:<id>`）、
  自由文本在 `asset_type`。T9 那张"三种 actor 色块"的映射表里，`admin` 归 `person`。
- **前端 F5**：`console/src/api/types.ts` 里没有归档存储页的类型（那份文件只覆盖会议列表那一族）。
  本任务的响应形状因此是新定义的，接 F5 时把它抄进 `types.ts`，不要两边各自演化（阶段 4 §1 第 5 条）。
