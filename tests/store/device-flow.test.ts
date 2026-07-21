import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createAuthStore } from '../../src/store/auth'
import { createDeviceFlow, DeviceFlowPending, DeviceFlowSlowDown } from '../../src/auth/device'

/**
 * device.ts 的单元测试全部对着 tests/auth/device.test.ts 里的内存 stub 跑，
 * stub 对 pollDevice 语义的实现（返回更新前的旧 last_polled_at）恰好是正确的，
 * 但真实的 createAuthStore().pollDevice 曾经把返回值里的 last_polled_at 替换成
 * 本次传入的 now，导致差值恒为 0，限速判断对每一次轮询都会触发。这个问题只有在
 * 真实 store 下端到端跑一遍整条设备流程才会暴露——纯内存 stub 会掩盖它。
 *
 * 本文件用真实的 AuthStore（连接真实 MySQL）驱动 createDeviceFlow，逐字复刻
 * 审查者的复现场景：首次 poll、间隔 10 秒的第二次 poll、授权后的最终 poll，
 * 三种场景都不应该抛出 DeviceFlowSlowDown。
 */

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

test('设备授权流程在真实 store 下可用（回归：pollDevice 曾把 lastPolledAt 覆盖成 now，导致永远 slow_down）', async () => {
  const store = createAuthStore(pool)
  const flow = createDeviceFlow({ store, baseUrl: 'https://gw', ttlSec: 300 })

  const t0 = 1_700_000_000
  const started = await flow.start(t0)

  // 场景一：首次 poll。旧值曾经被塞进了本次的 now，导致这里必然 slow_down；
  // 修复后应该是 pending（还未授权）。
  await expect(flow.poll(started.deviceCode, t0 + 1)).rejects.toThrow(DeviceFlowPending)

  // 场景二：间隔 10 秒的第二次 poll，仍未授权。interval 是 5 秒，10 秒早已足够，
  // 应继续是 pending，不应该是 slow_down。
  await expect(flow.poll(started.deviceCode, t0 + 11)).rejects.toThrow(DeviceFlowPending)

  // 验证限速本身没有被误删：紧接着立刻再 poll 一次（间隔 1 秒 < interval 5 秒）
  // 仍然应该 slow_down。
  await expect(flow.poll(started.deviceCode, t0 + 12)).rejects.toThrow(DeviceFlowSlowDown)

  const authorized = await flow.completeAuthorization(started.state, 'wecom-zed', 'tm-zed')
  expect(authorized).toBe(true)

  // 场景三：授权后、间隔 10 秒的最终 poll。这是设备流程真正拿到令牌的一步，
  // 之前的 bug 会让这一步也 slow_down，客户端永远拿不到身份。
  const identity = await flow.poll(started.deviceCode, t0 + 22)
  expect(identity).toEqual({ kind: 'wecom_user', wecomUserId: 'wecom-zed', tmUserId: 'tm-zed' })
})
