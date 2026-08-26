import type { ReactNode } from 'react'
import { READONLY_WHY, useReadonly } from '@/app/session'
import styles from './PageShell.module.css'

export interface PageShellProps {
  /** 页面标题。逐字对应 spec.md §3 的页面名，也是左栏导航上的那个词。 */
  title: string
  /** 标题下面那一句。说清这一页回答的是什么问题，不是装饰。 */
  description?: ReactNode
  /** 标题右侧的动作区（「新建规则」一类）。 */
  actions?: ReactNode
  children?: ReactNode
}

/**
 * 每一页共同的头部骨架：标题 + 一句说明 + 右侧动作区。
 *
 * 抽出来的理由和 `api/client.ts` 一样——七个页面并行开工，各自画一遍页头，
 * 得到的是七种略微不同的间距和字号。这里定死一份，页面只管往 `children` 里
 * 填自己的内容。
 *
 * **landmark 不在这里**：`<main>` 由 `AppShell` 提供（一页只能有一个），
 * 这里用 `<section aria-labelledby>` 把标题和内容绑起来，读屏念得出
 * "采集授权，区域"。标题是 `<h1>`——它是这个视图里层级最高的标题。
 */
export function PageShell({ title, description, actions, children }: PageShellProps) {
  const titleId = `page-title-${title}`
  const readonly = useReadonly()
  return (
    <section className={styles.page} aria-labelledby={titleId}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h1 id={titleId} className={styles.title}>
            {title}
          </h1>
          {description !== undefined && <p className={styles.desc}>{description}</p>}
        </div>
        {actions !== undefined && <div className={styles.actions}>{actions}</div>}
      </header>
      {/* 只读账号：一页一句，说清为什么下面那些按钮点不动（spec §11 缺口 1）。
          它放在页头里而不是每个按钮旁边——按钮上的 title 只有把鼠标停上去才
          看得见，而"我这个账号本来就改不了"这件事该在动手之前就知道。 */}
      {readonly && (
        <p className={styles.readonly} data-testid="readonly-banner" role="note">
          {READONLY_WHY}
        </p>
      )}
      {children}
    </section>
  )
}

export default PageShell
