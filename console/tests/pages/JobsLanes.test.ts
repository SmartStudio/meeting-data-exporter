import { describe, expect, test } from 'vitest'
import type { JobFailure, JobItem } from '../../src/api/admin/jobs'
import {
  CHAIN_AFTER,
  chainEdgeText,
  failureCountsByJob,
  groupAttemptsText,
  groupFailures,
  groupScopeText,
  laneOf,
  splitLanes,
  targetView,
} from '../../src/pages/Jobs/view'

/**
 * `view.ts` 里这一轮新加的两组纯函数：任务分组（链 / 独立）与失败项归并。
 *
 * 两组都在盯同一件事：**页面上画出来的关系必须是后端真有的关系**。
 * 链的拓扑抄自 `JOB_CHAINS`（根目录 `tests/store/jobs-chain-copy.test.ts` 钉住两处一致），
 * 失败项的归并只认逐字相同，不按关键词猜"这算不算同一类错"。
 */

function job(name: string, label = name): JobItem {
  return {
    name,
    label,
    what: '',
    schedule: '',
    nextDueAt: 0,
    impact: '',
    maxAttempts: 5,
    openFailures: 0,
    health: 'ok',
    lastRun: null,
    recentRuns: [],
  }
}

function failure(over: Partial<JobFailure> = {}): JobFailure {
  return {
    id: 1,
    jobName: 'fetch_recordings',
    target: 'm-1|',
    targetLabel: '',
    meetingId: 'm-1',
    subMeetingId: '',
    reason: 'r',
    impact: 'i',
    attempts: 1,
    maxAttempts: 5,
    escalated: false,
    firstFailedAt: 0,
    lastFailedAt: 100,
    ...over,
  }
}

describe('splitLanes() —— 两组，链内是拓扑序', () => {
  test('后端顺序是 拉取 / 归档 / 清理 / 刷新 / 自动授权：链上三个，独立两个', () => {
    const lanes = splitLanes([
      job('fetch_recordings'),
      job('archive_nas'),
      job('cleanup_expired'),
      job('refresh_inventory'),
      job('auto_grant'),
    ])
    expect(lanes.chain.map((j) => j.name)).toEqual(['fetch_recordings', 'archive_nas', 'auto_grant'])
    expect(lanes.solo.map((j) => j.name)).toEqual(['cleanup_expired', 'refresh_inventory'])
  })

  test('后端顺序乱了也按上游 → 下游排', () => {
    const lanes = splitLanes([job('auto_grant'), job('archive_nas'), job('fetch_recordings')])
    expect(lanes.chain.map((j) => j.name)).toEqual(['fetch_recordings', 'archive_nas', 'auto_grant'])
  })

  test('上游没发下来时下游照样排得出，不会整条链消失', () => {
    const lanes = splitLanes([job('auto_grant'), job('archive_nas')])
    expect(lanes.chain.map((j) => j.name)).toEqual(['archive_nas', 'auto_grant'])
  })

  test('认不出的任务名归独立组，保持后端顺序', () => {
    const lanes = splitLanes([job('x'), job('fetch_recordings'), job('y')])
    expect(lanes.solo.map((j) => j.name)).toEqual(['x', 'y'])
    expect(lanes.chain.map((j) => j.name)).toEqual(['fetch_recordings'])
    expect(laneOf('x')).toBe('solo')
  })

  test('链头（拉取）不是 CHAIN_AFTER 的键——它不接在谁后面——但它在链上', () => {
    expect(CHAIN_AFTER.fetch_recordings).toBeUndefined()
    expect(laneOf('fetch_recordings')).toBe('chain')
  })

  test('箭头文字把方向说出来', () => {
    expect(chainEdgeText({ label: '拉取新录制' }, { label: '归档到 NAS' })).toBe(
      '「拉取新录制」有新产出时，「归档到 NAS」立刻接着跑',
    )
  })
})

describe('groupFailures() —— 任务 + 原因 + 影响逐字相同才是一组', () => {
  test('组按最近失败倒序，组内也倒序；原因或影响差一个字就是另一组', () => {
    const groups = groupFailures([
      failure({ id: 1, lastFailedAt: 100 }),
      failure({ id: 2, lastFailedAt: 300 }),
      failure({ id: 3, reason: 'r2', lastFailedAt: 200 }),
      failure({ id: 4, impact: 'i2', lastFailedAt: 400 }),
    ])
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([[4], [2, 1], [3]])
    expect(groups[1]!.latestAt).toBe(300)
  })

  test('escalated 数的是到上限的条数', () => {
    const g = groupFailures([failure({ id: 1, escalated: true }), failure({ id: 2 })])[0]!
    expect(g.escalated).toBe(1)
    expect(g.items).toHaveLength(2)
  })

  test('groupAttemptsText：全组一样给分数，不一样给区间，不取平均', () => {
    expect(groupAttemptsText({ items: [failure({ attempts: 2 }), failure({ attempts: 2 })] })).toBe('2 / 5')
    expect(groupAttemptsText({ items: [failure({ attempts: 2 }), failure({ attempts: 5 })] })).toBe('2–5 / 5')
  })

  test('groupScopeText：都是会议说「N 场会议」，混着整轮 / 程序说「N 项」', () => {
    expect(groupScopeText({ items: [failure(), failure()] })).toBe('2 场会议')
    expect(groupScopeText({ items: [failure(), failure({ meetingId: null })] })).toBe('2 项')
  })
})

describe('targetView() —— 「对象」那一格', () => {
  test('有标题：主行标题，副行会议 id（带子会议）', () => {
    expect(targetView({ target: 'm|s', targetLabel: '周会', meetingId: 'm', subMeetingId: 's' })).toEqual({
      name: '周会',
      sub: 'm · s',
    })
  })

  test('没标题但有会议 id：主行就是 id，副行留空——不印两遍，也不印 `id|` 那个规范化键', () => {
    expect(targetView({ target: '9070|', targetLabel: '', meetingId: '9070', subMeetingId: '' })).toEqual({
      name: '9070',
      sub: '',
    })
  })

  test('整轮维度（target 是后端的 __round__ 键）：显示「整轮」，不把机器键印出来', () => {
    expect(targetView({ target: '__round__', targetLabel: '', meetingId: null, subMeetingId: '' })).toEqual({
      name: '整轮',
      sub: '',
    })
  })

  test('既没标题也没会议（程序）：照 target 显示，不留空', () => {
    expect(targetView({ target: 'kb-indexer', targetLabel: '', meetingId: null, subMeetingId: '' })).toEqual({
      name: 'kb-indexer',
      sub: '',
    })
  })
})

describe('failureCountsByJob() —— 筛选 chip 的计数', () => {
  test('只含有失败的任务，顺序照 jobs；认不出的任务名排最后并用原名', () => {
    const out = failureCountsByJob({
      jobs: [job('fetch_recordings', '拉取新录制'), job('archive_nas', '归档到 NAS'), job('cleanup_expired', '清理')],
      failures: [
        failure({ jobName: 'archive_nas' }),
        failure({ jobName: 'zzz' }),
        failure({ jobName: 'archive_nas' }),
        failure({ jobName: 'fetch_recordings' }),
      ],
    })
    expect(out).toEqual([
      { name: 'fetch_recordings', label: '拉取新录制', count: 1 },
      { name: 'archive_nas', label: '归档到 NAS', count: 2 },
      { name: 'zzz', label: 'zzz', count: 1 },
    ])
  })
})
