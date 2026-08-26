import { PageShell } from '@/ui/PageShell'

/**
 * 操作审计页（spec.md §4.10）。空壳——F5c 往里填。
 *
 * 两个已知的坑（计划 §9）：`audit_log.occurred_at` 是 **unix 秒不是毫秒**
 * （阶段 4 有两个独立的实施者都在这一列上栽过），格式化一律走 `lib/format.ts`；
 * `detail` 可能为 NULL（这一列加进来之前的历史记录），为 NULL 时显示"无细节"
 * 而不是空白——空白让人以为是渲染坏了。
 */
export default function AuditPage() {
  return (
    <PageShell
      title="操作审计"
      description="谁、在什么时候、对哪一场会议做了什么。本页的数据接线在 F5c。"
    />
  )
}
