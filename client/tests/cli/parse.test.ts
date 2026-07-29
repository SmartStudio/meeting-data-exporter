import { expect, test } from 'bun:test'
import { parseArgs } from '../../src/cli'

test('run --from --to --out --assets', () => {
  const c = parseArgs(['run', '--from', '2026-07-01', '--to', '2026-07-31', '--out', './m', '--assets', 'video,transcript'])
  expect(c.command).toBe('run')
  expect(c.assets).toEqual(['video', 'transcript'])
  expect(c.from).toBe(Date.UTC(2026, 6, 1) / 1000)
})
test('get 位置参数为会议号/ID', () => {
  const c = parseArgs(['get', '88123456'])
  expect(c.command).toBe('get'); expect(c.target).toBe('88123456')
})
test('未知资产键报错', () => {
  expect(() => parseArgs(['run', '--assets', 'bogus'])).toThrow('bogus')
})
test('缺命令返回 help', () => {
  expect(parseArgs([]).command).toBe('help')
})
