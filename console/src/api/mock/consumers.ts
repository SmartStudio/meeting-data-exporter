import type { Consumer } from '../types'

/**
 * 迁自原型的 `CONSUMERS`。
 *
 * 原来还有一个 `scope` 字段（'AI 纪要 + 完整转写' 一类），阶段 5 · F4 连同
 * `Consumer.scope` 一起删了：真实的 `GET /api/v1/admin/programs` 不下发它，
 * 留着就是拿一个配置串冒充"这个程序实际能取到什么"（spec.md §4.5）。
 */
export const CONSUMERS: Consumer[] = [
  { id: 'kb-indexer', name: '知识库索引器' },
  { id: 'daily-digest', name: '简报机器人' },
  { id: 'dw-sync', name: '数据仓库同步' },
]
