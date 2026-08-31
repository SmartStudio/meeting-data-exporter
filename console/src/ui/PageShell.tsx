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

  /* 视觉上隐藏，语义上保留。
     改版把「你在哪」搬进了顶栏（`app/GlobalBar.tsx` 从路由派生同一份文案，连同
     计数和主操作），页头再印一遍就是同一个词同屏出现两次——六个页面都这样。
     但这个 `<h1>` 不能删：它是本视图层级最高的标题，`<section aria-labelledby>`
     靠它把整块内容绑起来，读屏才念得出「会议记录，区域」；顶栏那份是导航指示，
     刻意不是 heading（否则每页两个 h1）。
     它写在 `<header>` 外面是因为页头本身可以整条不存在（见 `hasHead`），
     而这个 `<h1>` 一页都不能少。 */
  const hidden = (
    <h1 id={titleId} className={styles.titleHidden}>
      {title}
    </h1>
  )

  /**
   * **没话说的时候，这条带子整条不存在。**
   *
   * 页头里可见的东西只有两样：`description` 和 `actions`。两样都没有时，
   * 旧写法照样渲染一个 `<header>`——高度 0，但 `margin-bottom` 20px 照给，
   * 加上内容区自己的 16px 上留白，就是顶栏底下 36px 什么都没有的一条空带。
   * 会议记录与归档存储两页正是这样（1440 实测 36px；有说明的页面同一位置是
   * 64–86px，装着一句话）。空白高度于是不是一条规则，是"这一页恰好有没有
   * 副标题"的副产品。
   *
   * 现在的规则一句话：**带子按它装的东西高，装不下东西就没有带子。**
   */
  const hasHead = description !== undefined || actions !== undefined

  return (
    <section className={styles.page} aria-labelledby={titleId}>
      {!hasHead && hidden}
      {hasHead && (
        <header className={styles.head}>
          <div className={styles.headText}>
            {hidden}
            {description !== undefined && <p className={styles.desc}>{description}</p>}
          </div>
          {actions !== undefined && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      {/* 只读账号：一页一句，说清为什么下面那些按钮点不动（spec §11 缺口 1）。
          它放在页头里而不是每个按钮旁边——按钮上的 title 只有把鼠标停上去才
          看得见，而"我这个账号本来就改不了"这件事该在动手之前就知道。

          `.readonlyUnderHead` 那条负的上外边距是用来抵消页头的 `margin-bottom` 的，
          页头不在时它会把这一条拽进内容区的上留白里——所以只有真有页头才加。 */}
      {readonly && (
        <p
          className={hasHead ? `${styles.readonly} ${styles.readonlyUnderHead}` : styles.readonly}
          data-testid="readonly-banner"
          role="note"
        >
          {READONLY_WHY}
        </p>
      )}
      {children}
    </section>
  )
}

export default PageShell
