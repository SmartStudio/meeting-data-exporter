import { expect, test } from 'bun:test'
import { assignDirOrdinals } from '../../src/domain/dir-ordinal'
import { meetingPathKey } from '../../src/domain/types'

/**
 * 目录序号：同一 `meeting_id` 下算出同名目录的多条录制记录，按 `sub_meeting_id`
 * 字符串升序编号，第一条不带后缀。
 *
 * 这不是理论上的边角：腾讯常给同一场会议两条记录——正常录制 + 主题带「转写_」
 * 前缀的转写记录，两者 `media_start_time` 相同。本机库 294 场会议里有 84 组
 * 落在同一 `(meeting_id, 起始分钟)`。按场次拆开之后它们是两场会议，目录名却
 * 一样，于是 transcript.txt / meeting.json / _manifest.json 互相覆盖。
 */

/** 2026-08-20T09:30:00Z 与 09:30:59Z：同一分钟（目录名只到 hhmm） */
const T0 = 1787218200
/** 默认 createdAt 相同：这样「同批发现」的那几条用例落在 sub_meeting_id 这个次序上 */
const row = (subMeetingId: string, over: Partial<{ meetingId: string; startTime: number; meetingCode: string | null; subject: string | null; createdAt: number }> = {}) => ({
  meetingId: 'm1', subMeetingId, subject: null, startTime: T0, meetingCode: '881-123-40', createdAt: 100, ...over,
})

test('同一分钟同一目录名的两条记录：sub 升序，第一条 1、第二条 2', () => {
  // 故意逆序传入：序号只能由 sub_meeting_id 决定，不能由输入顺序决定
  const m = assignDirOrdinals([row('rec-2'), row('rec-1')])
  expect(m.get(meetingPathKey('m1', 'rec-1'))).toBe(1)
  expect(m.get(meetingPathKey('m1', 'rec-2'))).toBe(2)
})

test('存量空串行排最前，永远保住无后缀的目录', () => {
  const m = assignDirOrdinals([row('rec-1'), row('')])
  expect(m.get(meetingPathKey('m1', ''))).toBe(1)
  expect(m.get(meetingPathKey('m1', 'rec-1'))).toBe(2)
})

test('起始分钟不同 → 目录本就不同名，各自都是 1', () => {
  const m = assignDirOrdinals([row('rec-1'), row('rec-2', { startTime: T0 + 60 })])
  expect(m.get(meetingPathKey('m1', 'rec-1'))).toBe(1)
  expect(m.get(meetingPathKey('m1', 'rec-2'))).toBe(1)
})

test('同一分钟内的秒数差不算另一个目录：目录名只到 hhmm，仍要编号', () => {
  const m = assignDirOrdinals([row('rec-1'), row('rec-2', { startTime: T0 + 59 })])
  expect(m.get(meetingPathKey('m1', 'rec-2'))).toBe(2)
})

test('不同 meeting 同分钟同会议号 → 互不干扰，都是 1', () => {
  const m = assignDirOrdinals([row('rec-1'), row('rec-1', { meetingId: 'm2' })])
  expect(m.get(meetingPathKey('m1', 'rec-1'))).toBe(1)
  expect(m.get(meetingPathKey('m2', 'rec-1'))).toBe(1)
})

test('三条同分钟 → 1/2/3，按 sub 升序', () => {
  const m = assignDirOrdinals([row('c'), row('a'), row('b')])
  expect([m.get(meetingPathKey('m1', 'a')), m.get(meetingPathKey('m1', 'b')), m.get(meetingPathKey('m1', 'c'))])
    .toEqual([1, 2, 3])
})

test('同分钟但会议号不同 → 目录名不同，各自都是 1', () => {
  const m = assignDirOrdinals([row('rec-1'), row('rec-2', { meetingCode: '999-000-00' })])
  expect(m.get(meetingPathKey('m1', 'rec-1'))).toBe(1)
  expect(m.get(meetingPathKey('m1', 'rec-2'))).toBe(1)
})

test('主题不进目录名（2026-09-08 起），所以主题不同也照样要编号', () => {
  // 「转写_」记录与正常记录的差别只在主题上——如果分组键掺了主题，这两条会各占一个
  // 序号 1，回到互相覆盖的老路
  const m = assignDirOrdinals([row('rec-1', { subject: '周会' }), row('rec-2', { subject: '转写_周会' })])
  expect(m.get(meetingPathKey('m1', 'rec-2'))).toBe(2)
})

test('空输入给空 Map，不抛', () => {
  expect(assignDirOrdinals([]).size).toBe(0)
})

// ── 序号必须「钉住」：后来者不抢先到者的目录 ────────────────────────────────
//
// 只按 sub_meeting_id 排序是不够的，因为这个函数每一轮都从头算一遍：某场会议这一轮
// 只有 rec-5（序号 1，资产已经落进无后缀的目录），下一轮上游补出一条 sub 更小的
// rec-3，纯字符串序会把 rec-3 排到前面——rec-5 的目录当场改名，已完成的资产留在旧
// 目录里（清单从此写不出来），未完成的落进 _2，而 rec-3 下载进那个已经装着 rec-5
// 文件的目录。正是本文件要防的那次碰撞，只是晚了一轮。
//
// 所以主序是 created_at（首次发现时间，upsertMeeting 在冲突时不改它），
// sub_meeting_id 只做同批发现时的次序。不变量：**只要没有行被删除，一行的序号
// 永远不变，新来的取下一个号**。

test('后来发现的场次即使 sub 更小也排后面：先到者的序号不动', () => {
  const m = assignDirOrdinals([
    row('rec-5', { createdAt: 100 }),
    row('rec-3', { createdAt: 200 }),   // 晚一轮才被发现
  ])
  expect(m.get(meetingPathKey('m1', 'rec-5'))).toBe(1)
  expect(m.get(meetingPathKey('m1', 'rec-3'))).toBe(2)
})

test('同一批发现（created_at 相同）时按 sub 升序定序', () => {
  const m = assignDirOrdinals([row('rec-3', { createdAt: 100 }), row('rec-1', { createdAt: 100 })])
  expect(m.get(meetingPathKey('m1', 'rec-1'))).toBe(1)
  expect(m.get(meetingPathKey('m1', 'rec-3'))).toBe(2)
})

test('空串行排在前不是特权：created_at 更早的那条才保住无后缀的目录', () => {
  // 空串行排最前靠的是「它先被发现」这个事实，不是靠给空串开小灶。真出现一条
  // created_at 更早的新场次时，先到者才是那个保住无后缀目录的人——存量目录的
  // 稳定性由「已经在库里 = created_at 更早」保证。
  const m = assignDirOrdinals([row('', { createdAt: 300 }), row('rec-1', { createdAt: 100 })])
  expect(m.get(meetingPathKey('m1', 'rec-1'))).toBe(1)
  expect(m.get(meetingPathKey('m1', ''))).toBe(2)
})

test('新增一行不改动已有行的序号（追加稳定）', () => {
  const before = assignDirOrdinals([row('rec-5', { createdAt: 100 })])
  const after = assignDirOrdinals([row('rec-5', { createdAt: 100 }), row('rec-3', { createdAt: 200 })])
  expect(before.get(meetingPathKey('m1', 'rec-5'))).toBe(1)
  expect(after.get(meetingPathKey('m1', 'rec-5'))).toBe(1)   // 没被后来者挤走
  expect(after.get(meetingPathKey('m1', 'rec-3'))).toBe(2)
})
