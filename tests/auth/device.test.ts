import { expect, test } from 'bun:test'
import {
  createDeviceFlow, DeviceFlowExpired, DeviceFlowPending, DeviceFlowSlowDown,
} from '../../src/auth/device'
import type { DeviceAuth } from '../../src/store/auth'

function memAuthStore() {
  const rows = new Map<string, DeviceAuth>()
  return {
    rows,
    async createDeviceAuth(d: DeviceAuth) { rows.set(d.deviceCode, d) },
    async findByState(state: string) {
      return [...rows.values()].find((r) => r.state === state) ?? null
    },
    async authorize(state: string, wecomUserId: string, tmUserId: string) {
      const r = [...rows.values()].find((x) => x.state === state)
      if (!r || r.status !== 'pending') return false
      rows.set(r.deviceCode, { ...r, status: 'authorized', wecomUserId, tmUserId })
      return true
    },
    async pollDevice(deviceCode: string, now: number) {
      const r = rows.get(deviceCode)
      if (r) rows.set(deviceCode, { ...r, lastPolledAt: now })
      return r ?? null
    },
  }
}

test('start 返回 user_code 与验证地址', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  expect(r.userCode).toHaveLength(8)
  expect(r.verificationUri).toContain('https://gw')
  expect(r.interval).toBe(5)
  expect(r.expiresIn).toBe(300)
})

test('授权前轮询返回 pending', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  await expect(flow.poll(r.deviceCode, 1010)).rejects.toThrow(DeviceFlowPending)
})

test('早于 interval 轮询返回 slow_down', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  await flow.poll(r.deviceCode, 1010).catch(() => {})
  await expect(flow.poll(r.deviceCode, 1012)).rejects.toThrow(DeviceFlowSlowDown)
})

test('授权后轮询返回身份', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  await flow.completeAuthorization(r.state, 'ww-alice', 'tm-alice')
  expect(await flow.poll(r.deviceCode, 1100)).toEqual({
    // programId 为 null：设备授权流程登录的是人，人没有采集程序身份
    kind: 'wecom_user', wecomUserId: 'ww-alice', tmUserId: 'tm-alice', programId: null,
  })
})

test('超过 ttl 后轮询报过期', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  await expect(flow.poll(r.deviceCode, 1400)).rejects.toThrow(DeviceFlowExpired)
})

test('重放已使用的 state 不再生效（防会话绑定攻击）', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  expect(await flow.completeAuthorization(r.state, 'ww-alice', 'tm-alice')).toBe(true)
  expect(await flow.completeAuthorization(r.state, 'ww-mallory', 'tm-mallory')).toBe(false)
})
