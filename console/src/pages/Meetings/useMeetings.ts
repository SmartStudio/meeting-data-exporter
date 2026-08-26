import type { Meeting } from '@/api/types'
import { mockApi } from '@/api/mock'
import { useSystemState } from '@/app/SystemStatus'
import { useResource, type Resource } from '@/lib/useResource'

/**
 * 会议列表数据。
 *
 * **从 `app/SystemStatus.tsx` 搬过来的，实现一个字没改。** 它住在那里纯属
 * 历史原因：那个文件同时装着两样不相干的东西——全局的系统健康状态，和只有
 * 这一页用的会议数据。地基（F0）要把系统状态接到真实端点，会议记录页（F2）
 * 要把这份数据换成真 API，两件事撞在同一个文件上。搬开之后各改各的。
 *
 * **它现在仍然吃 mock**，换真 API（`GET /api/v1/admin/meetings`）是 F2 的事，
 * 不是 F0 的。F0 的验收里明写"会议记录页行为完全不变"。
 *
 * F2 换掉这里时要一起处理的三处形态差异见计划 §4.1：分页（真 API 带分页与
 * 总数，分诊条的计数**不能**用当前页的行去算，它有自己的端点）、"今天"
 * （`MOCK_NOW` 钉在 2026-08-23，换成 `new Date()`）、以及筛选与排序在服务端。
 */
export function useMeetings(): Resource<Meeting[]> & { retry: () => void } {
  const { state } = useSystemState()
  return useResource(() => mockApi(state).listMeetings(), [state])
}
