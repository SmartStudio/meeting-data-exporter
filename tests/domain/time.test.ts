import { expect, test } from 'bun:test'
import { msToSec, secToMs } from '../../src/domain/time'

test('msToSec 把毫秒数字转为秒', () => {
  expect(msToSec(1609313201465)).toBe(1609313201)
})

test('msToSec 接受字符串型毫秒（record_info.start_time 为字符串）', () => {
  expect(msToSec('1603089930577')).toBe(1603089930)
})

test('msToSec 向下取整而非四舍五入', () => {
  expect(msToSec(1999)).toBe(1)
})

test('secToMs 是 msToSec 的逆向', () => {
  expect(secToMs(1609313201)).toBe(1609313201000)
})

test('msToSec 拒绝非法输入', () => {
  expect(() => msToSec('abc')).toThrow('invalid millisecond timestamp')
})
