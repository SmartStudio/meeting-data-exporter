import { useState, type ReactNode } from 'react'
import type { AuditPage } from '@/api/admin/audit'
import { dayKeyOf, fmtDayHeading } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Skeleton } from '@/ui/Skeleton'
import { Table } from '@/ui/Table'
import { AuditRow } from './AuditRow'
import { AUDIT_PAGE_SIZES, type AuditEmptyKind } from './filters'
import styles from './Audit.module.css'

/** 时间 · 操作者 · 动作 · 对象 · 结果 · 细节（spec §4.10 的五个字段 + 明细）+ 行尾的展开钮。 */
const COL_COUNT = 7

export interface AuditTableProps {
  page: AuditPage | null
  now: Date
  loading: boolean
  error: Error | null
  onRetry: () => void
  empty: AuditEmptyKind
  onClearFilters: () => void
  onAllTime: () => void
  /** 展开区里「只看这个操作者 / 只看这个动作」——直接从一条记录出发缩小范围。 */
  onFilterActor: (id: string) => void
  onFilterAction: (action: string) => void

  /** 当前请求的页码（1 起）与每页条数——**分页控件按"我请求的是什么"来画**。 */
  current: number
  pageSize: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}

/**
 * 审计条目表。
 *
 * 筛选与分页**全在后端**（见 `filters.ts`），这里不做任何本地过滤：
 * 一次请求只带回一页，在这一页上再筛一次，得到的是"这 50 条里符合的"，
 * 而页脚写的是"共 N 条"——翻到第二页就对不上，且看不出来。
 *
 * ## 按天分组，但不折叠
 *
 * 每一天的第一条前面插一行日期（`9 月 14 日 周日`），时间列因此只报当天的
 * 时刻、到秒。这是**分组**不是**合并**：每一条记录仍然是自己一行，一条不少
 * ——审计不许折叠的规矩见 `AuditRow.tsx` 顶部。
 */
export function AuditTable(props: AuditTableProps) {
  const { page, now, loading, error, onRetry, empty, onClearFilters, onAllTime, onFilterActor, onFilterAction } =
    props
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const rows = page?.rows ?? []
  // 加载中 / 读不到都**不是**空态：三者的出口完全不同（spec.md §8）。
  const showEmpty = !loading && error === null && rows.length === 0

  const body: ReactNode[] = []
  let lastDay: string | null = null
  for (const row of rows) {
    const day = dayKeyOf(row.at)
    if (day !== lastDay) {
      lastDay = day
      body.push(
        <tr key={`day-${day}`} className={styles.dayRow} data-testid="audit-day">
          <td colSpan={COL_COUNT}>{fmtDayHeading(row.at, now)}</td>
        </tr>,
      )
    }
    body.push(
      <AuditRow
        key={row.id}
        row={row}
        now={now}
        expanded={expanded.has(row.id)}
        onToggle={toggle}
        onFilterActor={onFilterActor}
        onFilterAction={onFilterAction}
        colSpan={COL_COUNT}
      />,
    )
  }

  return (
    <div className={styles.tableWrap}>
      {/* cards：窄屏（≤56em）一行一张卡片，而不是横向滚动（spec §11 缺口 2）。
          每个有列名的 <td> 因此必须带 data-label——见 AuditRow。 */}
      <Table className={styles.table} cards>
        <thead>
          <tr>
            <th className={styles.timeHead}>时间</th>
            <th>操作者</th>
            <th>动作</th>
            <th>对象</th>
            <th>结果</th>
            <th>细节</th>
            <th className={styles.toggleHead}>
              <span className={styles.srOnly}>展开</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows />
          ) : error !== null ? (
            <ErrorRow error={error} onRetry={onRetry} />
          ) : showEmpty ? (
            <EmptyRow kind={empty} onClearFilters={onClearFilters} onAllTime={onAllTime} />
          ) : (
            body
          )}
        </tbody>
      </Table>

      <Pager {...props} hidden={loading || error !== null || showEmpty} />
    </div>
  )
}

const SKELETON_WIDTHS: string[] = ['80%', '60%', '55%', '70%', '40%', '85%', '30%']

/** 骨架按真实行的几何画（一行一条，宽度不齐）——齐了就不像一张表，像一块占位板。 */
function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }, (_, r) => (
        <tr key={r} data-skeleton="true" {...(r === 0 ? { 'data-testid': 'audit-skeleton' } : {})}>
          {SKELETON_WIDTHS.map((w, i) => (
            <td key={i}>
              <Skeleton width={shrink(w, r)} size="sm" />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

function shrink(width: string, row: number): string {
  return `${parseFloat(width) - (row % 3) * 6}%`
}

function ErrorRow({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <tr>
      <td colSpan={COL_COUNT}>
        <div className={styles.big} data-kind="error" data-testid="audit-error">
          <h3 className={styles.bigTitle}>读不到操作审计</h3>
          {/* 读不出来 ≠ 没发生过。审计页的空表和读失败长得很像，所以这句必须
              在最显眼的地方——否则"查不到这次取用"会被读成"这次取用没发生"。 */}
          <p className={styles.bigText}>
            后台服务没有响应。<b>这是读不出来，不是没有留痕</b>——记录还在库里，
            没有任何一条因为这次读取失败而丢失。
          </p>
          <div className={styles.bigActs}>
            <Button variant="primary" onClick={onRetry}>
              重试
            </Button>
          </div>
          <p className={styles.errDetail}>{error.message}</p>
        </div>
      </td>
    </tr>
  )
}

function EmptyRow({
  kind,
  onClearFilters,
  onAllTime,
}: {
  kind: AuditEmptyKind
  onClearFilters: () => void
  onAllTime: () => void
}) {
  if (kind === 'none-at-all') {
    return (
      <tr>
        <td colSpan={COL_COUNT}>
          <div className={styles.big} data-testid="audit-empty" data-kind="none-at-all">
            <h3 className={styles.bigTitle}>一条审计记录都没有</h3>
            <p className={styles.bigText}>
              时间范围已经是「全部时间」，也没有别的筛选条件——库里确实是空的。
              登录、拉取、归档、取用都会在这里留痕，跑过一次之后就不再是这一屏。
            </p>
          </div>
        </td>
      </tr>
    )
  }

  if (kind === 'out-of-range') {
    return (
      <tr>
        <td colSpan={COL_COUNT}>
          <div className={styles.small} data-testid="audit-empty" data-kind="out-of-range">
            <span>这段时间里没有操作记录。更早的操作不在本次结果里。</span>
            <Button variant="quiet" size="sm" onClick={onAllTime}>
              改为全部时间
            </Button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td colSpan={COL_COUNT}>
        <div className={styles.small} data-testid="audit-empty" data-kind="filtered-out">
          <span>没有符合这些条件的记录。</span>
          <Button variant="quiet" size="sm" onClick={onClearFilters}>
            清除筛选
          </Button>
        </div>
      </td>
    </tr>
  )
}

function Pager({
  page,
  current,
  pageSize,
  onPage,
  onPageSize,
  hidden,
}: AuditTableProps & { hidden: boolean }) {
  if (hidden) return null

  const total = page?.total ?? 0
  // **「第 X–Y 条」用后端回显的 offset 与这一页真实的行数**，不用界面上的页码
  // 心算。两者本该一致；不一致的时候，说了实话的那一个才有用。
  const from = total === 0 ? 0 : (page?.offset ?? 0) + 1
  const to = (page?.offset ?? 0) + (page?.rows.length ?? 0)
  const maxPage = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className={styles.pager}>
      <span className={styles.pagerRange}>
        第 {from}–{to} 条，共 {total}
      </span>
      <label className={styles.pagerSize}>
        每页
        <select
          className={styles.select}
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          aria-label="每页条数"
        >
          {AUDIT_PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span className={styles.pagerNav}>
        <button
          type="button"
          className={styles.pageBtn}
          disabled={current <= 1}
          onClick={() => onPage(current - 1)}
          aria-label="上一页"
        >
          ‹
        </button>
        {Array.from({ length: maxPage }, (_, i) => i + 1)
          // 页数可以很多（200 条一页时 total 上万仍有几十页），只画首尾与光标附近
          .filter((n) => n === 1 || n === maxPage || Math.abs(n - current) <= 1)
          .map((n, i, all) => (
            <span key={n} className={styles.pageSlot}>
              {i > 0 && n - all[i - 1]! > 1 && <span className={styles.pageGap}>…</span>}
              <button
                type="button"
                className={styles.pageBtn}
                aria-current={n === current ? 'page' : undefined}
                onClick={() => onPage(n)}
              >
                {n}
              </button>
            </span>
          ))}
        <button
          type="button"
          className={styles.pageBtn}
          disabled={current >= maxPage}
          onClick={() => onPage(current + 1)}
          aria-label="下一页"
        >
          ›
        </button>
      </span>
    </div>
  )
}
