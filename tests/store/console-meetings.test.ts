import { expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import {
  ARCHIVE_GRACE_SEC,
  buildExtendCountSql,
  consoleMeetingId,
  createConsoleMeetingsStore,
  parseConsoleMeetingId,
} from '../../src/store/console-meetings'
import { expiresAt } from '../../src/worker/retention'
// 延长次数那一族用例要按**写侧真正填的那两列**去数（阶段 4 · T17）。
// 常量放在 audit.ts 而不是 handler 里，读写两侧共用同一份，见那里的注释。
import { ACTION_EXTEND_RETENTION, auditSubMeetingAssetId, createAuditStore } from '../../src/store/audit'
import { createArchivesStore } from '../../src/store/archives'
import { extendMeetingRetention } from '../../src/http/handlers/console/storage'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'

/**
 * 会议查询 store（阶段 4 · T1）。控制台会议记录页（spec §4.2）的数据底座。
 *
 * store 层不 mock 数据库，理由见 tests/helpers/testdb.ts。本文件测的**不是 CRUD 往返**
 * ——这个模块压根没有写侧——而是五条**只要一改就会静默出错**的判据：
 *
 * 1. **分诊条五格的定义**。五个数是管理员每天第一眼看的东西，其中「归档失败」
 *    是最高级别告警。每一格都单独钉住，包括「什么**不**该被数进去」——
 *    一个被人工关掉归档的会议算进「归档失败」，等于每天报一次假警。
 * 2. **保留窗口公式只有一处**。到期清理按 `retention.ts` 的 `expiresAt()` 挑候选，
 *    分诊条的「7 天内到期」在 SQL 里算同一个公式。两边漂了，界面会说「还剩 3 天」
 *    而清理昨天就把文件删了。下面有一条测试拿 `expiresAt()` 的返回值直接对着
 *    SQL 的计数断言，就是为了让漂移当场失败。
 * 3. **N+1 是不许的**。列一页 3 行和列一页 30 行，发出去的查询数必须**完全相同**。
 *    这条用一个数查询次数的 pool 代理钉死，不靠人读代码。
 * 4. **NULL 不许悄悄变成空串**。`meetings` 表的列全部 nullable，而契约
 *    （`console/src/api/types.ts` 的 `Meeting`）的字段是必填的。一场
 *    `subject IS NULL` 的会议和一场标题真的是空串的会议在界面上必须区分得开。
 * 5. **`getMeetings` 查不到的会议不造空壳顶上**。理由写在
 *    `src/worker/visibility.ts` 的 `VisibilityDeps.getMeetings` 上：空壳会让一条
 *    `title has 财务` 的规则对着空标题判不匹配，看起来一切正常。
 *
 * 每个用例各自持有一个隔离的测试库（跟随 tests/store/grants.test.ts 的约定）：
 * 本文件几乎每条断言都是「满足条件的行有几个」，别的用例漏一行进来就是假绿。
 */

// ── 播种 ────────────────────────────────────────────────────────────────

interface SeedMeetingInput {
  meetingId: string
  subMeetingId?: string
  meetingCode?: string | null
  subject?: string | null
  hostUserId?: string | null
  startTime?: number | null
  endTime?: number | null
}

async function seedMeeting(pool: Pool, input: SeedMeetingInput): Promise<void> {
  const {
    meetingId,
    subMeetingId = '',
    meetingCode = '888-000',
    subject = '周会',
    hostUserId = 'zhangsan',
    startTime = 1_700_000_000,
    endTime = 1_700_003_600,
  } = input
  await pool.execute(
    `INSERT INTO meetings
       (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1000, 1000)`,
    [meetingId, subMeetingId, meetingCode, subject, hostUserId, startTime, endTime],
  )
}

interface SeedAssetInput {
  meetingId: string
  subMeetingId?: string
  /** 库里存的是**网关的 asset_type**（meeting_summary / ai_meeting_transcripts…），
   *  不是客户端的 AssetKey。这个区分正是 M3.5 吃过亏的地方 */
  assetType?: string
  remoteId?: string
  fileType?: string
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'dead'
  bytesExpected?: number | null
  completedAt?: number | null
}

async function seedAsset(pool: Pool, input: SeedAssetInput): Promise<void> {
  const {
    meetingId,
    subMeetingId = '',
    assetType = 'video',
    remoteId = 'r-1',
    fileType = 'mp4',
    status = 'completed',
    bytesExpected = null,
    completedAt = null,
  } = input
  await pool.execute(
    `INSERT INTO meeting_assets
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path,
        bytes_written, bytes_expected, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026/08/d/a.bin', 0, ?, ?, 1000, 1000)`,
    [meetingId, subMeetingId, assetType, remoteId, fileType, status, bytesExpected, completedAt],
  )
}

interface SeedArchiveInput {
  meetingId: string
  subMeetingId?: string
  nasDir?: string
  archivedAt?: number
  retentionDays?: number
  extendedDays?: number
  localPurgedAt?: number | null
}

async function seedArchive(pool: Pool, input: SeedArchiveInput): Promise<void> {
  const {
    meetingId,
    subMeetingId = '',
    nasDir = '/nas/2026/08/m',
    archivedAt = 1_700_010_000,
    retentionDays = 30,
    extendedDays = 0,
    localPurgedAt = null,
  } = input
  await pool.execute(
    `INSERT INTO meeting_archives
       (meeting_id, sub_meeting_id, nas_dir, archived_at, retention_days, extended_days,
        local_purged_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1000, 1000)`,
    [meetingId, subMeetingId, nasDir, archivedAt, retentionDays, extendedDays, localPurgedAt],
  )
}

async function seedGrant(
  pool: Pool,
  input: { meetingId: string; subMeetingId?: string; programId: string; revokedAt?: number },
): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
     VALUES (?, ?, ?, NULL, 1000, ?)`,
    [input.meetingId, input.subMeetingId ?? '', input.programId, input.revokedAt ?? 0],
  )
}

async function seedOverride(
  pool: Pool,
  input: {
    meetingId: string
    subMeetingId?: string
    kind: 'fetch' | 'archive' | 'allow'
    effect: string
    assetTypes?: string[] | null
    revokedAt?: number
  },
): Promise<void> {
  await pool.execute(
    `INSERT INTO meeting_overrides
       (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, '测试用', 1000, ?)`,
    [
      input.meetingId,
      input.subMeetingId ?? '',
      input.kind,
      input.effect,
      input.assetTypes === undefined || input.assetTypes === null
        ? null
        : JSON.stringify(input.assetTypes),
      input.revokedAt ?? 0,
    ],
  )
}

/** 一条 allow 栈规则。conds 空数组 = 匹配全部会议（conds.ts 的 evaluateRule） */
async function seedAllowRule(
  pool: Pool,
  input: {
    programId: string | null
    effect?: string
    assetTypes?: string[]
    enabled?: boolean
    conds?: unknown[]
  },
): Promise<void> {
  await pool.execute(
    `INSERT INTO policy_rules
       (kind, priority, join_op, conds, subject_type, subject_value, asset_types, effect,
        note, created_by, enabled, created_at, updated_at)
     VALUES ('allow', 10, 'and', ?, ?, ?, ?, ?, NULL, NULL, ?, 1000, 1000)`,
    [
      JSON.stringify(input.conds ?? []),
      input.programId === null ? '' : 'program',
      input.programId ?? '',
      JSON.stringify(input.assetTypes ?? ['*']),
      input.effect ?? 'allow',
      input.enabled === false ? 0 : 1,
    ],
  )
}

/**
 * 数查询次数的 pool 代理。
 *
 * 「N+1 是不许的」这条验收要求测试能**证明**查询数与行数无关，而不是靠人读一遍
 * SQL 自己相信。代理只拦 execute / query 两个出口——store 拿不到别的口子发查询。
 */
function countingPool(pool: Pool): { pool: Pool; queries: () => number; reset: () => void } {
  let n = 0
  const proxy = new Proxy(pool, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (prop === 'execute' || prop === 'query') {
        return (...args: unknown[]) => {
          n += 1
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value
    },
  })
  return { pool: proxy as Pool, queries: () => n, reset: () => (n = 0) }
}

const NOW = 1_700_100_000

// ── 会议行的拼装 ─────────────────────────────────────────────────────────

test('list 拼装一行：标题/会议号/主持人/时长/资产/授权/改写/保留窗口一次给全', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, {
      meetingId: 'm-1',
      meetingCode: '123-456-789',
      subject: '财务月度复盘',
      hostUserId: 'lisi',
      startTime: 1_700_000_000,
      endTime: 1_700_005_400,
    })
    await seedAsset(pool, { meetingId: 'm-1', assetType: 'video', status: 'completed', bytesExpected: 1000 })
    await seedAsset(pool, {
      meetingId: 'm-1', assetType: 'meeting_summary', remoteId: 'r-2', fileType: 'txt',
      status: 'completed', bytesExpected: 24,
    })
    await seedAsset(pool, {
      meetingId: 'm-1', assetType: 'meeting_summary', remoteId: 'r-3', fileType: 'docx',
      status: 'dead',
    })
    await seedArchive(pool, { meetingId: 'm-1', archivedAt: 1_700_010_000, retentionDays: 30 })
    await seedGrant(pool, { meetingId: 'm-1', programId: 'kb-indexer' })
    await seedGrant(pool, { meetingId: 'm-1', programId: 'gone', revokedAt: 5000 })
    await seedOverride(pool, { meetingId: 'm-1', kind: 'allow', effect: 'allow' })

    const store = createConsoleMeetingsStore(pool)
    const { rows, total } = await store.list({ now: NOW })
    expect(total).toBe(1)
    const row = rows[0]!

    expect(row.meetingId).toBe('m-1')
    expect(row.subMeetingId).toBe('')
    expect(row.title).toBe('财务月度复盘')
    expect(row.code).toBe('123-456-789')
    expect(row.host).toBe('lisi')
    expect(row.startAt).toBe(1_700_000_000)
    expect(row.durationSec).toBe(5400)
    expect(row.missing).toEqual([])

    // 资产按 AssetKey 分组（库里存的是网关的 asset_type，这里必须换算过来），
    // 不适用的类不出现在对象里
    expect(row.assets).toEqual({
      video: { got: 1, total: 1 },
      transcript: { got: 1, total: 2 },
    })
    expect(row.sizeBytes).toBe(1024)

    // 生效授权才算数，撤销过的不算
    expect(row.grants).toEqual(['kb-indexer'])
    expect(row.hand).toEqual(['allow'])

    expect(row.keep.archivedAt).toBe(1_700_010_000)
    expect(row.keep.expiresAt).toBe(1_700_010_000 + 30 * 86400)
    expect(row.keep.retentionDays).toBe(30)
    expect(row.keep.extendedDays).toBe(0)
    expect(row.keep.filesGone).toBe(false)
    expect(row.nasPath).toBe('/nas/2026/08/m')
    expect(row.archive).toBe('done')
    expect(row.fetch).toBe('done')
  } finally {
    await cleanup()
  }
})

/** `identity_map` 的一行。姓名列不存在——这张表能给的最接近姓名的东西是 email */
async function seedIdentity(
  pool: Pool,
  input: { wecomUserId: string; tmUserId: string; email?: string | null; updatedAt?: number },
): Promise<void> {
  const { wecomUserId, tmUserId, email = null, updatedAt = 1000 } = input
  await pool.execute(
    `INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at) VALUES (?, ?, ?, ?)`,
    [wecomUserId, tmUserId, email, updatedAt],
  )
}

test('hostName：identity_map 命中时给邮箱的本地部分，host 仍是原始 userid', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', hostUserId: 'woaJARCQAAt_hKBw' })
    await seedIdentity(pool, {
      wecomUserId: 'zhangsan',
      tmUserId: 'woaJARCQAAt_hKBw',
      email: 'zhang.san@corp.com',
    })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    expect(rows[0]!.hostName).toBe('zhang.san')
    // 原始 userid **不被替换掉**：界面要拿它做 title 供复制，排查时也只有它有用
    expect(rows[0]!.host).toBe('woaJARCQAAt_hKBw')
  } finally {
    await cleanup()
  }
})

test('hostName：identity_map 是空表时为 null——那是本部署当前唯一会跑到的那条路径', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', hostUserId: 'woaJARCQAAt_hKBw' })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    // null 是「不知道他叫什么」。**不许**退回 host_userid：那样一来界面就分不出
    // 「这是姓名」和「这是主键」，而它现在正把主键当人名渲染
    expect(rows[0]!.hostName).toBeNull()
    expect(rows[0]!.host).toBe('woaJARCQAAt_hKBw')
  } finally {
    await cleanup()
  }
})

test('hostName：有映射行但 email 是 NULL 时仍是 null，不退回 wecom_userid', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', hostUserId: 'tm-1' })
    await seedIdentity(pool, { wecomUserId: 'zhangsan', tmUserId: 'tm-1', email: null })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    // 「表里有这个人」不等于「知道他叫什么」。退回 wecom_userid 只是换一串机器 id
    expect(rows[0]!.hostName).toBeNull()
  } finally {
    await cleanup()
  }
})

test('hostName：同一个 tm_userid 撞了两行时取最新的，且会议行不被复制成两行', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', hostUserId: 'tm-1' })
    // tm_userid 上没有唯一约束（主键是 wecom_userid），重复是可能出现的脏数据。
    // 这条测试同时钉两件事：取哪一条（最新），以及**分页行数不受它影响**
    // ——LEFT JOIN 的写法会在这里把 total 变成 2。
    await seedIdentity(pool, { wecomUserId: 'old', tmUserId: 'tm-1', email: 'old@corp.com', updatedAt: 1000 })
    await seedIdentity(pool, { wecomUserId: 'new', tmUserId: 'tm-1', email: 'new@corp.com', updatedAt: 2000 })

    const store = createConsoleMeetingsStore(pool)
    const { rows, total } = await store.list({ now: NOW })
    expect(total).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.hostName).toBe('new')
  } finally {
    await cleanup()
  }
})

test('不适用的资产类不出现在 assets 里，而不是 {got:0,total:0}', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedAsset(pool, { meetingId: 'm-1', assetType: 'audio' })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    expect(Object.keys(rows[0]!.assets)).toEqual(['audio'])
    // 这条是重点：video 这一类这场会议压根没有，就**不该出现**——
    // {got:0,total:0} 在界面上会渲染成「0/0」，看起来像一次失败的拉取
    expect(rows[0]!.assets.video).toBeUndefined()
  } finally {
    await cleanup()
  }
})

test('认不出的 asset_type 不被静默丢掉，单列在 unknownAssetTypes 里', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedAsset(pool, { meetingId: 'm-1', assetType: 'ai_future_minutes' })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    expect(rows[0]!.assets).toEqual({})
    expect(rows[0]!.unknownAssetTypes).toEqual(['ai_future_minutes'])
  } finally {
    await cleanup()
  }
})

test('NULL 列不悄悄变成空串：missing 标出来，与真的是空串的会议区分得开', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, {
      meetingId: 'm-null',
      subject: null, meetingCode: null, hostUserId: null, startTime: null, endTime: null,
    })
    await seedMeeting(pool, {
      meetingId: 'm-empty',
      subject: '', meetingCode: '', hostUserId: '', startTime: 0, endTime: 0,
    })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    const byId = new Map(rows.map((r) => [r.meetingId, r]))

    const nul = byId.get('m-null')!
    expect(nul.title).toBe('')
    expect(nul.missing).toEqual(['title', 'code', 'host', 'startAt', 'endAt'])

    const empty = byId.get('m-empty')!
    expect(empty.title).toBe('')
    // 两行的 title 都是空串，但 missing 把它们区分开了——这正是这条验收要的
    expect(empty.missing).toEqual([])
  } finally {
    await cleanup()
  }
})

test('durationSec：end<=start 视为没有结束时间数据，算 0 而不是负数', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', startTime: 2000, endTime: 2000 })
    await seedMeeting(pool, { meetingId: 'm-2', startTime: 2000, endTime: 1000 })
    await seedMeeting(pool, { meetingId: 'm-3', startTime: 2000, endTime: null })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    const byId = new Map(rows.map((r) => [r.meetingId, r]))
    expect(byId.get('m-1')!.durationSec).toBe(0)
    expect(byId.get('m-2')!.durationSec).toBe(0)
    expect(byId.get('m-3')!.durationSec).toBe(0)
    expect(byId.get('m-3')!.missing).toEqual(['endAt'])
  } finally {
    await cleanup()
  }
})

test('sizeBytes 只数 completed 行的 bytes_expected；一个都没有时是 null 不是 0', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedAsset(pool, { meetingId: 'm-1', bytesExpected: 100 })
    // pending 行不计入：它还没下载完，那个数字是平台声明值不是本地事实
    await seedAsset(pool, { meetingId: 'm-1', assetType: 'audio', remoteId: 'r-2', status: 'pending', bytesExpected: 999 })
    await seedMeeting(pool, { meetingId: 'm-2' })
    await seedAsset(pool, { meetingId: 'm-2', bytesExpected: null })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    const byId = new Map(rows.map((r) => [r.meetingId, r]))
    expect(byId.get('m-1')!.sizeBytes).toBe(100)
    // 「一个 completed 行都没有声明大小」是**算不出来**，不是 0 字节
    expect(byId.get('m-2')!.sizeBytes).toBeNull()
  } finally {
    await cleanup()
  }
})

// ── 阶段状态 ─────────────────────────────────────────────────────────────

test('fetch 状态：没有资产行是 none，有 pending/running 是 running，都终结是 done', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-none' })
    await seedMeeting(pool, { meetingId: 'm-run' })
    await seedAsset(pool, { meetingId: 'm-run', status: 'running' })
    await seedMeeting(pool, { meetingId: 'm-done' })
    await seedAsset(pool, { meetingId: 'm-done', status: 'completed' })
    await seedMeeting(pool, { meetingId: 'm-allfail' })
    await seedAsset(pool, { meetingId: 'm-allfail', status: 'dead' })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    const byId = new Map(rows.map((r) => [r.meetingId, r]))
    expect(byId.get('m-none')!.fetch).toBe('none')
    expect(byId.get('m-run')!.fetch).toBe('running')
    expect(byId.get('m-done')!.fetch).toBe('done')
    // 全部资产都放弃了：契约的 FetchState 没有 'failed' 这个取值，报 'none'（无录制）
    // 是错的——明明有录制，只是一个都没拉下来。got/total 会说出这件事
    expect(byId.get('m-allfail')!.fetch).toBe('done')
    expect(byId.get('m-allfail')!.assets).toEqual({ video: { got: 0, total: 1 } })
  } finally {
    await cleanup()
  }
})

test('人工把拉取关掉：fetch 是 off（不是 blocked——blocked 专指规则做的决定）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedAsset(pool, { meetingId: 'm-1', status: 'completed' })
    await seedOverride(pool, { meetingId: 'm-1', kind: 'fetch', effect: 'skip' })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    expect(rows[0]!.fetch).toBe('off')
    expect(rows[0]!.hand).toEqual(['fetch'])
  } finally {
    await cleanup()
  }
})

test('archive 状态：没有 completed 资产是 none，归档行在是 done，超过宽限没归档是 failed', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-none' })

    await seedMeeting(pool, { meetingId: 'm-done' })
    await seedAsset(pool, { meetingId: 'm-done', completedAt: NOW - 10 })
    await seedArchive(pool, { meetingId: 'm-done' })

    await seedMeeting(pool, { meetingId: 'm-running' })
    await seedAsset(pool, { meetingId: 'm-running', completedAt: NOW - 60 })

    await seedMeeting(pool, { meetingId: 'm-failed' })
    await seedAsset(pool, { meetingId: 'm-failed', completedAt: NOW - ARCHIVE_GRACE_SEC - 1 })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    const byId = new Map(rows.map((r) => [r.meetingId, r]))
    expect(byId.get('m-none')!.archive).toBe('none')
    expect(byId.get('m-done')!.archive).toBe('done')
    expect(byId.get('m-running')!.archive).toBe('running')
    expect(byId.get('m-failed')!.archive).toBe('failed')
  } finally {
    await cleanup()
  }
})

// ── 分诊条五格 ───────────────────────────────────────────────────────────

test('分诊条 archiveFailed：过了归档宽限还没进 meeting_archives 才算', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 算：有 completed 资产、无归档行、最后一个资产完成于宽限之外
    await seedMeeting(pool, { meetingId: 'm-late' })
    await seedAsset(pool, { meetingId: 'm-late', completedAt: NOW - ARCHIVE_GRACE_SEC - 1 })
    // 不算：还在宽限内（归档任务每小时整点跑，还没轮到不是失败）
    await seedMeeting(pool, { meetingId: 'm-fresh' })
    await seedAsset(pool, { meetingId: 'm-fresh', completedAt: NOW - 60 })
    // 不算：已经归档了
    await seedMeeting(pool, { meetingId: 'm-archived' })
    await seedAsset(pool, { meetingId: 'm-archived', completedAt: NOW - ARCHIVE_GRACE_SEC - 1 })
    await seedArchive(pool, { meetingId: 'm-archived' })
    // 不算：一个 completed 资产都没有，没东西可归档
    await seedMeeting(pool, { meetingId: 'm-empty' })
    await seedAsset(pool, { meetingId: 'm-empty', status: 'pending' })

    const store = createConsoleMeetingsStore(pool)
    expect((await store.triage(NOW)).archiveFailed).toBe(1)

    const { rows, total } = await store.list({ now: NOW, triage: 'archiveFailed' })
    expect(total).toBe(1)
    expect(rows[0]!.meetingId).toBe('m-late')
  } finally {
    await cleanup()
  }
})

test('被人工关掉归档的会议不算归档失败——最高级别告警不许每天报一次假警', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-off' })
    await seedAsset(pool, { meetingId: 'm-off', completedAt: NOW - ARCHIVE_GRACE_SEC - 1 })
    await seedOverride(pool, { meetingId: 'm-off', kind: 'archive', effect: 'skip' })

    const store = createConsoleMeetingsStore(pool)
    expect((await store.triage(NOW)).archiveFailed).toBe(0)
    // 计数与行状态必须同源：这一条同时钉住两侧，免得以后只改一边
    const { rows } = await store.list({ now: NOW })
    expect(rows[0]!.archive).toBe('off')
  } finally {
    await cleanup()
  }
})

test('分诊条 expiringIn7d：与 retention.ts 的 expiresAt() 是同一个公式', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 正好 7 天后到期（含边界）
    const onBoundary = { meetingId: 'm-edge', archivedAt: NOW + 7 * 86400 - 30 * 86400, retentionDays: 30, extendedDays: 0 }
    // 7 天零一秒后到期，不算
    const outside = { meetingId: 'm-out', archivedAt: NOW + 7 * 86400 + 1 - 30 * 86400, retentionDays: 30, extendedDays: 0 }
    // 已经过期但清理被暂停：文件还在，照样要提醒
    const overdue = { meetingId: 'm-overdue', archivedAt: NOW - 40 * 86400, retentionDays: 30, extendedDays: 0 }
    // 延长过：延长的天数要算进公式，否则刚延长完的会议还挂在琥珀格里
    const extended = { meetingId: 'm-ext', archivedAt: NOW - 25 * 86400, retentionDays: 30, extendedDays: 60 }
    for (const a of [onBoundary, outside, overdue, extended]) {
      await seedMeeting(pool, { meetingId: a.meetingId })
      await seedArchive(pool, a)
    }
    // 本地已清理的不算——它已经在「仅存 NAS」那一格了
    await seedMeeting(pool, { meetingId: 'm-purged' })
    await seedArchive(pool, { meetingId: 'm-purged', archivedAt: NOW - 40 * 86400, localPurgedAt: NOW - 100 })

    // 先用 retention.ts 的公式把期望值算出来，再拿它对 SQL 的计数——
    // 两边哪天漂了，这条测试当场红
    const expectCount = [onBoundary, outside, overdue, extended].filter(
      (a) =>
        expiresAt({
          meetingId: a.meetingId, subMeetingId: '', nasDir: '', archivedAt: a.archivedAt,
          retentionDays: a.retentionDays, extendedDays: a.extendedDays, localPurgedAt: null,
        }) -
          NOW <=
        7 * 86400,
    ).length
    expect(expectCount).toBe(2)

    const store = createConsoleMeetingsStore(pool)
    expect((await store.triage(NOW)).expiringIn7d).toBe(expectCount)

    const { rows } = await store.list({ now: NOW, triage: 'expiringIn7d' })
    expect(rows.map((r) => r.meetingId).sort()).toEqual(['m-edge', 'm-overdue'])
  } finally {
    await cleanup()
  }
})

test('分诊条 inProgress / nasOnly', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-pending' })
    await seedAsset(pool, { meetingId: 'm-pending', status: 'pending' })
    await seedMeeting(pool, { meetingId: 'm-running' })
    await seedAsset(pool, { meetingId: 'm-running', status: 'running' })
    await seedMeeting(pool, { meetingId: 'm-done' })
    await seedAsset(pool, { meetingId: 'm-done', status: 'completed' })

    await seedMeeting(pool, { meetingId: 'm-purged' })
    await seedArchive(pool, { meetingId: 'm-purged', localPurgedAt: NOW - 10 })

    const store = createConsoleMeetingsStore(pool)
    const t = await store.triage(NOW)
    expect(t.inProgress).toBe(2)
    expect(t.nasOnly).toBe(1)

    expect((await store.list({ now: NOW, triage: 'inProgress' })).total).toBe(2)
    const purged = await store.list({ now: NOW, triage: 'nasOnly' })
    expect(purged.rows.map((r) => r.meetingId)).toEqual(['m-purged'])
    expect(purged.rows[0]!.keep.filesGone).toBe(true)
  } finally {
    await cleanup()
  }
})

test('分诊条 awaitingGrant：规则判 allow 且一条生效授权都没有', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-wait' })
    await seedMeeting(pool, { meetingId: 'm-granted' })
    await seedGrant(pool, { meetingId: 'm-granted', programId: 'kb-indexer' })
    await seedAllowRule(pool, { programId: 'kb-indexer' })

    const store = createConsoleMeetingsStore(pool)
    expect((await store.triage(NOW)).awaitingGrant).toBe(1)
    const { rows, total } = await store.list({ now: NOW, triage: 'awaitingGrant' })
    expect(total).toBe(1)
    expect(rows[0]!.meetingId).toBe('m-wait')
  } finally {
    await cleanup()
  }
})

test('没有任何采集权限规则时 awaitingGrant 是 0——兜底 deny，谁都没被准许', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedAsset(pool, { meetingId: 'm-1', status: 'completed' })

    const store = createConsoleMeetingsStore(pool)
    // 这里若报 1，管理员会看到一格「1 场待授权」，而实际上规则集是空的：
    // 就算他真去授权了，采集权限栈照样兜底 deny，程序还是取不到
    expect((await store.triage(NOW)).awaitingGrant).toBe(0)
  } finally {
    await cleanup()
  }
})

test('停用的规则不算准许；effect=deny 的规则也不算', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedAllowRule(pool, { programId: 'p-1', enabled: false })
    await seedAllowRule(pool, { programId: 'p-2', effect: 'deny' })

    const store = createConsoleMeetingsStore(pool)
    expect((await store.triage(NOW)).awaitingGrant).toBe(0)
  } finally {
    await cleanup()
  }
})

test('人工改写优先于规则：改写成 deny 的不算待授权，改写成 allow 的算', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-denied' })
    await seedOverride(pool, { meetingId: 'm-denied', kind: 'allow', effect: 'deny' })
    await seedMeeting(pool, { meetingId: 'm-forced' })
    await seedOverride(pool, {
      meetingId: 'm-forced', kind: 'allow', effect: 'allow', assetTypes: ['video'],
    })
    // 规则本身对两场都判 allow
    await seedAllowRule(pool, { programId: 'p-1' })

    const store = createConsoleMeetingsStore(pool)
    expect((await store.triage(NOW)).awaitingGrant).toBe(1)
    const { rows } = await store.list({ now: NOW, triage: 'awaitingGrant' })
    expect(rows.map((r) => r.meetingId)).toEqual(['m-forced'])
  } finally {
    await cleanup()
  }
})

test('规则集为空但有一条 allow 改写：改写照样把会议推进待授权格', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedOverride(pool, { meetingId: 'm-1', kind: 'allow', effect: 'allow', assetTypes: ['video'] })

    const store = createConsoleMeetingsStore(pool)
    // 「没有规则就早退」这个优化不能把改写一起早退掉：改写优先于所有规则，
    // 它不需要任何规则存在就能生效
    expect((await store.triage(NOW)).awaitingGrant).toBe(1)
  } finally {
    await cleanup()
  }
})

test('effect=allow 但 asset_types 里一个合法资产键都没有的规则不算准许', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    // 'summary' 是原型里的短名，不是合法 AssetKey——判定是 allow 而实际一类都取不到
    await seedAllowRule(pool, { programId: 'p-1', assetTypes: ['summary'] })

    const store = createConsoleMeetingsStore(pool)
    expect((await store.triage(NOW)).awaitingGrant).toBe(0)
  } finally {
    await cleanup()
  }
})

test('五格是各自独立的计数，同一场会议可以同时落进多格', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 本地已清理 + 快到期：nasOnly 数它，expiringIn7d 不数（文件都没了）
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedAsset(pool, { meetingId: 'm-1', status: 'pending' })
    await seedArchive(pool, { meetingId: 'm-1', archivedAt: NOW - 29 * 86400, localPurgedAt: NOW - 5 })

    const store = createConsoleMeetingsStore(pool)
    const t = await store.triage(NOW)
    expect(t).toEqual({
      archiveFailed: 0,
      expiringIn7d: 0,
      awaitingGrant: 0,
      inProgress: 1,
      nasOnly: 1,
    })
  } finally {
    await cleanup()
  }
})

// ── 搜索与筛选 ───────────────────────────────────────────────────────────

test('search 同时命中标题 / 会议号 / 主持人', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-title', subject: '财务复盘', meetingCode: '111', hostUserId: 'a' })
    await seedMeeting(pool, { meetingId: 'm-code', subject: '别的', meetingCode: '财务-222', hostUserId: 'b' })
    await seedMeeting(pool, { meetingId: 'm-host', subject: '别的', meetingCode: '333', hostUserId: '财务c' })
    await seedMeeting(pool, { meetingId: 'm-no', subject: '别的', meetingCode: '444', hostUserId: 'd' })

    const store = createConsoleMeetingsStore(pool)
    const { rows, total } = await store.list({ now: NOW, search: '财务' })
    expect(total).toBe(3)
    expect(rows.map((r) => r.meetingId).sort()).toEqual(['m-code', 'm-host', 'm-title'])
  } finally {
    await cleanup()
  }
})

test('search 里的 % 与 _ 是字面量，不是通配符', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-lit', subject: '进度_周会' })
    await seedMeeting(pool, { meetingId: 'm-any', subject: '进度X周会' })

    const store = createConsoleMeetingsStore(pool)
    // 不转义的话 `_` 会匹配任意一个字符，管理员搜出来的是另一批会议
    const { rows } = await store.list({ now: NOW, search: '度_周' })
    expect(rows.map((r) => r.meetingId)).toEqual(['m-lit'])
  } finally {
    await cleanup()
  }
})

test('hasGrant / hasOverride / inRetention 三个筛选', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-grant' })
    await seedGrant(pool, { meetingId: 'm-grant', programId: 'p-1' })
    await seedMeeting(pool, { meetingId: 'm-revoked' })
    await seedGrant(pool, { meetingId: 'm-revoked', programId: 'p-1', revokedAt: 9 })

    await seedMeeting(pool, { meetingId: 'm-hand' })
    await seedOverride(pool, { meetingId: 'm-hand', kind: 'archive', effect: '/nas/x/' })

    // 在保留期内的两种形态：归档了且没清理 · 没归档但本地有下载完成的资产
    await seedMeeting(pool, { meetingId: 'm-kept' })
    await seedArchive(pool, { meetingId: 'm-kept' })
    await seedMeeting(pool, { meetingId: 'm-local' })
    await seedAsset(pool, { meetingId: 'm-local', status: 'completed' })
    await seedMeeting(pool, { meetingId: 'm-purged' })
    await seedArchive(pool, { meetingId: 'm-purged', localPurgedAt: 9 })

    const store = createConsoleMeetingsStore(pool)
    expect((await store.list({ now: NOW, hasGrant: true })).rows.map((r) => r.meetingId)).toEqual(['m-grant'])
    expect((await store.list({ now: NOW, hasOverride: true })).rows.map((r) => r.meetingId)).toEqual(['m-hand'])
    const kept = await store.list({ now: NOW, inRetention: true })
    expect(kept.rows.map((r) => r.meetingId).sort()).toEqual(['m-kept', 'm-local'])
    const gone = await store.list({ now: NOW, inRetention: false })
    expect(gone.rows.map((r) => r.meetingId).sort()).toEqual([
      'm-grant', 'm-hand', 'm-purged', 'm-revoked',
    ])
  } finally {
    await cleanup()
  }
})

test('分页：total 是筛选后的总数，不是本页行数；顺序按开始时间倒序且稳定', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    for (let i = 0; i < 5; i++) {
      await seedMeeting(pool, { meetingId: `m-${i}`, startTime: 1000 + i })
    }
    // 没有开始时间的排最后：它在界面上没有可读的时间，不该插在中间
    await seedMeeting(pool, { meetingId: 'm-notime', startTime: null })

    const store = createConsoleMeetingsStore(pool)
    const page1 = await store.list({ now: NOW, limit: 2, offset: 0 })
    expect(page1.total).toBe(6)
    expect(page1.rows.map((r) => r.meetingId)).toEqual(['m-4', 'm-3'])

    const page2 = await store.list({ now: NOW, limit: 2, offset: 2 })
    expect(page2.rows.map((r) => r.meetingId)).toEqual(['m-2', 'm-1'])

    const last = await store.list({ now: NOW, limit: 2, offset: 4 })
    expect(last.rows.map((r) => r.meetingId)).toEqual(['m-0', 'm-notime'])
  } finally {
    await cleanup()
  }
})

// ── keep.extended：延长次数（阶段 4 · T17）────────────────────────────────

/**
 * 一条「延长保留」审计。**列的填法必须与 `recordAdminWrite` 逐字一致**，
 * 否则这些用例测的是一个真实写侧从来不会产出的形状——所以 action 与 asset_id
 * 都走 `src/store/audit.ts` 导出的那两个共享常量，不在这里另抄一份字面量。
 */
async function seedExtendAudit(
  pool: Pool,
  input: {
    meetingId: string
    subMeetingId?: string
    occurredAt: number
    action?: string
    decision?: 'allow' | 'deny'
  },
): Promise<void> {
  await pool.execute(
    `INSERT INTO audit_log
       (occurred_at, actor_type, actor_id, action, meeting_id, asset_id, asset_type,
        decision, matched_rule, client_kind)
     VALUES (?, 'admin', 'admin-1', ?, ?, ?, '延长 30 天（累计 30 天）', ?, NULL, 'console')`,
    [
      input.occurredAt,
      input.action ?? ACTION_EXTEND_RETENTION,
      input.meetingId,
      auditSubMeetingAssetId(input.subMeetingId ?? ''),
      input.decision ?? 'allow',
    ],
  )
}

test('keep.extended 是审计里数出来的真实次数，不再是「延长过就报 1」的下界', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    // 两次 30 天，而不是一次 60 天——这正是 extended_days 换算不回次数的那个歧义
    await seedArchive(pool, { meetingId: 'm-1', archivedAt: 1_700_010_000, extendedDays: 60 })
    await seedExtendAudit(pool, { meetingId: 'm-1', occurredAt: 1_700_020_000 })
    await seedExtendAudit(pool, { meetingId: 'm-1', occurredAt: 1_700_030_000 })

    const store = createConsoleMeetingsStore(pool)
    const row = (await store.list({ now: NOW })).rows[0]!
    expect(row.keep.extended).toBe(2)
    expect(row.keep.extendedSource).toBe('audit')
    // 天数那个字段是准确的，界面上「延长了多少天」照旧用它
    expect(row.keep.extendedDays).toBe(60)

    // get() 走同一条拼装路径，两处不许分叉
    const one = await store.get('m-1', '', NOW)
    expect(one!.keep.extended).toBe(2)
  } finally {
    await cleanup()
  }
})

test('T8 之前延长过的会议：审计里一条都没有，报下界 1 而不是 0', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-old' })
    await seedArchive(pool, { meetingId: 'm-old', extendedDays: 60 })

    const store = createConsoleMeetingsStore(pool)
    const keep = (await store.list({ now: NOW })).rows[0]!.keep
    // 报 0 等于说「从没延长过」，而 extendedDays 明明是 60——两个字段不许打架
    expect(keep.extended).toBe(1)
    expect(keep.extendedSource).toBe('floor')
    expect(keep.extendedDays).toBe(60)
  } finally {
    await cleanup()
  }
})

test('extended_days 说了算「有没有延长过」：它是 0 时，审计里的孤儿记录不算数', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 归档过、但从没延长过
    await seedMeeting(pool, { meetingId: 'm-fresh' })
    await seedArchive(pool, { meetingId: 'm-fresh', archivedAt: 1_700_010_000, extendedDays: 0 })
    // 归档记录被重建过（重复归档会把 archived_at 推后、但一个字都不碰 extended_days），
    // 于是审计里留着上一轮的记录。extended_days = 0 时它不该让 extended 变成 2
    await seedExtendAudit(pool, { meetingId: 'm-fresh', occurredAt: 1_700_020_000 })
    await seedExtendAudit(pool, { meetingId: 'm-fresh', occurredAt: 1_700_030_000 })

    // 压根还没归档：保留窗口还没开始计时，也就没有「延长过」这回事
    await seedMeeting(pool, { meetingId: 'm-unarchived' })
    await seedExtendAudit(pool, { meetingId: 'm-unarchived', occurredAt: 1_700_020_000 })

    const store = createConsoleMeetingsStore(pool)
    const fresh = (await store.get('m-fresh', '', NOW))!.keep
    expect(fresh.extended).toBe(0)
    expect(fresh.extendedSource).toBe('none')

    const unarchived = (await store.get('m-unarchived', '', NOW))!.keep
    expect(unarchived.archivedAt).toBeNull()
    expect(unarchived.extended).toBe(0)
    expect(unarchived.extendedSource).toBe('none')
  } finally {
    await cleanup()
  }
})

test('只有本轮窗口内、而且真的做成了的那些延长才算数', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedArchive(pool, { meetingId: 'm-1', archivedAt: 1_700_010_000, extendedDays: 30 })
    // 上一轮归档窗口里的延长，早于现在这个 archived_at——不属于这一轮
    await seedExtendAudit(pool, { meetingId: 'm-1', occurredAt: 1_700_000_000 })
    // 起点那一刻算数（含边界）
    await seedExtendAudit(pool, { meetingId: 'm-1', occurredAt: 1_700_010_000 })
    // 别的管理动作不算
    await seedExtendAudit(pool, { meetingId: 'm-1', occurredAt: 1_700_020_000, action: 'purge_local' })
    // 被拒绝的尝试不算——那是一次没做成的延长，不是一次延长
    await seedExtendAudit(pool, { meetingId: 'm-1', occurredAt: 1_700_021_000, decision: 'deny' })

    // 同一页里另有一场归档得早得多的会议。它把**全页那个统一下界**拉到了
    // 1_699_900_000——如果逐场的 `occurred_at >= archived_at` 被谁省掉、只剩全页
    // 那一层，m-1 上面那条上一轮的记录就会被数进来，这里会变成 2。
    // 这条会议本身在这一页里的次数也要对（它自己那条记录在自己的窗口内）。
    await seedMeeting(pool, { meetingId: 'm-old', startTime: 1_699_000_000 })
    await seedArchive(pool, { meetingId: 'm-old', archivedAt: 1_699_900_000, extendedDays: 30 })
    await seedExtendAudit(pool, { meetingId: 'm-old', occurredAt: 1_699_950_000 })

    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    const byId = new Map(rows.map((r) => [r.meetingId, r.keep]))
    expect(byId.get('m-1')!.extended).toBe(1)
    expect(byId.get('m-1')!.extendedSource).toBe('audit')
    expect(byId.get('m-old')!.extended).toBe(1)
  } finally {
    await cleanup()
  }
})

test('周期性会议：同一个 meeting_id 下的两个场次各数各的', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', subMeetingId: '' })
    await seedMeeting(pool, { meetingId: 'm-1', subMeetingId: 's-2' })
    await seedArchive(pool, { meetingId: 'm-1', subMeetingId: '', extendedDays: 30 })
    await seedArchive(pool, { meetingId: 'm-1', subMeetingId: 's-2', extendedDays: 90 })
    await seedExtendAudit(pool, { meetingId: 'm-1', subMeetingId: '', occurredAt: 1_700_020_000 })
    for (const at of [1_700_020_000, 1_700_021_000, 1_700_022_000]) {
      await seedExtendAudit(pool, { meetingId: 'm-1', subMeetingId: 's-2', occurredAt: at })
    }

    const store = createConsoleMeetingsStore(pool)
    // **必须走 list**：两场会议要落在**同一条**审计聚合查询里，分组分错了才看得出来。
    // 逐场 get() 的那条查询里只有一个场次，WHERE 就把别的场次滤掉了，分组键少一列
    // 也照样绿——这正是这条用例差点漏掉的东西。
    const rows = (await store.list({ now: NOW })).rows
    const bySub = new Map(rows.map((r) => [r.subMeetingId, r.keep]))
    // 只按 meeting_id 分组的话两场都会报 4——审计表没有 sub_meeting_id 列，
    // 场次信息只在 asset_id 里（`sub:<subMeetingId>`）
    expect(bySub.get('')!.extended).toBe(1)
    expect(bySub.get('s-2')!.extended).toBe(3)
  } finally {
    await cleanup()
  }
})

test('数延长次数不是 N+1：30 场都延长过时，查询数与 3 场时完全相同', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    for (let i = 0; i < 30; i++) {
      const id = `m-${String(i).padStart(2, '0')}`
      await seedMeeting(pool, { meetingId: id, startTime: 1000 + i })
      await seedArchive(pool, { meetingId: id, archivedAt: 1_700_010_000, extendedDays: 30 })
      await seedExtendAudit(pool, { meetingId: id, occurredAt: 1_700_020_000 })
      await seedExtendAudit(pool, { meetingId: id, occurredAt: 1_700_021_000 })
    }

    const counted = countingPool(pool)
    const store = createConsoleMeetingsStore(counted.pool)

    counted.reset()
    const small = await store.list({ now: NOW, limit: 3 })
    const smallQueries = counted.queries()

    counted.reset()
    const big = await store.list({ now: NOW, limit: 30 })
    const bigQueries = counted.queries()

    expect(small.rows.every((r) => r.keep.extended === 2)).toBe(true)
    expect(big.rows).toHaveLength(30)
    expect(big.rows.every((r) => r.keep.extended === 2)).toBe(true)
    expect(bigQueries).toBe(smallQueries)
    // 比 T1 那条上界只多一次：整页一条审计聚合查询，不是逐行查
    expect(smallQueries).toBeLessThanOrEqual(7)
  } finally {
    await cleanup()
  }
})

/**
 * `audit_log` 上**没有 `meeting_id` 索引**，只有 `idx_audit_time` 与
 * `idx_audit_actor`（001 的建表）。所以「按会议数延长次数」这条查询能不能不退化成
 * 全表扫，全靠 `buildExtendCountSql` 塞进去的那个时间下界。
 *
 * 这条断言**打在真正跑的那条语句上**（EXPLAIN 的是 store 拿去执行的同一个字符串），
 * 沿用 tests/store/audit.test.ts 里那条计划断言的做法：另抄一条等价 SQL 去 EXPLAIN
 * 是自欺——改了实现忘了改测试，测试照样绿。
 */
test('数延长次数的那条查询走 idx_audit_time，不是全表扫', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 优化器按成本选计划，几十行的表上它会直接全表扫。灌够行数这条断言才有意义
    // （与 audit.test.ts 那条同一手法、同一规模）
    const base = 1_700_000_000
    const values: unknown[] = []
    const placeholders: string[] = []
    for (let i = 0; i < 400; i++) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      values.push(base + i * 1000, 'admin', `admin-${i % 40}`, ACTION_EXTEND_RETENTION,
        `plan-m-${i % 20}`, auditSubMeetingAssetId(''), '延长 30 天', 'allow', null, 'console')
    }
    await pool.query(
      `INSERT INTO audit_log
         (occurred_at, actor_type, actor_id, action, meeting_id, asset_id, asset_type,
          decision, matched_rule, client_kind)
       VALUES ${placeholders.join(', ')}`,
      values,
    )
    await pool.query('ANALYZE TABLE audit_log')

    // 下界取在最后一段：一页会议的 archived_at 通常离现在不远，这正是那个下界
    // 该起作用的形态
    const since = base + 380 * 1000
    const built = buildExtendCountSql([
      { meetingId: 'plan-m-1', subMeetingId: '', since },
      { meetingId: 'plan-m-2', subMeetingId: '', since },
    ])!
    const [plan] = await pool.query<RowDataPacket[]>(`EXPLAIN ${built.sql}`, built.params)
    const row = plan[0] as { key: string | null; type: string }
    expect(row.key).toBe('idx_audit_time')
    // range 而不是 index：后者是"把整个索引从头扫到尾"，正是没有下界时的样子
    expect(row.type).toBe('range')

    expect(buildExtendCountSql([])).toBeNull()
  } finally {
    await cleanup()
  }
})

/**
 * 写侧与读侧的**同源性**：真的调一次 `extendMeetingRetention` handler（真库、
 * 真 ArchivesStore、真 AuditStore），再从 store 读回来。
 *
 * 这条用例是本文件唯一一处 import HTTP handler 的地方，理由与
 * tests/http/console-storage.test.ts 里那条 `cleanup_paused` 极性用例相同：
 * 「延长次数」这件事横跨两个模块——一边往 `audit_log` 写 action/asset_id，
 * 一边按 action/asset_id 数。两边任何一侧改了列的填法，靠注释叮嘱挡不住，
 * 靠这条能。它同时也钉住了「两次 30 天」数出来确实是 2、而不是 60 或 1。
 */
test('写侧与读侧同源：真的延长两次之后，keep.extended 是 2', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1' })
    await seedArchive(pool, {
      meetingId: 'm-1',
      archivedAt: NOW - 10 * 86400,
      retentionDays: 30,
      extendedDays: 0,
    })

    const ctx = {
      params: { meetingId: 'm-1' },
      deps: {
        now: () => NOW,
        adminAuth: {
          async verifySession() {
            // role 是阶段 5 · A8 加的。漏掉它这条用例会拿到 403——
            // requireAdminWrite 只放行明确是 'admin' 的角色，拿不到角色按只读处理
            return { adminId: 'admin-1', username: 'alice', role: 'admin' }
          },
        },
        storage: { archives: createArchivesStore(pool), audit: createAuditStore(pool) },
      },
    } as unknown as Parameters<typeof extendMeetingRetention>[1]

    for (let i = 0; i < 2; i++) {
      const res = await extendMeetingRetention(
        new Request('https://gw.example/api/v1/admin/meetings/m-1/extend', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `${ADMIN_SESSION_COOKIE}=tok` },
          body: JSON.stringify({}),
        }),
        ctx,
      )
      expect(res.status).toBe(200)
    }

    const store = createConsoleMeetingsStore(pool)
    const keep = (await store.get('m-1', '', NOW))!.keep
    expect(keep.extendedDays).toBe(60)
    expect(keep.extended).toBe(2)
    expect(keep.extendedSource).toBe('audit')
  } finally {
    await cleanup()
  }
})

// ── N+1 ─────────────────────────────────────────────────────────────────

test('N+1 不许有：列 3 行与列 30 行发出去的查询数完全相同', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    for (let i = 0; i < 30; i++) {
      const id = `m-${String(i).padStart(2, '0')}`
      await seedMeeting(pool, { meetingId: id, startTime: 1000 + i })
      await seedAsset(pool, { meetingId: id, completedAt: 2000 })
      await seedAsset(pool, { meetingId: id, assetType: 'audio', remoteId: 'r-2', status: 'pending' })
      await seedArchive(pool, { meetingId: id })
      await seedGrant(pool, { meetingId: id, programId: 'p-1' })
      await seedOverride(pool, { meetingId: id, kind: 'fetch', effect: 'all' })
    }

    const counted = countingPool(pool)
    const store = createConsoleMeetingsStore(counted.pool)

    counted.reset()
    const small = await store.list({ now: NOW, limit: 3 })
    const smallQueries = counted.queries()

    counted.reset()
    const big = await store.list({ now: NOW, limit: 30 })
    const bigQueries = counted.queries()

    expect(small.rows).toHaveLength(3)
    expect(big.rows).toHaveLength(30)
    expect(bigQueries).toBe(smallQueries)
    // 顺带钉住量级：分页 1 + 计数 1 + 资产/授权/改写各 1 + 主持人姓名 1，
    // 再多就是有人偷偷加了逐行查询
    expect(smallQueries).toBeLessThanOrEqual(6)
  } finally {
    await cleanup()
  }
})

test('triage 的查询数与会议数无关', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedAllowRule(pool, { programId: 'p-1' })
    for (let i = 0; i < 20; i++) {
      await seedMeeting(pool, { meetingId: `m-${i}` })
      await seedAsset(pool, { meetingId: `m-${i}`, completedAt: 2000 })
    }

    const counted = countingPool(pool)
    const store = createConsoleMeetingsStore(counted.pool)
    counted.reset()
    await store.triage(NOW)
    expect(counted.queries()).toBeLessThanOrEqual(5)
  } finally {
    await cleanup()
  }
})

// ── get ──────────────────────────────────────────────────────────────────

test('get 按真实主键取，周期性会议的两个场次不互相顶替', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', subMeetingId: '', subject: '主场次' })
    await seedMeeting(pool, { meetingId: 'm-1', subMeetingId: 's-2', subject: '第二场' })

    const store = createConsoleMeetingsStore(pool)
    expect((await store.get('m-1', '', NOW))!.title).toBe('主场次')
    expect((await store.get('m-1', 's-2', NOW))!.title).toBe('第二场')
    expect(await store.get('m-1', 's-9', NOW)).toBeNull()
    expect(await store.get('nope', '', NOW)).toBeNull()
  } finally {
    await cleanup()
  }
})

// ── 行 id ────────────────────────────────────────────────────────────────

test('行 id 可往返，且 ("a,b","") 与 ("a","b") 不撞成同一个', async () => {
  const a = consoleMeetingId('a,b', '')
  const b = consoleMeetingId('a', 'b')
  expect(a).not.toBe(b)
  expect(parseConsoleMeetingId(a)).toEqual({ meetingId: 'a,b', subMeetingId: '' })
  expect(parseConsoleMeetingId(b)).toEqual({ meetingId: 'a', subMeetingId: 'b' })
  expect(parseConsoleMeetingId(consoleMeetingId('m/1', 's 2'))).toEqual({
    meetingId: 'm/1',
    subMeetingId: 's 2',
  })
})

test('list 给出的 id 解回来就是这一行的主键', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', subMeetingId: 's-2' })
    const store = createConsoleMeetingsStore(pool)
    const { rows } = await store.list({ now: NOW })
    expect(parseConsoleMeetingId(rows[0]!.id)).toEqual({ meetingId: 'm-1', subMeetingId: 's-2' })
  } finally {
    await cleanup()
  }
})

// ── getMeetings（visibility.ts 的数据源）────────────────────────────────

test('getMeetings 查不到的会议不造空壳顶上——数组里就是没有它', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', subject: '财务复盘' })

    const store = createConsoleMeetingsStore(pool)
    const got = await store.getMeetings([
      { meetingId: 'm-1', subMeetingId: '' },
      { meetingId: 'ghost', subMeetingId: '' },
    ])
    expect(got).toHaveLength(1)
    expect(got[0]!.meetingId).toBe('m-1')
    expect(got[0]!.subject).toBe('财务复盘')
    // 空壳会让一条 `title has 财务` 的规则对着空标题判不匹配，看起来一切正常
    expect(got.some((m) => m.meetingId === 'ghost')).toBe(false)
  } finally {
    await cleanup()
  }
})

test('getMeetings 一次问清一批，且传空数组时不查库', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    for (let i = 0; i < 10; i++) await seedMeeting(pool, { meetingId: `m-${i}` })

    const counted = countingPool(pool)
    const store = createConsoleMeetingsStore(counted.pool)

    counted.reset()
    expect(await store.getMeetings([])).toEqual([])
    expect(counted.queries()).toBe(0)

    counted.reset()
    const keys = Array.from({ length: 10 }, (_, i) => ({ meetingId: `m-${i}`, subMeetingId: '' }))
    expect(await store.getMeetings(keys)).toHaveLength(10)
    expect(counted.queries()).toBe(1)
  } finally {
    await cleanup()
  }
})

test('getMeetings 的 NULL 列按仓库既有口径补齐（文本空串、时间 0），行本身照样返回，并记一笔 missingFacts', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, {
      meetingId: 'm-null', subject: null, hostUserId: null, meetingCode: null,
      startTime: null, endTime: null,
    })
    const store = createConsoleMeetingsStore(pool)
    const [m] = await store.getMeetings([{ meetingId: 'm-null', subMeetingId: '' }])
    expect(m).toEqual({
      meetingId: 'm-null',
      subMeetingId: '',
      meetingRecordId: '',
      meetingCode: '',
      subject: '',
      hostUserId: '',
      startTime: 0,
      endTime: 0,
      state: 'completed',
      // 阶段 4 · T13：折成空串的同时记账，判定才分得开「标题是空的」与「没有标题」。
      // meeting_code 不在内——它不参与任何条件求值，不是一项「事实」
      missingFacts: ['title', 'hostUserId', 'startTime', 'endTime'],
    })
  } finally {
    await cleanup()
  }
})

test('getMeetings：列有真实值（哪怕是空串 / 0）时不记 missingFacts——这正是 T13 要分开的两件事', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, {
      meetingId: 'm-empty', subject: '', hostUserId: '', meetingCode: '',
      startTime: 0, endTime: 0,
    })
    await seedMeeting(pool, { meetingId: 'm-notitle', subject: null })

    const store = createConsoleMeetingsStore(pool)
    const [empty] = await store.getMeetings([{ meetingId: 'm-empty', subMeetingId: '' }])
    const [noTitle] = await store.getMeetings([{ meetingId: 'm-notitle', subMeetingId: '' }])

    // 两行的 subject 都是空串，但一行是「事实为空」、另一行是「没有这个事实」
    expect(empty!.subject).toBe('')
    expect(empty!.missingFacts).toBeUndefined()
    expect(noTitle!.subject).toBe('')
    expect(noTitle!.missingFacts).toEqual(['title'])
  } finally {
    await cleanup()
  }
})

test('getMeetings 按真实主键匹配，不会把另一个场次顶上来', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', subMeetingId: '', subject: '主场次' })
    await seedMeeting(pool, { meetingId: 'm-1', subMeetingId: 's-2', subject: '第二场' })

    const store = createConsoleMeetingsStore(pool)
    const got = await store.getMeetings([{ meetingId: 'm-1', subMeetingId: 's-2' }])
    expect(got).toHaveLength(1)
    expect(got[0]!.subject).toBe('第二场')
  } finally {
    await cleanup()
  }
})
