import { PageShell } from '@/ui/PageShell'

/**
 * 定时任务页（spec.md §4.8）。空壳——F5a 往里填。
 *
 * 两条已经定死的事，F5a 照办：
 * - **「新建任务」按钮不做**（计划 G-g）：四个内置任务是代码里的常量不是一张表，
 *   自定义任务要先回答"执行体从哪来"。留一个点了弹"还没做"的按钮比没有更差。
 * - 这一页同时是 `tencent-down` 的来源：措辞用 `api/admin/health.ts` 的
 *   `fetchStreakText()`，与系统状态条同一个函数——两处说法不一致等于给了
 *   两个不同的事实。
 */
export default function JobsPage() {
  return (
    <PageShell
      title="定时任务"
      description="四个内置任务的运行情况，以及需要人处理的失败项。本页的数据接线在 F5a。"
    />
  )
}
