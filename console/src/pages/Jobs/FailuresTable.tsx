import { useEffect, useMemo, useState } from 'react'
import type { JobFailure, JobsOverview } from '@/api/admin/jobs'
import { fmtDateTime } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Chip } from '@/ui/Chip'
import { Table } from '@/ui/Table'
import {
  FAILURE_GROUPS_PAGE,
  FAILURE_ITEMS_PAGE,
  attemptsText,
  failureCountsByJob,
  fmtAgo,
  groupAttemptsText,
  groupFailures,
  groupScopeText,
  hiddenFailureCount,
  targetView,
  type FailureGroup,
} from './view'
import styles from './Jobs.module.css'

/**
 * 「失败项 · 需要处理」（spec.md §4.8）。
 *
 * spec 在这一节写死了两件事，所以它们是这张表的存在理由，不是可选的列：
 *
 * > **失败项不会静默丢弃**，会一直留在下方的「失败项 · 需要处理」表里等重试，
 * > 且明写影响（「未归档，到期会永久丢失」）和已重试次数（`2 / 5`）
 *
 * 第三件事是契约给的：`failures[]` 一次最多 100 条而 `failuresTotal` 是全量总数。
 * **被截断时必须说出来**——「显示 100 条」与「一共就 100 条」在屏幕上长得一模一样，
 * 而后者会让人以为已经看完了。
 *
 * ## 一行是「一件事」，不是「一条记录」
 *
 * 原来一条失败项一行。一轮拉取里 18 场会议在腾讯会议那头 404，屏幕上就是 18 行
 * 逐字一样的原因、逐字一样的「如果不处理」，整页被它撑到要滚三屏才见底，而任务
 * 卡片——这一页真正该先看的东西——被挤到视口外。现在按「任务 + 原因 + 影响」
 * 归并（`view.ts` 的 `groupFailures`）：同一件事一行，涉及了几场会议写成一个可以
 * 展开的数字。展开也分页（`FAILURE_ITEMS_PAGE`），组也分页（`FAILURE_GROUPS_PAGE`），
 * 页面高度于是有上限，不随失败项数无限长。
 *
 * 表格**不在自己的框里滚**：页面已经在滚，框里再滚一层就是两条滚动条打架——
 * 这正是原来「表一大整个页面滚动就不对」的另一种写法。高度靠归并和分页收住，
 * 不靠一个固定高度的滚动框。
 *
 * ## 为什么每行没有「重试」按钮
 *
 * 原型里有一个（`gate-console.html` 的 `data-retry`），但后端只有一条写端点
 * （`POST /api/v1/admin/jobs/:name/run`），**没有"重试这一条失败项"这个动作**。
 * 每个任务的重试都是由各自的枚举源结构性驱动的：那一条失败项下一轮照样会被捞起来
 * 重试，不需要也没法单独点。把整个任务的「立即运行」伪装成行内的「重试」，
 * 点下去实际跑的是一整轮——那是一个名字和行为对不上的按钮。
 *
 * 「已自动重试」这个列名把"它在被重试、不用人点"写进了表头，逐行的 `2 / 5`
 * 就是这条承诺可核对的样子；表头上方因此不用再挂一段说明。
 */
export function FailuresTable({ o, now }: { o: JobsOverview; now: number }) {
  const hidden = hiddenFailureCount(o)
  const base = new Date(now * 1000)
  const labelOf = (name: string): string => o.jobs.find((j) => j.name === name)?.label ?? name

  const counts = useMemo(() => failureCountsByJob(o), [o])
  const [jobFilter, setJobFilter] = useState<string | null>(null)
  // 筛的那个任务在这一批里已经没有失败项了（重取之后清空了）：退回「全部」，
  // 不让一个筛选把表筛成空的还看不出为什么。
  const filterAlive = jobFilter === null || counts.some((c) => c.name === jobFilter)
  const activeFilter = filterAlive ? jobFilter : null

  const groups = useMemo(() => {
    const list = activeFilter === null ? o.failures : o.failures.filter((f) => f.jobName === activeFilter)
    return groupFailures(list)
  }, [o.failures, activeFilter])

  const [groupLimit, setGroupLimit] = useState(FAILURE_GROUPS_PAGE)
  // 换筛选就从第一页重新数——上一个筛选翻到第三页，不代表这个也要从第三页看起。
  useEffect(() => {
    setGroupLimit(FAILURE_GROUPS_PAGE)
  }, [activeFilter])

  const shown = groups.slice(0, groupLimit)
  const moreGroups = groups.length - shown.length

  return (
    <section className={styles.failures} aria-labelledby="jobs-failures-title">
      <div className={styles.failHead}>
        <h2 id="jobs-failures-title" className={styles.h2}>
          失败项 · 需要处理
        </h2>
        {o.failuresTotal > 0 && (
          <span className={styles.failCount} data-testid="failures-count">
            {o.failuresTotal} 条
          </span>
        )}
      </div>

      {/* 只有失败项散在两个以上任务里时才给筛选。全在一个任务里时，
          「全部 19 / 拉取新录制 19」两个 chip 说的是同一件事。 */}
      {counts.length > 1 && (
        <div className={styles.facets} role="group" aria-label="按任务筛选失败项" data-testid="failures-facets">
          <Chip active={activeFilter === null} onClick={() => setJobFilter(null)}>
            全部 {o.failures.length}
          </Chip>
          {counts.map((c) => (
            <Chip key={c.name} active={activeFilter === c.name} onClick={() => setJobFilter(c.name)}>
              {c.label} {c.count}
            </Chip>
          ))}
        </div>
      )}

      {hidden > 0 && (
        <p className={styles.truncated} data-testid="failures-truncated" role="status">
          下面只列出最近 {o.failures.length} 条；<b>一共 {o.failuresTotal} 条待处理</b>，
          还有 {hidden} 条没有列出来。
        </p>
      )}

      {o.failures.length === 0 ? (
        <p className={styles.empty} data-testid="failures-empty">
          没有待处理的失败项。
        </p>
      ) : (
        <>
          {/* cards：窄屏（≤56em）一行一张卡片，不横滚（spec §11 缺口 2）。
              每个 td 因此必须带 data-label。 */}
          <Table data-testid="failures-table" cards>
            <thead>
              <tr>
                <th scope="col">任务</th>
                <th scope="col">原因</th>
                <th scope="col">涉及</th>
                <th scope="col">最近失败</th>
                {/* 「已自动重试」而不是「已重试」：列名把「自动」写进去，
                    表头上方那段「它们会被各自的任务自动捞起来重试」就不用写了。 */}
                <th scope="col">已自动重试</th>
                {/* 「如果不处理」而不是「影响」：这张表是一份待办清单，每一行都是
                    一件**还没处理的事**，列名说的就是不处理的下场。任务卡上那行
                    标签是「影响：」——那里说的是这个任务本身的性质，不针对某一条。 */}
                <th scope="col">如果不处理</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => (
                <GroupRows key={g.key} g={g} label={labelOf(g.jobName)} base={base} now={now} />
              ))}
            </tbody>
          </Table>
          {moreGroups > 0 && (
            <div className={styles.moreRow}>
              <Button size="sm" onClick={() => setGroupLimit((n) => n + FAILURE_GROUPS_PAGE)} data-testid="failures-more-groups">
                再显示 {Math.min(FAILURE_GROUPS_PAGE, moreGroups)} 组
              </Button>
              <span className={styles.moreNote}>还有 {moreGroups} 组没有显示</span>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/**
 * 一组一行；涉及多条时可以展开，展开的明细是紧跟着的第二个 `<tr>`。
 *
 * `data-escalated`：全组到上限是 `true`，一部分到上限是 `partial`，都没到是 `false`。
 * 「到上限」的含义是**该找人了**，不是"系统放弃了"：每个任务的重试都由各自的
 * 枚举源驱动，没有一个会因为这个数字停下来。
 */
function GroupRows({ g, label, base, now }: { g: FailureGroup; label: string; base: Date; now: number }) {
  const single = g.items.length === 1
  const [open, setOpen] = useState(false)
  const [itemLimit, setItemLimit] = useState(FAILURE_ITEMS_PAGE)
  const escalated = g.escalated === g.items.length ? 'true' : g.escalated > 0 ? 'partial' : 'false'
  const first = g.items[0]!
  const shownItems = g.items.slice(0, itemLimit)
  const moreItems = g.items.length - shownItems.length

  return (
    <>
      <tr data-testid="failure-row" data-escalated={escalated} data-count={g.items.length}>
        <td className={styles.nowrap} data-label="任务">
          {label}
        </td>
        <td className={styles.reason} data-label="原因">
          {g.reason}
        </td>
        <td data-label="涉及">
          {single ? (
            <Target f={first} />
          ) : (
            <button
              type="button"
              className={styles.scopeBtn}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              data-testid="failure-scope"
            >
              <span className={styles.caret} aria-hidden="true">
                ›
              </span>
              {groupScopeText(g)}
            </button>
          )}
        </td>
        <td className={styles.nowrap} data-label="最近失败">
          {fmtDateTime(g.latestAt, base)}
          <span className={styles.sub}>{fmtAgo(g.latestAt, now)}</span>
        </td>
        <td className={styles.nowrap} data-label="已自动重试">
          {single ? attemptsText(first) : groupAttemptsText(g)}
          {escalated === 'true' && <span className={styles.escalated}>已到上限 · 需要人工介入</span>}
          {escalated === 'partial' && <span className={styles.escalated}>{g.escalated} 条已到上限</span>}
        </td>
        <td className={styles.impactCell} data-label="如果不处理">
          {g.impact}
        </td>
      </tr>
      {!single && open && (
        <tr className={styles.itemsRow} data-testid="failure-items">
          <td colSpan={6}>
            <ul className={styles.items} aria-label={`${label}：${g.reason}`}>
              {shownItems.map((f) => (
                <li key={f.id} className={styles.item}>
                  <Target f={f} />
                  <span className={styles.itemMeta}>
                    {fmtAgo(f.lastFailedAt, now)} · {attemptsText(f)}
                  </span>
                </li>
              ))}
            </ul>
            {moreItems > 0 && (
              <div className={styles.moreRow}>
                <Button size="sm" variant="quiet" onClick={() => setItemLimit((n) => n + FAILURE_ITEMS_PAGE)}>
                  再显示 {Math.min(FAILURE_ITEMS_PAGE, moreItems)} 条
                </Button>
                <span className={styles.moreNote}>还有 {moreItems} 条</span>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

/** 「对象」：名字 + 副行。三种取值的处置在 `view.ts` 的 `targetView`。 */
function Target({ f }: { f: JobFailure }) {
  const t = targetView(f)
  return (
    <span className={styles.target}>
      <span className={t.sub === '' && f.targetLabel === '' ? styles.targetId : styles.targetName}>{t.name}</span>
      {t.sub !== '' && <span className={styles.sub}>{t.sub}</span>}
    </span>
  )
}

export default FailuresTable
