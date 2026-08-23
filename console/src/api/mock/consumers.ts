import type { Consumer } from '../types'

/** 迁自原型的 `CONSUMERS`，形状本就与 `Consumer` 一致，无需转换。 */
export const CONSUMERS: Consumer[] = [
  { id: 'kb-indexer', name: '知识库索引器', scope: 'AI 纪要 + 完整转写' },
  { id: 'daily-digest', name: '简报机器人', scope: 'AI 纪要（仅 txt）' },
  { id: 'dw-sync', name: '数据仓库同步', scope: '全部八类资产' },
]
