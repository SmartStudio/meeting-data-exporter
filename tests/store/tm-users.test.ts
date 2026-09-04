import { expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createMeetingHostIdsStore, createTmUsersStore } from '../../src/store/tm-users'

/**
 * 腾讯会议成员姓名的本地副本（`tm_users`，migrations/012）。
 *
 * store 层不 mock 数据库，理由见 tests/helpers/testdb.ts。这个模块的全部价值在
 * 两条判据上，而两条都是「改了不会有任何报错、只会悄悄错」的那一类：
 *
 * 1. **`username IS NULL` 与「不在表里」不是一回事**。前者是「问过腾讯，没有这个
 *    成员」，一天之内不该再问；后者是「从没问过」，该尽快去问。`listMissing`
 *    只挑后者与过期的前者，`namesFor` 则把两者一视同仁地不返回——两个方法对同一
 *    行 NULL 的态度**故意相反**，各自钉一条。
 * 2. **批量**。三个方法都没有单条版本，一批 id 一条 SQL——控制台列一页 50 行、
 *    同步轮一次 50 个，逐条就是 50 次往返。
 */

const NOW = 1_700_000_000

async function seedMeeting(
  pool: Pool,
  input: { meetingId: string; hostUserId?: string | null },
): Promise<void> {
  await pool.execute(
    `INSERT INTO meetings
       (meeting_id, sub_meeting_id, meeting_code, subject, host_userid, start_time, end_time,
        created_at, updated_at)
     VALUES (?, '', '888-000', '周会', ?, 1000, 2000, 1000, 1000)`,
    [input.meetingId, input.hostUserId === undefined ? 'tm-1' : input.hostUserId],
  )
}

/** 数一数发了几条查询。「批量，不是 N 次往返」那条要能证明，不靠人读代码 */
function countingPool(pool: Pool): { pool: Pool; queries: () => number; reset: () => void } {
  let n = 0
  const proxy = new Proxy(pool, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if ((prop === 'query' || prop === 'execute') && typeof value === 'function') {
        return (...args: unknown[]) => {
          n++
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return value
    },
  })
  return { pool: proxy as Pool, queries: () => n, reset: () => (n = 0) }
}

// ── listMissing ─────────────────────────────────────────────────────────

test('listMissing：没查过的全在里面，且顺序跟着入参走', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createTmUsersStore(pool)
    expect(await store.listMissing(['b', 'a', 'c'], NOW, 86_400)).toEqual(['b', 'a', 'c'])
  } finally {
    await cleanup()
  }
})

test('listMissing：staleSec 内查过的不再问，包括「查无此人」那一行', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createTmUsersStore(pool)
    await store.upsertMany([
      { tmUserId: 'named', username: '张三', fetchedAt: NOW - 10 },
      // 这一行是全文件最要紧的一条：问过腾讯、腾讯说没有这个成员。**它也算查过**
      // ——不认这一条的话，离职回收掉的账号会每一轮都被重新问一遍，永远问不出结果，
      // 而配额是和录制下载共用的
      { tmUserId: 'absent', username: null, fetchedAt: NOW - 10 },
    ])

    expect(await store.listMissing(['named', 'absent', 'fresh'], NOW, 86_400)).toEqual(['fresh'])
  } finally {
    await cleanup()
  }
})

test('listMissing：查过但已经过期的要重新问', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createTmUsersStore(pool)
    await store.upsertMany([{ tmUserId: 'old', username: '张三', fetchedAt: NOW - 86_400 }])

    // 边界取「恰好满 staleSec 就算过期」：fetched_at = now - staleSec 要重问
    expect(await store.listMissing(['old'], NOW, 86_400)).toEqual(['old'])
    expect(await store.listMissing(['old'], NOW, 86_401)).toEqual([])
  } finally {
    await cleanup()
  }
})

test('listMissing：重复的 id 只出现一次，且空数组不查库', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const counted = countingPool(pool)
    const store = createTmUsersStore(counted.pool)

    counted.reset()
    expect(await store.listMissing([], NOW, 86_400)).toEqual([])
    expect(counted.queries()).toBe(0)

    // 同一个人主持了 40 场会议时，入参里就有 40 个一样的 id
    counted.reset()
    expect(await store.listMissing(['a', 'a', 'a', 'b'], NOW, 86_400)).toEqual(['a', 'b'])
    expect(counted.queries()).toBe(1)
  } finally {
    await cleanup()
  }
})

// ── upsertMany ──────────────────────────────────────────────────────────

test('upsertMany：一批一条 SQL，不是一行一条', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const counted = countingPool(pool)
    const store = createTmUsersStore(counted.pool)

    counted.reset()
    await store.upsertMany([])
    expect(counted.queries()).toBe(0)

    counted.reset()
    await store.upsertMany(
      Array.from({ length: 50 }, (_, i) => ({
        tmUserId: `u-${i}`,
        username: `名字${i}`,
        fetchedAt: NOW,
      })),
    )
    expect(counted.queries()).toBe(1)
    expect((await store.namesFor(['u-0', 'u-49'])).size).toBe(2)
  } finally {
    await cleanup()
  }
})

test('upsertMany：同一个 id 再写一次会覆盖姓名与 fetched_at', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createTmUsersStore(pool)
    await store.upsertMany([{ tmUserId: 'u', username: '旧名', fetchedAt: NOW - 100 }])
    await store.upsertMany([{ tmUserId: 'u', username: '新名', fetchedAt: NOW }])

    expect((await store.namesFor(['u'])).get('u')).toBe('新名')
    // fetched_at 也要跟着覆盖：不覆盖的话「一天内不重查」会一直按第一次那一刻算，
    // 于是这个人从第二天起每一轮都被重新问
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT fetched_at FROM tm_users WHERE tm_userid = 'u'`,
    )
    expect(Number(rows[0]!.fetched_at)).toBe(NOW)
  } finally {
    await cleanup()
  }
})

test('upsertMany：查到姓名的人后来查无此人时，姓名被 NULL 覆盖', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createTmUsersStore(pool)
    await store.upsertMany([{ tmUserId: 'u', username: '张三', fetchedAt: NOW - 100 }])
    // 账号被回收了。**不许留着旧姓名**：那会让一个已经不存在的成员在界面上
    // 继续以真名出现，而管理员会拿着这个名字去找人
    await store.upsertMany([{ tmUserId: 'u', username: null, fetchedAt: NOW }])

    expect((await store.namesFor(['u'])).has('u')).toBe(false)
    // 但它仍然「查过了」——不会被 listMissing 再挑出来
    expect(await store.listMissing(['u'], NOW, 86_400)).toEqual([])
  } finally {
    await cleanup()
  }
})

// ── namesFor ────────────────────────────────────────────────────────────

test('namesFor：username 是 NULL 与不在表里同义，都不出现在结果里', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createTmUsersStore(pool)
    await store.upsertMany([
      { tmUserId: 'named', username: '张三', fetchedAt: NOW },
      { tmUserId: 'absent', username: null, fetchedAt: NOW },
    ])

    const names = await store.namesFor(['named', 'absent', 'never'])
    expect(names.get('named')).toBe('张三')
    // 读侧要的答案只有「知不知道他叫什么」，NULL 那一行说的正是「不知道」
    expect(names.has('absent')).toBe(false)
    expect(names.has('never')).toBe(false)
  } finally {
    await cleanup()
  }
})

test('namesFor：空串姓名不当成已知姓名——那会在界面上渲染成一行空白', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createTmUsersStore(pool)
    // 直接写库：正路（syncHostNames）已经把空串折成 NULL 了，这一条守的是
    // 绕开 store 的直接 SQL 与将来的回填脚本
    await pool.execute(`INSERT INTO tm_users (tm_userid, username, fetched_at) VALUES ('u', '  ', ?)`, [
      NOW,
    ])
    expect((await store.namesFor(['u'])).has('u')).toBe(false)
  } finally {
    await cleanup()
  }
})

test('namesFor：一批一条 SQL，空数组不查库', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const counted = countingPool(pool)
    const store = createTmUsersStore(counted.pool)
    await createTmUsersStore(pool).upsertMany(
      Array.from({ length: 30 }, (_, i) => ({ tmUserId: `u-${i}`, username: `n${i}`, fetchedAt: NOW })),
    )

    counted.reset()
    expect((await store.namesFor([])).size).toBe(0)
    expect(counted.queries()).toBe(0)

    counted.reset()
    const ids = Array.from({ length: 30 }, (_, i) => `u-${i}`)
    expect((await store.namesFor(ids)).size).toBe(30)
    expect(counted.queries()).toBe(1)
  } finally {
    await cleanup()
  }
})

// ── MeetingHostIdsStore ─────────────────────────────────────────────────

test('listHostUserIds：去重，且 NULL 与空串都不在结果里', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    await seedMeeting(pool, { meetingId: 'm-1', hostUserId: 'tm-1' })
    // 同一个人主持了两场
    await seedMeeting(pool, { meetingId: 'm-2', hostUserId: 'tm-1' })
    await seedMeeting(pool, { meetingId: 'm-3', hostUserId: 'tm-2' })
    // 元数据没拉回来
    await seedMeeting(pool, { meetingId: 'm-4', hostUserId: null })
    // 设备账号发起的快速会议：腾讯真的返回空串。它是「这场会议没有主持人」，
    // 不是「有个叫空串的人」——拿它去问腾讯只会换回一次必然失败的调用
    await seedMeeting(pool, { meetingId: 'm-5', hostUserId: '' })

    expect(await createMeetingHostIdsStore(pool).listHostUserIds()).toEqual(['tm-1', 'tm-2'])
  } finally {
    await cleanup()
  }
})
