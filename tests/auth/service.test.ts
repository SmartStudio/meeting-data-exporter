import { beforeAll, expect, test } from 'bun:test'
import { createServiceAuth, ServiceAuthError } from '../../src/auth/service'
import type { ServiceAccount } from '../../src/store/auth'

let correctHash: string

beforeAll(async () => {
  correctHash = await Bun.password.hash('s3cr3t-pass', { algorithm: 'argon2id' })
})

function memServiceAccountStore(accounts: ServiceAccount[]) {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  return {
    async findServiceAccount(id: string) {
      return byId.get(id) ?? null
    },
  }
}

test('密钥正确：返回 service_account 身份', async () => {
  const store = memServiceAccountStore([
    {
      id: 'svc-1',
      name: '导出机器人',
      secretHash: correctHash,
      tmUserId: 'tm-svc-1',
      enabled: true,
      expiresAt: null,
      createdAt: 1000,
    },
  ])
  const auth = createServiceAuth({ store })

  const identity = await auth.authenticate('svc-1', 's3cr3t-pass', 2000)
  expect(identity).toEqual({ kind: 'service_account', wecomUserId: null, tmUserId: 'tm-svc-1' })
})

test('密钥错误：拒绝', async () => {
  const store = memServiceAccountStore([
    {
      id: 'svc-1',
      name: '导出机器人',
      secretHash: correctHash,
      tmUserId: 'tm-svc-1',
      enabled: true,
      expiresAt: null,
      createdAt: 1000,
    },
  ])
  const auth = createServiceAuth({ store })

  await expect(auth.authenticate('svc-1', 'wrong-pass', 2000)).rejects.toThrow(ServiceAuthError)
})

test('账号已禁用：拒绝', async () => {
  const store = memServiceAccountStore([
    {
      id: 'svc-disabled',
      name: '已停用账号',
      secretHash: correctHash,
      tmUserId: 'tm-svc-disabled',
      enabled: false,
      expiresAt: null,
      createdAt: 1000,
    },
  ])
  const auth = createServiceAuth({ store })

  await expect(auth.authenticate('svc-disabled', 's3cr3t-pass', 2000)).rejects.toThrow(
    ServiceAuthError,
  )
})

test('账号已过期：拒绝', async () => {
  const store = memServiceAccountStore([
    {
      id: 'svc-expired',
      name: '已过期账号',
      secretHash: correctHash,
      tmUserId: 'tm-svc-expired',
      enabled: true,
      expiresAt: 1500,
      createdAt: 1000,
    },
  ])
  const auth = createServiceAuth({ store })

  // now(2000) >= expiresAt(1500)
  await expect(auth.authenticate('svc-expired', 's3cr3t-pass', 2000)).rejects.toThrow(
    ServiceAuthError,
  )
})

test('未过期边界：now 等于 expiresAt 之前仍可通过', async () => {
  const store = memServiceAccountStore([
    {
      id: 'svc-not-yet-expired',
      name: '未到期账号',
      secretHash: correctHash,
      tmUserId: 'tm-svc-not-yet-expired',
      enabled: true,
      expiresAt: 1500,
      createdAt: 1000,
    },
  ])
  const auth = createServiceAuth({ store })

  const identity = await auth.authenticate('svc-not-yet-expired', 's3cr3t-pass', 1499)
  expect(identity.tmUserId).toBe('tm-svc-not-yet-expired')
})

test('账号不存在：拒绝', async () => {
  const store = memServiceAccountStore([])
  const auth = createServiceAuth({ store })

  await expect(auth.authenticate('svc-does-not-exist', 'any-pass', 2000)).rejects.toThrow(
    ServiceAuthError,
  )
})

test('账号不存在与密钥错误：都跑一次 verify（消除时序预言机），且都抛同一错误', async () => {
  // 行为锁定：两条路径都必须抛 ServiceAuthError（不可区分）。恒定时间属性由
  // 「不存在时也对 dummy hash 跑一次 verify」的实现保证，见 service.ts。
  const store = memServiceAccountStore([
    {
      id: 'svc-1', name: '导出机器人', secretHash: correctHash,
      tmUserId: 'tm-svc-1', enabled: true, expiresAt: null, createdAt: 1000,
    },
  ])
  const auth = createServiceAuth({ store })
  await expect(auth.authenticate('does-not-exist', 'any', 2000)).rejects.toThrow(ServiceAuthError)
  await expect(auth.authenticate('svc-1', 'wrong-pass', 2000)).rejects.toThrow(ServiceAuthError)
})
