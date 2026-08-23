import type { Consumer, Meeting, SystemState } from '../types'
import { CONSUMERS } from './consumers'
import { MEETINGS, MOCK_NOW } from './meetings'
import { applyNasDown, loadFailedError } from './system'

export { MOCK_NOW }

export interface MockApi {
  listMeetings(): Promise<Meeting[]>
  listConsumers(): Promise<Consumer[]>
}

/**
 * mock 数据层，按 `SystemState` 分支返回不同结果——五种形态是规格的一部分
 * （spec.md §7、§8），不是彩蛋，每种的告警等级和给出的操作都不一样。
 *
 * F1 阶段这是唯一的数据来源；F6 换真 API 时只替换这个模块，`types.ts` 与
 * 消费方（hook / 组件）不用动。
 *
 * 每次调用都返回数据的深拷贝，调用方随便改都不会污染 mock 的基准数据。
 */
export function mockApi(state: SystemState): MockApi {
  return {
    async listMeetings() {
      if (state === 'loading') return new Promise<Meeting[]>(() => {})
      if (state === 'load-failed') throw loadFailedError()
      if (state === 'empty') return []
      if (state === 'nas-down') return applyNasDown(structuredClone(MEETINGS))
      // 'ok' | 'tencent-down'：会议数据照常——腾讯会议不可达只影响"拉新的"，
      // 已经拉下来的会议、归档、对外采集都不受影响（spec.md §7.1）。
      // 「拉新的受影响」这一层告警属于横幅/系统状态展示，不属于会议数据本身。
      return structuredClone(MEETINGS)
    },
    async listConsumers() {
      if (state === 'loading') return new Promise<Consumer[]>(() => {})
      if (state === 'load-failed') throw loadFailedError()
      return structuredClone(CONSUMERS)
    },
  }
}
