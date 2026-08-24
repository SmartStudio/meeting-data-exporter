import { expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'
import { createAdminStore } from '../../src/store/admin'

/**
 * 每个用例各自持有一个隔离的测试库（跟随 tests/store/migrations.test.ts 的约定），
 * 而不是像 audit.test.ts / policy.test.ts 那样共用一个 beforeAll 建的 pool——
 * 本文件的 countAccounts/listAccounts 用例需要从确定的空库基线（0 行）开始断言，
 * 共用 pool 会被同文件内其他用例插入的行污染基线。
 */

test('createAccount + findByUsername 往返', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-1', username: 'alice', passwordHash: 'hash-1', now: 1000 })

    const found = await store.findByUsername('alice')
    expect(found).toEqual({ id: 'admin-1', username: 'alice', passwordHash: 'hash-1', createdAt: 1000 })
  } finally {
    await cleanup()
  }
})

test('findByUsername 对不存在的用户名返回 null', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    expect(await store.findByUsername('does-not-exist-user')).toBeNull()
  } finally {
    await cleanup()
  }
})

test('findById 往返，且对不存在的 id 返回 null', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-2', username: 'bob', passwordHash: 'hash-2', now: 1000 })

    const found = await store.findById('admin-2')
    expect(found).toEqual({ id: 'admin-2', username: 'bob', passwordHash: 'hash-2', createdAt: 1000 })
    expect(await store.findById('admin-does-not-exist')).toBeNull()
  } finally {
    await cleanup()
  }
})

test('username 唯一冲突报错', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-dup-1', username: 'carol', passwordHash: 'h', now: 1000 })

    await expect(
      store.createAccount({ id: 'admin-dup-2', username: 'carol', passwordHash: 'h2', now: 1000 }),
    ).rejects.toThrow(/duplicate|unique/i)
  } finally {
    await cleanup()
  }
})

test('countAccounts 从 0 到 N', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    expect(await store.countAccounts()).toBe(0)

    await store.createAccount({ id: 'count-1', username: 'count-user-1', passwordHash: 'h', now: 1000 })
    expect(await store.countAccounts()).toBe(1)

    await store.createAccount({ id: 'count-2', username: 'count-user-2', passwordHash: 'h', now: 1000 })
    await store.createAccount({ id: 'count-3', username: 'count-user-3', passwordHash: 'h', now: 1000 })
    expect(await store.countAccounts()).toBe(3)
  } finally {
    await cleanup()
  }
})

test('listAccounts 返回全部账号，按创建时间升序排列', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    expect(await store.listAccounts()).toEqual([])

    await store.createAccount({ id: 'list-2', username: 'list-second', passwordHash: 'h', now: 2000 })
    await store.createAccount({ id: 'list-1', username: 'list-first', passwordHash: 'h', now: 1000 })

    const accounts = await store.listAccounts()
    expect(accounts.map((a) => a.username)).toEqual(['list-first', 'list-second'])
  } finally {
    await cleanup()
  }
})

test('deleteAccount 对不存在的 id 返回 false', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    expect(await store.deleteAccount('never-existed-id')).toBe(false)
  } finally {
    await cleanup()
  }
})

test('deleteAccount 成功删除后返回 true，且再查不到该账号', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-del-1', username: 'dave', passwordHash: 'h', now: 1000 })

    expect(await store.deleteAccount('admin-del-1')).toBe(true)
    expect(await store.findById('admin-del-1')).toBeNull()
  } finally {
    await cleanup()
  }
})

test('createSession + findSessionByTokenHash 往返', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-sess-1', username: 'erin', passwordHash: 'h', now: 1000 })
    await store.createSession({
      tokenHash: 'token-hash-1',
      adminId: 'admin-sess-1',
      expiresAt: 5000,
      now: 1000,
    })

    const session = await store.findSessionByTokenHash('token-hash-1')
    expect(session).toEqual({ adminId: 'admin-sess-1', expiresAt: 5000 })
  } finally {
    await cleanup()
  }
})

test('findSessionByTokenHash 对不存在的 token 返回 null', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    expect(await store.findSessionByTokenHash('never-issued-token-hash')).toBeNull()
  } finally {
    await cleanup()
  }
})

test('token_hash 唯一冲突报错', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-sess-dup', username: 'frank', passwordHash: 'h', now: 1000 })
    await store.createSession({
      tokenHash: 'dup-token-hash',
      adminId: 'admin-sess-dup',
      expiresAt: 5000,
      now: 1000,
    })

    await expect(
      store.createSession({
        tokenHash: 'dup-token-hash',
        adminId: 'admin-sess-dup',
        expiresAt: 6000,
        now: 1000,
      }),
    ).rejects.toThrow(/duplicate|unique/i)
  } finally {
    await cleanup()
  }
})

test('touchSessionExpiry 更新后重新查询能看到新值', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-touch-1', username: 'grace', passwordHash: 'h', now: 1000 })
    await store.createSession({
      tokenHash: 'touch-token-1',
      adminId: 'admin-touch-1',
      expiresAt: 5000,
      now: 1000,
    })

    await store.touchSessionExpiry('touch-token-1', 99999)

    const session = await store.findSessionByTokenHash('touch-token-1')
    expect(session?.expiresAt).toBe(99999)
  } finally {
    await cleanup()
  }
})

test('deleteSession 删除后再查不到该会话', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-delsess-1', username: 'heidi', passwordHash: 'h', now: 1000 })
    await store.createSession({
      tokenHash: 'delsess-token-1',
      adminId: 'admin-delsess-1',
      expiresAt: 5000,
      now: 1000,
    })

    await store.deleteSession('delsess-token-1')

    expect(await store.findSessionByTokenHash('delsess-token-1')).toBeNull()
  } finally {
    await cleanup()
  }
})

test('deleteSessionsByAdminId 删除该管理员的全部会话，且不影响其他管理员的会话', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-cascade-1', username: 'ivan', passwordHash: 'h', now: 1000 })
    await store.createAccount({ id: 'admin-cascade-2', username: 'judy', passwordHash: 'h', now: 1000 })

    await store.createSession({
      tokenHash: 'cascade-a-1',
      adminId: 'admin-cascade-1',
      expiresAt: 5000,
      now: 1000,
    })
    await store.createSession({
      tokenHash: 'cascade-a-2',
      adminId: 'admin-cascade-1',
      expiresAt: 6000,
      now: 1000,
    })
    await store.createSession({
      tokenHash: 'cascade-b-1',
      adminId: 'admin-cascade-2',
      expiresAt: 7000,
      now: 1000,
    })

    const revoked = await store.deleteSessionsByAdminId('admin-cascade-1')
    expect(revoked).toBe(2)

    expect(await store.findSessionByTokenHash('cascade-a-1')).toBeNull()
    expect(await store.findSessionByTokenHash('cascade-a-2')).toBeNull()
    // 另一个管理员的会话不受影响
    expect(await store.findSessionByTokenHash('cascade-b-1')).toEqual({
      adminId: 'admin-cascade-2',
      expiresAt: 7000,
    })
  } finally {
    await cleanup()
  }
})

test('中文用户名正确往返（utf8mb4）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-zh-1', username: '张三', passwordHash: 'h', now: 1000 })

    const found = await store.findByUsername('张三')
    expect(found?.username).toBe('张三')
  } finally {
    await cleanup()
  }
})
