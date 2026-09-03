import { expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import { withTestDb } from '../helpers/testdb'
import { createGrantsStore } from '../../src/store/grants'
import type { Pool } from '../../src/store/db'

/**
 * 逐会议授权（meeting_grants）与单场会议的人工改写（meeting_overrides）。
 *
 * 这是「外部程序真能取到 = 三个『与』」（spec §1.3）里的第一个「与」的存储层，
 * 所以本文件的重点不是 CRUD 往返，而是三条**不变量**：
 *
 * 1. **撤销不删行**。重新授权是插新行，不是把旧行的 revoked_at 清零——
 *    spec §4.10 的操作审计要能回答「什么时候授权给谁、什么时候撤的」，
 *    改写历史就答不了。测试里因此反复断言旧行的 revoked_at **原封不动**。
 * 2. **「同时只能有一条生效授权」由唯一键保证，不由应用约定**。
 *    下面有一条测试绕过 store 直接 INSERT 两行，钉的就是数据库这一层。
 * 3. **asset_types 的 NULL / 非空数组 / 空数组是三个不同的意思**，
 *    空数组绝不能被当成「不限制」。在授权中枢里让空集合意外等价于全集，
 *    正是「不许静默放行」这条全局约束要防的事故。
 *
 * 每个用例各自持有一个隔离的测试库（跟随 tests/store/archives.test.ts 的约定），
 * 免得同文件里其他用例的行污染「列出全部生效授权」这类计数断言。
 */

interface GrantRawRow extends RowDataPacket {
  id: number
  meeting_id: string
  sub_meeting_id: string
  program_id: string
  asset_types: unknown
  granted_at: number
  revoked_at: number
}

/** 绕过 store 直接读全部行（含已撤销的），用来验证「历史没被改写」 */
async function rawGrants(pool: Pool): Promise<GrantRawRow[]> {
  const [rows] = await pool.execute<GrantRawRow[]>(
    `SELECT id, meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at
       FROM meeting_grants ORDER BY id`,
  )
  return rows
}

// ── 授权 / 撤销的基本往返 ────────────────────────────────────────────

test('授权 → 查得到生效授权 → 撤销 → 查不到', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    const created = await store.grant({
      meetingId: 'm-1', subMeetingId: '', programId: 'kb-indexer',
      assetTypes: null, now: 1000,
    })
    expect(created.meetingId).toBe('m-1')
    expect(created.programId).toBe('kb-indexer')
    expect(created.grantedAt).toBe(1000)
    expect(created.revokedAt).toBeNull()

    const found = await store.findActiveGrant('m-1', '', 'kb-indexer')
    expect(found?.id).toBe(created.id)

    expect(await store.revoke('m-1', '', 'kb-indexer', 2000)).toBe(true)
    expect(await store.findActiveGrant('m-1', '', 'kb-indexer')).toBeNull()
    expect(await store.listActiveGrantsForProgram('kb-indexer')).toEqual([])
  } finally {
    await cleanup()
  }
})

test('撤销是软删除：行还在，revoked_at 记着撤销时刻', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })
    await store.revoke('m-1', '', 'p-1', 2000)

    const rows = await rawGrants(pool)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.granted_at)).toBe(1000)
    expect(Number(rows[0]!.revoked_at)).toBe(2000)
  } finally {
    await cleanup()
  }
})

test('撤销后重新授权：生效的是新行，旧行的 revoked_at 原封不动', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    const first = await store.grant({
      meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000,
    })
    await store.revoke('m-1', '', 'p-1', 2000)
    const second = await store.grant({
      meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 3000,
    })

    // 新行，不是把旧行翻回来
    expect(second.id).not.toBe(first.id)
    expect(second.grantedAt).toBe(3000)

    const rows = await rawGrants(pool)
    expect(rows).toHaveLength(2)
    // 旧行仍然停在 2000——历史是一串事件，不是一个可翻转的开关
    expect(Number(rows[0]!.id)).toBe(first.id)
    expect(Number(rows[0]!.granted_at)).toBe(1000)
    expect(Number(rows[0]!.revoked_at)).toBe(2000)
    expect(Number(rows[1]!.id)).toBe(second.id)
    expect(Number(rows[1]!.revoked_at)).toBe(0)

    const active = await store.findActiveGrant('m-1', '', 'p-1')
    expect(active?.id).toBe(second.id)
  } finally {
    await cleanup()
  }
})

test('重复撤销是幂等的无操作，不抛错', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })

    expect(await store.revoke('m-1', '', 'p-1', 2000)).toBe(true)
    // 第二次：已经撤销了，什么都不该发生，尤其不该抛错
    expect(await store.revoke('m-1', '', 'p-1', 2500)).toBe(false)
    // 压根没授权过的，同样是无操作
    expect(await store.revoke('m-1', '', 'never-granted', 2500)).toBe(false)

    const rows = await rawGrants(pool)
    expect(rows).toHaveLength(1)
    // 第二次撤销没有把撤销时刻改成 2500
    expect(Number(rows[0]!.revoked_at)).toBe(2000)
  } finally {
    await cleanup()
  }
})

test('同一毫秒内撤销两条不同的授权行不会撞唯一键，且第二条确实被撤销', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // D-m 的窄窗口：授权→撤销(t)→重新授权→再撤销(同一个 t)。
    // 第二次撤销想写的 revoked_at 与第一行已有的值相同，(meeting, sub, program,
    // revoked_at) 会撞唯一键。绝不允许的处理方式是「吞掉异常当无事发生」——
    // 那会让一条管理员明确要求撤销的授权继续生效，正是最不能出的事故。
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })
    await store.revoke('m-1', '', 'p-1', 2000)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 3000 })

    expect(await store.revoke('m-1', '', 'p-1', 2000)).toBe(true)

    // 最要紧的断言：撤销真的发生了
    expect(await store.findActiveGrant('m-1', '', 'p-1')).toBeNull()

    const rows = await rawGrants(pool)
    expect(rows).toHaveLength(2)
    expect(Number(rows[0]!.revoked_at)).toBe(2000)
    // 让开一格，时间戳差 1ms 无伤大雅，丢掉撤销才有伤
    expect(Number(rows[1]!.revoked_at)).toBe(2001)
  } finally {
    await cleanup()
  }
})

test('用 0 当撤销时刻会写出一行看起来仍然生效的记录，所以直接报错', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 0 正是「未撤销」那个哨兵。撤销时把 revoked_at 写成 0 = 一次静默的不撤销，
    // 是 0 哨兵这个设计自带的坑，只能在入口挡住。
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })

    await expect(store.revoke('m-1', '', 'p-1', 0)).rejects.toThrow(/positive timestamp/)
    await expect(store.revokeOverride('m-1', '', 'allow', -1)).rejects.toThrow(/positive timestamp/)

    // 授权仍然生效，没有被那次调用改成一个含糊的状态
    expect(await store.findActiveGrant('m-1', '', 'p-1')).not.toBeNull()
  } finally {
    await cleanup()
  }
})

// ── 「同时只能有一条生效授权」是数据库层面的不变量 ──────────────────

test('唯一键挡住第二条生效授权：绕过 store 直接 INSERT 也插不进去', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await pool.execute(
      `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
       VALUES ('m-1', '', 'p-1', NULL, 1000, 0)`,
    )
    // revoked_at 恒为 0 的生效行只能有一条——这是 uk_grant_active 说了算，
    // 不是 store 里某个 if 说了算
    await expect(
      pool.execute(
        `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
         VALUES ('m-1', '', 'p-1', NULL, 5000, 0)`,
      ),
    ).rejects.toThrow(/Duplicate entry/i)

    // 但已撤销的多行可以共存（revoked_at 各不相同）
    await pool.execute(
      `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
       VALUES ('m-1', '', 'p-1', NULL, 500, 900)`,
    )
    await pool.execute(
      `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
       VALUES ('m-1', '', 'p-1', NULL, 200, 400)`,
    )
    expect(await rawGrants(pool)).toHaveLength(3)
  } finally {
    await cleanup()
  }
})

test('grant 幂等：参数完全相同的第二次调用不插新行', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    const a = await store.grant({
      meetingId: 'm-1', subMeetingId: '', programId: 'p-1',
      assetTypes: ['ai_minutes'], now: 1000,
    })
    const b = await store.grant({
      meetingId: 'm-1', subMeetingId: '', programId: 'p-1',
      assetTypes: ['ai_minutes'], now: 9999,
    })
    expect(b.id).toBe(a.id)
    // 第二次调用没有把 granted_at 推到 9999：授权时刻是第一次那次
    expect(b.grantedAt).toBe(1000)
    expect(await rawGrants(pool)).toHaveLength(1)
  } finally {
    await cleanup()
  }
})

test('grant 改了 assetTypes：旧行被撤销、新行生效，不是静默沿用旧范围', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 「已有生效授权就不重复插」如果不比对 assetTypes，管理员把白名单**收窄**
    // 的操作会被静默丢弃，旧的更宽授权继续生效——那是一次静默放行。
    const store = createGrantsStore(pool)
    const wide = await store.grant({
      meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000,
    })
    const narrow = await store.grant({
      meetingId: 'm-1', subMeetingId: '', programId: 'p-1',
      assetTypes: ['ai_minutes'], now: 2000,
    })

    expect(narrow.id).not.toBe(wide.id)
    expect(narrow.assetTypes).toEqual(['ai_minutes'])

    const active = await store.findActiveGrant('m-1', '', 'p-1')
    expect(active?.id).toBe(narrow.id)
    expect(active?.assetTypes).toEqual(['ai_minutes'])

    const rows = await rawGrants(pool)
    expect(rows).toHaveLength(2)
    expect(Number(rows[0]!.revoked_at)).toBe(2000)
  } finally {
    await cleanup()
  }
})

test('改范围时内部那次撤销撞上唯一键也要撑住（事务里语句级报错不能拖垮整笔）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // grant 改范围走的是「撤旧插新」，那次撤销和 revoke() 一样会撞同一毫秒的窄窗口，
    // 但它发生在事务内部——MySQL 里语句级错误只回滚该语句，不回滚整个事务，
    // 所以让开一格重试是有效的。这条测试钉住这一点。
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })
    await store.revoke('m-1', '', 'p-1', 2000)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 3000 })

    const narrowed = await store.grant({
      meetingId: 'm-1', subMeetingId: '', programId: 'p-1',
      assetTypes: ['ai_minutes'], now: 2000,
    })

    const active = await store.findActiveGrant('m-1', '', 'p-1')
    expect(active?.id).toBe(narrowed.id)
    expect(active?.assetTypes).toEqual(['ai_minutes'])

    const rows = await rawGrants(pool)
    expect(rows).toHaveLength(3)
    expect(Number(rows[0]!.revoked_at)).toBe(2000)
    expect(Number(rows[1]!.revoked_at)).toBe(2001)
    expect(Number(rows[2]!.revoked_at)).toBe(0)
  } finally {
    await cleanup()
  }
})

// ── asset_types 的三种取值 ──────────────────────────────────────────

test('asset_types 三态：NULL 是不限制、非空数组是白名单、空数组是什么都不授权', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-null', assetTypes: null, now: 1000 })
    await store.grant({
      meetingId: 'm-1', subMeetingId: '', programId: 'p-list',
      assetTypes: ['ai_minutes', 'transcript'], now: 1000,
    })
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-empty', assetTypes: [], now: 1000 })

    expect((await store.findActiveGrant('m-1', '', 'p-null'))!.assetTypes).toBeNull()
    expect((await store.findActiveGrant('m-1', '', 'p-list'))!.assetTypes).toEqual(['ai_minutes', 'transcript'])
    // 关键：空数组读回来必须还是空数组，绝不能变成 null（= 不限制）
    const empty = (await store.findActiveGrant('m-1', '', 'p-empty'))!.assetTypes
    expect(empty).toEqual([])
    expect(empty).not.toBeNull()

    // 列出来的那条路径也一样，不许两条读路径的解释不同（按 program_id 排序）
    const all = await store.listActiveGrantsForMeeting('m-1', '')
    expect(all.map((g) => g.programId)).toEqual(['p-empty', 'p-list', 'p-null'])
    expect(all.map((g) => g.assetTypes)).toEqual([[], ['ai_minutes', 'transcript'], null])
  } finally {
    await cleanup()
  }
})

test('asset_types 是坏数据时抛错，不悄悄当成「不限制」', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // store 自己只会写合法的 JSON 数组，所以这一行只可能来自库外的写入者
    // 或者数据损坏。落到「不限制」是静默放行，落到「什么都不放行」是静默拒绝
    // 且没人知道为什么——两种沉默都不行，直接喊出来。
    await pool.execute(
      `INSERT INTO meeting_grants (meeting_id, sub_meeting_id, program_id, asset_types, granted_at, revoked_at)
       VALUES ('m-1', '', 'p-1', CAST('"ai_minutes"' AS JSON), 1000, 0)`,
    )
    const store = createGrantsStore(pool)
    await expect(store.findActiveGrant('m-1', '', 'p-1')).rejects.toThrow(/asset_types/)
  } finally {
    await cleanup()
  }
})

// ── 两条列表查询 ────────────────────────────────────────────────────

test('listActiveGrantsForProgram 只返回该程序当前生效的授权', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })
    await store.grant({ meetingId: 'm-2', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })
    await store.grant({ meetingId: 'm-3', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-2', assetTypes: null, now: 1000 })
    await store.revoke('m-2', '', 'p-1', 2000)

    const rows = await store.listActiveGrantsForProgram('p-1')
    expect(rows.map((r) => r.meetingId)).toEqual(['m-1', 'm-3'])
    expect(await store.listActiveGrantsForProgram('p-2')).toHaveLength(1)
    expect(await store.listActiveGrantsForProgram('p-none')).toEqual([])
  } finally {
    await cleanup()
  }
})

test('listActiveGrantsForMeeting 返回这场会议当前授权给了哪些程序', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-2', assetTypes: null, now: 1000 })
    await store.grant({ meetingId: 'm-2', subMeetingId: '', programId: 'p-3', assetTypes: null, now: 1000 })
    await store.revoke('m-1', '', 'p-2', 2000)

    const rows = await store.listActiveGrantsForMeeting('m-1', '')
    expect(rows.map((r) => r.programId)).toEqual(['p-1'])
  } finally {
    await cleanup()
  }
})

test('周期性会议：sub_meeting_id 区分场次，空串是默认值路径', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-1', assetTypes: null, now: 1000 })
    await store.grant({ meetingId: 'm-1', subMeetingId: 'sub-a', programId: 'p-1', assetTypes: null, now: 1000 })

    // 同一 meeting_id 下的两个场次是两条互不相干的授权，不是重复
    expect(await rawGrants(pool)).toHaveLength(2)
    expect((await store.findActiveGrant('m-1', '', 'p-1'))!.subMeetingId).toBe('')
    expect((await store.findActiveGrant('m-1', 'sub-a', 'p-1'))!.subMeetingId).toBe('sub-a')

    // 撤掉主场次不影响子场次
    await store.revoke('m-1', '', 'p-1', 2000)
    expect(await store.findActiveGrant('m-1', '', 'p-1')).toBeNull()
    expect(await store.findActiveGrant('m-1', 'sub-a', 'p-1')).not.toBeNull()
  } finally {
    await cleanup()
  }
})

// ── 人工改写 ────────────────────────────────────────────────────────

test('改写：写入 → 读回 → 撤销 → 读不到', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    const created = await store.putOverride({
      meetingId: 'm-1', subMeetingId: '', kind: 'allow', effect: 'deny',
      assetTypes: null, reason: '涉密，人工关闭', now: 1000,
    })
    expect(created.kind).toBe('allow')
    expect(created.effect).toBe('deny')
    expect(created.reason).toBe('涉密，人工关闭')
    expect(created.revokedAt).toBeNull()

    const found = await store.findActiveOverride('m-1', '', 'allow')
    expect(found?.id).toBe(created.id)
    expect(found?.effect).toBe('deny')

    expect(await store.revokeOverride('m-1', '', 'allow', 2000)).toBe(true)
    expect(await store.findActiveOverride('m-1', '', 'allow')).toBeNull()
    expect(await store.listActiveOverrides('m-1', '')).toEqual([])
    // 幂等
    expect(await store.revokeOverride('m-1', '', 'allow', 2500)).toBe(false)
  } finally {
    await cleanup()
  }
})

test('改写：三个 kind 互不干扰，改了 allow 不影响 fetch', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    await store.putOverride({ meetingId: 'm-1', subMeetingId: '', kind: 'fetch', effect: 'all', assetTypes: null, reason: '', now: 1000 })
    await store.putOverride({ meetingId: 'm-1', subMeetingId: '', kind: 'archive', effect: '/nas/vip/{年}/', assetTypes: null, reason: '', now: 1000 })
    await store.putOverride({ meetingId: 'm-1', subMeetingId: '', kind: 'allow', effect: 'deny', assetTypes: null, reason: '', now: 1000 })

    const all = await store.listActiveOverrides('m-1', '')
    expect(all.map((o) => o.kind).sort()).toEqual(['allow', 'archive', 'fetch'])

    await store.revokeOverride('m-1', '', 'allow', 2000)
    const left = await store.listActiveOverrides('m-1', '')
    expect(left.map((o) => o.kind).sort()).toEqual(['archive', 'fetch'])
    expect((await store.findActiveOverride('m-1', '', 'fetch'))!.effect).toBe('all')
    // 归档栈的 effect 是目录模板，不是枚举，原样存原样取
    expect((await store.findActiveOverride('m-1', '', 'archive'))!.effect).toBe('/nas/vip/{年}/')
  } finally {
    await cleanup()
  }
})

test('改写：改变同一个 kind 的内容是撤旧插新，历史保留', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    const first = await store.putOverride({
      meetingId: 'm-1', subMeetingId: '', kind: 'allow', effect: 'deny',
      assetTypes: null, reason: '先关掉', now: 1000,
    })
    const second = await store.putOverride({
      meetingId: 'm-1', subMeetingId: '', kind: 'allow', effect: 'allow',
      assetTypes: ['ai_minutes'], reason: '复核后放行', now: 2000,
    })
    expect(second.id).not.toBe(first.id)

    const active = await store.findActiveOverride('m-1', '', 'allow')
    expect(active?.id).toBe(second.id)
    expect(active?.effect).toBe('allow')
    expect(active?.assetTypes).toEqual(['ai_minutes'])

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, effect, revoked_at FROM meeting_overrides ORDER BY id`,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]!.effect).toBe('deny')
    expect(Number(rows[0]!.revoked_at)).toBe(2000)

    // 内容完全一样的第二次写入是幂等的
    const again = await store.putOverride({
      meetingId: 'm-1', subMeetingId: '', kind: 'allow', effect: 'allow',
      assetTypes: ['ai_minutes'], reason: '复核后放行', now: 3000,
    })
    expect(again.id).toBe(second.id)
    const [after] = await pool.execute<RowDataPacket[]>(`SELECT id FROM meeting_overrides`)
    expect(after).toHaveLength(2)
  } finally {
    await cleanup()
  }
})

test('改写：批量读只返回有生效改写的那些会议', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    // 影响预览（spec §5.5）要把改写过的会议排除在「会被改变」之外，
    // 一场一场查就是 N+1。
    const store = createGrantsStore(pool)
    await store.putOverride({ meetingId: 'm-1', subMeetingId: '', kind: 'allow', effect: 'deny', assetTypes: null, reason: '', now: 1000 })
    await store.putOverride({ meetingId: 'm-1', subMeetingId: '', kind: 'fetch', effect: 'skip', assetTypes: null, reason: '', now: 1000 })
    await store.putOverride({ meetingId: 'm-2', subMeetingId: 'sub-a', kind: 'allow', effect: 'allow', assetTypes: null, reason: '', now: 1000 })
    await store.putOverride({ meetingId: 'm-3', subMeetingId: '', kind: 'allow', effect: 'deny', assetTypes: null, reason: '', now: 1000 })
    await store.revokeOverride('m-3', '', 'allow', 2000)

    const rows = await store.listActiveOverridesForMeetings([
      { meetingId: 'm-1', subMeetingId: '' },
      { meetingId: 'm-2', subMeetingId: 'sub-a' },
      { meetingId: 'm-3', subMeetingId: '' },
      { meetingId: 'm-4', subMeetingId: '' },
    ])
    expect(rows.map((r) => `${r.meetingId}/${r.subMeetingId}/${r.kind}`).sort()).toEqual([
      'm-1//allow', 'm-1//fetch', 'm-2/sub-a/allow',
    ])

    // 同一 meeting_id 不同场次不许混为一谈
    const onlyMain = await store.listActiveOverridesForMeetings([{ meetingId: 'm-2', subMeetingId: '' }])
    expect(onlyMain).toEqual([])

    // 空输入不发查询，也不许拼出 `IN ()` 那种语法错
    expect(await store.listActiveOverridesForMeetings([])).toEqual([])
  } finally {
    await cleanup()
  }
})

test('改写：asset_types 三态与授权侧一致', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    await store.putOverride({ meetingId: 'm-1', subMeetingId: '', kind: 'allow', effect: 'allow', assetTypes: null, reason: '', now: 1000 })
    await store.putOverride({ meetingId: 'm-2', subMeetingId: '', kind: 'allow', effect: 'allow', assetTypes: ['video'], reason: '', now: 1000 })
    await store.putOverride({ meetingId: 'm-3', subMeetingId: '', kind: 'allow', effect: 'allow', assetTypes: [], reason: '', now: 1000 })

    expect((await store.findActiveOverride('m-1', '', 'allow'))!.assetTypes).toBeNull()
    expect((await store.findActiveOverride('m-2', '', 'allow'))!.assetTypes).toEqual(['video'])
    expect((await store.findActiveOverride('m-3', '', 'allow'))!.assetTypes).toEqual([])
  } finally {
    await cleanup()
  }
})

test('改写：唯一键挡住同一 kind 的第二条生效改写', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await pool.execute(
      `INSERT INTO meeting_overrides (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
       VALUES ('m-1', '', 'allow', 'deny', NULL, '', 1000, 0)`,
    )
    await expect(
      pool.execute(
        `INSERT INTO meeting_overrides (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
         VALUES ('m-1', '', 'allow', 'allow', NULL, '', 2000, 0)`,
      ),
    ).rejects.toThrow(/Duplicate entry/i)

    // 换一个 kind 就不冲突
    await pool.execute(
      `INSERT INTO meeting_overrides (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
       VALUES ('m-1', '', 'fetch', 'skip', NULL, '', 2000, 0)`,
    )
  } finally {
    await cleanup()
  }
})

/**
 * kind 是改写行上唯一没有安全侧可落的字段（计划 §3.4 的 D-u，T7 落地时发现）。
 * 下面三条钉的是两道防线：store 的运行时校验、以及数据库那条 CHECK（migrations/006）。
 *
 * 求值层为什么拦不住：`normalizeEffect(kind, effect)` 是按栈校验 effect 的，
 * 它无从知道这一行原本是为哪一栈写的——一条 fetch 改写（effect `all`）套到归档栈上，
 * `all` 会被当成一段合法的目录模板，录像因此归档进一个叫 all 的目录。
 */
test('改写：store 拒绝三栈之外的 kind，不当成无事发生', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)

    await expect(
      store.putOverride({
        meetingId: 'm-1', subMeetingId: '',
        // @ts-expect-error 故意绕过类型：真实入口是 HTTP 请求体反序列化出来的值
        kind: 'fecth',
        effect: 'all', assetTypes: null, reason: '', now: 1000,
      }),
    ).rejects.toThrow(/must be one of fetch \/ archive \/ allow/)

    // 撤销侧同理：拼错 kind 会匹配到零行、返回 false，看起来像「本来就没有改写」
    await expect(
      // @ts-expect-error 同上
      store.revokeOverride('m-1', '', 'fecth', 2000),
    ).rejects.toThrow(/must be one of fetch \/ archive \/ allow/)

    // 什么都没写进去
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM meeting_overrides`,
    )
    expect(Number(rows[0]!.n)).toBe(0)
  } finally {
    await cleanup()
  }
})

test('改写：数据库的 CHECK 挡住绕开 store 的直接 INSERT', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await expect(
      pool.execute(
        `INSERT INTO meeting_overrides (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
         VALUES ('m-1', '', 'fecth', 'all', NULL, '', 1000, 0)`,
      ),
    ).rejects.toThrow(/ck_override_kind|Check constraint/i)

    // 三个合法值都插得进去，证明约束没有误伤
    for (const kind of ['fetch', 'archive', 'allow']) {
      await pool.execute(
        `INSERT INTO meeting_overrides (meeting_id, sub_meeting_id, kind, effect, asset_types, reason, created_at, revoked_at)
         VALUES ('m-1', '', ?, 'skip', NULL, '', 1000, 0)`,
        [kind],
      )
    }
  } finally {
    await cleanup()
  }
})

// ── 撤销过的会议：自动授权的第二条规矩（方案 2）────────────────────────

test('listRevokedMeetingKeysForProgram 只返回**这个程序**撤销过的会议，去重', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    // m-1 撤过；m-2 一直生效；m-3 是另一个程序撤的
    await store.grant({ meetingId: 'm-1', subMeetingId: '', programId: 'p-a', assetTypes: null, now: 1000 })
    await store.revoke('m-1', '', 'p-a', 2000)
    await store.grant({ meetingId: 'm-2', subMeetingId: '', programId: 'p-a', assetTypes: null, now: 1000 })
    await store.grant({ meetingId: 'm-3', subMeetingId: '', programId: 'p-b', assetTypes: null, now: 1000 })
    await store.revoke('m-3', '', 'p-b', 2000)

    expect(await store.listRevokedMeetingKeysForProgram('p-a')).toEqual([
      { meetingId: 'm-1', subMeetingId: '' },
    ])
    expect(await store.listRevokedMeetingKeysForProgram('p-b')).toEqual([
      { meetingId: 'm-3', subMeetingId: '' },
    ])
    // 从没撤过任何东西的程序拿到的是空数组，不是 null——调用方不必区分「没有」与「没算」
    expect(await store.listRevokedMeetingKeysForProgram('p-never')).toEqual([])
  } finally {
    await cleanup()
  }
})

test('撤销过再重新授权的会议**仍然算撤销过**——人的决定不会因为又授权了一次就作废', async () => {
  // 这一条是自动授权那条规矩的要害：判据是「有过撤销行」，不是「当前没有生效授权」。
  // 用后者的话，撤销 → 人工重新授权 → 再撤销的会议会在下一轮被自动补回来
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    await store.grant({ meetingId: 'm-x', subMeetingId: '', programId: 'p-a', assetTypes: null, now: 1000 })
    await store.revoke('m-x', '', 'p-a', 2000)
    await store.grant({ meetingId: 'm-x', subMeetingId: '', programId: 'p-a', assetTypes: null, now: 3000 })

    // 此刻这场会议有一条**生效**授权，同时有一条撤销历史——两件事都是真的
    expect(await store.findActiveGrant('m-x', '', 'p-a')).not.toBeNull()
    expect(await store.listRevokedMeetingKeysForProgram('p-a')).toEqual([
      { meetingId: 'm-x', subMeetingId: '' },
    ])

    // 撤两次也只算一场（DISTINCT），不是「撤过几次」
    await store.revoke('m-x', '', 'p-a', 4000)
    expect(await store.listRevokedMeetingKeysForProgram('p-a')).toEqual([
      { meetingId: 'm-x', subMeetingId: '' },
    ])
  } finally {
    await cleanup()
  }
})

test('周期性会议的场次分得开：撤了 s-1 不代表 s-2 也撤过', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createGrantsStore(pool)
    for (const sub of ['s-1', 's-2']) {
      await store.grant({ meetingId: 'm-r', subMeetingId: sub, programId: 'p-a', assetTypes: null, now: 1000 })
    }
    await store.revoke('m-r', 's-1', 'p-a', 2000)

    expect(await store.listRevokedMeetingKeysForProgram('p-a')).toEqual([
      { meetingId: 'm-r', subMeetingId: 's-1' },
    ])
  } finally {
    await cleanup()
  }
})
