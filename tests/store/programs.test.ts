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
      // 两列走库里的默认值：新接进来的程序不该自带一个会往授权表里写行的开关
      autoGrant: false,
      autoGrantAssetTypes: null,
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

// ── 停用 / 启用与轮换凭据（阶段 5 · A8，spec §11 缺口 4）──────────────────

async function seed(
  store: ReturnType<typeof createProgramsStore>,
  id: string,
  secretHash = 'hash-0',
): Promise<void> {
  await store.create({ id, name: id, secretHash, tmUserId: 't', expiresAt: null, now: 1000 })
}

test('setEnabled 往返：停用之后读出来是 false，再启用回 true', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-toggle')

    expect(await store.setEnabled('p-toggle', false)).toBe(true)
    expect((await store.find('p-toggle'))?.enabled).toBe(false)

    expect(await store.setEnabled('p-toggle', true)).toBe(true)
    expect((await store.find('p-toggle'))?.enabled).toBe(true)
  } finally {
    await cleanup()
  }
})

test('setEnabled 对不存在的 id 返回 false（handler 据此报 404）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    expect(await store.setEnabled('never-existed', false)).toBe(false)
  } finally {
    await cleanup()
  }
})

test('把一个已经停用的程序再停用一次仍返回 true——问的是「有没有这个程序」不是「值有没有变」', async () => {
  // 用 changedRows 判断的话，重复点一次停用会报 404，而那个程序明明就在
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-idem')
    await store.setEnabled('p-idem', false)
    expect(await store.setEnabled('p-idem', false)).toBe(true)
  } finally {
    await cleanup()
  }
})

test('setEnabled 只改 enabled，不碰 secret_hash / expires_at / name', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await store.create({
      id: 'p-narrow', name: '原名', secretHash: 'keep-this-hash',
      tmUserId: 'tm-x', expiresAt: 9_999_999, now: 1000,
    })
    await store.setEnabled('p-narrow', false)

    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT name, secret_hash, tm_userid, expires_at FROM service_accounts WHERE id = ?',
      ['p-narrow'],
    )
    expect(rows[0]?.name).toBe('原名')
    expect(rows[0]?.secret_hash).toBe('keep-this-hash')
    expect(rows[0]?.tm_userid).toBe('tm-x')
    expect(Number(rows[0]?.expires_at)).toBe(9_999_999)
  } finally {
    await cleanup()
  }
})

test('rotateSecret 换掉 secret_hash（认证路径读的是同一列）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-rotate', 'old-hash')

    expect(await store.rotateSecret('p-rotate', 'brand-new-hash')).toBe(true)
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT secret_hash FROM service_accounts WHERE id = ?',
      ['p-rotate'],
    )
    expect(rows[0]?.secret_hash).toBe('brand-new-hash')
  } finally {
    await cleanup()
  }
})

test('rotateSecret 对不存在的 id 返回 false，且不新建一行', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    expect(await store.rotateSecret('never-existed', 'h')).toBe(false)
    expect(await store.list()).toEqual([])
  } finally {
    await cleanup()
  }
})

test('rotateSecret 不改 enabled——给一个停用中的程序换凭据，它仍然是停用的', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-rot-disabled')
    await store.setEnabled('p-rot-disabled', false)

    await store.rotateSecret('p-rot-disabled', 'h2')
    expect((await store.find('p-rot-disabled'))?.enabled).toBe(false)
  } finally {
    await cleanup()
  }
})

test('读侧仍然不返回 secret_hash——轮换之后也一样', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-nohash')
    await store.rotateSecret('p-nohash', 'the-new-hash')

    const found = await store.find('p-nohash')
    expect(found).not.toBeNull()
    expect(Object.keys(found!)).not.toContain('secretHash')
    expect(JSON.stringify(found)).not.toContain('the-new-hash')
  } finally {
    await cleanup()
  }
})

// ── 程序级自动授权的两列（方案 2，migrations/011）────────────────────────

test('setAutoGrant 往返：开关与资产范围一起写，list / find 都读得回来', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-ag')

    // 建号时两列走库里的默认值：新接进来的程序不自带一个会往授权表里写行的开关
    expect((await store.find('p-ag'))?.autoGrant).toBe(false)
    expect((await store.find('p-ag'))?.autoGrantAssetTypes).toBeNull()

    expect(
      await store.setAutoGrant('p-ag', { enabled: true, assetTypes: ['ai_minutes', 'transcript'] }),
    ).toBe(true)
    const found = await store.find('p-ag')
    expect(found?.autoGrant).toBe(true)
    expect(found?.autoGrantAssetTypes).toEqual(['ai_minutes', 'transcript'])
    // list 与 find 读的是同一份列，不能只有一边接上
    expect((await store.list())[0]?.autoGrantAssetTypes).toEqual(['ai_minutes', 'transcript'])
  } finally {
    await cleanup()
  }
})

test('setAutoGrant 的 assetTypes 为 null 时落成 SQL NULL（= 不额外限制）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-ag-null')
    await store.setAutoGrant('p-ag-null', { enabled: true, assetTypes: ['video'] })
    await store.setAutoGrant('p-ag-null', { enabled: true, assetTypes: null })

    expect((await store.find('p-ag-null'))?.autoGrantAssetTypes).toBeNull()
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT auto_grant_asset_types FROM service_accounts WHERE id = ?',
      ['p-ag-null'],
    )
    // 库里真的是 NULL，不是字符串 'null'——后者读回来是一个长度 4 的白名单
    expect(rows[0]?.auto_grant_asset_types).toBeNull()
  } finally {
    await cleanup()
  }
})

test('autoGrant 读成布尔，不是 TINYINT 的 0/1', async () => {
  // 自动授权轮按它决定要不要替这个程序往授权表里写行，一个数字下发到前端的开关上
  // 是一个说不清开没开的值
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-ag-bool')
    await pool.execute('UPDATE service_accounts SET auto_grant = 1 WHERE id = ?', ['p-ag-bool'])
    expect((await store.find('p-ag-bool'))?.autoGrant).toBe(true)
    await pool.execute('UPDATE service_accounts SET auto_grant = 0 WHERE id = ?', ['p-ag-bool'])
    expect((await store.find('p-ag-bool'))?.autoGrant).toBe(false)
  } finally {
    await cleanup()
  }
})

test('setAutoGrant 关掉开关时**只改这两列**，enabled / secret_hash / name 一个都不碰', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await store.create({
      id: 'p-ag-narrow', name: '原名', secretHash: 'keep-this-hash',
      tmUserId: 'tm-x', expiresAt: 9_999_999, now: 1000,
    })
    await store.setAutoGrant('p-ag-narrow', { enabled: false, assetTypes: null })

    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT name, secret_hash, tm_userid, enabled, expires_at FROM service_accounts WHERE id = ?',
      ['p-ag-narrow'],
    )
    expect(rows[0]?.name).toBe('原名')
    expect(rows[0]?.secret_hash).toBe('keep-this-hash')
    expect(rows[0]?.tm_userid).toBe('tm-x')
    expect(Number(rows[0]?.enabled)).toBe(1)
    expect(Number(rows[0]?.expires_at)).toBe(9_999_999)
  } finally {
    await cleanup()
  }
})

test('setAutoGrant 对不存在的 id 返回 false（handler 据此报 404），且不新建一行', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    expect(await store.setAutoGrant('never-existed', { enabled: true, assetTypes: null })).toBe(false)
    expect(await store.list()).toEqual([])
  } finally {
    await cleanup()
  }
})

test('把同一个开关重复设成同一个值仍返回 true——问的是「有没有这个程序」', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-ag-idem')
    await store.setAutoGrant('p-ag-idem', { enabled: true, assetTypes: null })
    // 用 changedRows 判断的话这一次会报 404，而那个程序明明就在
    expect(await store.setAutoGrant('p-ag-idem', { enabled: true, assetTypes: null })).toBe(true)
  } finally {
    await cleanup()
  }
})

test('auto_grant_asset_types 是坏 JSON 时**抛**，不折成 null（静默放宽）也不折成 []', async () => {
  // 折成 null = 本来只该授权 AI 纪要的程序按规则放行的全部八类自动授权出去；
  // 折成 [] = 自动授权轮会写出一批资产范围为空的真授权行，那些行一类都取不到，
  // 却又满足「已有生效授权」于是永远挡住这场会议日后被正确地自动授权。
  // 两个方向都是静默的错，所以这里响亮地失败。
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-ag-bad')
    // JSON 列装得下一个对象/数字——无 schema 校验，库外的写入者塞得进来
    await pool.execute(
      `UPDATE service_accounts SET auto_grant_asset_types = CAST('{"a":1}' AS JSON) WHERE id = ?`,
      ['p-ag-bad'],
    )
    expect(store.find('p-ag-bad')).rejects.toThrow(/auto_grant_asset_types/)
    // list 走同一段 mapRow，也必须抛——只挡一条路等于没挡
    expect(store.list()).rejects.toThrow(/auto_grant_asset_types/)
  } finally {
    await cleanup()
  }
})

test('auto_grant_asset_types 是「数组但元素不是字符串」时同样抛', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createProgramsStore(pool)
    await seed(store, 'p-ag-bad2')
    await pool.execute(
      `UPDATE service_accounts SET auto_grant_asset_types = CAST('[1,2]' AS JSON) WHERE id = ?`,
      ['p-ag-bad2'],
    )
    expect(store.find('p-ag-bad2')).rejects.toThrow(/JSON array of strings/)
  } finally {
    await cleanup()
  }
})
