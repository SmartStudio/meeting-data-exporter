/**
 * 采集程序（`service_accounts`）的控制台读写侧（阶段 4 · T7）。
 *
 * 每个用例各自持有一个隔离的测试库，跟随 `tests/store/admin.test.ts` 的约定：
 * `list()` 的用例要从确定的空库基线（0 行）出发，共用一个 pool 会被同文件里
 * 其它用例插入的行污染。
 *
 * 本文件里分量最重的两条不是 CRUD 往返，是这两件事：
 *   1. **读侧永远不返回 `secret_hash`**——它在类型上就不存在，handler 想漏也漏不出去；
 *   2. **重名建号不覆盖已有的 `secret_hash`**——覆盖等于把一个正在跑的采集程序
 *      的凭据悄悄换掉，而管理员看到的是「接入成功」。
 */
import { expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import { withTestDb } from '../helpers/testdb'
import { createProgramsStore } from '../../src/store/programs'

test('create + find 往返，enabled/expiresAt 的默认形态与库一致', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    const created = await store.create({
      id: 'kb-indexer',
      name: '知识库索引器',
      secretHash: 'argon2id$fake',
      tmUserId: 'tm-001',
      expiresAt: null,
      now: 1000,
    })
    expect(created).toBe(true)

    expect(await store.find('kb-indexer')).toEqual({
      id: 'kb-indexer',
      name: '知识库索引器',
      tmUserId: 'tm-001',
      enabled: true,
      expiresAt: null,
      createdAt: 1000,
    })
  } finally {
    await cleanup()
  }
})

test('expiresAt 非 null 时按 unix 秒原样往返（不被 TINYINT/BIGINT 转成字符串）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await store.create({
      id: 'temp-prog',
      name: '临时程序',
      secretHash: 'h',
      tmUserId: 'tm-002',
      expiresAt: 1_800_000_000,
      now: 1000,
    })
    const found = await store.find('temp-prog')
    expect(found?.expiresAt).toBe(1_800_000_000)
    expect(typeof found?.expiresAt).toBe('number')
  } finally {
    await cleanup()
  }
})

test('find 对不存在的 id 返回 null', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    expect(await store.find('nope')).toBeNull()
  } finally {
    await cleanup()
  }
})

test('读侧不返回 secret_hash——它在返回值里根本不存在这个键', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await store.create({
      id: 'p1',
      name: 'P1',
      secretHash: 'super-secret-hash-value',
      tmUserId: 'tm-1',
      expiresAt: null,
      now: 1000,
    })

    const one = await store.find('p1')
    const all = await store.list()
    // 键不存在，而不是"值恰好是空串"：后者只要有人改一行映射就会漏出去
    expect(Object.keys(one ?? {})).not.toContain('secretHash')
    expect(Object.keys(all[0] ?? {})).not.toContain('secretHash')
    // 兜底：整段 JSON 里都不许出现那串哈希
    expect(JSON.stringify({ one, all })).not.toContain('super-secret-hash-value')
  } finally {
    await cleanup()
  }
})

test('重名建号返回 false，且绝不覆盖已有的 secret_hash', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await store.create({
      id: 'dup',
      name: '第一次',
      secretHash: 'hash-of-the-live-program',
      tmUserId: 'tm-1',
      expiresAt: null,
      now: 1000,
    })

    const second = await store.create({
      id: 'dup',
      name: '第二次',
      secretHash: 'hash-of-the-newcomer',
      tmUserId: 'tm-2',
      expiresAt: null,
      now: 2000,
    })
    expect(second).toBe(false)

    // 库里那一行必须原封不动：正在跑的采集程序的凭据不能因为一次重名建号被换掉
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT name, secret_hash, tm_userid, created_at FROM service_accounts WHERE id = ?',
      ['dup'],
    )
    expect(rows[0]?.secret_hash).toBe('hash-of-the-live-program')
    expect(rows[0]?.name).toBe('第一次')
    expect(rows[0]?.tm_userid).toBe('tm-1')
    expect(Number(rows[0]?.created_at)).toBe(1000)
  } finally {
    await cleanup()
  }
})

test('list 按 created_at、id 稳定排序，且空库返回空数组', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    expect(await store.list()).toEqual([])

    // 故意让 b 与 c 同一时刻建立：同刻的顺序由 id 决定，不交给优化器
    await store.create({ id: 'c', name: 'C', secretHash: 'h', tmUserId: 't', expiresAt: null, now: 2000 })
    await store.create({ id: 'b', name: 'B', secretHash: 'h', tmUserId: 't', expiresAt: null, now: 2000 })
    await store.create({ id: 'a', name: 'A', secretHash: 'h', tmUserId: 't', expiresAt: null, now: 1000 })

    expect((await store.list()).map((p) => p.id)).toEqual(['a', 'b', 'c'])
  } finally {
    await cleanup()
  }
})

test('enabled 读成布尔，不是 TINYINT 的 0/1', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await store.create({ id: 'e', name: 'E', secretHash: 'h', tmUserId: 't', expiresAt: null, now: 1000 })
    await pool.execute('UPDATE service_accounts SET enabled = 0 WHERE id = ?', ['e'])

    const found = await store.find('e')
    // 严格 false，不是 0——handler 会直接把它下发给前端，0 在 JSON 里不是布尔
    expect(found?.enabled).toBe(false)
  } finally {
    await cleanup()
  }
})

test('create 写进去的 secret_hash 就是传进来的那一串（认证路径读的是同一列）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await store.create({
      id: 'verify-me',
      name: 'V',
      secretHash: 'the-exact-hash',
      tmUserId: 't',
      expiresAt: null,
      now: 1000,
    })
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT secret_hash FROM service_accounts WHERE id = ?',
      ['verify-me'],
    )
    expect(rows[0]?.secret_hash).toBe('the-exact-hash')
  } finally {
    await cleanup()
  }
})
