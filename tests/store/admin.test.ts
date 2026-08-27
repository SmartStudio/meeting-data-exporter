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
    expect(found).toEqual({ id: 'admin-1', username: 'alice', passwordHash: 'hash-1', createdAt: 1000, role: 'admin' })
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
    expect(found).toEqual({ id: 'admin-2', username: 'bob', passwordHash: 'hash-2', createdAt: 1000, role: 'admin' })
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
    // createdAt 一并往返：AdminAuth.verifySession 靠 expiresAt - createdAt 判断
    // 这是不是"记住此设备"的长会话，这一列漏映射会让短会话被当成长会话续期
    expect(session).toEqual({ adminId: 'admin-sess-1', expiresAt: 5000, createdAt: 1000 })
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
      createdAt: 1000,
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

// ── 只读角色（阶段 5 · A8，spec §2 / §11 缺口 1）────────────────────────

test('createAccount 不给 role 时落成 admin——加一列不改变任何既有账号的权限', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'role-default', username: 'role-default', passwordHash: 'h', now: 1000 })
    expect((await store.findById('role-default'))?.role).toBe('admin')
  } finally {
    await cleanup()
  }
})

test('createAccount 显式建只读账号，三条读路径都带得出 role', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({
      id: 'role-ro', username: 'watcher', passwordHash: 'h', now: 1000, role: 'readonly',
    })
    expect((await store.findById('role-ro'))?.role).toBe('readonly')
    expect((await store.findByUsername('watcher'))?.role).toBe('readonly')
    expect((await store.listAccounts())[0]?.role).toBe('readonly')
  } finally {
    await cleanup()
  }
})

test('库里出现认不出的角色值时读成 readonly——认不出来按最小权限，不是按最大权限', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    // 手工 UPDATE 写错、或者将来多一个角色再降级回滚，都会留下这样一行。
    // 这一列是 VARCHAR 不是 ENUM，所以库拦不住它——拦得住的只有读侧
    await pool.execute(
      `INSERT INTO admin_accounts (id, username, password_hash, created_at, \`role\`)
       VALUES ('role-weird', 'weird', 'h', 1000, 'superadmin')`,
    )
    expect((await store.findById('role-weird'))?.role).toBe('readonly')
  } finally {
    await cleanup()
  }
})

// ── 修改密码（阶段 5 · A8，spec §11 缺口 5）────────────────────────────

test('updatePassword 换掉哈希，且对不存在的 id 返回 false', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'pw-1', username: 'pw-user', passwordHash: 'old-hash', now: 1000 })

    expect(await store.updatePassword('pw-1', 'new-hash')).toBe(true)
    expect((await store.findById('pw-1'))?.passwordHash).toBe('new-hash')
    expect(await store.updatePassword('pw-does-not-exist', 'x')).toBe(false)
  } finally {
    await cleanup()
  }
})

test('deleteSessionsByAdminIdExcept 吊销其它会话但留下当前这一条', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createSession({ tokenHash: 'keep-me', adminId: 'pw-2', expiresAt: 9000, now: 1000 })
    await store.createSession({ tokenHash: 'other-a', adminId: 'pw-2', expiresAt: 9000, now: 1000 })
    await store.createSession({ tokenHash: 'other-b', adminId: 'pw-2', expiresAt: 9000, now: 1000 })
    // 别人的会话不许被牵连
    await store.createSession({ tokenHash: 'someone-else', adminId: 'pw-3', expiresAt: 9000, now: 1000 })

    expect(await store.deleteSessionsByAdminIdExcept('pw-2', 'keep-me')).toBe(2)

    expect(await store.findSessionByTokenHash('keep-me')).not.toBeNull()
    expect(await store.findSessionByTokenHash('other-a')).toBeNull()
    expect(await store.findSessionByTokenHash('other-b')).toBeNull()
    expect(await store.findSessionByTokenHash('someone-else')).not.toBeNull()
  } finally {
    await cleanup()
  }
})

// ── 「最后一个管理员」的判据（US-3.5「不能把自己锁在外面」）─────────────
//
// 这里测的是**唯一那一份判据**：删号与改角色两条路径问的是同一句话
// （见 src/http/handlers/console/auth.ts 的 refuseIfLastAdmin）。
// 它取代的是旧的 `countAccounts() <= 1`——那句数的是 COUNT(*) 不分角色，
// 于是「1 admin + 1 readonly」时 admin 删掉自己是放行的：删完没人能写、
// 没人能建号，admin-bootstrap 也因为表非空而拒跑。

test('isLastAdminAccount：1 admin + 1 readonly 时那个 admin 就是最后一个管理员（旧守卫放走的正是这个死局）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'the-admin', username: 'boss', passwordHash: 'h', now: 1000, role: 'admin' })
    await store.createAccount({ id: 'the-watcher', username: 'watcher', passwordHash: 'h', now: 1000, role: 'readonly' })

    // 旧守卫在这里数出 COUNT(*) = 2 > 1，于是放行
    expect(await store.countAccounts()).toBe(2)
    expect(await store.isLastAdminAccount('the-admin')).toBe(true)
    // 只读账号无论如何都不是「最后一个管理员」——删掉它不会把任何人锁在外面
    expect(await store.isLastAdminAccount('the-watcher')).toBe(false)
  } finally {
    await cleanup()
  }
})

test('isLastAdminAccount：还有第二个 admin 时谁都不是最后一个', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'admin-a', username: 'a', passwordHash: 'h', now: 1000, role: 'admin' })
    await store.createAccount({ id: 'admin-b', username: 'b', passwordHash: 'h', now: 1000, role: 'admin' })

    expect(await store.isLastAdminAccount('admin-a')).toBe(false)
    expect(await store.isLastAdminAccount('admin-b')).toBe(false)
  } finally {
    await cleanup()
  }
})

test('isLastAdminAccount：不存在的 id 与空库都回 false（没有要保护的东西，不能拿它当拒绝的理由）', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    expect(await store.isLastAdminAccount('nobody')).toBe(false)

    await store.createAccount({ id: 'solo-admin', username: 'solo', passwordHash: 'h', now: 1000, role: 'admin' })
    expect(await store.isLastAdminAccount('nobody')).toBe(false)
    expect(await store.isLastAdminAccount('solo-admin')).toBe(true)
  } finally {
    await cleanup()
  }
})

test('isLastAdminAccount：认不出来的角色值不算「另一个管理员」——折叠方式与 parseAdminRole 一致', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'real-admin', username: 'real', passwordHash: 'h', now: 1000, role: 'admin' })
    // 手工 UPDATE 写成大写：MySQL 默认排序规则不区分大小写，`WHERE role = 'admin'`
    // 会把它数成第二个管理员，而 parseAdminRole（`=== 'admin'`）把它折成 readonly
    // ——它一个写端点都调不动。两处不一致的代价正好落在最坏的方向：真正的最后
    // 一个管理员被当成「还有别人」放走
    await pool.execute(
      `INSERT INTO admin_accounts (id, username, password_hash, created_at, \`role\`)
       VALUES ('fake-admin', 'fake', 'h', 1000, 'ADMIN')`,
    )
    expect((await store.findById('fake-admin'))?.role).toBe('readonly')
    expect(await store.isLastAdminAccount('real-admin')).toBe(true)
  } finally {
    await cleanup()
  }
})

// ── 改角色（缺陷二：角色从前只能在建号那一刻定死）──────────────────────

test('updateRole 换掉角色，且对不存在的 id 返回 false', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'role-1', username: 'role-user', passwordHash: 'h', now: 1000, role: 'readonly' })

    expect(await store.updateRole('role-1', 'admin')).toBe(true)
    expect((await store.findById('role-1'))?.role).toBe('admin')
    expect(await store.updateRole('role-1', 'readonly')).toBe(true)
    expect((await store.findById('role-1'))?.role).toBe('readonly')

    expect(await store.updateRole('role-does-not-exist', 'admin')).toBe(false)
  } finally {
    await cleanup()
  }
})

test('updateRole 只碰 role 一列：用户名、密码哈希、建号时刻一个都不动', async () => {
  const { pool, cleanup } = await withTestDb()
  try {
    const store = createAdminStore(pool)
    await store.createAccount({ id: 'role-2', username: 'keep-me', passwordHash: 'keep-hash', now: 4242, role: 'admin' })

    await store.updateRole('role-2', 'readonly')

    expect(await store.findById('role-2')).toEqual({
      id: 'role-2',
      username: 'keep-me',
      passwordHash: 'keep-hash',
      createdAt: 4242,
      role: 'readonly',
    })
  } finally {
    await cleanup()
  }
})
