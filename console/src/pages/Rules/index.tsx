import { PageShell } from '@/ui/PageShell'

/**
 * 自动规则页 + 规则编辑器（spec.md §4.6 · §4.7 · §5）。空壳——F3 往里填。
 *
 * F3 的头号风险写在计划 §5：**前端不要自己实现一遍求值语义**。
 * 三栈各自独立求值的规则前端只用于"呈现"（这条排第几、会不会被上面那条挡住），
 * 判定结果与影响预览一律来自后端。
 */
export default function RulesPage() {
  return (
    <PageShell
      title="自动规则"
      description="拉取 / 归档 / 采集三栈规则各自独立求值：优先级降序、首个命中即停、不合并。本页的数据接线在 F3。"
    />
  )
}
