import { useState } from 'react'
import { listPrograms } from '@/api/admin/grants'
import { readonlyTitle, useReadonly } from '@/app/session'
import { useResource } from '@/lib/useResource'
import { Button } from '@/ui/Button'
import { PageShell } from '@/ui/PageShell'
import { Skeleton } from '@/ui/Skeleton'
import { ProgramCard } from './ProgramCard'
import { Wizard } from './Wizard'
import styles from './Consumers.module.css'

/**
 * 采集授权页（spec.md §4.5 · §6.4）。
 *
 * 这一页只回答一个问题：**每个外部程序现在实际能取到什么**。spec 说卡片正中间
 * 那句话是「这一页的全部价值」，并且明说它是三个「与」求交之后的**实际结果，
 * 不是配置值**——所以这一页的每一个数字都来自
 * `GET /api/v1/admin/programs/:id/inventory`，逐程序一个请求，没有任何一处
 * 是前端算出来的。
 *
 * 已经删掉的东西：`Consumer.scope`（'AI 纪要 + 完整转写' 那个配置串）。
 * 真实的 `GET /admin/programs` 不下发它，mock 里那一份把一个配置值伪装成了
 * 一次实际结果。删掉它连带动了会议记录页的 `GrantPicker` 一行（那一页归 F2）。
 *
 * 这一轮**没有**的两个动作：停用程序、轮换凭据（spec §11 缺口 4）。
 * 端点还不存在，A8 之后由 F7 接。不放假按钮。
 *
 * ## 三个「与」不再写在导语里
 *
 * 「有授权 ∩ 在保留期内 ∩ 规则允许采集」这件事，卡片自己就在说：`ReachBlock`
 * 报的那个数**就是**求交的结果，取不到时它逐条列出被哪一类判定挡下、去哪一页
 * 改。把同一件事再写成一段导语，等于用文字复述界面已经在做的事——而它占掉了
 * 这一页六成的可见文字。
 *
 * ## 「接入新程序」在空态下搬进空态框里
 *
 * 原来的空态句子里有半句是「点右上角「接入新程序」」——那是用文字指路，
 * 说明按钮站得离人太远。一个程序都没有的时候这一页只该有一个动作，所以
 * 页头的动作区在这时**让位**：按钮搬到空态框正中间，那句指路的话就不用写了。
 */
export default function ConsumersPage() {
  // 挂载时冻结一次。同一屏里"剩 N 天"要按同一个此刻算，不能一个卡片一个时钟。
  const [now] = useState(() => new Date())
  const [wizardOpen, setWizardOpen] = useState(false)
  const readonly = useReadonly()
  const res = useResource(() => listPrograms(), [])

  const empty = res.state === 'ready' && res.data.length === 0
  const addButton = (
    <Button
      variant="primary"
      onClick={() => setWizardOpen(true)}
      disabled={readonly}
      title={readonlyTitle(readonly)}
    >
      接入新程序
    </Button>
  )

  return (
    <PageShell
      title="采集授权"
      description="每个外部程序现在实际能取到哪些会议。"
      // 空态时页头不放按钮：那一刻这一页只该有一个动作，它在空态框里
      actions={empty ? undefined : addButton}
    >
      {res.state === 'loading' && (
        <ul className={styles.cards} aria-busy="true" aria-label="正在读取采集程序">
          {[0, 1, 2].map((i) => (
            <li key={i} className={styles.card}>
              <Skeleton width="52%" />
              <Skeleton width="34%" size="sm" />
              <div className={styles.reach} data-kind="loading">
                <Skeleton width="80%" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {res.state === 'error' && (
        <div className={styles.pageError}>
          {/* 标题把「没读到」与「一个都没有」分开——这件事以前靠一段说明文字说，
              而两种状态本来就长得完全不一样，写成标题就够了 */}
          <h2 className={styles.pageErrorTitle}>没读到程序列表</h2>
          {/* 端点名与后端错误码都在 message 里，照原样显示——"读取失败"四个字定位不了任何东西 */}
          <p role="alert" className={styles.pageErrorText}>
            {res.error.message}
          </p>
          <Button onClick={res.retry}>重试</Button>
        </div>
      )}

      {res.state === 'ready' &&
        (empty ? (
          <div className={styles.empty}>
            <p className={styles.emptyLead}>还没有接入任何采集程序</p>
            {addButton}
          </div>
        ) : (
          <ul className={styles.cards}>
            {res.data.map((p) => (
              <ProgramCard key={p.id} program={p} now={now} onChanged={res.retry} />
            ))}
          </ul>
        ))}

      <Wizard
        open={wizardOpen}
        onDone={(created) => {
          setWizardOpen(false)
          // 建成了就重取列表：不做乐观更新，界面上的每一行都是后端说的（裁定 G-c）
          if (created) res.retry()
        }}
      />
    </PageShell>
  )
}
