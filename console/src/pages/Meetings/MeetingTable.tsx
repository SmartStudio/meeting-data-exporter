import { useEffect, useRef } from 'react'
import type { ServiceProgram } from '@/api/admin/grants'
import type { AdminMeeting } from '@/api/admin/meetings'
import { Button } from '@/ui/Button'
import { Skeleton } from '@/ui/Skeleton'
import { Table } from '@/ui/Table'
import { MeetingRow, type MeetingRowProps } from './MeetingRow'
import styles from './MeetingTable.module.css'

/** 空态的两种成因。出口不同，不能糊成同一句"暂无数据"（spec.md §8）。 */
export type EmptyKind = 'none-at-all' | 'filtered-out' | null

/**
 * 表格空了是因为什么？
 *
 * F1 时代有三种成因，第三种是「时间范围之外」。**接真 API 之后那一种没有了**：
 * `GET /api/v1/admin/meetings` 没有时间范围参数，那个筛选器因此被删掉了
 * （不支持的筛选不在前端偷偷补一个内存版本——翻到第二页就失效）。
 *
 * 判据从「全量行数」换成了「有没有在筛」：分页之后前端手里只有当前这一页，
 * 「系统里一共有几场」是问不出来的。所以：`total === 0` 且没有任何筛选条件
 * ＝ 一场都没有；`total === 0` 但正在筛 ＝ 被筛没了。
 */
export function emptyKind(args: { total: number; narrowed: boolean }): EmptyKind {
  if (args.total > 0) return null
  return args.narrowed ? 'filtered-out' : 'none-at-all'
}

type RowHandlers = Omit<
  MeetingRowProps,
  'meeting' | 'programs' | 'now' | 'selected' | 'cursor' | 'isPending'
>

export interface MeetingTableProps extends RowHandlers {
  /** 当前页要渲染的行。**已经是服务端切好的一页** */
  rows: readonly AdminMeeting[]
  programs: readonly ServiceProgram[]
  now: Date
  selected: ReadonlySet<string>
  cursorId: string | null
  isPending: (key: string) => boolean

  /** 表头勾选：只作用于**本页**（也只可能作用于本页——别的页不在手里） */
  onSelectPage: (next: boolean) => void

  /** 符合当前筛选的总数，由后端下发 */
  total: number
  page: number
  pageSize: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void

  loading: boolean
  error: Error | null
  onRetry: () => void
  empty: EmptyKind
  onClearFilters: () => void
  onGoRules: () => void
  onGoJobs: () => void
}

const PAGE_SIZES = [5, 10, 20, 50]
/** 表头 + 8 列，空态/骨架行要横跨整张表。 */
const COL_COUNT = 8
/** 页码按钮最多画这么多个。总页数上千时全画出来会把分页条撑成一屏。 */
const MAX_PAGE_BUTTONS = 9

export function MeetingTable(props: MeetingTableProps) {
  const {
    rows,
    programs,
    now,
    selected,
    cursorId,
    isPending,
    onSelectPage,
    total,
    page,
    pageSize,
    onPage,
    onPageSize,
    loading,
    error,
    onRetry,
    empty,
    onClearFilters,
    onGoRules,
    onGoJobs,
    ...rowHandlers
  } = props

  const pageIds = rows.map((m) => m.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const somePageSelected = pageIds.some((id) => selected.has(id))

  // 本页只选了一部分时表头必须是"半选"，不是"未选"——未选的勾选框在说
  // "这一页一个都没选"，而屏幕上明明有几行是选中的。
  const headCheck = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headCheck.current) headCheck.current.indeterminate = somePageSelected && !allPageSelected
  }, [somePageSelected, allPageSelected])

  return (
    <div className={styles.wrap}>
      {/* cards：窄屏（≤56em）一行一张卡片，而不是横向滚动（spec §11 缺口 2）。
          每个 <td> 因此必须带 data-label——见 MeetingRow。 */}
      <Table className={styles.table} cards>
        <thead>
          <tr>
            <th className={styles.check}>
              <input
                ref={headCheck}
                type="checkbox"
                className={styles.checkbox}
                checked={allPageSelected}
                disabled={loading || pageIds.length === 0}
                onChange={(e) => onSelectPage(e.target.checked)}
                aria-label="全选本页"
              />
            </th>
            <th>会议记录</th>
            <th>主持人</th>
            <th>资产</th>
            <th>拉取 · 归档</th>
            <th>本地保留</th>
            <th>已授权给</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows />
          ) : error ? (
            <ErrorRow error={error} onRetry={onRetry} />
          ) : empty ? (
            <EmptyRow
              kind={empty}
              onClearFilters={onClearFilters}
              onGoRules={onGoRules}
              onGoJobs={onGoJobs}
            />
          ) : (
            rows.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                programs={programs}
                now={now}
                selected={selected.has(m.id)}
                cursor={cursorId === m.id}
                isPending={isPending}
                {...rowHandlers}
              />
            ))
          )}
        </tbody>
      </Table>

      <Pager
        loading={loading}
        hidden={!!error || !!empty}
        total={total}
        page={page}
        pageSize={pageSize}
        onPage={onPage}
        onPageSize={onPageSize}
      />
    </div>
  )
}

/** 骨架按真实行的几何画，宽度不齐——齐了就不像一张表，像一块占位板。 */
const SKELETON_WIDTHS: Array<[string, string | null]> = [
  ['62%', '46%'],
  ['34%', null],
  ['22%', null],
  ['58%', null],
  ['50%', null],
  ['70%', null],
  ['18%', null],
]

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }, (_, r) => (
        <tr key={r} data-skeleton="true">
          <td className={styles.check}>
            <Skeleton width="2ch" />
          </td>
          {SKELETON_WIDTHS.map(([main, sub], i) => (
            <td key={i}>
              <Skeleton width={shrink(main, r)} />
              {sub && <Skeleton width={sub} size="sm" />}
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/** 每三行错开一档宽度，让骨架看起来是不同长度的真实内容。 */
function shrink(width: string, row: number): string {
  const n = parseFloat(width)
  return `${n - (row % 3) * 6}%`
}

function ErrorRow({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <tr>
      <td colSpan={COL_COUNT}>
        <div className={styles.big} data-kind="error" data-testid="meetings-error">
          <h3 className={styles.bigTitle}>读不到会议列表</h3>
          {/* 读不出来 ≠ 丢了。这句必须在最显眼的地方——归档到 NAS 的文件
              是不是还在，是看到这一屏的人第一个想知道的事。 */}
          <p className={styles.bigText}>
            后台服务没有响应。<b>已经归档到 NAS 的文件不受影响</b>——这是读不出来，不是丢了。
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
  onGoRules,
  onGoJobs,
}: {
  kind: Exclude<EmptyKind, null>
  onClearFilters: () => void
  onGoRules: () => void
  onGoJobs: () => void
}) {
  if (kind === 'none-at-all') {
    return (
      <tr>
        <td colSpan={COL_COUNT}>
          <div className={styles.big} data-testid="meetings-empty" data-kind="none-at-all">
            <h3 className={styles.bigTitle}>还没有拉取过任何会议</h3>
            <p className={styles.bigText}>
              拉取任务会自动去腾讯会议找已经产出录屏和智能纪要的会议。第一次运行前，
              先确认拉取规则里至少有一条是放行的。
            </p>
            <div className={styles.bigActs}>
              <Button variant="primary" onClick={onGoRules}>
                去看拉取规则
              </Button>
              <Button onClick={onGoJobs}>去看定时任务</Button>
            </div>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td colSpan={COL_COUNT}>
        <div className={styles.small} data-testid="meetings-empty" data-kind="filtered-out">
          <span>没有符合条件的会议。</span>
          <Button variant="quiet" size="sm" onClick={onClearFilters}>
            清除筛选
          </Button>
        </div>
      </td>
    </tr>
  )
}

/**
 * 页码按钮。总页数超过 `MAX_PAGE_BUTTONS` 时以当前页为中心开一个窗口——
 * 全画出来在一个有几千场会议的部署里会把分页条撑成一整屏。
 */
function pageWindow(page: number, maxPage: number): number[] {
  if (maxPage <= MAX_PAGE_BUTTONS) return Array.from({ length: maxPage }, (_, i) => i + 1)
  const half = Math.floor(MAX_PAGE_BUTTONS / 2)
  const start = Math.max(1, Math.min(page - half, maxPage - MAX_PAGE_BUTTONS + 1))
  return Array.from({ length: MAX_PAGE_BUTTONS }, (_, i) => start + i)
}

function Pager({
  loading,
  hidden,
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
}: {
  loading: boolean
  hidden: boolean
  total: number
  page: number
  pageSize: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}) {
  if (loading) {
    return (
      <div className={styles.pager}>
        <span className={styles.pagerRange} data-testid="meetings-loading">
          正在读取…
        </span>
      </div>
    )
  }
  if (hidden) return null

  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  const window = pageWindow(page, maxPage)

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
          {PAGE_SIZES.map((n) => (
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
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
          aria-label="上一页"
        >
          ‹
        </button>
        {window[0] !== 1 && <span className={styles.pagerGap}>…</span>}
        {window.map((n) => (
          <button
            key={n}
            type="button"
            className={styles.pageBtn}
            aria-current={n === page ? 'page' : undefined}
            onClick={() => onPage(n)}
          >
            {n}
          </button>
        ))}
        {window[window.length - 1] !== maxPage && <span className={styles.pagerGap}>…</span>}
        <button
          type="button"
          className={styles.pageBtn}
          disabled={page === maxPage}
          onClick={() => onPage(page + 1)}
          aria-label="下一页"
        >
          ›
        </button>
      </span>
    </div>
  )
}
