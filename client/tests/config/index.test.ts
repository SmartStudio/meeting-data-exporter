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
