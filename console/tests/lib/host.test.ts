import { describe, expect, test } from 'vitest'
import {
  HOST_MISSING_LABEL,
  HOST_UNKNOWN_LABEL,
  hostLabel,
  hostView,
  HOST_NONE_LABEL,
  shortHostId,
} from '../../src/lib/host'

/**
 * 主持人展示（`src/lib/host.ts`）。
 *
 * 它住在 `lib/` 而不是某一页里，是因为**两个页面都要用**：会议记录页的那一列，
 * 和内容预览页的抬头。后者曾经把同一串 32 位 userid 原样上屏——同一个病在两页
 * 各犯一次，正是「逻辑只属于第一个用到它的页面」的代价。
 *
 * 真实取值（本部署 2026-08-28 实测）：`woaJARCQAAt_hKBw--YKZeVjEaIMGFQQ`，
 * 而 `identity_map` 一行都没有，所以**降级路径是当前唯一会跑到的路径**。
 */

const REAL_ID = 'woaJARCQAAt_hKBw--YKZeVjEaIMGFQQ'
const OTHER_ID = 'woaJARCQAAA1LL0U0f3ZkO1CNpkzWNrQ'

describe('三条路径', () => {
  test('平台没给主持人（host 为空串、元数据齐全）→ 说「无主持人」，带一句解释，不是「未取到」', () => {
    // 设备账号发起的快速会议就是这样（2026-09-03 实测）。它与「元数据没取到」不是一回事。
    const v = hostView({ host: '', hostName: null, missing: [] })
    expect(v.text).toBe(HOST_NONE_LABEL)
    expect(v.text).not.toBe(HOST_MISSING_LABEL)
    expect(v.tail).toBeNull()
    expect(v.title).toContain('设备账号')
    expect(v.resolved).toBe(false)
    expect(hostLabel({ host: '', hostName: null, missing: [] })).toBe(HOST_NONE_LABEL)
  })

  test('库里没有主持人 → 说「未取到」，不是空白', () => {
    const v = hostView({ host: '', hostName: null, missing: ['host'] })
    expect(v.text).toBe(HOST_MISSING_LABEL)
    expect(v.resolved).toBe(false)
    expect(v.tail).toBeNull()
    // 离开列头之后要说清「未取到」的是哪一样东西
    expect(hostLabel({ host: '', hostName: null, missing: ['host'] })).toBe(`主持人${HOST_MISSING_LABEL}`)
  })

  test('查不到姓名 → 降级，且**绝不**把 id 原样当人名摆出去', () => {
    const v = hostView({ host: REAL_ID, hostName: null, missing: [] })
    expect(v.text).toBe(HOST_UNKNOWN_LABEL)
    expect(v.resolved).toBe(false)
    // 这是这个模块存在的全部理由
    expect(v.text).not.toBe(REAL_ID)
    expect(hostLabel({ host: REAL_ID, hostName: null, missing: [] })).not.toContain(REAL_ID)
    // 全量 id 仍然给得到——排查时只有它有用
    expect(v.title).toContain(REAL_ID)
  })

  test('查到了 → 显示姓名，全量 id 退进 title', () => {
    const v = hostView({ host: REAL_ID, hostName: '邹燕建', missing: [] })
    expect(v.text).toBe('邹燕建')
    expect(v.resolved).toBe(true)
    expect(v.tail).toBeNull()
    expect(v.title).toContain(REAL_ID)
  })
})

describe('降级形态要顶用', () => {
  test('两个不同的主持人必须分得开——勾选前要判断的正是「这几场是不是同一个人」', () => {
    const a = hostLabel({ host: REAL_ID, hostName: null, missing: [] })
    const b = hostLabel({ host: OTHER_ID, hostName: null, missing: [] })
    expect(a).not.toBe(b)
  })

  test('同一个主持人的两行长得一样', () => {
    const a = hostLabel({ host: REAL_ID, hostName: null, missing: [] })
    const b = hostLabel({ host: REAL_ID, hostName: null, missing: [] })
    expect(a).toBe(b)
  })

  test('短 id 整串显示——给它掐头去尾反而更难认', () => {
    expect(shortHostId('abc123')).toBe('abc123')
    expect(shortHostId(REAL_ID)).toBe('…IMGFQQ')
  })

  test('空字符串的 hostName 不算查到了（后端下发空串 ≠ 有姓名）', () => {
    expect(hostView({ host: REAL_ID, hostName: '', missing: [] }).text).toBe(HOST_UNKNOWN_LABEL)
  })
})
