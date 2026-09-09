# 周期会议按录制记录拆场次 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `sub_meeting_id` 等于腾讯的 `meeting_record_id`，使周期会议的每个场次成为库里、目录里、授权里各自独立的一场会议，并把存量数据一次性拆开。

**Architecture:** 身份改在源头（`src/tencent/records.ts` 的 `toMeeting`），全库九张表的两段键因此自动按场次分开；引擎的目录 Map 从「按 meeting_id」改成「按 `meetingPathKey(meetingId, subMeetingId)`」，`AssetSource.listAssets` 加第二个位置参数把资产清单收窄到本场次；存量数据由一次性脚本 `scripts/split-recurring-meetings.ts` 搬文件 + 一个事务改六张表，NAS 侧车由从 `src/worker/archive.ts` 抽出来的可复用 `writeNasSidecars` 重写。

**Tech Stack:** Bun + TypeScript（网关 `src/`、引擎 `packages/engine/`、CLI `client/`、控制台 `console/`）、MySQL 8（测试库经 `TEST_DATABASE_URL`，见 `tests/helpers/testdb.ts`）、SQLite（引擎 CLI 宿主）。

**Spec:** `docs/superpowers/specs/2026-09-09-recurring-meetings-by-record-design.md`

## Global Constraints

- 规格是唯一裁定来源：`docs/superpowers/specs/2026-09-09-recurring-meetings-by-record-design.md`。本计划与它冲突时以它为准。
- **不改目录命名规则**（`packages/engine/src/domain/filename.ts` 的 `meetingDirPath` 一个字符都不动），**不改 UTC**（目录名的年月日时分一律 UTC 拆解）。改的只是喂给它的那张 Map。
- `sub_meeting_id === ''` 在**读路径**上继续被容忍（旧 CLI 的 SQLite 库、上线前留下的探测行、控制台旧链接），但**新代码一律不再写入空串**——唯一的例外是 `src/worker/scheduler.ts` 的整轮失败项（`meetingId: null`，那一行根本不是一场会议，见 Task 7）。
- 两个 Store 宿主**同改**：`packages/engine/src/store/index.ts`（SQLite）与 `src/worker/store-mysql.ts`（MySQL）实现同一个 `Store` 接口，只改一边等于让引擎在两个宿主上行为分叉，而且不报错。
- 一次性脚本：**默认 dry-run**，`--apply` 才动手；**可重复跑**（只处理 `sub_meeting_id = ''` 的 `meetings` 行，自消耗）；`--apply` 下出现 `conflict` 或 `undecidable` 以**退出码 2** 结束。
- **绝不删除非空目录**。旧目录搬空了才 `rmdir`，不空就保留并记 `left_over`。
- 凡是按**前缀**改写路径列的 SQL，一律 `LEFT(col, CHAR_LENGTH(?)) = ?` 判前缀、`CONCAT(?, SUBSTRING(col, CHAR_LENGTH(?) + 1))` 换前缀（照抄 `scripts/rename-archive-dirs.ts` 的 `PREFIX_MATCH` / `PREFIX_SWAP`），**绝不用 `LIKE`**（旧目录名里必然有 `_`，那是 LIKE 的单字符通配符），长度一律用 MySQL 的 `CHAR_LENGTH` 而不是 JS 的 `String.length`（主题里可能有 emoji）。本计划的拆分脚本按**行主键整列改写**，用不上前缀匹配；将来要加前缀改写时按这条来。
- 测试**用真 MySQL**（`withTestDb()`，需要 `TEST_DATABASE_URL`），**不 mock 连接池**——唯一的例外是既有的 `brokenTxPool` 模式（造「UPDATE 与 rollback 同时失败」这一种真库造不出来的场景）。
- `migrations/*.sql` 的注释里**不许出现分号**（`runMigrations` 按分号朴素切分语句）。
- 提交信息格式：`feat(scope): 中文一句话` / `fix(scope): …` / `refactor(scope): …` / `docs: …`，结尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 测试命令：网关 `bun test <path>`；引擎 `cd packages/engine && bun test <path>`；类型 `bun run typecheck`（引擎另有 `cd packages/engine && bun run typecheck`）。改了 `packages/engine/src` 之后，如果在 worktree 里跑，先确认 worktree 装了 `node_modules`，否则测试绿的是主工作树的旧引擎（见 memory `worktree-resolves-to-main-engine`）。
- 脚本**只在上线阶段对生产跑**（Task 7 的 runbook），开发期只跑测试库与 `mkdtemp` 出来的临时目录。

---

### Task 1: 场次身份 = meeting_record_id（源头 + 迁移 013）

**Files:**
- Modify: `src/tencent/records.ts:186-207`（`toMeeting`）
- Create: `migrations/013_meeting_cache_sub_meeting_id.sql`
- Test: `tests/tencent/records.test.ts`、`tests/store/migrations.test.ts`
- Modify（跟着改的既有测试）: `tests/http/meetings.test.ts`、`tests/e2e/flow.test.ts`

**Interfaces:**
- Produces: `toMeeting` 产出的 `Meeting.subMeetingId === Meeting.meetingRecordId`（网关 `Meeting`，`src/domain/types.ts`）。这条经 `src/store/meetings.ts` 的 `upsertMany` 原样写进 `meeting_cache.sub_meeting_id`（那里已经写的就是 `m.subMeetingId`，**不用改**），经 `src/worker/source-inproc.ts` 的 `toEngineMeeting` 原样进引擎 `Meeting.subMeetingId`（**签名不用改**），最终由 `discover` 写进 `meetings.sub_meeting_id`。
- Consumes: 无（本计划第一个任务）。

- [ ] **Step 1: 写失败的测试（records 层）**

在 `tests/tencent/records.test.ts` 里，先把 `cached()` 这个 fixture 改成「场次 id 跟着 record id 走」（当前第 68-80 行写死 `subMeetingId: ''`）：

```ts
/** 网关侧的 Meeting——缓存里存的就是这个形状。场次 id 就是 record id（spec §2.1） */
const cached = (o: Partial<Meeting> = {}): Meeting => {
  const meetingRecordId = o.meetingRecordId ?? 'rec-1'
  return {
    meetingId: 'm-1',
    subMeetingId: meetingRecordId,
    meetingRecordId,
    meetingCode: '88123456',
    subject: '评审',
    hostUserId: 'tm-alice',
    startTime: 1767225600,
    endTime: 1767229200,
    state: 'completed',
    ...o,
  }
}
```

再在文件末尾加一条新用例：

```ts
test('场次 id = meeting_record_id：同一个 meeting_id 的两条录制记录是两场会议', async () => {
  const { client } = stubClient([
    onePage([
      { ...corpMeeting, meeting_record_id: 'rec-1', meeting_id: 'm-1', media_start_time: 1767225600000 },
      { ...corpMeeting, meeting_record_id: 'rec-2', meeting_id: 'm-1', media_start_time: 1767312000000 },
    ]),
  ])
  const api = createRecordsApi(client, 'admin', memCache())
  const ms = await api.listMeetings({ kind: 'range', from: 0, to: 1_800_000_000 }, NOW)

  expect(ms.map((m) => m.subMeetingId)).toEqual(['rec-1', 'rec-2'])
  // 单次会议不是特例：它也只有一条记录，规则统一
  expect(ms.every((m) => m.subMeetingId === m.meetingRecordId)).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tencent/records.test.ts`
Expected: FAIL —— 新用例得到 `['', '']`，且 `cached()` 相关的两条用例（第 285-291 行「缓存命中零 API 调用」）因为 fixture 变了而对不上。

- [ ] **Step 3: 改 toMeeting**

`src/tencent/records.ts` 的 `toMeeting`（约第 199 行）：

```ts
  return {
    meetingId: r.meeting_id,
    // 场次 id 就是这条录制记录自己的 id（spec §2.1）。周期会议的每一场各有一条
    // record，单次会议也只有一条——规则统一，没有「周期会议才拆」这种特例。
    // 平台**没有** sub_meeting_id 这个字段，这一列的含义由我们定，定的就是它。
    subMeetingId: r.meeting_record_id,
    meetingRecordId: r.meeting_record_id,
    meetingCode: r.meeting_code,
    subject: r.subject,
    hostUserId: r.userid,
    startTime: msToSec(r.media_start_time),
    endTime: meetingEndTime(r),
    state: STATE_MAP[r.state] ?? 'recording',
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/tencent/records.test.ts tests/store/meetings.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败的测试（迁移 013）**

在 `tests/store/migrations.test.ts` 的 `describe('runMigrations', …)` 里加：

```ts
  test('013 把 meeting_cache 里的空 sub_meeting_id 回填成 meeting_record_id', async () => {
    const { pool, cleanup } = await withTestDb()
    try {
      // 造一行上线之前的数据：sub_meeting_id 是空串
      await pool.execute(
        `INSERT INTO meeting_cache
           (meeting_record_id, meeting_id, sub_meeting_id, meeting_code, subject,
            host_user_id, start_time, end_time, state, updated_at)
         VALUES ('rec-old', 'm-old', '', '881', '旧数据', 'u', 1000, 2000, 'completed', 1)`,
      )
      const { runMigrations } = await import('../../src/store/db')
      await runMigrations(pool)

      const [rows] = await pool.query<any[]>(
        `SELECT sub_meeting_id FROM meeting_cache WHERE meeting_record_id = 'rec-old'`,
      )
      expect(rows[0].sub_meeting_id).toBe('rec-old')

      // 幂等：再跑一次不会把已经回填过的行改坏
      await runMigrations(pool)
      const [again] = await pool.query<any[]>(
        `SELECT sub_meeting_id FROM meeting_cache WHERE meeting_record_id = 'rec-old'`,
      )
      expect(again[0].sub_meeting_id).toBe('rec-old')
    } finally {
      await cleanup()
    }
  })
```

- [ ] **Step 6: 跑测试确认失败**

Run: `bun test tests/store/migrations.test.ts`
Expected: FAIL —— `expect(received).toBe('rec-old')`，实际是 `''`。

- [ ] **Step 7: 写迁移 013**

新建 `migrations/013_meeting_cache_sub_meeting_id.sql`（注释里不许有分号）：

```sql
-- 场次身份回填：sub_meeting_id = meeting_record_id（spec 2026-09-09 §2.1）。
--
-- meeting_cache 的主键本来就是 meeting_record_id，也就是说这张表**一直**是按场次
-- 存的，只有 sub_meeting_id 这一列写着上线之前的空串。这条 UPDATE 把那一列的含义
-- 与主键对齐，之后 src/tencent/records.ts 写进来的新行本身就带着 record id。
--
-- 放进迁移而不是放进一次性脚本，是因为它**没有文件副作用**，所有环境（本机、测试库、
-- 服务器）都要跑，而且幂等——WHERE 把已经回填过的行排除在外，重复执行是空操作。
UPDATE meeting_cache SET sub_meeting_id = meeting_record_id WHERE sub_meeting_id = '';
```

- [ ] **Step 8: 跑测试确认通过**

Run: `bun test tests/store/migrations.test.ts`
Expected: PASS

- [ ] **Step 9: 修既有测试里被这条身份变更打翻的授权行**

`meeting_grants` / `meeting_overrides` 都按**精确的** `(meeting_id, sub_meeting_id)` 查（`src/store/grants.ts:301`、`:361`），所以凡是「假腾讯响应 + 真授权行」的用例，授权行的 sub 必须跟着变成那条记录的 record id，否则判定会变成「一条授权都没有」。

`tests/http/meetings.test.ts`：给全部 10 处 `insertGrant(pool, …)` 补上 `subMeetingId`。fixture 里 `meeting_id: 'm-X'` 对应 `meeting_record_id: 'rec-X'`，逐条对应：

```ts
  await insertGrant(pool, { meetingId: 'm-a-1', subMeetingId: 'rec-a-1', programId: 'prog-alice-1' })
  await insertGrant(pool, { meetingId: 'm-b-1', subMeetingId: 'rec-b-1', programId: 'prog-alice-1' })
  await insertGrant(pool, { meetingId: 'm-a-2', subMeetingId: 'rec-a-2', programId: 'prog-alice-2' })
  await insertGrant(pool, { meetingId: 'm-b-2', subMeetingId: 'rec-b-2', programId: 'prog-alice-2' })
  await insertGrant(pool, { meetingId: 'm-kate-1', subMeetingId: 'rec-kate-1', programId: 'prog-kate-1' })
  await insertGrant(pool, { meetingId: 'm-e-1', subMeetingId: 'rec-e-1', programId: 'prog-erin-1' })
  await insertGrant(pool, { meetingId: 'm-e-2', subMeetingId: 'rec-e-2', programId: 'prog-erin-1' })
  await insertGrant(pool, { meetingId: 'm-g-1', subMeetingId: 'rec-g-1', programId: 'prog-grace-1' })
  await insertGrant(pool, { meetingId: 'm-i-1', subMeetingId: 'rec-i-1', programId: 'prog-ivan-1' })
  await insertGrant(pool, { meetingId: 'm-l-2', subMeetingId: 'rec-l-2', programId: 'prog-lena-1' })
```

`tests/e2e/flow.test.ts`：`grantMeeting` 加第三个**必填**参数（必填而不是可选，让编译器盯着每一个调用点）：

```ts
async function grantMeeting(
  meetingId: string,
  programId: string,
  subMeetingId: string,
): Promise<void> {
  await createGrantsStore(pool).grant({
    meetingId,
    // 场次 id = record id（spec §2.1）。授权挂在**场次**上，挂在空串上等于挂在一场
    // 不存在的会议上——判定会安静地变成「没有授权」
    subMeetingId,
    programId,
    assetTypes: null,
    now: NOW * 1000,
  })
}
```

调用点逐条补（每处所在用例里都已经有 `meetingRecordId` 变量或字面量）：

```ts
  await grantMeeting(meetingId, 'prog-e2e-full-1', meetingRecordId)     // 第 481 行
  await grantMeeting(meetingId, 'prog-e2e-deny-1', meetingRecordId)     // 第 686 行
  await grantMeeting(meetingId, 'prog-e2e-ovr-1', meetingRecordId)      // 第 772 行
  await grantMeeting(meetingId, 'prog-e2e-sts-1', meetingRecordId)      // 第 876 行
  await grantMeeting('m-e2e-multi-1', 'prog-e2e-multi-1', 'rec-e2e-multi-1')   // 第 950 行
  await grantMeeting('m-e2e-multi-2', 'prog-e2e-multi-1', 'rec-e2e-multi-2')   // 第 951 行
  for (let i = 0; i < hosts.length; i++) {
    await grantMeeting('m-e2e-corp-' + i, 'prog-e2e-corp-1', 'rec-e2e-corp-' + i)  // 第 1104 行
  }
  await grantMeeting('m-e2e-exact-1', 'prog-e2e-exact-1', 'rec-e2e-exact-1')   // 第 1160 行
```

同一文件第 796 行那处 `putOverride`（「管理员按下『这场不许取』」）同样把 `subMeetingId: ''` 改成 `subMeetingId: meetingRecordId`。

- [ ] **Step 10: 跑测试确认通过**

Run: `bun test tests/tencent tests/store tests/http/meetings.test.ts tests/e2e/flow.test.ts`
Expected: PASS

- [ ] **Step 11: 提交**

```bash
git add src/tencent/records.ts migrations/013_meeting_cache_sub_meeting_id.sql \
        tests/tencent/records.test.ts tests/store/migrations.test.ts \
        tests/http/meetings.test.ts tests/e2e/flow.test.ts
git commit -m "$(cat <<'EOF'
feat(records): 场次 id 取 meeting_record_id，meeting_cache 同步回填

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 目录 Map 改两段键（两个 Store 宿主 + 执行器 + 清单）

**Files:**
- Modify: `packages/engine/src/domain/types.ts`（末尾加 `meetingPathKey`）
- Modify: `packages/engine/src/store/index.ts:213-222`（接口声明 + SQLite 实现）
- Modify: `src/worker/store-mysql.ts:302-326`（MySQL 实现）
- Modify: `packages/engine/src/executor/index.ts:10-20, 60-67`（`ExecutorDeps` + `buildRelPath`）
- Modify: `packages/engine/src/manifest/index.ts:187-217`（`writeMeetingManifests` 遍历）
- Modify: `src/worker/index.ts:196-236`、`client/src/cli/commands/get.ts:20-21`、`client/src/cli/commands/run.ts:22-31`、`client/src/cli/commands/execute.ts:14-23`（宿主接线）
- Test: `packages/engine/tests/store/index.test.ts`、`tests/worker/store-mysql.test.ts:500-543`、`packages/engine/tests/executor/index.test.ts`、`packages/engine/tests/manifest/index.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Meeting.subMeetingId = record id`（`meetings` 表里因此开始出现同 `meeting_id` 多行）。
- Produces:
  - `meetingPathKey(meetingId: string, subMeetingId: string): string`（从 `@yaowu/mde-engine` 导出，`packages/engine/src/index.ts` 第 1 行的 `export * from './domain/types'` 自动带出）。
  - `Store.meetingsForPaths(): Promise<Map<string, MeetingPathRow>>`，键 = `meetingPathKey(...)`，值 = `{ meetingId: string; subMeetingId: string; subject: string | null; startTime: number | null; meetingCode: string | null; endTime: number | null }`。
  - `ExecutorDeps.meetingsByPathKey`（**改名**，原 `meetingsById`），类型同上。
  - `writeMeetingManifests(deps, meetings: ReadonlyMap<string, { meetingId: string; subMeetingId: string }>, now)`。

- [ ] **Step 1: 写失败的测试（引擎 SQLite store）**

`packages/engine/tests/store/index.test.ts` 顶部加 import，并在 `getMeeting` 那条用例之前插入两条：

```ts
import { meetingPathKey } from '../../src/domain/types'

test('meetingsForPaths 按 (meeting_id, sub_meeting_id) 建键：周期会议每个场次各一项', async () => {
  const s = fresh()
  await s.upsertMeeting({ ...M, subMeetingId: 'rec-1', subject: '第一场', startTime: 1000 }, 1)
  await s.upsertMeeting({ ...M, subMeetingId: 'rec-2', subject: '第二场', startTime: 2000 }, 1)

  const map = await s.meetingsForPaths()
  expect(map.size).toBe(2)                       // 不再塌成一条
  expect(map.get(meetingPathKey('m1', 'rec-1'))).toEqual({
    meetingId: 'm1', subMeetingId: 'rec-1', subject: '第一场',
    startTime: 1000, meetingCode: '88', endTime: 200,
  })
  expect(map.get(meetingPathKey('m1', 'rec-2'))!.startTime).toBe(2000)
})

test('meetingsForPaths 仍认得空 sub_meeting_id 的旧行（旧 SQLite 库的兼容口径）', async () => {
  const s = fresh()
  await s.upsertMeeting(M, 1)                    // M.subMeetingId === ''
  const map = await s.meetingsForPaths()
  expect(map.get(meetingPathKey('m1', ''))!.meetingId).toBe('m1')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/engine && bun test tests/store/index.test.ts`
Expected: FAIL —— `meetingPathKey` 不存在（TS 报错），且 `map.size` 是 1。

- [ ] **Step 3: 加 meetingPathKey 并改两个 Store 宿主**

`packages/engine/src/domain/types.ts` 末尾（`MeetingSelector` 之后）加：

```ts
/**
 * 会议目录 Map 的键：`meeting_id` + `\u0000` + `sub_meeting_id`。
 *
 * 分隔符与 `src/store/archives.ts` 的 `archiveStateKey`、`src/worker/archive.ts` 的
 * `overrideKey` 是同一个，理由也同一条：两段都是平台给的字符串，用可打印字符分隔会让
 * `("a:b", "")` 与 `("a", "b")` 撞成同一个键，而 `\u0000` 在任何一段里都不会出现。
 *
 * 它取代的是「只按 meeting_id 建 Map」——周期会议各场次共享 meeting_id、start_time
 * 各不相同，而 start_time 进目录名，于是所有场次的文件会落进某一场次的目录里
 * （2026-09-09 之前的行为，src/worker/store-mysql.ts 的注释承认过这个洞）。
 */
export function meetingPathKey(meetingId: string, subMeetingId: string): string {
  return `${meetingId}\u0000${subMeetingId}`
}
```

`packages/engine/src/store/index.ts`，接口声明（原第 213-222 行那段注释保留，签名与实现改成）：

```ts
  /**
   * 拼落盘路径要用的会议元数据，键为 `meetingPathKey(meeting_id, sub_meeting_id)`。
   *
   * 键是两段的，不是 meeting_id：周期会议的每个场次各有自己的 start_time，也就各有
   * 自己的目录。值里带回 `meetingId` / `subMeetingId` 两段原文，调用方（executor 拼
   * 路径、manifest 逐场写 sidecar）因此不必再去拆键。
   *
   * 新增这个方法不是顺手加功能——`client/src/cli/commands/{run,execute}.ts` 各有一份
   * **逐字重复**的 `loadMeetings(db)`，都绕过 Store 直接查 SQLite 的 `db`，且全程 `any`。
   * 那条路在 MySQL 宿主下根本不存在，必须收进接口。
   */
  meetingsForPaths(): Promise<Map<string, MeetingPathRow>>
```

并在文件顶部（`ProbeKey` 之后）加类型，两个宿主共用：

```ts
/** `meetingsForPaths()` 的值：拼目录名要的三列，加上两段主键原文 */
export interface MeetingPathRow {
  meetingId: string
  subMeetingId: string
  subject: string | null
  startTime: number | null
  meetingCode: string | null
  endTime: number | null
}
```

SQLite 实现（同文件，替换原 `meetingsForPaths`）：

```ts
    async meetingsForPaths() {
      const rows = db.query<{ meeting_id: string; sub_meeting_id: string; subject: string | null;
                              meeting_code: string | null; start_time: number | null; end_time: number | null }, []>(
        `SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time FROM meetings`,
      ).all()
      return new Map(rows.map((r) => [meetingPathKey(r.meeting_id, r.sub_meeting_id), {
        meetingId: r.meeting_id, subMeetingId: r.sub_meeting_id,
        subject: r.subject, startTime: r.start_time, meetingCode: r.meeting_code,
        endTime: r.end_time,
      }]))
    },
```

顶部 import 补上 `meetingPathKey`：

```ts
import { meetingPathKey, type Meeting, type AssetStatus, type ProbeState } from '../domain/types'
```

`src/worker/store-mysql.ts`（替换原第 302-326 行整段，连同那段「后行覆盖是个洞」的注释一起换掉）：

```ts
    /**
     * 键是 `meetingPathKey(meeting_id, sub_meeting_id)`，与 SQLite 宿主逐字同构。
     *
     * 2026-09-09 之前这里的键只有 meeting_id，后一行覆盖前一行——周期会议各场次共享
     * meeting_id、start_time 各不相同，而 start_time 进目录名，于是**所有场次的文件
     * 落进某一场次的目录**。那个洞随 sub_meeting_id = meeting_record_id 一起补掉。
     *
     * ORDER BY 留着：它让行序确定，出问题时两个宿主的输出可以逐行对。
     */
    async meetingsForPaths() {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT meeting_id, sub_meeting_id, subject, meeting_code, start_time, end_time
           FROM meetings ORDER BY meeting_id, sub_meeting_id`,
      )
      return new Map(rows.map((r) => [
        meetingPathKey(r.meeting_id as string, r.sub_meeting_id as string),
        {
          meetingId: r.meeting_id as string,
          subMeetingId: r.sub_meeting_id as string,
          subject: (r.subject ?? null) as string | null,
          startTime: r.start_time === null ? null : Number(r.start_time),
          meetingCode: (r.meeting_code ?? null) as string | null,
          endTime: r.end_time === null ? null : Number(r.end_time),
        },
      ]))
    },
```

`src/worker/store-mysql.ts` 顶部的引擎 import 加上 `meetingPathKey`（该文件第 3 行已经在从 `@yaowu/mde-engine` 引类型，`meetingPathKey` 是**值**，要另起一条 `import { meetingPathKey } from '@yaowu/mde-engine'`）。

`packages/engine/src/index.ts` 第 7 行把新类型带出去（`meetingPathKey` 本身由第 1 行的 `export * from './domain/types'` 自动带出，不用改）：

```ts
export type { Store, AssetRow, AssetUpsert, MeetingPathRow, ProbeRow, ProbeKey, ProbeUpsert } from './store'
```

- [ ] **Step 4: 跑测试确认通过（引擎侧）**

Run: `cd packages/engine && bun test tests/store/index.test.ts`
Expected: PASS

- [ ] **Step 5: 改 MySQL 宿主的那两条用例**

`tests/worker/store-mysql.test.ts`：第 500-517 行那条「meetingsForPaths 返回按 meeting_id 索引的会议元数据」与第 530-543 行那条「sub_meeting_id 最大的一条胜出」，一起换成：

```ts
  test('meetingsForPaths 按 (meeting_id, sub_meeting_id) 建键，值里带回两段原文', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertMeeting({
        meetingId: 'm2', subMeetingId: 's1', meetingCode: null, subject: null,
        hostUserId: null, startTime: null, endTime: null,
      }, 100)
      const map = await s.meetingsForPaths()
      expect(map.size).toBe(2)
      expect(map.get(meetingPathKey('m1', ''))).toEqual({
        meetingId: 'm1', subMeetingId: '', subject: '周会',
        startTime: 1000, meetingCode: '881', endTime: 2000,
      })
      expect(map.get(meetingPathKey('m2', 's1'))).toEqual({
        meetingId: 'm2', subMeetingId: 's1', subject: null,
        startTime: null, meetingCode: null, endTime: null,
      })
    })
  })

  /**
   * 2026-09-09 之前这里钉的是「同 meeting_id 多 sub_meeting 时 sub_meeting_id 最大的
   * 一条胜出」——那是个洞：周期会议的所有场次会共用胜出那一场的目录。现在钉的是补好
   * 之后的行为：两个场次各一项，各自带着自己的 start_time（也就是各自的目录）。
   */
  test('meetingsForPaths 同 meeting_id 多场次时各成一项，不再互相覆盖', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      // 故意先插 'rec-2' 再插 'rec-1'，插入顺序与键序相反，塌成一条时立刻看得出来
      await s.upsertMeeting({ ...M, subMeetingId: 'rec-2', subject: '第二场', startTime: 2000 }, 100)
      await s.upsertMeeting({ ...M, subMeetingId: 'rec-1', subject: '第一场', startTime: 1000 }, 100)

      const map = await s.meetingsForPaths()
      expect(map.size).toBe(2)
      expect(map.get(meetingPathKey('m1', 'rec-1'))!.subject).toBe('第一场')
      expect(map.get(meetingPathKey('m1', 'rec-1'))!.startTime).toBe(1000)
      expect(map.get(meetingPathKey('m1', 'rec-2'))!.subject).toBe('第二场')
      expect(map.get(meetingPathKey('m1', 'rec-2'))!.startTime).toBe(2000)
    })
  })
```

同文件第 78-84 行那条「upsertMeeting 二次投递更新元数据而不新增行」里的 `map.get('m1')` 改成 `map.get(meetingPathKey('m1', ''))`；顶部 import 加 `import { meetingPathKey } from '@yaowu/mde-engine'`。

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test tests/worker/store-mysql.test.ts`
Expected: PASS

- [ ] **Step 7: 执行器按两段键查（先改测试）**

`packages/engine/tests/executor/index.test.ts` 里全部 6 处 `meetingsById: new Map([['m1', { subject: 's', startTime: 100 }]])`（第 13、26、36、69、104、138 行）改成：

```ts
      meetingsByPathKey: new Map([[meetingPathKey('m1', ''), {
        meetingId: 'm1', subMeetingId: '', subject: 's',
        startTime: 100, meetingCode: null, endTime: null,
      }]]),
```

（顶部 `import { meetingPathKey } from '../../src/domain/types'`。这些 `deps` 是 `any`，改名本身不会有编译错误——**必须**靠这一步的断言变红来证明改动生效。）

并加一条新用例，钉住「两个场次落两个目录」：

```ts
test('两个场次各落各的目录：buildRelPath 按 (meeting_id, sub_meeting_id) 查', async () => {
  const s = fresh()
  await s.upsertMeeting({ meetingId: 'm1', subMeetingId: 'rec-1', meetingCode: '881', subject: 's', hostUserId: 'h', startTime: 0, endTime: 0 }, 1)
  await s.upsertMeeting({ meetingId: 'm1', subMeetingId: 'rec-2', meetingCode: '881', subject: 's', hostUserId: 'h', startTime: 86400, endTime: 86400 }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: 'rec-1', assetType: 'meeting_summary', remoteId: 'r1', fileType: 'txt' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: 'rec-2', assetType: 'meeting_summary', remoteId: 'r2', fileType: 'txt' }, 1)

  const paths: string[] = []
  const deps: any = {
    store: s,
    download: async (t: any) => { paths.push(t.relPath); return { status: 'completed', contentHash: null, bytesWritten: 1 } },
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: await s.meetingsForPaths(),
  }
  await runExecutor(deps, { concurrency: 1, leaseSec: 60 }, () => 1)

  // 两个目录，且各自的文件名都不带 _2 后缀——分组变小之后同类只剩一个
  expect(paths.sort()).toEqual([
    '1970/01/1970-01-01_0000_881/transcript.txt',
    '1970/01/1970-01-02_0000_881/transcript.txt',
  ])
})
```

- [ ] **Step 8: 跑测试确认失败**

Run: `cd packages/engine && bun test tests/executor/index.test.ts`
Expected: FAIL —— 既有用例全部 `skipped: meeting_meta_missing`（`meetingsById` 这个字段名已经没人读了），新用例拿到两条相同路径或空数组。

- [ ] **Step 9: 改执行器**

`packages/engine/src/executor/index.ts`：

```ts
import { GATEWAY_TYPE_TO_ASSET_KEY, assetKeyToFilename, isTextAssetType, ASSET_WAIT_CAP_SEC, meetingPathKey } from '../domain/types'
import type { MeetingPathRow, Store, AssetRow } from '../store'

export interface ExecutorDeps {
  store: Store
  download: (task: DownloadTask, onProgress: (b: number) => void) => Promise<DownloadResult>
  storage: Pick<Storage, 'ensureFreeSpace' | 'writeMeta'>
  gw: Pick<AssetSource, 'listAssets'>
  /**
   * `Store.meetingsForPaths()` 的返回值，键是 `meetingPathKey(meeting_id, sub_meeting_id)`。
   * 字段名不叫 meetingsById 了——键不再是 meeting_id，叫那个名字会让下一个读代码的人
   * 按 `get(row.meeting_id)` 写，而那句在周期会议上永远查不到、静默把资产判成
   * meeting_meta_missing。
   */
  meetingsByPathKey: Map<string, MeetingPathRow>
}
```

`buildRelPath`：

```ts
async function buildRelPath(deps: ExecutorDeps, row: AssetRow): Promise<string | null> {
  // 按两段键查：周期会议各场次共享 meeting_id，只按它查会拿到别的场次的 start_time，
  // 于是这一场的文件落进另一场的目录
  const m = deps.meetingsByPathKey.get(meetingPathKey(row.meeting_id, row.sub_meeting_id))
  if (!m) return null
  const key = GATEWAY_TYPE_TO_ASSET_KEY[row.asset_type] ?? (row.asset_type as any)
  const { ordinal } = await deps.store.siblingRank(row)
  const fname = assetKeyToFilename(key, row.remote_id, row.file_type, ordinal)
  return `${meetingDirPath(m, row.meeting_id)}/${fname}`
}
```

（`meetingDirPath(m, …)` 收的是 `MeetingDirInfo`，`MeetingPathRow` 多带两个字段，结构上满足，不用改 `filename.ts`。）

- [ ] **Step 10: 跑测试确认通过**

Run: `cd packages/engine && bun test tests/executor/index.test.ts`
Expected: PASS

- [ ] **Step 11: 清单遍历改成按场次（先改测试）**

`packages/engine/tests/manifest/index.test.ts`：第 53-56 行 `downloadAll` 里的 `const meetingsById = await store.meetingsForPaths()` 与 `deps` 字段改名：

```ts
  const meetingsByPathKey = await store.meetingsForPaths()
  const relPaths: string[] = []
  const deps = {
    store, gw: {}, meetingsByPathKey,
```

第 216、233、395 行三处传给 `writeMeetingManifests` 的变量同样改名（传的仍然是 `await store.meetingsForPaths()`，只是名字跟着变）。并加一条新用例：

```ts
test('一轮收尾按场次各写一份 sidecar：同 meeting_id 的两场各有自己的目录', async () => {
  const store = await seeded()                       // m1 / sub ''，已下载
  await store.upsertMeeting({ ...MEETING, subMeetingId: 'rec-2', meetingCode: '881-123-40', subject: '第二场', startTime: (MEETING.startTime ?? 0) + 86400 }, 1)
  await store.upsertAsset({ meetingId: MEETING.meetingId, subMeetingId: 'rec-2', assetType: 'meeting_summary', remoteId: 'r-2', fileType: 'txt' }, 1)
  await downloadAll(store)
  const storage = fakeStorage()

  const r = await writeMeetingManifests(
    { store, storage, generatedBy: 'mde-worker' }, await store.meetingsForPaths(), () => 5000,
  )

  expect(r.written).toBe(2)                          // 两场各一份，不是一场
  const dirs = [...storage.writes.keys()].filter((k) => k.endsWith('/meeting.json')).sort()
  expect(dirs).toHaveLength(2)
})
```

- [ ] **Step 12: 跑测试确认失败**

Run: `cd packages/engine && bun test tests/manifest/index.test.ts`
Expected: FAIL —— `writeMeetingManifests` 的 `meetings` 形参类型是 `ReadonlyMap<string, { subMeetingId: string }>`，它把键当 meetingId 用，第二场拿不到自己的键；`r.written` 为 1。

- [ ] **Step 13: 改 writeMeetingManifests**

`packages/engine/src/manifest/index.ts`（替换原第 187-217 行的注释与函数）：

```ts
/**
 * 一轮的收尾：对给定的每场会议写一次 sidecar，逐会议做错误隔离。
 *
 * `meetings` 直接收 `Store.meetingsForPaths()` 的返回值——**刻意与 executor 拼落盘
 * 路径时用的是同一张 Map**：目录由它算出，清单也就该按它枚举，两边同源才谈得上
 * 「sidecar 和资产在同一个目录」。那张 Map 现在按 `(meeting_id, sub_meeting_id)`
 * 建键，所以周期会议的每个场次各拿到自己的 sidecar（2026-09-09 之前只有胜出的
 * 那个场次有，那是与 executor 一起的同一个洞，已经补掉）。
 *
 * 遍历的是 **values**，两段主键从值里取：键是 `meetingPathKey` 拼出来的，拆键还原
 * 等于把编码规则又实现一遍。
 *
 * 写 sidecar 失败**不能让整轮挂掉**：资产已经落盘了，一份没写出来的清单不该把一轮
 * 成功的下载变成失败。但也**不许静默吞掉**——照 executor 里进度回写失败的先例，
 * 留一行 warn，并把次数计进返回值让宿主打出来。
 */
export async function writeMeetingManifests(
  deps: ManifestDeps,
  meetings: ReadonlyMap<string, { meetingId: string; subMeetingId: string }>,
  now: () => number,
): Promise<ManifestRoundOutcome> {
  const out: ManifestRoundOutcome = { written: 0, unchanged: 0, skipped: 0, failed: 0 }
  for (const m of meetings.values()) {
    try {
      const r = await writeMeetingManifest(deps, m.meetingId, m.subMeetingId, now())
      out[r]++
    } catch (err) {
      out.failed++
      console.warn(`manifest write failed for meeting=${m.meetingId} subMeeting=${m.subMeetingId}: ${err}`)
    }
  }
  return out
}
```

- [ ] **Step 14: 跑测试确认通过**

Run: `cd packages/engine && bun test`
Expected: PASS（引擎全绿）

- [ ] **Step 15: 四个宿主接线改名**

`src/worker/index.ts` 第 196-236 行：局部变量 `meetingsById` 改名 `meetingsByPathKey`，`execDeps` 里的字段名同改，并把第 220-224 行那段「继承了按 meeting_id 去重的已知窟窿」的注释改成：

```ts
  // 枚举源用 meetingsByPathKey 而不是归档那边的 listMeetingsNeedingArchive()：sidecar
  // 描述的是**本地归档区里那个目录**，而那个目录正是它算出来的，两边必须同源，否则
  // 清单会落到一个没有资产的目录里。这张 Map 现在按 (meeting_id, sub_meeting_id)
  // 建键，周期会议的每个场次各写各的 sidecar。
```

`client/src/cli/commands/get.ts`、`run.ts`、`execute.ts`：三处 `const meetingsById = await store.meetingsForPaths()` 与 `deps` 里的字段、以及 `run.ts:31` / `execute.ts:23` 传给 `writeMeetingManifests` 的实参，一律改名 `meetingsByPathKey`（三个文件各 2-3 处）。

- [ ] **Step 16: 类型与测试全绿**

Run: `bun run typecheck && cd packages/engine && bun run typecheck`
Expected: PASS（`meetingsById` 一处都不剩；`grep -rn "meetingsById" src client packages` 只应命中 `src/worker/source-inproc.ts` 里那个同名的**局部函数**）

Run: `bun test tests/worker && cd packages/engine && bun test`
Expected: PASS

- [ ] **Step 17: 提交**

```bash
git add packages/engine/src client/src src/worker/store-mysql.ts src/worker/index.ts \
        packages/engine/tests tests/worker/store-mysql.test.ts
git commit -m "$(cat <<'EOF'
feat(engine): 目录 Map 改两段键，每个场次落自己的目录与清单

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 资产清单按场次收窄（引擎 → 两个 AssetSource → 公开 API）

**Files:**
- Modify: `packages/engine/src/source/types.ts:30-35`（`AssetSource.listAssets` 加第二个位置参数）
- Modify: `packages/engine/src/discovery/index.ts:18`、`packages/engine/src/executor/index.ts:90-92`（`runProbes`）
- Modify: `src/worker/source-inproc.ts:88-95`
- Modify: `client/src/gateway/client.ts:70-76`
- Modify: `src/http/handlers/meetings.ts:164-245`（两个端点加可选 query `sub_meeting_id`）
- Test: `packages/engine/tests/discovery/index.test.ts`、`tests/worker/source-inproc.test.ts`、`tests/http/meetings.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Meeting.subMeetingId = meetingRecordId`；Task 2 的两段键 Map。
- Produces:
  - `AssetSource.listAssets(meetingId: string, subMeetingId: string, from?: number, to?: number): Promise<SourceAsset[]>`（两个实现同签名：`src/worker/source-inproc.ts`、`client/src/gateway/client.ts`）。
  - HTTP：`GET /api/v1/meetings/:meetingId?sub_meeting_id=&from=&to=` 与 `GET /api/v1/meetings/:meetingId/assets?sub_meeting_id=&from=&to=`；命中不到该 `meetingRecordId` 时 404 `meeting_not_found_in_range`。

- [ ] **Step 1: 写失败的测试（进程内实现的收窄）**

`tests/worker/source-inproc.test.ts` 第 100 行附近那条「多条记录并起来」的用例之后加两条：

```ts
test('listAssets 按场次收窄：只要 meetingRecordId 等于 subMeetingId 的那一条记录', async () => {
  const second = { ...GW_MEETING, subMeetingId: 'rec2', meetingRecordId: 'rec2' }
  const src = createInProcSource({
    recordsApi: { listMeetings: async () => [GW_MEETING, second] },
    catalog: {
      listAssets: async (m: any) => [{ ...GW_ASSET, subMeetingId: m.subMeetingId, recordFileId: `f-${m.subMeetingId}` }],
      resolveDownloadUrl: async () => ({ url: 'https://x', expiresAt: 0 }),
    } as any,
    now: () => 0,
  })

  const only = await src.listAssets(GW_MEETING.meetingId, 'rec2')
  expect(only.map((a) => a.remoteId)).toEqual(['f-rec2'])
})

test('listAssets 的 subMeetingId 为空串时保留全部记录（旧库与旧探测行的兼容口径）', async () => {
  const second = { ...GW_MEETING, subMeetingId: 'rec2', meetingRecordId: 'rec2' }
  const src = createInProcSource({
    recordsApi: { listMeetings: async () => [GW_MEETING, second] },
    catalog: {
      listAssets: async (m: any) => [{ ...GW_ASSET, subMeetingId: m.subMeetingId, recordFileId: `f-${m.subMeetingId}` }],
      resolveDownloadUrl: async () => ({ url: 'https://x', expiresAt: 0 }),
    } as any,
    now: () => 0,
  })

  expect((await src.listAssets(GW_MEETING.meetingId, '')).map((a) => a.remoteId)).toHaveLength(2)
})
```

（文件里既有的 `GW_MEETING` 用 `subMeetingId: 's1'`；把它的 `meetingRecordId` 也设成 `'s1'`，与 Task 1 的口径一致。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/worker/source-inproc.test.ts`
Expected: FAIL —— 第二个位置参数当成了 `from`（数字位收到字符串），两条用例都拿到 2 条资产。

- [ ] **Step 3: 改接口与两个实现**

`packages/engine/src/source/types.ts`：

```ts
export interface AssetSource {
  listMeetings(sel: MeetingSelector, cursor?: string, limit?: number): Promise<{ meetings: Meeting[]; nextCursor: string | null }>
  /**
   * 一场**会议场次**的资产清单。
   *
   * `subMeetingId` 是第二个位置参数而不是可选项：同一个 meeting_id 下可能有好几条
   * 录制记录（周期会议），不收窄的话每个场次都会把全部场次的资产各存一份。
   * **空串 = 不收窄**（旧 CLI 的 SQLite 库、上线之前留下的探测行），这条兼容口径
   * 会随存量数据自然消失。
   */
  listAssets(meetingId: string, subMeetingId: string, from?: number, to?: number): Promise<SourceAsset[]>
  getDownloadUrl(assetId: string): Promise<DownloadUrl>
}
```

`src/worker/source-inproc.ts` 的 `listAssets`：

```ts
    async listAssets(meetingId, subMeetingId, from, to) {
      const out: SourceAsset[] = []
      for (const m of await meetingsById(meetingId, from, to)) {
        // 场次收窄（spec §2.2）：sub 给了就只要那一条录制记录。反查按 meeting_id 走，
        // 周期会议会命中多条，全都列进来的话每个场次都会存下全部场次的资产。
        // 空串保留全部——旧库与旧探测行的兼容口径。
        if (subMeetingId !== '' && m.meetingRecordId !== subMeetingId) continue
        for (const a of await deps.catalog.listAssets(m)) out.push(toSourceAsset(a))
      }
      return out
    },
```

`client/src/gateway/client.ts` 的 `listAssets`：

```ts
    async listAssets(meetingId, subMeetingId, from, to) {
      const q = new URLSearchParams()
      // 空串不带这个参数：网关那边「没给」= 取最新一条，与旧客户端的行为一致
      if (subMeetingId) q.set('sub_meeting_id', subMeetingId)
      if (from) q.set('from', String(from)); if (to) q.set('to', String(to))
      const res = await authed(`/api/v1/meetings/${encodeURIComponent(meetingId)}/assets?${q}`)
      if (!res.ok) return parseError(res)
      const b = (await res.json()) as { assets: RawAsset[] }
      return b.assets.map((a) => ({ assetId: a.asset_id, assetType: a.asset_type, remoteId: a.remote_id ?? a.asset_id, state: a.state, allowDownload: a.allow_download, fileType: a.file_type ?? null, bytesExpected: a.bytes_expected ?? null }))
    },
```

`packages/engine/src/discovery/index.ts` 第 18 行：

```ts
    const assets = await deps.gw.listAssets(m.meetingId, m.subMeetingId, sel.kind !== 'range' ? sel.from : undefined, sel.kind !== 'range' ? sel.to : undefined)
```

`packages/engine/src/executor/index.ts` 的 `runProbes`（删掉 `meetingKey` 那个只用一次的局部变量）：

```ts
  for (const p of await deps.store.dueProbes(now())) {
    // 探测行本来就是按 (meeting_id, sub_meeting_id, asset_type) 存的，反查时把场次
    // 一起带上——不带的话一条探测行会被同 meeting_id 别的场次的资产判成"就绪"
    const assets = await deps.gw.listAssets(p.meeting_id, p.sub_meeting_id)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/worker/source-inproc.test.ts && cd packages/engine && bun test tests/discovery tests/executor`
Expected: PASS（引擎测试里所有假 `gw.listAssets` 的桩都收 `(meetingId, subMeetingId, …)`——桩函数忽略多余参数，不用逐个改；只有断言「listAssets 收到了什么」的桩要跟着改，`packages/engine/tests/discovery/index.test.ts` 里记参数的那个是唯一一处。）

- [ ] **Step 5: 写失败的测试（公开 API 的 sub_meeting_id）**

`tests/http/meetings.test.ts` 末尾加：

```ts
test('单场详情与资产清单可按 sub_meeting_id 点名要某一场，未命中 404', async () => {
  const judy: ActorIdentity = {
    kind: 'service_account', wecomUserId: null, tmUserId: 'tm-judy-1', programId: 'prog-judy-1',
  }
  // 同一个 meeting_id 的两条录制记录 = 周期会议的两场
  const first = rawMeeting({
    meeting_record_id: 'rec-j-1', meeting_id: 'm-j-1', meeting_code: '893', host_user_id: 'tm-judy-1',
    subject: '第一场',
  })
  const second = {
    ...(rawMeeting({
      meeting_record_id: 'rec-j-2', meeting_id: 'm-j-1', meeting_code: '893', host_user_id: 'tm-judy-1',
      subject: '第二场',
    }) as Record<string, unknown>),
    media_start_time: (NOW + 3600) * 1000,   // 更晚的一场：不带参数时它胜出
  }

  const { app } = buildTestApp(pool, {
    now: () => NOW + 7200,
    tencentGet: (path) => (recordsFor(path, [first, second]) ?? {}),
  })
  await insertPolicyRule(pool, { priority: 10, programId: 'prog-judy-1', assetTypes: ['*'], effect: 'allow' })
  await insertGrant(pool, { meetingId: 'm-j-1', subMeetingId: 'rec-j-1', programId: 'prog-judy-1' })
  await insertGrant(pool, { meetingId: 'm-j-1', subMeetingId: 'rec-j-2', programId: 'prog-judy-1' })
  const headers = bearer(judy, NOW + 7200)

  // ① 不给 sub_meeting_id：保持旧口径，取 startTime 最新的一条
  const latest = await app(new Request('https://gw/api/v1/meetings/m-j-1', { headers }))
  expect(latest.status).toBe(200)
  expect(((await latest.json()) as { subject: string }).subject).toBe('第二场')

  // ② 给了就取那一条
  const pinned = await app(
    new Request('https://gw/api/v1/meetings/m-j-1?sub_meeting_id=rec-j-1', { headers }),
  )
  expect(pinned.status).toBe(200)
  const pinnedBody = (await pinned.json()) as { subject: string; sub_meeting_id: string }
  expect(pinnedBody.subject).toBe('第一场')
  expect(pinnedBody.sub_meeting_id).toBe('rec-j-1')

  // ③ 没命中：404，与「范围外未命中」同一个形状
  const miss = await app(
    new Request('https://gw/api/v1/meetings/m-j-1?sub_meeting_id=rec-nope', { headers }),
  )
  expect(miss.status).toBe(404)
  expect(((await miss.json()) as { error: string }).error).toBe('meeting_not_found_in_range')

  // ④ 资产端点同样认这个参数
  const assets = await app(
    new Request('https://gw/api/v1/meetings/m-j-1/assets?sub_meeting_id=rec-nope', { headers }),
  )
  expect(assets.status).toBe(404)
})
```

`prog-judy-1` 已经在文件顶部的 `TEST_PROGRAM_IDS` 里，不用新增。

- [ ] **Step 6: 跑测试确认失败**

Run: `bun test tests/http/meetings.test.ts`
Expected: FAIL —— ② 拿到「第二场」（参数被忽略），③④ 拿到 200。

- [ ] **Step 7: 改两个端点**

`src/http/handlers/meetings.ts`，在 `parseIntParam` 下面加一个共用的挑选函数：

```ts
/**
 * 从同 meeting_id 的多条录制记录里挑出这次要的那一条。
 *
 * `sub_meeting_id` 给了就按 `meetingRecordId` 精确取——周期会议的每一场是一条记录，
 * 点名要哪一场只能靠它（spec §2.2）。没给保持既有口径：`startTime` 最新的那条，
 * 这是「问一个 meeting_id 要详情」的合理默认，也不改变任何旧调用方的行为。
 *
 * 挑不出来返回 null，由调用方按「范围外未命中」的同一个形状回 404——区分
 * 「不存在」与「无权限」本身就是一种信息泄露，两条路必须长得一样。
 */
function pickMeeting(meetings: Meeting[], subMeetingId: string | null): Meeting | null {
  if (subMeetingId !== null && subMeetingId !== '') {
    return meetings.find((m) => m.meetingRecordId === subMeetingId) ?? null
  }
  return [...meetings].sort((a, b) => b.startTime - a.startTime)[0] ?? null
}
```

`getMeeting` 里（替换原第 184 行那句 `const meeting = […].sort(…)[0]!`）：

```ts
  const subMeetingId = url.searchParams.get('sub_meeting_id')
  // 缓存写入由 recordsApi 统一负责（见上面 listMeetings 处的说明）
  const meeting = pickMeeting(meetings, subMeetingId)
  if (meeting === null) {
    const notFound = new MeetingNotFoundInRangeError(meetingIdParam, from ?? now - DEFAULT_WINDOW_SEC, to ?? now)
    return json(404, { error: 'meeting_not_found_in_range', message: notFound.message })
  }
```

`listAssets` 里（替换原第 235 行同样那句），`url` 已经在函数里建好了：

```ts
  const meeting = pickMeeting(meetings, url.searchParams.get('sub_meeting_id'))
  if (meeting === null) {
    const notFound = new MeetingNotFoundInRangeError(ctx.params.meetingId!, from ?? now - DEFAULT_WINDOW_SEC, to ?? now)
    return json(404, { error: 'meeting_not_found_in_range', message: notFound.message })
  }
```

- [ ] **Step 8: 跑测试确认通过**

Run: `bun test tests/http/meetings.test.ts tests/worker tests/e2e && cd packages/engine && bun test`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add packages/engine/src src/worker/source-inproc.ts src/http/handlers/meetings.ts \
        client/src/gateway/client.ts tests packages/engine/tests
git commit -m "$(cat <<'EOF'
feat(source): 资产清单按场次收窄，公开 API 两个端点加 sub_meeting_id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 把 writeNasSidecars 抽成可复用函数

**Files:**
- Create: `src/worker/nas-sidecars.ts`
- Modify: `src/worker/archive.ts:44`（常量搬走）、`:526-640`（函数搬走）、`:674-690`（四个小helper 搬走）、`:833`（调用点）
- Test: `tests/worker/archive.test.ts`（既有用例**不改**，它们跑的就是这条路）

**Interfaces:**
- Consumes: `ArchivesStore` 的 `listArchivedAssetsForMeeting` / `listMissingAssets`（`src/store/archives.ts`），`CompletedAssetRow` / `ArchivedAssetRecord` / `MissingAssetRow` 三个行类型。
- Produces:

```ts
export const NAS_WRITE_TIMEOUT_MS: number            // 10 * 60_000
export interface NasSidecarInput {
  meetingId: string
  subMeetingId: string
  meeting: Meeting | null                            // 引擎的 Meeting（字段可空）
  completed: readonly CompletedAssetRow[]
  archived: readonly ArchivedAssetRecord[]
  missing: readonly MissingAssetRow[]
  nasRoot: string
  nasDir: string
  retentionDays: number
  now: number
  writeMeta?: (relPath: string, data: unknown) => Promise<void>
  timeoutMs?: number
}
export async function writeNasSidecars(input: NasSidecarInput): Promise<void>
```

- [ ] **Step 1: 确认既有测试是绿的（这是重构，行为不许变）**

Run: `bun test tests/worker/archive.test.ts`
Expected: PASS —— 记下用例数，Step 5 之后必须一模一样。

- [ ] **Step 2: 建新模块**

新建 `src/worker/nas-sidecars.ts`，把 `src/worker/archive.ts` 的 `NAS_WRITE_TIMEOUT_MS`（第 44 行连同它上面那段注释）、`writeNasSidecars`（第 526-640 行）、`naturalKey` / `emptyToNull` / `baseNameOf` / `isUnder`（第 674-690 行）整段搬过来，函数签名换成收一个入参对象：

```ts
import { join, relative } from 'node:path'
import {
  MANIFEST_SCHEMA_VERSION,
  createNasStorage,
  manifestAssetKey,
  manifestBytes,
  withFsTimeout,
  type ArchivedManifestAssetEntry,
  type ArchivedManifestFile,
  type ManifestMissingEntry,
  type Meeting,
  type MeetingMetaFile,
} from '@yaowu/mde-engine'
import type { ArchivedAssetRecord, CompletedAssetRow, MissingAssetRow } from '../store/archives'

/** （原样搬自 archive.ts 第 27-43 行的注释：为什么是 10 分钟而不是 5 秒） */
export const NAS_WRITE_TIMEOUT_MS = 10 * 60_000

export interface NasSidecarInput {
  meetingId: string
  subMeetingId: string
  /** 元数据由调用方读好传进来；取不到时为 null，两个 ID 照样写得出（US-6.2 要的"原始 ID"） */
  meeting: Meeting | null
  /** meeting_assets 里 status='completed' 的行，按 id 升序 = 入库顺序 */
  completed: readonly CompletedAssetRow[]
  /** archived_assets 里这一场的行，按自然键 join 进来 */
  archived: readonly ArchivedAssetRecord[]
  /** meeting_assets 里没拿到的那些（skipped / dead / failed） */
  missing: readonly MissingAssetRow[]
  nasRoot: string
  nasDir: string
  retentionDays: number
  now: number
  /** 缺省 `createNasStorage(nasRoot, timeoutMs).writeMeta` */
  writeMeta?: (relPath: string, data: unknown) => Promise<void>
  /** 缺省 `NAS_WRITE_TIMEOUT_MS` */
  timeoutMs?: number
}

/**
 * NAS 上那份**自解释** sidecar：`meeting.json`（会议元数据）与 `_manifest.json`
 * （资产清单 + 校验信息 + 归档段）。US-6.2：「数年后在 NAS 上翻到该目录，无需本工具
 * 即可知道内容、完整性与原始 ID」。
 *
 * （archive.ts 里那三条「为什么在 NAS 上独立生成，而不是把本地那两个文件搬过去」的
 * 理由原样搬过来：① NAS 那份要带归档特有的信息；② 本地那份可能压根不存在；
 * ③ 本地那份 30 天后会被到期清理删掉，长期活下来的是这一份。）
 *
 * **为什么收一个纯数据入参、而不是收 ArchiveDeps**：这一份逻辑有两个调用方——
 * 归档流水线（`src/worker/archive.ts`）和拆场次脚本
 * （`scripts/split-recurring-meetings.ts`，它拆完之后要按新场次把清单重写一遍）。
 * 脚本手上没有 ArchiveDeps，也不该为了写一份 JSON 去搭半个归档流水线；而这两份清单
 * 要是各写一遍，字段含义立刻分叉——NAS 上那一份是**要留数年**的东西。
 *
 * 抛出的错误由调用方接住——**写不出 sidecar 绝不能让归档判为失败**。
 */
export async function writeNasSidecars(input: NasSidecarInput): Promise<void> {
  const { meetingId, subMeetingId, meeting, completed, archived, missing, nasRoot, nasDir, retentionDays, now } = input
  const timeoutMs = input.timeoutMs ?? NAS_WRITE_TIMEOUT_MS
  const write = input.writeMeta ?? createNasStorage(nasRoot, timeoutMs).writeMeta

  const nasByKey = new Map(archived.map((a) => [naturalKey(a), a]))

  // 枚举源是 meeting_assets 的 completed 行（按 id 升序 = 入库顺序），NAS 侧的事实
  // 从 archived_assets 按自然键 join 进来。两张表都要读是因为它们各知道一半。
  const assets: ArchivedManifestAssetEntry[] = []
  let unrecorded = 0
  let elsewhere = 0
  for (const row of completed) {
    const nas = nasByKey.get(naturalKey(row))
    if (nas === undefined) {
      // 理论上不该发生。真发生了也不能编一个 NAS 路径出来——清单宁可少一条，也不能撒谎
      unrecorded++
      continue
    }
    if (!isUnder(nasDir, nas.nasPath)) elsewhere++
    assets.push({
      assetType: row.assetType,
      assetKey: manifestAssetKey(row.assetType),
      remoteId: emptyToNull(row.remoteId),
      fileType: emptyToNull(row.fileType),
      fileName: baseNameOf(nas.nasPath),
      // 与本地那份清单共用同一条取值规则（平台声明值优先、否则用落盘真实大小）
      bytes: manifestBytes(row.bytesExpected, row.bytesWritten),
      sha256: row.contentHash,
      nasPath: nas.nasPath,
      nasHash: nas.nasHash,
    })
  }
  if (unrecorded > 0) {
    console.warn(
      `archive sidecar: meeting=${meetingId} subMeeting=${subMeetingId} 有 ${unrecorded} 个已完成资产在 archived_assets 里找不到对应记录，未列入 NAS 清单`,
    )
  }
  if (elsewhere > 0) {
    // 目录模板中途被改过时，同一场会议前后两轮会判出不同的目录。清单照实写每个文件的
    // 真实 nasPath（找得到），但错位本身要留痕
    console.warn(
      `archive sidecar: meeting=${meetingId} subMeeting=${subMeetingId} 有 ${elsewhere} 个已归档资产不在 ${nasDir} 内（跨月归档？），清单按各自真实的 nasPath 记录`,
    )
  }

  const missingEntries: ManifestMissingEntry[] = missing.map((r) => ({
    assetType: r.assetType,
    assetKey: manifestAssetKey(r.assetType),
    remoteId: emptyToNull(r.remoteId),
    status: r.status,
    reason: r.lastError ?? 'unknown',
  }))

  const meta: MeetingMetaFile = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    meeting: {
      // 这两个是**调用方给的主键**，不是从 meeting 里取的：元数据取不到时它们照样
      // 是已知事实，而 US-6.2 第二条验收标准要的"原始 ID"正是它们
      meetingId,
      subMeetingId,
      meetingCode: meeting?.meetingCode ?? null,
      subject: meeting?.subject ?? null,
      hostUserId: meeting?.hostUserId ?? null,
      startTime: meeting?.startTime ?? null,
      endTime: meeting?.endTime ?? null,
    },
    generatedAt: now,
    generatedBy: 'mde-worker',
  }
  const manifest: ArchivedManifestFile = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    meetingId,
    subMeetingId,
    assets,
    missing: missingEntries,
    archive: { archivedAt: now, retentionDays, nasDir },
    generatedAt: now,
    generatedBy: 'mde-worker',
  }

  // 路径相对 nasRoot（Storage 接口的口径），落点仍然是 nasDir 本身
  const relDir = relative(nasRoot, nasDir)
  // 超时包装由**这里**持有，不指望 write 的实现自带：NAS 挂起时 fs 调用是挂住而不是
  // 报错，"有限时间内返回"这条保证不能随着换一个实现就消失
  await withFsTimeout(write(join(relDir, 'meeting.json'), meta), `write ${join(nasDir, 'meeting.json')}`, timeoutMs)
  await withFsTimeout(write(join(relDir, '_manifest.json'), manifest), `write ${join(nasDir, '_manifest.json')}`, timeoutMs)
}

/** meeting_assets 与 archived_assets 共用的自然键；\u0000 当分隔符，任何一段里都不会出现 */
function naturalKey(r: { assetType: string; remoteId: string; fileType: string }): string {
  return `${r.assetType}\u0000${r.remoteId}\u0000${r.fileType}`
}

/** DB 里 NOT NULL 的文本列用空串编码「没有」，清单里如实写 null（与引擎那份同一口径） */
function emptyToNull(v: string): string | null {
  return v === '' ? null : v
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function isUnder(dir: string, path: string): boolean {
  return path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)
}
```

两处与原实现的差别，只有这两处：
1. `missing` 不再 `await deps.archives.listMissingAssets(...)`，直接用入参（局部变量改名 `missingEntries`，免得与入参撞名）。
2. `createNasStorage(nasRoot, timeoutMs).writeMeta` 直接取方法（`nas.ts` 返回对象字面量，方法体用的是闭包 `abs`，不依赖 `this`），原实现的 `.bind(nasStorage)` 可以去掉。

- [ ] **Step 3: archive.ts 改成调它**

`src/worker/archive.ts`：删掉搬走的那些，顶部 import 改成

```ts
import { NAS_WRITE_TIMEOUT_MS, writeNasSidecars } from './nas-sidecars'
```

（`MANIFEST_SCHEMA_VERSION` / `manifestAssetKey` / `manifestBytes` / `ArchivedManifestAssetEntry` / `ArchivedManifestFile` / `ManifestMissingEntry` / `MeetingMetaFile` 这些若在 archive.ts 里别处不再使用，一并从它的 import 里删掉——`bun run typecheck` 会告诉你哪些还留着。`createNasStorage` / `withFsTimeout` 仍被 `archiveOneAsset` 用着，保留。）

并加一个薄包装，把 store 读取留在归档侧：

```ts
/** 归档流水线这一侧的入口：两张表的行在这里读，写清单本身交给 nas-sidecars.ts */
async function writeSidecarsForMeeting(
  deps: ArchiveDeps,
  meetingId: string,
  subMeetingId: string,
  meeting: Meeting | null,
  completed: CompletedAssetRow[],
  nasDir: string,
  retentionDays: number,
  now: number,
): Promise<void> {
  await writeNasSidecars({
    meetingId,
    subMeetingId,
    meeting,
    completed,
    archived: await deps.archives.listArchivedAssetsForMeeting(meetingId, subMeetingId),
    missing: await deps.archives.listMissingAssets(meetingId, subMeetingId),
    nasRoot: deps.nasRoot,
    nasDir,
    retentionDays,
    now,
    writeMeta: deps.writeMeta,
    timeoutMs: deps.nasWriteTimeoutMs,
  })
}
```

第 833 行的调用点改成 `await writeSidecarsForMeeting(deps, meetingId, subMeetingId, meeting, completed, nasDir, retentionDays, now)`。

- [ ] **Step 4: 跑测试确认没变行为**

Run: `bun test tests/worker/archive.test.ts && bun run typecheck`
Expected: PASS，用例数与 Step 1 完全一致。

- [ ] **Step 5: 提交**

```bash
git add src/worker/nas-sidecars.ts src/worker/archive.ts
git commit -m "$(cat <<'EOF'
refactor(archive): writeNasSidecars 抽成收纯数据的可复用函数

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 拆场次脚本 —— 规划这一遍

**Files:**
- Modify: `scripts/rename-archive-dirs.ts`（给 7 个符号加 `export`，无行为改动）
- Create: `scripts/split-recurring-meetings.ts`（本任务只写到 `planSplits` 为止）
- Test: `tests/scripts/split-recurring-meetings.test.ts`

**Interfaces:**
- Consumes: `meetingDirPath`、`assetKeyToFilename`、`GATEWAY_TYPE_TO_ASSET_KEY`、`ASSET_KEY_TO_GATEWAY_TYPE`（`@yaowu/mde-engine`）；`createPool` / `runMigrations` / `Pool`（`src/store/db`）；`exists` / `NAS_BASE` / `cleanBase` / `mergeBase` / `resolveNasBase` / `DerivedBase`（`scripts/rename-archive-dirs.ts`）。
- Produces：见下面 Step 3 的类型块；`planSplits(pool, localRoot): Promise<SplitItem[]>`、`parseArgs(argv): SplitArgs`。

- [ ] **Step 1: 给改名脚本的可复用件加 export**

`scripts/rename-archive-dirs.ts`：给 `exists`（第 151 行）、`NAS_BASE`（第 213 行）、`cleanBase`（第 239 行）、`DerivedBase`（第 243 行）、`resolveNasBase`（第 252 行）、`mergeBase`（第 273 行）、`undoRename`（第 453 行）各加一个 `export`。**只加关键字，一行逻辑都不动**——两个脚本共用同一份「什么算存在」「NAS 基准目录怎么反推」「回滚怎么不抛」，各写一遍就会漂移，而漂移的表现是「NAS 掉线被当成目录不存在」这种查不出来的事。

Run: `bun test tests/scripts/rename-archive-dirs.test.ts`
Expected: PASS（加 export 不改行为，这一步是证明它没改）

- [ ] **Step 2: 写失败的测试（规划这一遍）**

新建 `tests/scripts/split-recurring-meetings.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTestDb } from '../helpers/testdb'
import { parseArgs, planSplits } from '../../scripts/split-recurring-meetings'
import type { Pool } from '../../src/store/db'

/**
 * 与改名脚本同一条约定：不 mock 数据库。这个脚本的全部风险都在「文件搬到哪」与
 * 「六张表一起改成」这两件事必须一起成/一起不成上，而后者是事务语义，mock 掉等于没测。
 * 唯一 mock 掉的是「写库炸了」那一条（Task 6 的 brokenTxPool）。
 */
async function withDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try { await fn(pool) } finally { await cleanup() }
}

async function withDirs(fn: (localRoot: string, nasRoot: string) => Promise<void>): Promise<void> {
  const localRoot = await mkdtemp(join(tmpdir(), 'mde-split-local-'))
  const nasRoot = await mkdtemp(join(tmpdir(), 'mde-split-nas-'))
  try { await fn(localRoot, nasRoot) } finally {
    await rm(localRoot, { recursive: true, force: true })
    await rm(nasRoot, { recursive: true, force: true })
  }
}

/** 2026-09-02 01:27 UTC 与它的次日——两个场次的 start_time */
const DAY1 = Date.UTC(2026, 8, 2, 1, 27) / 1000
const DAY2 = DAY1 + 86400
const REL1 = '2026/09/2026-09-02_0127_881'
const REL2 = '2026/09/2026-09-03_0127_881'

/** 一场没拆过的会议：meetings 里一行空 sub，meeting_cache 里两个场次 */
async function seedMeeting(pool: Pool, opts: { records?: Array<{ id: string; start: number }> } = {}) {
  const records = opts.records ?? [{ id: 'rec-1', start: DAY1 }, { id: 'rec-2', start: DAY2 }]
  // meetings 那一行描述的是**最新的**一场（upsertMeeting 每轮把 start_time 覆盖成
  // 最后拉到的那场），所以取最后一条；一条都没有时用 DAY2，与默认的最新那场一致
  const start = records.at(-1)?.start ?? DAY2
  await pool.execute(
    `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
     VALUES ('m1', '', '881', '销售日会', 'u1', ?, ?, 1, 1)`,
    [start, start + 1800],
  )
  for (const r of records) {
    await pool.execute(
      `INSERT INTO meeting_cache (meeting_record_id, meeting_id, sub_meeting_id, meeting_code, subject, host_user_id, start_time, end_time, state, updated_at)
       VALUES (?, 'm1', ?, '881', '销售日会', 'u1', ?, ?, 'completed', 1)`,
      [r.id, r.id, r.start, r.start + 1800],
    )
  }
}

/** 一个资产：asset_id 的第一段就是它属于哪个场次 */
async function seedAsset(
  pool: Pool, recordId: string, remoteId: string, targetPath: string, fileType = 'txt',
) {
  await pool.execute(
    `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, asset_id, file_type, status, target_path, created_at, updated_at)
     VALUES ('m1', '', 'meeting_summary', ?, ?, ?, 'completed', ?, 1, 1)`,
    [remoteId, `${recordId}:${remoteId}:meeting_summary:txt`, fileType, targetPath],
  )
}

test('parseArgs：默认 dry-run，--apply 才动手', () => {
  expect(parseArgs([])).toEqual({ apply: false })
  expect(parseArgs(['--apply'])).toEqual({ apply: true })
})

test('按 meeting_cache 拆成两个场次，各自算出自己的目录；文件名不再带序号后缀', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      // 拆之前两段转写挤在同一个目录里，第二段被 siblingRank 加了 _2
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await seedAsset(pool, 'rec-2', 'f2', `${REL2}/transcript_2.txt`)

      const plan = await planSplits(pool, localRoot)
      expect(plan).toHaveLength(1)
      const item = plan[0]!
      expect(item.undecidableReason).toBeNull()
      expect(item.sessions.map((s) => s.recordId)).toEqual(['rec-1', 'rec-2'])
      expect(item.sessions.map((s) => s.newRel)).toEqual([REL1, REL2])
      // 分组变小之后各自都是组里唯一一个，序号后缀没了
      expect(item.sessions[0]!.assets.map((a) => a.newTargetPath)).toEqual([`${REL1}/transcript.txt`])
      expect(item.sessions[1]!.assets.map((a) => a.newTargetPath)).toEqual([`${REL2}/transcript.txt`])
    })
  })
})

test('资产指向的 record id 不在 meeting_cache 里、只有一个时，用 meetings 行自己的元数据顶上', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool, { records: [] })          // 缓存里一条都没有
      await seedAsset(pool, 'rec-orphan', 'f1', `${REL2}/transcript.txt`)

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toBeNull()
      expect(item.sessions.map((s) => s.recordId)).toEqual(['rec-orphan'])
      expect(item.sessions[0]!.subject).toBe('销售日会')   // 来自 meetings 行本身
      expect(item.sessions[0]!.newRel).toBe(REL2)
    })
  })
})

test('两个 record id 都不在 meeting_cache 里 → undecidable，整场跳过', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool, { records: [] })
      await seedAsset(pool, 'rec-x', 'f1', `${REL2}/transcript.txt`)
      await seedAsset(pool, 'rec-y', 'f2', `${REL2}/transcript_2.txt`)

      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toContain('meeting_cache')
      expect(item.sessions).toHaveLength(0)
    })
  })
})

test('asset_id 为空的资产行 → undecidable：说不出它属于哪一场，不许猜', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      await pool.execute(
        `INSERT INTO meeting_assets (meeting_id, sub_meeting_id, asset_type, remote_id, asset_id, file_type, status, target_path, created_at, updated_at)
         VALUES ('m1', '', 'meeting_summary', 'f9', NULL, 'txt', 'completed', ?, 1, 1)`,
        [`${REL2}/transcript.txt`],
      )
      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toContain('asset_id')
    })
  })
})

test('没有资产的会议只拆 meetings 行本身，按 meeting_cache 的场次', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      const item = (await planSplits(pool, localRoot))[0]!
      expect(item.undecidableReason).toBeNull()
      expect(item.sessions.map((s) => s.recordId)).toEqual(['rec-1', 'rec-2'])
      expect(item.sessions.every((s) => s.assets.length === 0)).toBe(true)
    })
  })
})

test('已经拆过的会议不再进计划（脚本自消耗、可重复跑）', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await pool.execute(
        `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
         VALUES ('m1', 'rec-1', '881', '销售日会', 'u1', ?, ?, 1, 1)`,
        [DAY1, DAY1 + 1800],
      )
      expect(await planSplits(pool, localRoot)).toHaveLength(0)
    })
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/scripts/split-recurring-meetings.test.ts`
Expected: FAIL —— `Cannot find module '../../scripts/split-recurring-meetings'`

- [ ] **Step 4: 写脚本的规划这一遍**

新建 `scripts/split-recurring-meetings.ts`：

```ts
#!/usr/bin/env bun
/**
 * 周期会议按录制记录拆场次的一次性脚本（spec 2026-09-09 §2.4）。
 *
 *   旧：一个 meeting_id 一行 meetings（sub_meeting_id 是空串），六个场次的资产
 *       全挤在一行会议下、文件全落进最新那一场的目录里
 *   新：一个 meeting_record_id 一行 meetings，各自的目录、各自的授权与归档记录
 *
 * 用法：
 *   DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/split-recurring-meetings.ts           # dry-run
 *   DATABASE_URL=... MDE_ARCHIVE_ROOT=... bun scripts/split-recurring-meetings.ts --apply   # 真改
 *
 * 跑之前**停掉网关与调度器**：搬文件与归档流水线并发，会让一半文件写到旧目录。
 * 建议 `2>&1 | tee split-$(date +%s).log`。
 *
 * 可重复跑：只处理 `sub_meeting_id = ''` 的 meetings 行，跑成功之后那些行就没了,
 * 第二次跑计划是空的。
 *
 * 与 scripts/rename-archive-dirs.ts 共用「什么算存在」（exists）、「NAS 基准目录怎么
 * 反推」（NAS_BASE / resolveNasBase / mergeBase / cleanBase）、「回滚不许抛」
 * （undoRename）这几件事——各写一遍就会漂移，而漂移的表现是「NAS 掉线被当成目录不
 * 存在，于是只改库不改盘」这种查不出来的事。
 */
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  ASSET_KEY_TO_GATEWAY_TYPE,
  GATEWAY_TYPE_TO_ASSET_KEY,
  assetKeyToFilename,
  meetingDirPath,
  type AssetKey,
} from '@yaowu/mde-engine'
import { createPool, runMigrations, type Pool } from '../src/store/db'
import { createArchivesStore } from '../src/store/archives'
import { jobFailureTarget } from '../src/store/jobs'
import { writeNasSidecars } from '../src/worker/nas-sidecars'
import {
  NAS_BASE,
  cleanBase,
  exists,
  mergeBase,
  resolveNasBase,
  undoRename,
  type DerivedBase,
} from './rename-archive-dirs'

export interface SplitArgs { apply: boolean }

export function parseArgs(argv: string[]): SplitArgs {
  return { apply: argv.includes('--apply') }
}

/**
 * `applyOne` 的五种结局，词汇与改名脚本同一套（spec §2.4「输出」）。
 *
 * `renamed` 沿用改名脚本的说法：这一场**动过了**（文件搬了、库改了）。
 * `already_done` 在这里特指「文件早就在新位置上了（上一次跑在事务之前断掉），
 * 这一次只补库」——不是「什么都没做」，因为 sub_meeting_id 还是空串时库总归要改。
 */
export type ApplyOutcome = 'renamed' | 'already_done' | 'not_found' | 'conflict' | 'undecidable'

export interface SplitFile { from: string; to: string }

export interface SplitAsset {
  /** meeting_assets.id——改这一行走主键，不做前缀匹配 */
  id: number
  assetType: string
  remoteId: string
  fileType: string
  /** 从 asset_id 第一段切出来的 meeting_record_id */
  recordId: string
  oldTargetPath: string | null
  newTargetPath: string
  /** 本地归档区里的绝对路径；target_path 为空（从没落过盘）时是 null */
  local: SplitFile | null
  /** NAS 上的绝对路径；没有 archived_assets 行、或反推不出基准目录时是 null */
  nas: SplitFile | null
}

export interface SplitSession {
  recordId: string
  subject: string | null
  meetingCode: string | null
  hostUserId: string | null
  startTime: number | null
  endTime: number | null
  /** meetingDirPath 算出来的新目录（相对） */
  newRel: string
  assets: SplitAsset[]
  /** 这一场有没有 archived_assets 行——决定要不要给它复制一行 meeting_archives */
  archived: boolean
}

export interface SplitItem {
  meetingId: string
  /** 旧 '' 行按自己的 subject/start_time/code 算出来的目录，用来收尾时清空目录 */
  oldRel: string
  /** NAS 基准目录；这场会议在 NAS 上什么都没有时是 null */
  nasDir: string | null
  sessions: SplitSession[]
  /**
   * 非 null = 这一条不动手（`applyOne` 直接返回 undecidable），字符串是给人看的理由。
   * 四种来路：资产的 record id 在 meeting_cache 里查不到且不止一个、asset_id 说不出
   * 场次、两个场次算出同一个目录、NAS 基准目录讲不清楚。
   */
  undecidableReason: string | null
}

interface MeetingRow extends RowDataPacket {
  meeting_id: string
  meeting_code: string | null
  subject: string | null
  host_userid: string | null
  start_time: number | null
  end_time: number | null
}

interface CacheRow extends RowDataPacket {
  meeting_id: string
  meeting_record_id: string
  meeting_code: string
  subject: string
  host_user_id: string
  start_time: number
  end_time: number
}

interface AssetRow extends RowDataPacket {
  id: number
  meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  record_id: string | null
  target_path: string | null
}

interface ArchivedRow extends RowDataPacket {
  meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  local_path: string
  nas_path: string
}

interface BaseRow extends RowDataPacket { meeting_id: string; base: string | null }
interface NasDirRow extends RowDataPacket { meeting_id: string; nas_dir: string }

/** meeting_assets 与 archived_assets 共用的自然键，与 archive.ts 的 naturalKey 同一形状 */
const naturalKey = (r: { asset_type: string; remote_id: string; file_type: string }): string =>
  `${r.asset_type}\u0000${r.remote_id}\u0000${r.file_type}`

/**
 * 一个资产在**新的**分组 `(meeting_id, record_id, asset_type, file_type)` 里的序号。
 *
 * 与 `Store.siblingRank` 逐字同一个分组与同一个排序（按 id 升序），因为文件名要由
 * `assetKeyToFilename` 按同一个 ordinal 算出来——两处不一致的表现是脚本把文件搬到
 * 一个名字上，而下一轮 worker 又按另一个名字去写。
 */
function assignOrdinals(assets: AssetRow[]): Map<number, number> {
  const groups = new Map<string, AssetRow[]>()
  for (const a of [...assets].sort((x, y) => x.id - y.id)) {
    const k = `${a.record_id}\u0000${a.asset_type}\u0000${a.file_type}`
    const g = groups.get(k)
    if (g === undefined) groups.set(k, [a])
    else g.push(a)
  }
  const out = new Map<number, number>()
  for (const g of groups.values()) g.forEach((a, i) => out.set(a.id, i + 1))
  return out
}

export async function planSplits(pool: Pool, localRoot: string): Promise<SplitItem[]> {
  const [meetings] = await pool.execute<MeetingRow[]>(
    `SELECT meeting_id, meeting_code, subject, host_userid, start_time, end_time
       FROM meetings WHERE sub_meeting_id = '' ORDER BY meeting_id`,
  )
  if (meetings.length === 0) return []

  // 场次清单的来源。meeting_cache 的主键就是 meeting_record_id，它一直是按场次存的
  const [cacheRows] = await pool.execute<CacheRow[]>(
    `SELECT meeting_id, meeting_record_id, meeting_code, subject, host_user_id, start_time, end_time
       FROM meeting_cache ORDER BY meeting_id, meeting_record_id`,
  )
  const cacheOf = new Map<string, CacheRow[]>()
  for (const c of cacheRows) {
    const g = cacheOf.get(c.meeting_id)
    if (g === undefined) cacheOf.set(c.meeting_id, [c]) else g.push(c)
  }

  // 每一行资产带着自己场次的 record id：asset_id 是
  // `<meetingRecordId>:<recordFileId>:<assetType>:<selector>`，第一段就是它
  const [assetRows] = await pool.execute<AssetRow[]>(
    `SELECT id, meeting_id, asset_type, remote_id, file_type, target_path,
            SUBSTRING_INDEX(asset_id, ':', 1) AS record_id
       FROM meeting_assets WHERE sub_meeting_id = '' ORDER BY meeting_id, id`,
  )
  const assetsOf = new Map<string, AssetRow[]>()
  for (const a of assetRows) {
    const g = assetsOf.get(a.meeting_id)
    if (g === undefined) assetsOf.set(a.meeting_id, [a]) else g.push(a)
  }

  const [archivedRows] = await pool.execute<ArchivedRow[]>(
    `SELECT meeting_id, asset_type, remote_id, file_type, local_path, nas_path
       FROM archived_assets WHERE sub_meeting_id = ''`,
  )
  const archivedOf = new Map<string, Map<string, ArchivedRow>>()
  for (const r of archivedRows) {
    const g = archivedOf.get(r.meeting_id) ?? new Map<string, ArchivedRow>()
    g.set(naturalKey(r), r)
    archivedOf.set(r.meeting_id, g)
  }

  // NAS 基准目录：有 meeting_archives 行以它为准，没有就从 nas_path 反推
  // （归档半途中断的会议只有 archived_assets 行，见 rename-archive-dirs.ts 的文件头）
  const [baseRows] = await pool.execute<BaseRow[]>(
    `SELECT DISTINCT meeting_id, ${NAS_BASE} AS base FROM archived_assets WHERE sub_meeting_id = ''`,
  )
  const derivedBaseOf = new Map<string, DerivedBase>()
  for (const b of baseRows) mergeBase(derivedBaseOf, b.meeting_id, cleanBase(b.base))
  const [dirRows] = await pool.execute<NasDirRow[]>(
    `SELECT meeting_id, nas_dir FROM meeting_archives WHERE sub_meeting_id = ''`,
  )
  const nasDirOf = new Map<string, string>()
  for (const d of dirRows) nasDirOf.set(d.meeting_id, d.nas_dir)

  const out: SplitItem[] = []
  for (const m of meetings) {
    out.push(
      planOne(m, {
        localRoot,
        cache: cacheOf.get(m.meeting_id) ?? [],
        assets: assetsOf.get(m.meeting_id) ?? [],
        archived: archivedOf.get(m.meeting_id) ?? new Map(),
        nas: resolveNasBase(nasDirOf.get(m.meeting_id) ?? null, derivedBaseOf.get(m.meeting_id)),
      }),
    )
  }
  return out
}

interface PlanInput {
  localRoot: string
  cache: CacheRow[]
  assets: AssetRow[]
  archived: Map<string, ArchivedRow>
  nas: { dir: string | null; reason: string | null }
}

function planOne(m: MeetingRow, input: PlanInput): SplitItem {
  const oldRel = meetingDirPath(
    { subject: m.subject, startTime: m.start_time, meetingCode: m.meeting_code },
    m.meeting_id,
  )
  const bail = (reason: string): SplitItem => ({
    meetingId: m.meeting_id, oldRel, nasDir: input.nas.dir, sessions: [], undecidableReason: reason,
  })

  if (input.nas.reason !== null) return bail(input.nas.reason)

  // ① 每个资产属于哪个场次
  for (const a of input.assets) {
    if (a.record_id === null || a.record_id === '') {
      return bail(`meeting_assets.id=${a.id} 的 asset_id 是空的，说不出它属于哪个场次——不许猜`)
    }
    const key = GATEWAY_TYPE_TO_ASSET_KEY[a.asset_type]
    if (key === undefined || !Object.hasOwn(ASSET_KEY_TO_GATEWAY_TYPE, key)) {
      return bail(`meeting_assets.id=${a.id} 的 asset_type=${a.asset_type} 不在引擎的资产词汇表里，算不出新文件名`)
    }
    const arch = input.archived.get(naturalKey(a))
    if (arch !== undefined && a.target_path !== null && arch.local_path !== a.target_path) {
      return bail(
        `archived_assets.local_path（${arch.local_path}）与 meeting_assets.target_path（${a.target_path}）不一致，` +
          '这两列本该是同一个值的副本，不一致时说不清该按哪个搬文件',
      )
    }
  }

  // ② 场次清单 = meeting_cache 的行 + 至多一个"缓存里没有"的孤儿 record id
  const known = new Set(input.cache.map((c) => c.meeting_record_id))
  const orphans = [...new Set(input.assets.map((a) => a.record_id!))].filter((r) => !known.has(r))
  if (orphans.length > 1) {
    return bail(
      `${orphans.length} 个 record id（${orphans.join(', ')}）在 meeting_cache 里查不到，` +
        '拿不到它们各自的 start_time 就算不出目录——只有单场次会议的老数据允许有一个',
    )
  }
  const sessionsMeta = [
    ...input.cache.map((c) => ({
      recordId: c.meeting_record_id, subject: c.subject, meetingCode: c.meeting_code,
      hostUserId: c.host_user_id, startTime: c.start_time, endTime: c.end_time,
    })),
    ...orphans.map((r) => ({
      recordId: r, subject: m.subject, meetingCode: m.meeting_code,
      hostUserId: m.host_userid, startTime: m.start_time, endTime: m.end_time,
    })),
  ]
  if (sessionsMeta.length === 0) {
    return bail('meeting_cache 里没有这个 meeting_id 的任何场次，资产也反推不出 record id')
  }

  // ③ 每个资产的新路径
  const ordinalOf = assignOrdinals(input.assets)
  const sessions: SplitSession[] = sessionsMeta.map((s) => {
    const newRel = meetingDirPath(
      { subject: s.subject, startTime: s.startTime, meetingCode: s.meetingCode }, m.meeting_id,
    )
    const assets: SplitAsset[] = input.assets
      .filter((a) => a.record_id === s.recordId)
      .map((a) => {
        const key = GATEWAY_TYPE_TO_ASSET_KEY[a.asset_type] as AssetKey
        const fname = assetKeyToFilename(key, a.remote_id, a.file_type, ordinalOf.get(a.id) ?? 1)
        const newTargetPath = `${newRel}/${fname}`
        const arch = input.archived.get(naturalKey(a))
        return {
          id: a.id, assetType: a.asset_type, remoteId: a.remote_id, fileType: a.file_type,
          recordId: s.recordId, oldTargetPath: a.target_path, newTargetPath,
          local: a.target_path === null ? null : {
            from: join(input.localRoot, a.target_path), to: join(input.localRoot, newTargetPath),
          },
          nas: arch === undefined || input.nas.dir === null ? null : {
            from: arch.nas_path, to: join(input.nas.dir, newTargetPath),
          },
        }
      })
    return {
      ...s, newRel, assets,
      archived: assets.some((a) => a.nas !== null),
    }
  })

  // ④ 两个场次算出同一个目录（start_time 与会议号都一样）：它们会争同一批文件名,
  //    改一次只能搬一次，先动的那场会把后面几场的行留在旧路径上。一律不动
  const rels = sessions.map((s) => s.newRel)
  if (new Set(rels).size !== rels.length) {
    return bail(`两个场次算出同一个目录（${rels.join(', ')}），它们会争同一批文件名`)
  }
  const targets = sessions.flatMap((s) => s.assets.map((a) => a.newTargetPath))
  if (new Set(targets).size !== targets.length) {
    return bail('两个资产算出同一个新路径，搬过去会互相覆盖')
  }

  return { meetingId: m.meeting_id, oldRel, nasDir: input.nas.dir, sessions, undecidableReason: null }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/scripts/split-recurring-meetings.test.ts`
Expected: PASS（6 条）

- [ ] **Step 6: 提交**

```bash
git add scripts/rename-archive-dirs.ts scripts/split-recurring-meetings.ts \
        tests/scripts/split-recurring-meetings.test.ts
git commit -m "$(cat <<'EOF'
feat(scripts): 拆场次脚本的规划这一遍，复用改名脚本的 NAS 基准目录反推

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 拆场次脚本 —— 执行这一遍

**Files:**
- Modify: `scripts/split-recurring-meetings.ts`（加 `applyOne` / `main`）
- Test: `tests/scripts/split-recurring-meetings.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `SplitItem` / `SplitSession` / `SplitAsset`；Task 4 的 `writeNasSidecars`；`createArchivesStore`、`jobFailureTarget`。
- Produces:

```ts
export interface ApplyResult {
  outcome: ApplyOutcome
  /** 搬空之后**没有**删掉的旧目录：里面还有不认识的东西。绝不删非空目录 */
  leftOver: string[]
}
export async function applyOne(
  pool: Pool, item: SplitItem, opts: { localRoot: string; now: number },
): Promise<ApplyResult>
```

- [ ] **Step 1: 写失败的测试（执行这一遍）**

在 `tests/scripts/split-recurring-meetings.test.ts` 追加。先补两个 seed 辅助与 `brokenTxPool`（与改名脚本的测试逐字同款）：

```ts
// 顶部 import 补齐：`node:fs/promises` 再加 readFile / stat，`node:path` 再加 dirname，
// 脚本这一条 import 加上 applyOne
import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { applyOne, planSplits } from '../../scripts/split-recurring-meetings'

/** 已归档的一个资产：archived_assets 行 + 本地文件 + NAS 文件 */
async function seedArchived(
  pool: Pool, localRoot: string, nasDir: string, remoteId: string, targetPath: string,
): Promise<void> {
  await pool.execute(
    `INSERT INTO archived_assets (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
     VALUES ('m1', '', 'meeting_summary', ?, 'txt', ?, ?, ?, 1)`,
    [remoteId, targetPath, join(nasDir, targetPath), 'a'.repeat(64)],
  )
  await mkdir(join(localRoot, dirname(targetPath)), { recursive: true })
  await writeFile(join(localRoot, targetPath), remoteId)
  await mkdir(join(nasDir, dirname(targetPath)), { recursive: true })
  await writeFile(join(nasDir, targetPath), remoteId)
}

async function seedMeetingArchive(pool: Pool, nasDir: string): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_archives (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, created_at, updated_at)
     VALUES ('m1', '', ?, 100, 30, 1, 1)`,
    [nasDir],
  )
}

/** UPDATE 与 rollback 一起失败的连接池——断掉的连接就是这个样子（同改名脚本的测试） */
function brokenTxPool(): Pool {
  return {
    getConnection: async () => ({
      beginTransaction: async (): Promise<void> => {},
      execute: async (): Promise<never> => { throw new Error('boom: connection lost') },
      query: async (): Promise<never> => { throw new Error('boom: connection lost') },
      commit: async (): Promise<void> => {},
      rollback: async (): Promise<never> => { throw new Error('rollback also failed') },
      release: (): void => {},
    }),
  } as unknown as Pool
}

const subsOf = async (pool: Pool, table: string): Promise<string[]> => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT sub_meeting_id FROM ${table} WHERE meeting_id = 'm1' ORDER BY sub_meeting_id`,
  )
  return rows.map((r) => r.sub_meeting_id as string)
}
```

用例：

```ts
test('端到端：文件按场次搬走、六张表跟着改、旧行没了、旧目录删掉、NAS 侧车重写', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await seedAsset(pool, 'rec-2', 'f2', `${REL2}/transcript_2.txt`)
      await seedArchived(pool, localRoot, nasDir, 'f1', `${REL2}/transcript.txt`)
      await seedArchived(pool, localRoot, nasDir, 'f2', `${REL2}/transcript_2.txt`)
      await seedMeetingArchive(pool, nasDir)
      await pool.execute(
        `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
         VALUES ('m1', '', 'prog-1', NULL, 10, 0), ('m1', '', 'prog-2', NULL, 10, 50)`,
      )
      await pool.execute(
        `INSERT INTO meeting_overrides (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
         VALUES ('m1', '', 'allow', 'deny', NULL, '法务要求', 10, 0)`,
      )
      await pool.execute(
        `INSERT INTO meeting_asset_probes (meeting_id, sub_meeting_id, asset_type, state, deadline_at)
         VALUES ('m1', '', 'video', 'probing', 999)`,
      )
      await pool.execute(
        `INSERT INTO job_failures (job_name, target, target_label, meeting_id, sub_meeting_id, reason, impact, first_failed_at, last_failed_at)
         VALUES ('archive', 'm1|', '销售日会', 'm1', '', '归不上', '未归档', 1, 1)`,
      )

      const item = (await planSplits(pool, localRoot))[0]!
      const res = await applyOne(pool, item, { localRoot, now: 5000 })
      expect(res.outcome).toBe('renamed')
      expect(res.leftOver).toEqual([])

      // 文件各就各位，旧目录空了被删掉
      await stat(join(localRoot, REL1, 'transcript.txt'))
      await stat(join(localRoot, REL2, 'transcript.txt'))
      await stat(join(nasDir, REL1, 'transcript.txt'))
      expect(await readFile(join(localRoot, REL1, 'transcript.txt'), 'utf8')).toBe('f1')
      await expect(stat(join(localRoot, REL2, 'transcript_2.txt'))).rejects.toThrow()

      // 六张表
      expect(await subsOf(pool, 'meetings')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'meeting_assets')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'archived_assets')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'meeting_archives')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'meeting_grants')).toEqual(['rec-1', 'rec-1', 'rec-2', 'rec-2'])
      expect(await subsOf(pool, 'meeting_overrides')).toEqual(['rec-1', 'rec-2'])
      expect(await subsOf(pool, 'meeting_asset_probes')).toEqual([])   // 过程量，下一轮重建

      const [assets] = await pool.execute<RowDataPacket[]>(
        `SELECT sub_meeting_id, target_path FROM meeting_assets WHERE meeting_id='m1' ORDER BY sub_meeting_id`,
      )
      expect(assets[0]!.target_path).toBe(`${REL1}/transcript.txt`)
      expect(assets[1]!.target_path).toBe(`${REL2}/transcript.txt`)
      const [arch] = await pool.execute<RowDataPacket[]>(
        `SELECT nas_path FROM archived_assets WHERE meeting_id='m1' AND sub_meeting_id='rec-1'`,
      )
      expect(arch[0]!.nas_path).toBe(join(nasDir, REL1, 'transcript.txt'))

      // 失败项标为已恢复（dead 资产下一轮由调度器按场次重新登记）
      const [fails] = await pool.execute<RowDataPacket[]>(
        `SELECT resolved_at FROM job_failures WHERE target = 'm1|'`,
      )
      expect(fails[0]!.resolved_at).toBe(5000)

      // NAS 侧车重写过（nas_dir 根上那一份，spec §2.4 步骤 4）
      const manifest = JSON.parse(await readFile(join(nasDir, '_manifest.json'), 'utf8'))
      expect(['rec-1', 'rec-2']).toContain(manifest.subMeetingId)

      // 幂等：跑完之后计划就空了
      expect(await planSplits(pool, localRoot)).toHaveLength(0)
    })
  })
})

test('目标文件已存在（且不是同一个文件）→ conflict，一个文件都不动、库一列没改', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await mkdir(join(localRoot, REL2), { recursive: true })
      await writeFile(join(localRoot, REL2, 'transcript.txt'), 'f1')
      // 别人已经在新目录里放了一个同名文件
      await mkdir(join(localRoot, REL1), { recursive: true })
      await writeFile(join(localRoot, REL1, 'transcript.txt'), '别的东西')

      const item = (await planSplits(pool, localRoot))[0]!
      expect((await applyOne(pool, item, { localRoot, now: 5000 })).outcome).toBe('conflict')

      expect(await readFile(join(localRoot, REL2, 'transcript.txt'), 'utf8')).toBe('f1')
      expect(await subsOf(pool, 'meetings')).toEqual([''])
    })
  })
})

test('写库失败（连回滚都失败）时文件搬回原位、库一列没动，原始错误照抛', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot, nasRoot) => {
      const nasDir = join(nasRoot, 'all')
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await seedArchived(pool, localRoot, nasDir, 'f1', `${REL2}/transcript.txt`)
      await seedMeetingArchive(pool, nasDir)

      const item = (await planSplits(pool, localRoot))[0]!
      // 抛的必须是 UPDATE 那个错，不是 rollback 那个——被盖掉的话原因就查不出来了
      await expect(applyOne(brokenTxPool(), item, { localRoot, now: 5000 }))
        .rejects.toThrow('boom: connection lost')

      await stat(join(localRoot, REL2, 'transcript.txt'))
      await stat(join(nasDir, REL2, 'transcript.txt'))
      await expect(stat(join(localRoot, REL1, 'transcript.txt'))).rejects.toThrow()
      expect(await subsOf(pool, 'meetings')).toEqual([''])

      // 回滚干净了，重跑照样能拆
      const retry = (await planSplits(pool, localRoot))[0]!
      expect((await applyOne(pool, retry, { localRoot, now: 5000 })).outcome).toBe('renamed')
    })
  })
})

test('旧文件与新文件都不在 → not_found，什么都不动（多半是 MDE_ARCHIVE_ROOT 指错了）', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)   // 盘上什么都没有

      const item = (await planSplits(pool, localRoot))[0]!
      expect((await applyOne(pool, item, { localRoot, now: 5000 })).outcome).toBe('not_found')
      expect(await subsOf(pool, 'meetings')).toEqual([''])
    })
  })
})

test('文件已经在新位置（上一次跑在事务之前断掉）→ already_done，库这一次补上', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      // 只有一个场次：断言 meetings 只剩 rec-1 这一行，才说得清"库补上了"
      await seedMeeting(pool, { records: [{ id: 'rec-1', start: DAY1 }] })
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await mkdir(join(localRoot, REL1), { recursive: true })
      await writeFile(join(localRoot, REL1, 'transcript.txt'), 'f1')   // 已经在新位置

      const item = (await planSplits(pool, localRoot))[0]!
      expect((await applyOne(pool, item, { localRoot, now: 5000 })).outcome).toBe('already_done')
      expect(await subsOf(pool, 'meetings')).toEqual(['rec-1'])        // 库补上了
    })
  })
})

test('旧目录里还有不认识的文件时保留目录并记 left_over，绝不删非空目录', async () => {
  await withDb(async (pool) => {
    await withDirs(async (localRoot) => {
      await seedMeeting(pool)
      await seedAsset(pool, 'rec-1', 'f1', `${REL2}/transcript.txt`)
      await mkdir(join(localRoot, REL2), { recursive: true })
      await writeFile(join(localRoot, REL2, 'transcript.txt'), 'f1')
      await writeFile(join(localRoot, REL2, '不认识的东西.bin'), 'x')

      const item = (await planSplits(pool, localRoot))[0]!
      const res = await applyOne(pool, item, { localRoot, now: 5000 })
      expect(res.outcome).toBe('renamed')
      expect(res.leftOver).toEqual([join(localRoot, REL2)])
      await stat(join(localRoot, REL2, '不认识的东西.bin'))            // 还在
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/scripts/split-recurring-meetings.test.ts`
Expected: FAIL —— `applyOne` 还没导出。

- [ ] **Step 3: 写执行这一遍**

在 `scripts/split-recurring-meetings.ts` 里接着写：

```ts
export interface ApplyResult {
  outcome: ApplyOutcome
  /** 搬空之后**没有**删掉的旧目录：里面还有不认识的东西。绝不删非空目录 */
  leftOver: string[]
}

/** 一次文件搬运的三种处境 */
type MoveState = 'move' | 'done' | 'gone'

interface PlannedMove extends SplitFile { state: MoveState }

/**
 * 两阶段搬运的临时后缀。加在**源文件原地**（同目录），所以那一步改名是原子的、
 * 也不会碰上 NAS 挂载点与本地盘之间的 EXDEV。
 */
const TMP_SUFFIX = '.mde-split-tmp'

/**
 * 两个路径是不是同一个文件。**不能只比字符串**：macOS 的默认文件系统大小写不敏感，
 * 而「同一个文件的两个写法」被判成 conflict 会让整场会议白白停下。
 */
async function sameFile(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  try {
    const [x, y] = [await stat(a), await stat(b)]
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

/**
 * 一条搬运的处境；目标被**外人**占了返回 null（调用方按 conflict 处理）。
 *
 * `sources` 是这一场会议自己要搬走的全部源路径。目标被占、而占着它的正是我们自己
 * 要搬走的另一个文件时**不算冲突**——拆场次天然会出现这种交换：
 * 第一场的 `transcript.txt` 要搬到自己的新目录去，而第二场的 `transcript_2.txt`
 * 要改名成 `transcript.txt` 顶上它的位置。两阶段搬运（先全部让位到 .tmp，再各就各位）
 * 处理的就是这种交换，包括首尾相接的环。
 */
async function classify(f: SplitFile, sources: ReadonlySet<string>): Promise<PlannedMove | null> {
  if (await sameFile(f.from, f.to)) return { ...f, state: 'done' }
  if (await exists(f.from)) {
    if ((await exists(f.to)) && !sources.has(f.to)) return null
    return { ...f, state: 'move' }
  }
  return { ...f, state: (await exists(f.to)) ? 'done' : 'gone' }
}

/**
 * 拆一场会议。顺序固定（spec §2.4「执行」）：本地文件 → NAS 文件 → 一个事务 →
 * 侧车与空目录。事务失败把已经搬动的文件原样搬回去。
 *
 * **事务里不碰文件、事务外不碰库**：文件系统没有回滚，库有。所以先做能撤销的
 * （搬文件，撤销 = 搬回来），再做原子的（一个事务改六张表）；反过来的话事务提交了
 * 而文件搬到一半，库与盘的对应关系就再也说不清了。
 */
export async function applyOne(
  pool: Pool,
  item: SplitItem,
  opts: { localRoot: string; now: number },
): Promise<ApplyResult> {
  if (item.undecidableReason !== null) return { outcome: 'undecidable', leftOver: [] }

  // ── 分类 ────────────────────────────────────────────────────────────
  const files: SplitFile[] = []
  for (const s of item.sessions) {
    for (const a of s.assets) {
      if (a.local !== null) files.push(a.local)
      if (a.nas !== null) files.push(a.nas)
    }
  }
  const sources = new Set(files.map((f) => f.from))
  const planned: PlannedMove[] = []
  for (const f of files) {
    const c = await classify(f, sources)
    if (c === null) return { outcome: 'conflict', leftOver: [] }
    planned.push(c)
  }
  // 一个文件都没找到（新旧位置都不在）：多半是根目录指错了，或者归档区被清理过。
  // 这时候改库等于把库指到一堆并不存在的路径上，宁可什么都不做、让人看见
  if (planned.length > 0 && planned.every((p) => p.state === 'gone')) {
    return { outcome: 'not_found', leftOver: [] }
  }
  // 单个找不到的文件不拦整场（本地文件被到期清理删过是正常的），但要逐条说出来:
  // 「这一条的文件哪儿都不在」是操作员该看见的事实（spec §2.4 执行 1 的 not_found）
  for (const p of planned) {
    if (p.state === 'gone') console.warn(`⚠ ${item.meetingId} not_found：${p.from} 新旧位置都不在`)
  }

  // ── 搬文件：两阶段 ──────────────────────────────────────────────────
  // ① 全部源文件先改名到同目录下的 .tmp，② 再从 .tmp 各就各位。
  // 一阶段直接 from→to 不行：拆场次天然有「A 的目标就是 B 的源」这种交换，
  // 顺序怎么排都可能撞上，环状的更是排不出来。同目录内改名是原子的，也不会 EXDEV。
  // 两阶段之间进程被杀的话，文件停在 .tmp 上，重跑会把它判成 not_found——
  // 那时按输出里的路径找 `*.mde-split-tmp` 手工改回去即可。
  const staged: PlannedMove[] = []
  const moved = new Set<PlannedMove>()
  const undoAll = async (): Promise<void> => {
    for (const p of [...staged].reverse()) {
      if (moved.has(p)) await undoRename(p.to, p.from, '拆场次搬运')
      else await undoRename(p.from + TMP_SUFFIX, p.from, '拆场次暂存')
    }
  }
  try {
    for (const p of planned) {
      if (p.state !== 'move') continue
      await rename(p.from, p.from + TMP_SUFFIX)
      staged.push(p)
    }
    for (const p of staged) {
      await mkdir(dirname(p.to), { recursive: true })
      await rename(p.from + TMP_SUFFIX, p.to)
      moved.add(p)
    }
  } catch (err) {
    await undoAll()
    throw err
  }

  // ── 一个事务 ────────────────────────────────────────────────────────
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await splitRows(conn, item, opts.now)
    await conn.commit()
  } catch (err) {
    // rollback 自己也可能抛（UPDATE 失败最常见的原因就是连接断了，而断了的连接
    // 回滚同样会炸）。它抛出去的话下面的文件回滚一步都跑不到，于是文件在新位置、
    // 库还是旧的——而重跑会把这些文件判成 already_done，再也没人回来看它。
    // 所以：回滚失败只记一行，文件一定要搬回去，最后抛的是**最初那个**错误。
    try { await conn.rollback() } catch (rollbackErr) {
      console.error(`‼ ${item.meetingId} 事务回滚失败：${rollbackErr}`)
    }
    await undoAll()
    throw err
  } finally {
    conn.release()
  }

  // ── 收尾：侧车与空目录（都在事务之后，失败不回滚已经一致的库与盘）────────
  await rewriteNasSidecars(pool, item, opts.now)
  const leftOver = await cleanupOldDirs(item, planned, opts.localRoot)
  // 一个文件都没搬动、但库刚刚才改成：上一次跑在事务之前断掉了，这一次把库补上。
  // 这不是「什么都没做」，所以它与 not_found / conflict 分得开
  return { outcome: moved.size === 0 ? 'already_done' : 'renamed', leftOver }
}

/** 六张表 + 两张表的删除，全在调用方的事务里 */
async function splitRows(conn: PoolConnection, item: SplitItem, now: number): Promise<void> {
  const mid = item.meetingId

  // ① meetings：每个场次一行。ON DUPLICATE 是为了上一次跑到一半时能接着跑
  for (const s of item.sessions) {
    await conn.execute(
      `INSERT INTO meetings (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?) AS new
       ON DUPLICATE KEY UPDATE meeting_code=new.meeting_code, subject=new.subject,
         host_userid=new.host_userid, start_time=new.start_time, end_time=new.end_time,
         updated_at=new.updated_at`,
      [mid, s.recordId, s.meetingCode, s.subject, s.hostUserId, s.startTime, s.endTime, now, now],
    )
  }

  // ② meeting_assets / archived_assets / asset_contents：逐行改，走主键与自然键，
  //    不做前缀匹配（要做的话见 rename-archive-dirs.ts 的 PREFIX_SWAP，绝不用 LIKE）
  for (const s of item.sessions) {
    for (const a of s.assets) {
      await conn.execute(
        `UPDATE meeting_assets SET sub_meeting_id = ?, target_path = ?, updated_at = ? WHERE id = ?`,
        [s.recordId, a.newTargetPath, now, a.id],
      )
      if (a.nas !== null) {
        await conn.execute(
          `UPDATE archived_assets SET sub_meeting_id = ?, local_path = ?, nas_path = ?
            WHERE meeting_id = ? AND sub_meeting_id = '' AND asset_type = ? AND remote_id = ? AND file_type = ?`,
          [s.recordId, a.newTargetPath, a.nas.to, mid, a.assetType, a.remoteId, a.fileType],
        )
      }
      await conn.execute(
        `UPDATE asset_contents SET sub_meeting_id = ?
          WHERE meeting_id = ? AND sub_meeting_id = '' AND asset_type = ? AND remote_id = ? AND file_type = ?`,
        [s.recordId, mid, a.assetType, a.remoteId, a.fileType],
      )
    }
  }

  // ③ meeting_archives：复制给**有 archived_assets 行的**场次。没归档过的场次不该
  //    凭空拿到一个归档记录——那会让它的保留窗口从别人的 archived_at 开始计时
  const [archRows] = await conn.execute<RowDataPacket[]>(
    `SELECT nas_dir, archived_at, retention_days, extended_days, local_purged_at, created_at
       FROM meeting_archives WHERE meeting_id = ? AND sub_meeting_id = ''`,
    [mid],
  )
  for (const s of item.sessions) {
    if (!s.archived) continue
    for (const r of archRows) {
      await conn.execute(
        `INSERT INTO meeting_archives (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, extended_days, local_purged_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) AS new
         ON DUPLICATE KEY UPDATE nas_dir=new.nas_dir, archived_at=new.archived_at,
           retention_days=new.retention_days, extended_days=new.extended_days,
           local_purged_at=new.local_purged_at, updated_at=new.updated_at`,
        [mid, s.recordId, r.nas_dir, r.archived_at, r.retention_days, r.extended_days,
         r.local_purged_at, r.created_at, now],
      )
    }
  }
  await conn.execute(`DELETE FROM meeting_archives WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid])

  // ④ meeting_grants / meeting_overrides：复制给**每一个**场次（含已撤销的行,
  //    revoked_at 原样）——一场会议上的授权与改写，对它的每个场次都成立
  const [grantRows] = await conn.execute<RowDataPacket[]>(
    `SELECT program_id, asset_types, granted_at, revoked_at
       FROM meeting_grants WHERE meeting_id = ? AND sub_meeting_id = ''`,
    [mid],
  )
  for (const s of item.sessions) {
    for (const g of grantRows) {
      await conn.execute(
        `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
         VALUES (?,?,?,?,?,?) AS new
         ON DUPLICATE KEY UPDATE asset_types=new.asset_types, granted_at=new.granted_at`,
        [mid, s.recordId, g.program_id,
         g.asset_types === null ? null : JSON.stringify(g.asset_types), g.granted_at, g.revoked_at],
      )
    }
  }
  await conn.execute(`DELETE FROM meeting_grants WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid])

  const [ovrRows] = await conn.execute<RowDataPacket[]>(
    `SELECT kind, effect, asset_types, reason, created_at, revoked_at
       FROM meeting_overrides WHERE meeting_id = ? AND sub_meeting_id = ''`,
    [mid],
  )
  for (const s of item.sessions) {
    for (const o of ovrRows) {
      await conn.execute(
        `INSERT INTO meeting_overrides (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
         VALUES (?,?,?,?,?,?,?,?) AS new
         ON DUPLICATE KEY UPDATE effect=new.effect, asset_types=new.asset_types, reason=new.reason`,
        [mid, s.recordId, o.kind, o.effect,
         o.asset_types === null ? null : JSON.stringify(o.asset_types), o.reason, o.created_at, o.revoked_at],
      )
    }
  }
  await conn.execute(`DELETE FROM meeting_overrides WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid])

  // ⑤ 探测行删掉：它是过程量，下一轮发现会按场次重建。复制过去反而会让每个场次
  //    继承同一个 deadline_at 与 attempts，看着像真的、其实是编的
  await conn.execute(
    `DELETE FROM meeting_asset_probes WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid],
  )

  // ⑥ 会议维度的失败项标为已恢复：它的 target 编的是 `<meeting_id>|`，拆完之后
  //    再也不会有任何一轮往这个 target 上写。dead 资产下一轮由调度器按场次重新登记
  await conn.execute(
    `UPDATE job_failures SET resolved_at = ? WHERE target = ? AND resolved_at IS NULL`,
    [now, jobFailureTarget(mid, '')],
  )

  // ⑦ audit_log **不动**：它没有 sub 列，延长保留期的历史挂在 meeting_id 上。
  //    已知损失，写在 docs/2026-09-09-recurring-split-rollout.md 里

  await conn.execute(`DELETE FROM meetings WHERE meeting_id = ? AND sub_meeting_id = ''`, [mid])
}

/**
 * 按新场次把 NAS 侧车重写一遍。
 *
 * **侧车在 `nas_dir` 根上，不在会议目录里**（`writeNasSidecars` 落的是
 * `<nasDir>/meeting.json`），同一条归档规则渲染出的所有会议共用那一份，归档流水线
 * 每轮也是这么覆盖的。这里逐场次写一遍，最后一场留在盘上——与流水线现有行为一致,
 * 不在一次性脚本里另发明一套。所以 NAS 那边**没有**「旧目录里的侧车」要删。
 *
 * 写不出来不算失败：文件与库已经一致了，侧车下一轮归档还会再写。但要留痕。
 */
async function rewriteNasSidecars(pool: Pool, item: SplitItem, now: number): Promise<void> {
  if (item.nasDir === null) return
  const archives = createArchivesStore(pool)
  for (const s of item.sessions) {
    if (!s.archived) continue
    try {
      const rec = await archives.findMeetingArchive(item.meetingId, s.recordId)
      await writeNasSidecars({
        meetingId: item.meetingId,
        subMeetingId: s.recordId,
        meeting: {
          meetingId: item.meetingId, subMeetingId: s.recordId, meetingCode: s.meetingCode,
          subject: s.subject, hostUserId: s.hostUserId, startTime: s.startTime, endTime: s.endTime,
        },
        completed: await archives.listCompletedAssets(item.meetingId, s.recordId),
        archived: await archives.listArchivedAssetsForMeeting(item.meetingId, s.recordId),
        missing: await archives.listMissingAssets(item.meetingId, s.recordId),
        // 侧车落在 nas_dir 根上，所以 root 与 dir 是同一个：relative(root, dir) = ''
        nasRoot: item.nasDir,
        nasDir: item.nasDir,
        retentionDays: rec?.retentionDays ?? 30,
        now,
      })
    } catch (err) {
      console.warn(`⚠ ${item.meetingId}/${s.recordId} NAS 侧车没写成（文件与库已经一致，下一轮归档会补）：${err}`)
    }
  }
}

/**
 * 旧目录的收尾：先删掉旧目录里的 `_manifest.json` / `meeting.json`（本地那两份是
 * 按目录写的，留在旧目录里只会描述一个已经搬空了的地方，下一轮 worker 会按场次
 * 重新写出来），然后**空了才删目录**。
 *
 * 不空一律保留并记 left_over：里面躺着我们不认识的东西，删掉就再也找不回来了。
 */
async function cleanupOldDirs(
  item: SplitItem, planned: PlannedMove[], localRoot: string,
): Promise<string[]> {
  // 某个场次的**新**目录不在清理范围里：它刚刚才收到文件，本来就该有东西。
  // 周期会议里有一场的新目录恰好就是旧目录（start_time 最新的那一场，旧 meetings 行
  // 描述的正是它），不排除的话它会被当成"没搬干净的旧目录"报进 left_over
  const keep = new Set(planned.filter((p) => p.state !== 'gone').map((p) => dirname(p.to)))
  const dirs = new Set(planned.filter((p) => p.state === 'move').map((p) => dirname(p.from)))
  dirs.add(join(localRoot, item.oldRel))
  const leftOver: string[] = []
  for (const d of [...dirs].sort()) {
    if (keep.has(d)) continue
    if (!(await exists(d))) continue
    for (const f of ['_manifest.json', 'meeting.json']) {
      await rm(join(d, f), { force: true })
    }
    const rest = await readdir(d)
    // rmdir 而不是 rm：rm 对目录必须带 recursive，而带上它就成了「连里面的东西一起删」
    // ——这里要的恰恰是「只删空目录」，非空一律保留
    if (rest.length === 0) await rmdir(d)
    else leftOver.push(d)
  }
  return leftOver
}
```

- [ ] **Step 4: 写 main()**

同文件末尾：

```ts
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  const localRoot = process.env.MDE_ARCHIVE_ROOT
  if (!databaseUrl || !localRoot) {
    console.error('需要 DATABASE_URL 与 MDE_ARCHIVE_ROOT')
    return 2
  }
  console.log('提示：把输出留下来——`… 2>&1 | tee split-$(date +%s).log`')
  const pool = createPool(databaseUrl)
  try {
    await runMigrations(pool)
    if (!(await exists(localRoot))) {
      console.error(`‼ MDE_ARCHIVE_ROOT 不存在：${localRoot}`)
      return 2
    }
    const plan = await planSplits(pool, localRoot)

    // NAS 基准目录先各 stat 一次：挂载点没挂上时全部文件都会被判成"不在",
    // 整份计划安静地退化成 not_found——这种半拉子结果比直接不跑坏得多
    const nasDirs = [...new Set(plan.flatMap((i) => (i.nasDir === null ? [] : [i.nasDir])))]
    const missing: string[] = []
    for (const d of nasDirs) if (!(await exists(d))) missing.push(d)
    if (missing.length > 0) {
      for (const d of missing) console.error(`‼ NAS 基准目录不存在：${d}`)
      console.error('NAS 多半没挂上。挂好再跑——现在跑一场都动不了')
      if (args.apply) return 2
    }

    const counts = { renamed: 0, already_done: 0, not_found: 0, conflict: 0, undecidable: 0 }
    let failed = 0
    const leftOver: string[] = []
    for (const item of plan) {
      const who = item.meetingId
      const sessions = item.sessions.map((s) => `${s.recordId}→${s.newRel}(${s.assets.length} 个资产)`)
      if (item.undecidableReason !== null) {
        counts.undecidable++
        console.error(`⚠ ${who} undecidable：${item.undecidableReason}——这一场不动，请人工确认`)
        continue
      }
      console.log(`${who}\n  ${item.oldRel}\n  → ${sessions.join('\n  → ')}`)
      if (!args.apply) continue
      try {
        const r = await applyOne(pool, item, { localRoot, now: Math.floor(Date.now() / 1000) })
        counts[r.outcome]++
        leftOver.push(...r.leftOver)
        if (r.outcome === 'conflict') console.error('  conflict：目标文件已被别的东西占着，未动')
        else if (r.outcome === 'not_found') console.error('  not_found：新旧位置都找不到这些文件')
        else console.log(`  ok（${r.outcome}）`)
      } catch (err) {
        // 一场炸了不该把剩下几百场一起停掉——已经回滚干净了，接着跑
        failed++
        console.error(`  failed：${err}`)
      }
    }
    for (const d of leftOver) {
      console.error(`⚠ 旧目录里还有不认识的文件，已保留：${d}`)
    }
    console.log(
      args.apply
        ? `renamed=${counts.renamed} already_done=${counts.already_done} not_found=${counts.not_found} ` +
          `conflict=${counts.conflict} undecidable=${counts.undecidable} failed=${failed} left_over=${leftOver.length}`
        : `dry-run：${plan.length} 场会议待拆（其中 ${counts.undecidable} 场说不清），加 --apply 执行`,
    )
    // conflict / undecidable 是"要人来看"的结局，退出码 2（spec §2.4）；
    // failed 是"跑炸了"，退出码 1。两者分开，好让 CI 与 `&&` 串起来的下一条命令分得清
    if (counts.conflict > 0 || counts.undecidable > 0) return 2
    return failed > 0 ? 1 : 0
  } finally {
    await pool.end()
  }
}

// 被 import 时（测试）不自动执行
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => { console.error(err); process.exit(1) })
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/scripts/ && bun run typecheck`
Expected: PASS（split 12 条 + rename 既有那些全绿）

- [ ] **Step 6: 提交**

```bash
git add scripts/split-recurring-meetings.ts tests/scripts/split-recurring-meetings.test.ts
git commit -m "$(cat <<'EOF'
feat(scripts): 拆场次脚本的执行这一遍，一个事务改六张表并重写 NAS 侧车

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 扫尾 —— 剩下的空串、控制台 mock、文档与上线 runbook

**Files:**
- Modify: `src/worker/scheduler.ts:647-657`（只加注释，**不改行为**）
- Modify: `console/src/api/mock/meetings.ts`（加常量）、`console/src/api/mock/{jobs,storage,content,install,consumers,rules}.ts`（9 处）
- Modify: `docs/m3.5-integration-runbook.md:197`
- Modify: `client/README.md:34` 附近
- Create: `docs/2026-09-09-recurring-split-rollout.md`

**Interfaces:**
- Consumes: 前六个任务的全部产物。
- Produces: `MOCK_SUB_MEETING_ID`（`console/src/api/mock/meetings.ts` 导出的示例 record id）；上线 runbook。

- [ ] **Step 1: 核对 scheduler.ts 里剩下的两处空串**

`src/worker/scheduler.ts` 有两处 `subMeetingId: ''`，**都不改**，但要把理由写下来，免得下一个人照着「新代码不写空串」这条把它改错：

- 第 617 行 `subMeetingId: input.subMeetingId ?? ''`：这是 `JobFailInput` 的缺省值，调用方给了就用调用方的。会议维度的失败项由 `recordDeadAssets`（第 285-290 行）填，它带的是资产行自己的 `sub_meeting_id`，拆完之后就是 record id。
- 第 652 行 `subMeetingId: ''`：**整轮失败**那一条，`meetingId: null`、`target: ROUND_FAILURE_TARGET`（`'__round__'`）。它根本不是一场会议，没有场次可言。

在第 651 行 `meetingId: null,` 后面加一行注释：

```ts
          meetingId: null,
          // 整轮失败不是某一场会议的事（target 是 __round__），所以没有场次可填。
          // 「新代码不再写空 sub_meeting_id」那条规矩管的是会议行，不管这里
          subMeetingId: '',
```

Run: `grep -rn "subMeetingId: ''" src/` —— 除这两处外应当只剩 `src/worker/source-inproc.ts` 的 `getDownloadUrl` 里那个合成 Asset（`resolveDownloadUrl` 不读这两个字段，注释已经写明）。逐条确认没有遗漏的写入点。

- [ ] **Step 2: 控制台 mock 换成示例 record id**

`console/src/api/mock/meetings.ts`（`MOCK_NOW` 旁边）加：

```ts
/**
 * mock 里的示例场次 id。真实取值是腾讯的 `meeting_record_id`（一串纯数字），
 * 不是空串——空串是 2026-09-09 之前的写法，界面按两段键工作，示例数据也该长得像真的。
 */
export const MOCK_SUB_MEETING_ID = '2095448286274887680'
```

把 `console/src/api/mock/` 下 9 处 `subMeetingId: ''`（`jobs.ts:110`、`storage.ts:121`、`content.ts:210`、`install.ts:143/267/628/644`、`consumers.ts:165`、`rules.ts:471`）改成 `subMeetingId: MOCK_SUB_MEETING_ID`，各文件按需 `import { MOCK_SUB_MEETING_ID } from './meetings'`（`meetings.ts` 自己不在这 9 处里）。

Run: `cd console && bun run typecheck && bun run test`
Expected: PASS（mock 的 `subMeetingId` 只是 wire 字段，不参与 `id` 的构造，改它不影响任何路由）

- [ ] **Step 3: 改两处文档里过时的一句话**

`docs/m3.5-integration-runbook.md` 第 197 行那一行表格：

```markdown
| `sub_meeting_id` | ☐ | 场次 id，等于 `meeting_record_id`（2026-09-09 起；此前恒为 `''`） |
```

`client/README.md` 第 34 行（讲 `<out>/.mde/queue.sqlite` 那段）之后补一句：

```markdown
> 2026-09-09 起场次 id 取腾讯的 `meeting_record_id`，周期会议的每一场各占一个目录。
> **旧的 `queue.sqlite` 不做迁移**：换一个 `--out` 目录重新跑一遍即可，已经下载过的
> 文件仍在旧目录里，不会丢。
```

- [ ] **Step 4: 写上线 runbook**

新建 `docs/2026-09-09-recurring-split-rollout.md`：

```markdown
# 周期会议按录制记录拆场次 · 上线 runbook（2026-09-09）

依据：`docs/superpowers/specs/2026-09-09-recurring-meetings-by-record-design.md` §2.5。
本机实测基数：86 场「会议」装着 232 条录制记录，销售日会 6 个场次挤在一行里。

## 0. 上线前必须知道的一件事：audit_log 的已知损失

`audit_log` **没有** sub 列，延长保留期那条审计把场次编在 `asset_id` 里
（`sub:<subMeetingId>`，见 `src/store/audit.ts` 的 `auditSubMeetingAssetId`）。拆分
**不动这张表**，于是拆分之前记下的那些延长记录仍然挂在 `sub:` 上——控制台抽屉里
「延长过 N 次」这一行，对拆分**之前**的延长记录，每个场次都显示不到。

**这是有意接受的损失，不是 bug**：给 audit_log 补一列 sub 要重写一张只增不减的审计表，
而它换来的只是几条历史记录的归属。`meeting_archives.extended_days` 那一列（真正决定
保留窗口的那个数）**是**按场次复制过去的，到期时间不受影响。

## 1. 停

```bash
sudo systemctl stop mde-gateway mde-scheduler     # 服务器
```

本机如果开着调度器也一起停——脚本搬文件期间不能有人往那些目录里写。
另：STS token 全局单例，本机与服务器不要同时跑（见 memory `sts-single-active-token-per-app`）。

## 2. 部署新代码并跑迁移

```bash
git pull && bun install
bun -e 'import{createPool,runMigrations}from"./src/store/db";const p=createPool(process.env.DATABASE_URL!);await runMigrations(p);await p.end()'
```

迁移 013 把 `meeting_cache.sub_meeting_id` 回填成 `meeting_record_id`。它是幂等的。

## 3. 拆存量数据

```bash
export DATABASE_URL=...  MDE_ARCHIVE_ROOT=/data/meetings
bun scripts/split-recurring-meetings.ts 2>&1 | tee split-dry-$(date +%s).log
```

**先看 dry-run 的输出**，逐条确认：
- 每场会议列出的场次数与你在控制台上看到的日会次数对得上；
- `undecidable` 的那几场，逐条看理由（`meeting_cache` 里没有那个 record id / `asset_id`
  是空的 / 两个场次算出同一个目录 / NAS 基准目录讲不清楚）。**不要绕过它们**——
  退出码 2 就是让你停下来看这个的。

确认无误后：

```bash
bun scripts/split-recurring-meetings.ts --apply 2>&1 | tee split-$(date +%s).log
```

退出码：`0` 全好；`2` 有 conflict / undecidable（要人看）；`1` 有跑炸的会议
（已经逐场回滚干净，可以查完原因再跑一次——脚本可重复跑）。
输出末尾的 `left_over=N` 是「旧目录里还有不认识的文件、目录被保留了」的场数，
逐条看一眼那些目录里是什么。

## 4. 起

```bash
sudo systemctl start mde-gateway mde-scheduler
```

首轮 `fetch_recordings` 会按场次重建探测行与本地清单（`_manifest.json` / `meeting.json`）。

## 5. 验收

```sql
-- ① 周期会议已经拆开：这条要有行
SELECT meeting_id, COUNT(*) FROM meetings GROUP BY 1 HAVING COUNT(*) > 1;
-- ② 一行空 sub 都不许剩
SELECT COUNT(*) FROM meetings WHERE sub_meeting_id = '';
-- ③ 没有资产孤儿（资产指向的会议行必须在）
SELECT COUNT(*) FROM meeting_assets a
  LEFT JOIN meetings m USING(meeting_id, sub_meeting_id) WHERE m.meeting_id IS NULL;
```

①有行、②为 0、③为 0。

界面上：控制台会议列表里「销售日会」按日期一场次一行，每行资产计数 6；
盘上每个场次目录里 `transcript.txt` / `minutes.md` / `chapters.json` **不带 `_2` 后缀**
（除非同一场次真有多个录制文件）。

## 6. 回滚

**没有自动回滚**。脚本是逐场会议的事务 + 文件搬运，一场一场地成，中途停下来的
后果是「一部分会议拆了、一部分没拆」——这两种状态新代码都认（`sub_meeting_id = ''`
在读路径上仍然被容忍）。所以真出事时的动作是**停下来查**，不是往回退。

要退代码的话：旧代码读拆完的库同样能跑（它只是把每个场次当成一场独立会议），
唯一失去的是「按 sub 点名查」那个新 query 参数。库不必回滚。
```

- [ ] **Step 5: 全量跑一遍**

Run: `bun test && bun run typecheck && cd packages/engine && bun test && bun run typecheck && cd ../../console && bun run typecheck && bun run test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/worker/scheduler.ts console/src/api/mock docs/m3.5-integration-runbook.md \
        client/README.md docs/2026-09-09-recurring-split-rollout.md
git commit -m "$(cat <<'EOF'
docs: 拆场次的上线 runbook，控制台 mock 与两处文档跟上新的场次 id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```
