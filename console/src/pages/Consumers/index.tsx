import { PageShell } from '@/ui/PageShell'

/**
 * 采集授权页（spec.md §4.5 · §6.4）。空壳——F4 往里填。
 *
 * 空壳而不是占位组件：七个页面任务并行开工，每人只碰自己这个目录，
 * 路由表（`app/routes.tsx`）在地基阶段就一次性指到位，此后没人再改它。
 *
 * 这一页的端点已经在 `api/admin/grants.ts`（地基建好，与会议记录页的详情
 * 抽屉共用）；F4 另外要建的是 `api/admin/programs.ts`。
 */
export default function ConsumersPage() {
  return (
    <PageShell
      title="采集授权"
      description="每个采集程序实际能取到哪些会议的哪些资产——这是三层求交之后的结果，不是配置值。本页的数据接线在 F4。"
    />
  )
}
