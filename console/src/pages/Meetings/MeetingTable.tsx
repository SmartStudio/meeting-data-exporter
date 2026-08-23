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
 */
export function emptyKind(args: {
  totalAll: number
  totalInRange: number
  totalMatching: number
  rangeDays: number
}): EmptyKind {
  if (args.totalMatching > 0) return null
  if (args.totalAll === 0) return 'none-at-all'
  if (args.rangeDays > 0 && args.totalInRange === 0) return 'out-of-range'
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
  selectAllMatching: boolean

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
    selectAllMatching,
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
  // 逃生门只在"本页全选了、且外面还有更多"时才有意义。
  const showSelectAllHint = allPageSelected && totalMatching > pageIds.length

  return (
    <div className={styles.wrap}>
      {showSelectAllHint && (
        <div className={styles.selectAllHint} data-testid="select-all-hint">
          {selectAllMatching ? (
            <>
              <span>
                已选中符合当前筛选的全部 <b className={styles.num}>{totalMatching}</b> 场会议。
              </span>
              <button type="button" className={styles.hintBtn} onClick={onSelectPageOnly}>
                只保留本页
              </button>
            </>
          ) : (
            <>
              <span>
                已选中本页 <b className={styles.num}>{pageIds.length}</b> 场。
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
        <div className={styles.big} data-kind="error" data-testid="meetings-status">
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
          <div className={styles.big} data-testid="meetings-status">
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
          <div className={styles.small} data-testid="meetings-status">
            <span>近 {rangeDays} 天内没有会议记录。</span>
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
        <div className={styles.small} data-testid="meetings-status">
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
        <span className={styles.pagerRange} data-testid="meetings-status">
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
