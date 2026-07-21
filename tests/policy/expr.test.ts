import { expect, test } from 'bun:test'
import { matchExpr } from '../../src/policy/expr'
import type { Meeting } from '../../src/domain/types'

const meeting: Meeting = {
  meetingId: 'm1', subMeetingId: '', meetingRecordId: 'r1', meetingCode: '88123456',
  subject: '季度评审', hostUserId: 'tm-alice', startTime: 1767225600,
  endTime: 1767229200, state: 'completed',
}

test('空表达式匹配任何会议', () => {
  expect(matchExpr({}, meeting)).toBe(true)
})

test('等值匹配', () => {
  expect(matchExpr({ host_userid: 'tm-alice' }, meeting)).toBe(true)
  expect(matchExpr({ host_userid: 'tm-bob' }, meeting)).toBe(false)
})

test('集合包含匹配', () => {
  expect(matchExpr({ host_userid: ['tm-alice', 'tm-bob'] }, meeting)).toBe(true)
  expect(matchExpr({ host_userid: ['tm-bob'] }, meeting)).toBe(false)
})

test('not_in 操作', () => {
  expect(matchExpr({ host_userid: { not_in: ['tm-bob'] } }, meeting)).toBe(true)
  expect(matchExpr({ host_userid: { not_in: ['tm-alice'] } }, meeting)).toBe(false)
})

test('时间区间 gte / lte', () => {
  expect(matchExpr({ start_time: { gte: 1767225600 } }, meeting)).toBe(true)
  expect(matchExpr({ start_time: { gte: 1767225601 } }, meeting)).toBe(false)
  expect(matchExpr({ start_time: { lte: 1767225600 } }, meeting)).toBe(true)
})

test('多个键之间为 AND', () => {
  expect(matchExpr({ host_userid: 'tm-alice', meeting_code: '88123456' }, meeting)).toBe(true)
  expect(matchExpr({ host_userid: 'tm-alice', meeting_code: '99' }, meeting)).toBe(false)
})

test('未知字段名不匹配（防拼写错误导致规则意外放行）', () => {
  expect(matchExpr({ nonexistent_field: 'x' }, meeting)).toBe(false)
})

test('end_time 不是合法字段：平台不返回真实结束时间，Meeting.endTime 恒等于 startTime，' +
  '开放该字段会让「按结束时间管控」的规则静默按开始时间比对——因此按未知字段一律拒绝', () => {
  expect(matchExpr({ end_time: { gte: 0 } }, meeting)).toBe(false)
  expect(matchExpr({ end_time: meeting.endTime }, meeting)).toBe(false)
})

test('gte/lte 套在非数值字段上：一律不匹配（不得静默放行）', () => {
  // subject 是字符串字段，Number('季度评审') = NaN。NaN 比较恒 false，绝不能
  // 被理解成「通过」——必须显式判定为不匹配。
  expect(matchExpr({ subject: { gte: 0 } }, meeting)).toBe(false)
  expect(matchExpr({ subject: { lte: 9999999999 } }, meeting)).toBe(false)
  expect(matchExpr({ host_userid: { gte: 0 } }, meeting)).toBe(false)
})

test('gte/lte 的界值非数值：不匹配', () => {
  expect(matchExpr({ start_time: { gte: 'abc' as unknown as number } }, meeting)).toBe(false)
  expect(matchExpr({ start_time: { lte: 'abc' as unknown as number } }, meeting)).toBe(false)
})

test('数值字段的 gte/lte 仍按原语义工作（回归保护）', () => {
  expect(matchExpr({ start_time: { gte: 1767225600 } }, meeting)).toBe(true)
  expect(matchExpr({ start_time: { gte: 1767225601 } }, meeting)).toBe(false)
  expect(matchExpr({ start_time: { lte: 1767225600 } }, meeting)).toBe(true)
  expect(matchExpr({ start_time: { gte: 1767225500, lte: 1767225700 } }, meeting)).toBe(true)
})
