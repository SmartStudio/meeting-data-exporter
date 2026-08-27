/**
 * 「不能把自己锁在门外」（US-3.5 验收标准）——**两条路径，一个判据**。
 *
 * ## 这个文件构造的死局
 *
 * 库里 1 个 `admin` + 1 个 `readonly`，那个 admin 想办法让自己不再是 admin。
 * 旧守卫数的是 `COUNT(*)`（`countAccounts() <= 1`），2 > 1 于是**放行**。
 * 放行之后的系统是这样的：
 *
 * - 19 条写端点全部要 `admin` 角色（`requireAdminWrite`）——没人能写；
 * - 建号本身就是写端点——没人能建号；
 * - `scripts/admin-bootstrap.ts` 只在**空表**时可用，而表里还躺着那个 readonly
 *   ——救不了。
 *
 * 没有任何产品路径能退出这个状态。所以这里的用例直接从那个配置出发，
 * 把两条通往它的路各走一遍：**删掉自己**、**把自己降级**。
 *
 * ## 为什么必须走真路由 + 真库
 *
 * 判据要问的是「库里现在还有几个真能写的账号」，而「真能写」是
 * `parseAdminRole` 折叠之后的事实，不是请求里带的角色。跟
 * tests/http/console-readonly.test.ts 同一个理由：装配链里任何一环掉了，
 * 注入假件的 handler 测试都测不出来。
 */
import { afterEach, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp } from './testApp'
import { ADMIN_SESSION_COOKIE } from '../../src/http/middleware'
import { createAdminStore, type AdminStore } from '../../src/store/admin'
import { createAdminAuth } from '../../src/auth/admin'

const NOW = 1_700_000_000

interface Rig {
  app: (req: Request) => Promise<Response>
  store: AdminStore
  /** 那个唯一的 admin 的会话 */
  cookie: string
  auditRows(): Promise<{ action: string; asset_id: string | null; detail: string | null }[]>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/**
 * 1 个 admin（`the-admin` / boss）+ 1 个 readonly（`the-watcher`）。
 * 每个用例各建一个库：「最后一个管理员」是**整张表**的性质，
 * 共用一个库的话上一个用例建的账号会把下一个用例的前提改掉。
 */
async function deadlockRig(): Promise<Rig> {
  const db = await withTestDb()
  cleanups.push(db.cleanup)

  const store = createAdminStore(db.pool)
  const auth = createAdminAuth({ store })
  await store.createAccount({
    id: 'the-admin', username: 'boss', passwordHash: 'h', now: NOW, role: 'admin',
  })
  await store.createAccount({
    id: 'the-watcher', username: 'watcher', passwordHash: 'h', now: NOW, role: 'readonly',
  })
  const cookie = (await auth.issueSession('the-admin', true, NOW)).token
  const { app } = buildTestApp(db.pool, { now: () => NOW })

  return {
    app,
    store,
    cookie,
    async auditRows() {
      const [rows] = await db.pool.execute<
        (RowDataPacket & { action: string; asset_id: string | null; detail: string | null })[]
      >(`SELECT action, asset_id, detail FROM audit_log ORDER BY id ASC`)
      return rows.map((r) => ({ action: r.action, asset_id: r.asset_id, detail: r.detail }))
    },
  }
}

function del(rig: Rig, id: string): Promise<Response> {
  return rig.app(
    new Request(`https://gw.example/api/v1/admin/accounts/${id}`, {
      method: 'DELETE',
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${rig.cookie}` },
    }),
  )
}

function patchRole(rig: Rig, id: string, body: unknown): Promise<Response> {
  return rig.app(
    new Request(`https://gw.example/api/v1/admin/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: `${ADMIN_SESSION_COOKIE}=${rig.cookie}` },
      body: JSON.stringify(body),
    }),
  )
}

// ── 路径一：删掉自己 ────────────────────────────────────────────────────

test('1 admin + 1 readonly：最后一个管理员删不掉自己（409，且账号还在）', async () => {
  const rig = await deadlockRig()

  const res = await del(rig, 'the-admin')
  expect(res.status).toBe(409)
  const body = (await res.json()) as { error: string; message: string }
  expect(body.error).toBe('cannot_remove_last_admin')
  // 判定理由必须可回溯：光一个 409 会让人以为是「账号总数不够」，
  // 于是他会去建一个只读账号再试一次——那一次还是失败，且他不知道为什么
  expect(body.message).toContain('最后一个管理员')

  // 真的没删：库里那一行还在，会话也没被牵连
  expect(await rig.store.findById('the-admin')).not.toBeNull()
  expect(await rig.store.isLastAdminAccount('the-admin')).toBe(true)
  // 被挡回去的请求不留审计（审计记的是已发生的事实）
  expect(await rig.auditRows()).toEqual([])
})

test('同一个死局里删掉那个只读账号是允许的——挡的是「最后一个管理员」，不是「最后一个账号」', async () => {
  const rig = await deadlockRig()

  const res = await del(rig, 'the-watcher')
  expect(res.status).toBe(204)
  expect(await rig.store.findById('the-watcher')).toBeNull()
  // 删到只剩一个账号是允许的，只要它是管理员——旧守卫在这里反而会拦
  expect(await rig.store.countAccounts()).toBe(1)
})

// ── 路径二：把自己降级（加了改角色之后新开的那条路）──────────────────

test('1 admin + 1 readonly：最后一个管理员降不了自己的级（409，且角色没变）', async () => {
  const rig = await deadlockRig()

  const res = await patchRole(rig, 'the-admin', { role: 'readonly' })
  expect(res.status).toBe(409)
  const body = (await res.json()) as { error: string; message: string }
  // 与删除走同一个判据、同一个错误码：分成两个的那一天，其中一个会忘了跟上
  expect(body.error).toBe('cannot_remove_last_admin')
  expect(body.message).toContain('最后一个管理员')

  expect((await rig.store.findById('the-admin'))?.role).toBe('admin')
  expect(await rig.auditRows()).toEqual([])
})

test('把最后一个管理员的角色「改成 admin」不算降级，照常放行（守卫认的是降级，不是这条端点）', async () => {
  const rig = await deadlockRig()

  const res = await patchRole(rig, 'the-admin', { role: 'admin' })
  expect(res.status).toBe(200)
  expect((await rig.store.findById('the-admin'))?.role).toBe('admin')
})

// ── 两条路径解套之后都通：判据认的是事实，不是端点 ──────────────────────

test('先把只读账号提成 admin，原来那个管理员就删得掉自己、也降得了级', async () => {
  const rig = await deadlockRig()

  const promoted = await patchRole(rig, 'the-watcher', { role: 'admin' })
  expect(promoted.status).toBe(200)
  expect(await promoted.json()).toEqual({ id: 'the-watcher', username: 'watcher', role: 'admin' })

  // 现在有两个 admin，降级自己不再是死局
  const demoted = await patchRole(rig, 'the-admin', { role: 'readonly' })
  expect(demoted.status).toBe(200)
  expect((await rig.store.findById('the-admin'))?.role).toBe('readonly')

  // 降完之后自己就是只读账号了——再想改回来会被 requireAdminWrite 挡在门口，
  // 这是角色守卫在起作用，不是本文件这条判据
  const again = await patchRole(rig, 'the-admin', { role: 'admin' })
  expect(again.status).toBe(403)
  expect(((await again.json()) as { error: string }).error).toBe('readonly_role')
})

// ── 改角色要留痕，且看得出改前改后 ──────────────────────────────────────

test('改角色落一行审计，detail 里看得出「从什么改成了什么」', async () => {
  const rig = await deadlockRig()

  expect((await patchRole(rig, 'the-watcher', { role: 'admin' })).status).toBe(200)

  const rows = await rig.auditRows()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.action).toBe('change_admin_role')
  expect(rows[0]!.asset_id).toBe('the-watcher')
  // 改前改后都要在：只写「改了角色」的审计回答不了「谁把他提成管理员的、
  // 他之前是什么」，而这正是事后追责唯一要问的那句话
  expect(rows[0]!.detail).toContain('readonly')
  expect(rows[0]!.detail).toContain('admin')
  expect(rows[0]!.detail).toContain('watcher')
})

// ── 入参校验：认不出来的角色报错，不悄悄折成某一个 ────────────────────

test('PATCH 的 role 认不出来时报 400，不悄悄折成 readonly', async () => {
  const rig = await deadlockRig()

  for (const bad of [{ role: 'read-only' }, { role: '' }, { role: 3 }, {}]) {
    const res = await patchRole(rig, 'the-watcher', bad)
    expect({ bad, status: res.status }).toEqual({ bad, status: 400 })
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_role' })
  }
  // 一次都没写进去
  expect((await rig.store.findById('the-watcher'))?.role).toBe('readonly')
  expect(await rig.auditRows()).toEqual([])
})

test('PATCH 一个不存在的账号是 404，不是「改成功了」', async () => {
  const rig = await deadlockRig()

  const res = await patchRole(rig, 'nobody-here', { role: 'admin' })
  expect(res.status).toBe(404)
  expect(((await res.json()) as { error: string }).error).toBe('account_not_found')
  expect(await rig.auditRows()).toEqual([])
})
