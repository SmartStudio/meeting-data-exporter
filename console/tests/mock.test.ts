import { describe, expect, test } from 'vitest'
import { mockApi } from '../src/api/mock'

describe('mock', () => {
  test('nas-down 时受影响会议的保留窗口清零、授权被撤下', async () => {
    const ms = await mockApi('nas-down').listMeetings()
    const broken = ms.filter((m) => m.archive === 'failed')
    expect(broken.length).toBe(5)
    for (const m of broken) {
      expect(m.keep.archivedAt).toBeNull() // 没归档成功就不该开始计时
      expect(m.keep.expiresAt).toBeNull()
      expect(m.grants).toEqual([]) // 没归档成功的东西不该对外可见
    }
  })

  test('empty 与 load-failed 是两种不同的结果，不能折叠', async () => {
    await expect(mockApi('empty').listMeetings()).resolves.toEqual([])
    await expect(mockApi('load-failed').listMeetings()).rejects.toThrow()
  })

  test('mock 数据的资产键全部落在 AssetKey 里', async () => {
    const valid = new Set([
      'video',
      'audio',
      'transcript',
      'ai_transcript',
      'ai_minutes',
      'ai_topic_minutes',
      'ai_speaker_minutes',
      'ai_ds_minutes',
    ])
    for (const m of await mockApi('ok').listMeetings()) {
      for (const k of Object.keys(m.assets)) expect(valid.has(k)).toBe(true)
    }
  })

  // ── 下面是简报之外补充的覆盖 ──

  test('ok 返回 9 场会议，且原本就归档失败的那 1 场不受影响', async () => {
    const ms = await mockApi('ok').listMeetings()
    expect(ms.length).toBe(9)
    expect(ms.filter((m) => m.archive === 'failed').length).toBe(1)
  })

  test('nas-down 不改变已经是 failed / blocked / off 的会议', async () => {
    const before = await mockApi('ok').listMeetings()
    const after = await mockApi('nas-down').listMeetings()
    for (const id of ['m3', 'm4', 'm5']) {
      const b = before.find((m) => m.id === id)!
      const a = after.find((m) => m.id === id)!
      expect(a.archive).toBe(b.archive)
    }
  })

  test('每次调用返回的是独立拷贝，调用方修改不会污染下一次调用', async () => {
    const first = await mockApi('ok').listMeetings()
    first[0]!.title = '被调用方改坏了'
    const second = await mockApi('ok').listMeetings()
    expect(second[0]!.title).not.toBe('被调用方改坏了')
  })
})
