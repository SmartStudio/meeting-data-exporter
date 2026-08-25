import { expect, test } from 'bun:test'
import { loadConfig } from '../../src/config'

const env = { MDE_GATEWAY_URL: 'https://gw', MDE_CLIENT_ID: 'cid', MDE_CLIENT_SECRET: 'sec' }

test('env 提供必填三项，文件/flag 提供可选项，默认并发 3', () => {
  const c = loadConfig(env, { storageRoot: './out' }, {})
  expect(c.gatewayUrl).toBe('https://gw')
  expect(c.clientId).toBe('cid')
  expect(c.storageRoot).toBe('./out')
  expect(c.concurrency).toBe(3)
})
test('CLI flag 覆盖文件覆盖默认', () => {
  const c = loadConfig(env, { storageRoot: './file', concurrency: 5 }, { out: './flag', concurrency: 8 })
  expect(c.storageRoot).toBe('./flag')
  expect(c.concurrency).toBe(8)
})
test('缺 MDE_GATEWAY_URL 报字段名', () => {
  const { MDE_GATEWAY_URL, ...bad } = env
  expect(() => loadConfig(bad, {}, {})).toThrow('MDE_GATEWAY_URL')
})
test('缺 storageRoot（无 out/文件）报错', () => {
  expect(() => loadConfig(env, {}, {})).toThrow('storageRoot')
})
test('并发非正整数报错', () => {
  expect(() => loadConfig(env, { concurrency: 0 }, {})).toThrow('concurrency')
})

/**
 * 租约时长可配（M3.5 Stage 9 §4.4）。
 *
 * 硬编码 900 的时候，「崩溃恢复」这条机制**只能靠干等 15 分钟来验**——
 * 这正是它至今零真实证据的原因之一。调小它在生产上是危险的
 * （下载比租约久 → 别的实例抢走还在下的任务 → 两个进程写同一个 .part），
 * 所以默认值一个字节都不能变。
 */
test('租约默认 900 秒，与 worker 的 LEASE_SEC 一致', () => {
  const c = loadConfig(env, { storageRoot: './out' }, {})
  expect(c.leaseSec).toBe(900)
})

test('MDE_LEASE_SEC 能覆盖租约时长', () => {
  const c = loadConfig({ ...env, MDE_LEASE_SEC: '10' }, { storageRoot: './out' }, {})
  expect(c.leaseSec).toBe(10)
})

test('租约非法值报错，且上限挡得住写错一个数量级', () => {
  const bad = (v: string) => () =>
    loadConfig({ ...env, MDE_LEASE_SEC: v }, { storageRoot: './out' }, {})

  expect(bad('0')).toThrow('MDE_LEASE_SEC')
  expect(bad('-1')).toThrow('MDE_LEASE_SEC')
  expect(bad('abc')).toThrow('MDE_LEASE_SEC')
  expect(bad('1.5')).toThrow('MDE_LEASE_SEC')
  // 90000 秒 = 25 小时：过期任务十天不被重领，表现就是「归档静默停滞」,
  // 而那正是租约本身要防的现象
  expect(bad('900000')).toThrow('MDE_LEASE_SEC')
})
