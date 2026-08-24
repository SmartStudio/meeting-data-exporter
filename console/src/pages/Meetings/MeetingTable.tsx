import { useEffect, useRef } from 'react'
import type { Consumer, Meeting } from '@/api/types'
import { Button } from '@/ui/Button'
import { Skeleton } from '@/ui/Skeleton'
import { Table } from '@/ui/Table'
import { MeetingRow, type MeetingRowProps } from './MeetingRow'
import styles from './MeetingTable.module.css'

/** 空态的三种成因。出口各不相同，不能糊成同一句"暂无数据"（spec.md §8）。 */
export type EmptyKind = 'none-at-all' | 'out-of-range' | 'filtered-out' | null

/**
 * 表格空了是因为什么？**顺序就是因果的粗细**：系统里一场都没有 > 时间范围之外 >
 * 被筛选条件筛没了。粗的那层先答，不然会给出"清除筛选"这种解决不了问题的出口。
 *
 * 「时间范围之外」的判据是 `totalMatchingIgnoringRange > 0`——**去掉范围就找得到**，
 * 而不是"范围内一场会议都没有"。差别是具体的：近 7 天里有 6 场会议、但搜索词
 * 只命中 40 天前的那一场时，旧判据会算成"被筛选筛没了"，给出的出口是"清除筛选"
 * ——点完范围没变，那一场还是找不到。
 */
export function emptyKind(args: {
  totalAll: number
  /** 只按筛选与搜索算、不套时间范围的命中数。 */
  totalMatchingIgnoringRange: number
  totalMatching: number
  rangeDays: number
}): EmptyKind {
  if (args.totalMatching > 0) return null
  if (args.totalAll === 0) return 'none-at-all'
  if (args.rangeDays > 0 && args.totalMatchingIgnoringRange > 0) return 'out-of-range'
  return 'filtered-out'
}

type RowHandlers = Omit<MeetingRowProps, 'meeting' | 'consumers' | 'now' | 'selected' | 'cursor'>

export interface MeetingTableProps extends RowHandlers {
  /** 当前页要渲染的行。 */
  rows: Meeting[]
  consumers: Consumer[]
  now: Date
  selected: ReadonlySet<string>
  cursorId: string | null

  /** 表头勾选：只作用于**本页**。 */
  onSelectPage: (next: boolean) => void
  /** 跨页全选的逃生门——点了才扩到"符合筛选的全部"。 */
  onSelectAllMatching: () => void
  /** 从"全部"收回到"只保留本页"。 */
  onSelectPageOnly: () => void
  /**
   * 符合当前筛选的行**是不是已经一场不落地被选中了**。
   * 这是从选择集与当前筛选**推出来**的，不是一个"点过跨页全选"的记忆标志位——
   * 标志位要靠"记得在每个改筛选的地方清一次"，那种约定迟早会漏。
   */
  allMatchingSelected: boolean
  /** 当前筛选下**真正**被选中的场数（＝批量操作会改到的场数）。 */
  selectedCount: number

  /** 符合当前筛选的总数（可能横跨多页）。 */
  totalMatching: number
  page: number
  pageSize: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void

  loading: boolean
  error: Error | null
  onRetry: () => void
  empty: EmptyKind
  rangeDays: number
  onClearFilters: () => void
  onClearRange: () => void
  onGoRules: () => void
  onGoJobs: () => void
}

const PAGE_SIZES = [5, 10, 20, 50]
/** 表头 + 8 列，空态/骨架行要横跨整张表。 */
const COL_COUNT = 8

export function MeetingTable(props: MeetingTableProps) {
  const {
    rows,
    consumers,
    now,
    selected,
    cursorId,
    onSelectPage,
    onSelectAllMatching,
    onSelectPageOnly,
    allMatchingSelected,
    selectedCount,
    totalMatching,
    page,
    pageSize,
    onPage,
    onPageSize,
    loading,
    error,
    onRetry,
    empty,
    rangeDays,
    onClearFilters,
    onClearRange,
    onGoRules,
    onGoJobs,
    ...rowHandlers
  } = props

  const pageIds = rows.map((m) => m.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const somePageSelected = pageIds.some((id) => selected.has(id))
  // 逃生门只在"本页全选了、且外面还有更多"时才有意义。
  const showSelectAllHint = allPageSelected && totalMatching > pageIds.length

  // 本页只选了一部分时表头必须是"半选"，不是"未选"——未选的勾选框在说
  // "这一页一个都没选"，而屏幕上明明有几行是选中的。
  const headCheck = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headCheck.current) headCheck.current.indeterminate = somePageSelected && !allPageSelected
  }, [somePageSelected, allPageSelected])

  return (
    <div className={styles.wrap}>
      {showSelectAllHint && (
        <div className={styles.selectAllHint} data-testid="select-all-hint">
          {allMatchingSelected ? (
            <>
              <span>
                已选中符合当前筛选的全部 <b className={styles.num}>{selectedCount}</b> 场会议。
              </span>
              <button type="button" className={styles.hintBtn} onClick={onSelectPageOnly}>
                只保留本页
              </button>
            </>
          ) : (
            <>
              {/* 说的是**实际选中的场数**，不是本页有几行：跨页选过之后再收窄
                  筛选，这两个数不一样，而底部批量条报的是前者。同一屏上两个
                  数字打架，用户没有办法判断按下去会改掉几场。 */}
              <span>
                已选中 <b className={styles.num}>{selectedCount}</b> 场。
              </span>
              {/* 明说总数：「一次点击选中 300 场并批量改授权」是这个产品里最贵的
                  误操作，所以扩到全部必须是第二次、看得见数字的点击。 */}
              <button type="button" className={styles.hintBtn} onClick={onSelectAllMatching}>
                改为选择符合筛选的全部 {totalMatching} 场
              </button>
            </>
          )}
        </div>
      )}

      <Table className={styles.table}>
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
              rangeDays={rangeDays}
              onClearFilters={onClearFilters}
              onClearRange={onClearRange}
              onGoRules={onGoRules}
              onGoJobs={onGoJobs}
            />
          ) : (
            rows.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                consumers={consumers}
                now={now}
                selected={selected.has(m.id)}
                cursor={cursorId === m.id}
                {...rowHandlers}
              />
            ))
          )}
        </tbody>
      </Table>

      <Pager
        loading={loading}
        hidden={!!error || !!empty}
        total={totalMatching}
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
  rangeDays,
  onClearFilters,
  onClearRange,
  onGoRules,
  onGoJobs,
}: {
  kind: Exclude<EmptyKind, null>
  rangeDays: number
  onClearFilters: () => void
  onClearRange: () => void
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

  if (kind === 'out-of-range') {
    return (
      <tr>
        <td colSpan={COL_COUNT}>
          <div className={styles.small} data-testid="meetings-empty" data-kind="out-of-range">
            <span>近 {rangeDays} 天内没有符合条件的会议记录。</span>
            <Button variant="quiet" size="sm" onClick={onClearRange}>
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
        {Array.from({ length: maxPage }, (_, i) => i + 1).map((n) => (
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
