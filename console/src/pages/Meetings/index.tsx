import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { mockApi, MOCK_NOW } from '@/api/mock'
import type { Consumer, Meeting, Why, WhyKind } from '@/api/types'
import { useSystemState } from '@/app/SystemStatus'
import { daysLeft, fmtDateTime, fmtDay } from '@/lib/format'
import { useMeetingKeys, type MeetingKeyAction } from '@/lib/keys'
import { useResource } from '@/lib/useResource'
import { Button } from '@/ui/Button'
import { Chip } from '@/ui/Chip'
import { Drawer } from '@/ui/Drawer'
import { Input } from '@/ui/Input'
import { Popover } from '@/ui/Popover'
import { StatusDot, STATUS_DOT_LABEL, type StatusDotState } from '@/ui/StatusDot'
import { Toast } from '@/ui/Toast'
import { BatchBar, type BatchAction } from './BatchBar'
import { GrantPicker } from './GrantPicker'
import { emptyKind, MeetingTable } from './MeetingTable'
import { TRIAGE_DEFS, TriageBar, type TriageId } from './TriageBar'
import { useMeetings } from './useMeetings'
import {
  applyWrite,
  canWrite,
  consumerName,
  grantCellKind,
  KEEP_DAYS,
  type MeetingWrite,
  type WriteCtx,
} from './write'
import styles from './Meetings.module.css'

/** 工具条上的三个附加筛选（分诊五格之外的）。 */
const CHIP_FILTERS = [
  { id: 'inwindow', label: '保留期内', test: (m: Meeting) => m.keep.expiresAt !== null && !m.keep.filesGone },
  { id: 'granted', label: '已授权', test: (m: Meeting) => m.grants.length > 0 },
  { id: 'hand', label: '有人工改写', test: (m: Meeting) => m.hand.length > 0 },
] as const

type FilterId = TriageId | (typeof CHIP_FILTERS)[number]['id']

const RANGES: Array<{ days: number; label: string }> = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
  { days: 0, label: '全部时间' },
]

/** 判定理由的呈现（spec.md §6.1）。`by` 决定样式，不是随手挑的颜色。 */
const WHY_LABEL: Record<WhyKind, string> = {
  rule: '来自规则',
  hand: '人工改写',
  fail: '失败',
  expired: '已到期',
  wait: '前置未完成',
  na: '不适用',
  deny: '规则禁止',
}

function whyTone(by: WhyKind): 'neutral' | 'warn' | 'fail' {
  if (by === 'fail') return 'fail'
  // 琥珀只有一个含义：**这需要你看一眼**（design-system.md §2.2）。
  // 所以只有 hand（有人手动改写了规则，绕过了规则系统）配得上它。
  //
  // deny 特意**不**用琥珀，尽管原型是琥珀的：一条 deny 规则命中是规则系统
  // 在正确地干活（原型那条是「标题含面试/薪酬/绩效 → 禁止采集」的隐私规则），
  // 绝大多数被拒的会议是故意且永久被拒的。画成琥珀，配了这类规则的组织
  // 就会有一大片永久琥珀，真正该被看见的琥珀（有人绕过了规则、还剩三天到期）
  // 淹死在里面——一直响的警报等于没有警报。
  // 「允许」与「拒绝」的区分由 AllowState 表达，不是理由文字的着色职责。
  //
  // expired / wait / na 是生命周期原因，不是谁的过错，同样中性。
  if (by === 'hand') return 'warn'
  return 'neutral'
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 会议距今几天（按自然日）。DST 切换周一天不是精确 86400 秒，所以 round 不 floor。 */
function daysAgo(unixSec: number, now: Date): number {
  const diff = startOfDay(now).getTime() - startOfDay(new Date(unixSec * 1000)).getTime()
  return Math.round(diff / 86400000)
}

/** 还没读到采集程序时的空列表。写成模块级常量，免得每次渲染都换一个引用，
 *  把下游所有 useMemo / useCallback 的依赖都带着失效一遍。 */
const NO_CONSUMERS: Consumer[] = []

/** 采集程序列表，同样跟着系统状态走（T3 只导出了 useMeetings，这里照它的写法补一个）。 */
function useConsumers() {
  const { state } = useSystemState()
  return useResource(() => mockApi(state).listConsumers(), [state])
}

/**
 * 会议记录页——控制台密度最高的一页。
 *
 * 它要同时回答三个问题：现在有什么需要处理（分诊条）、每场会议处在哪个阶段
 * （表格）、以及为什么是这个状态（判定理由）。
 *
 * F1 阶段所有写操作都只改本地状态、不接后端；`useMeetings()` 拿到的那份数据被
 * 复制到本地 `rows` 里再改，切系统状态时会被重新覆盖——这是刻意的，故障态下
 * 数据本来就该以服务端为准。
 */
export default function MeetingsPage() {
  const navigate = useNavigate()
  const res = useMeetings()
  const consumersRes = useConsumers()

  // mock 的"今天"固定在 2026-08-23，否则 daysLeft 会随真实日期漂移，
  // 截图和测试都对不上。F6 接真 API 时换成 new Date()。
  const now = useMemo(() => new Date(MOCK_NOW * 1000), [])

  const serverRows = res.state === 'ready' ? res.data : null
  const [rows, setRows] = useState<Meeting[]>([])
  const [mirrored, setMirrored] = useState<Meeting[] | null>(null)
  // **渲染期派生，不用 effect 镜像。** effect 要等这一帧提交完才跑，而在数据到达
  // 的那一帧里 `loading` 已经是 false、`rows` 还是空的——`empty` 算成
  // 'none-at-all'、分诊条与工具条整排卸载、表格画出大空态，下一帧才换回真实数据。
  // 首屏、重试、每次切系统状态各闪一次，闪的还是"还没有拉取过任何会议"这句
  // 与事实相反的话，且正是"整页往下跳"要防的那件事。
  // 在渲染期 setState，React 会丢掉这一次渲染结果、带着新 state 重来，那一帧
  // 根本不会被提交。
  if (serverRows !== mirrored) {
    setMirrored(serverRows)
    setRows(serverRows ?? [])
  }

  const consumers: Consumer[] = consumersRes.state === 'ready' ? consumersRes.data : NO_CONSUMERS

  const [filters, setFilters] = useState<ReadonlySet<FilterId>>(new Set())
  const [query, setQuery] = useState('')
  const [rangeDays, setRangeDays] = useState(90)
  const [rangeOpen, setRangeOpen] = useState(false)

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [detailId, setDetailId] = useState<string | null>(null)
  const [grantIds, setGrantIds] = useState<string[] | null>(null)
  const [toast, setToast] = useState<{ n: number; text: string } | null>(null)

  const searchRef = useRef<HTMLInputElement>(null)
  const toastSeq = useRef(0)

  const notify = useCallback((text: string) => {
    toastSeq.current += 1
    setToast({ n: toastSeq.current, text })
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4200)
    return () => clearTimeout(t)
  }, [toast])

  const loading = res.state === 'loading'
  const error = res.state === 'error' ? res.error : null

  /* ── 筛选 ────────────────────────────────────────────────── */

  // 先只按筛选与搜索算一遍（**不套时间范围**）。空态要靠它答"是不是范围把
  // 它们藏起来了"——差别很具体：搜索词只命中 40 天前的那一场时，出口该是
  // "改为全部时间"，而不是点了也没用的"清除筛选"。
  const matchingIgnoringRange = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((m) => {
      if (q && !`${m.title}${m.code}${m.host}`.toLowerCase().includes(q)) return false
      for (const f of filters) {
        const triage = TRIAGE_DEFS.find((t) => t.id === f)
        if (triage) {
          if (!triage.test(m, now)) return false
          continue
        }
        const chip = CHIP_FILTERS.find((c) => c.id === f)
        if (chip && !chip.test(m)) return false
      }
      return true
    })
  }, [rows, filters, query, now])

  const matching = useMemo(
    () => matchingIgnoringRange.filter((m) => rangeDays === 0 || daysAgo(m.startAt, now) <= rangeDays),
    [matchingIgnoringRange, rangeDays, now],
  )

  const maxPage = Math.max(1, Math.ceil(matching.length / pageSize))
  const safePage = Math.min(page, maxPage)
  const paged = useMemo(
    () => matching.slice((safePage - 1) * pageSize, safePage * pageSize),
    [matching, safePage, pageSize],
  )

  const safeCursor = paged.length === 0 ? 0 : Math.min(cursor, paged.length - 1)
  const cursorId = paged[safeCursor]?.id ?? null
  const cursorMeeting = paged[safeCursor]

  const narrowed = filters.size > 0 || query.trim().length > 0
  // 加载中 / 加载失败都**不是**空态：把它们折叠进"没有数据"正是 spec.md §8
  // 要防的那件事——三者的出口完全不同。
  const empty =
    loading || error
      ? null
      : emptyKind({
          totalAll: rows.length,
          totalMatchingIgnoringRange: matchingIgnoringRange.length,
          totalMatching: matching.length,
          rangeDays,
        })

  /* ── 写操作（F1 只改本地状态）───────────────────────────── */

  // **所有写操作都走 `applyWrite` 这一个口子**（见 write.ts 开头）：状态与
  // `why` / `hand` / 连带失效在那里一起变。这里只负责决定"改哪些行、改什么"，
  // 以及前置条件不满足时说人话——不许在这一层自己拼状态。
  const ctx = useMemo<WriteCtx>(
    () => ({ nowSec: Math.floor(now.getTime() / 1000), consumers }),
    [now, consumers],
  )

  const patch = useCallback(
    (id: string, w: MeetingWrite) => {
      setRows((prev) => prev.map((m) => (m.id === id ? applyWrite(m, w, ctx) : m)))
    },
    [ctx],
  )

  const toggleStage = useCallback(
    (id: string, stage: 'fetch' | 'archive') => {
      const m = rows.find((x) => x.id === id)
      if (!m) return
      const cur = stage === 'fetch' ? m.fetch : m.archive
      if (cur === 'none') {
        notify('这场会议没有录制，没有可操作的资产。')
        return
      }
      // 归档要等拉取。圆点本身是 disabled 的，但键盘 `2` 到得了这里。
      if (stage === 'archive' && m.fetch !== 'done') {
        notify('需要先完成拉取。')
        return
      }
      const on = cur === 'done'
      patch(id, { op: 'stage', stage, next: on ? 'off' : 'done' })
      notify(`${on ? '已关闭' : '已执行'}${stage === 'fetch' ? '拉取' : '归档'} · ${m.title}`)
    },
    [rows, notify, patch],
  )

  const extend = useCallback(
    (id: string) => {
      const m = rows.find((x) => x.id === id)
      if (!m) return
      if (m.keep.expiresAt === null) {
        notify('这场会议还没归档成功，保留期尚未开始计时。')
        return
      }
      if (m.keep.filesGone) {
        notify('本地文件已清理，无法延长。历史数据请到 NAS 取。')
        return
      }
      patch(id, { op: 'extend' })
      notify(`「${m.title}」本地保留期延长 ${KEEP_DAYS} 天`)
    },
    [rows, notify, patch],
  )

  const revoke = useCallback(
    (id: string, consumerId: string) => {
      const m = rows.find((x) => x.id === id)
      if (!m) return
      patch(id, { op: 'grants', next: m.grants.filter((g) => g !== consumerId) })
      notify(`已收回 ${consumerName(consumers, consumerId)} 对「${m.title}」的授权`)
    },
    [rows, consumers, notify, patch],
  )

  const openGrant = useCallback(
    (id: string) => {
      const m = rows.find((x) => x.id === id)
      if (!m) return
      const kind = grantCellKind(m).kind
      if (kind === 'denied') {
        notify('规则禁止这场会议被采集，需先改规则或人工改写权限。')
        return
      }
      if (kind === 'expired') {
        notify('本地文件已清理，授权已失效。历史数据请到 NAS 取。')
        return
      }
      if (kind === 'na') {
        notify('这场会议没有录制，没有可授权的资产。')
        return
      }
      if (kind === 'wait') {
        notify('需要先归档成功，保留期开始计时后才能授权。')
        return
      }
      setGrantIds([id])
    },
    [rows, notify],
  )

  const grantMeetings = useMemo(
    () => (grantIds === null ? [] : rows.filter((m) => grantIds.includes(m.id))),
    [grantIds, rows],
  )

  const confirmGrant = useCallback(
    (consumerIds: string[]) => {
      const ids = new Set(grantIds ?? [])
      const single = ids.size === 1
      // 单场是"改成这些程序"（勾选框预置了它现有的授权）；
      // 批量是"再加上这些程序"，不覆盖各场原有的授权。
      const nextFor = (m: Meeting) =>
        single ? consumerIds : Array.from(new Set([...m.grants, ...consumerIds]))
      const targets = rows.filter((m) => ids.has(m.id) && canWrite(m, { op: 'grants', next: nextFor(m) }))
      const targetIds = new Set(targets.map((m) => m.id))
      setRows((prev) =>
        prev.map((m) => (targetIds.has(m.id) ? applyWrite(m, { op: 'grants', next: nextFor(m) }, ctx) : m)),
      )
      setGrantIds(null)
      if (!single) setSelected(new Set())
      const names = consumerIds.map((id) => consumerName(consumers, id)).join('、')
      notify(
        consumerIds.length === 0
          ? `已收回 ${targets.length} 场会议的全部授权`
          : `已把 ${targets.length} 场会议授权给 ${names}`,
      )
    },
    [grantIds, rows, consumers, notify, ctx],
  )

  /* ── 选择 ────────────────────────────────────────────────── */

  /**
   * **唯一有效的选择集：选中 ∩ 当前筛选。**
   *
   * 屏幕上的数字和批量真正改到的行都从这里来，所以两者不可能对不上。
   * 之前是一个"点过跨页全选"的记忆标志位 + 一个自由生长的 id 集合：改筛选
   * 时忘了清标志位，提示条就会说"已选中符合当前筛选的全部 6 场"、底部批量条
   * 同时说"9 场已选"；筛到只剩 1 行时提示条整条消失、批量条仍是 9，一按
   * "收回授权"就改掉了屏幕上看不见的 8 场。**授权是数据出企业边界的闸门，
   * 而这四个批量按钮没有确认面板**，所以这里不留"记得在每处清一次"的约定，
   * 直接推。
   */
  const effective = useMemo(() => {
    const ids = new Set(matching.map((m) => m.id))
    return new Set([...selected].filter((id) => ids.has(id)))
  }, [selected, matching])

  const allMatchingSelected = matching.length > 0 && matching.every((m) => selected.has(m.id))

  const toggleSelect = useCallback((id: string, next: boolean) => {
    setSelected((prev) => {
      const s = new Set(prev)
      if (next) s.add(id)
      else s.delete(id)
      return s
    })
  }, [])

  /** 勾表头**只选本页**。要选全部得再点一次那个明说总数的按钮。 */
  const selectPage = useCallback(
    (next: boolean) => {
      setSelected((prev) => {
        const s = new Set(prev)
        for (const m of paged) {
          if (next) s.add(m.id)
          else s.delete(m.id)
        }
        return s
      })
    },
    [paged],
  )

  const selectAll = useCallback(() => {
    setSelected(new Set(matching.map((m) => m.id)))
    notify(`已选中符合当前筛选的全部 ${matching.length} 场（含未显示的页）`)
  }, [matching, notify])

  const selectPageOnly = useCallback(() => {
    const keep = new Set(paged.map((m) => m.id))
    setSelected((prev) => new Set([...prev].filter((id) => keep.has(id))))
  }, [paged])

  /* ── 批量 ────────────────────────────────────────────────── */

  const runBatch = useCallback(
    (action: BatchAction) => {
      const w: MeetingWrite =
        action === 'extend'
          ? { op: 'extend' }
          : action === 'revoke'
            ? { op: 'grants', next: [] }
            : { op: 'stage', stage: action, next: 'done' }
      // 兜底的第二道：只改**当前筛选下真的被选中**的行。第一道是上面那个
      // 推出来的 `effective`；两道都在，是因为屏幕上的数字和真正被改掉的行
      // 一旦对不上，代价是不可逆的。
      const targets = rows.filter((m) => effective.has(m.id) && canWrite(m, w))
      const targetIds = new Set(targets.map((m) => m.id))
      setRows((prev) => prev.map((m) => (targetIds.has(m.id) ? applyWrite(m, w, ctx) : m)))
      const verb = { fetch: '拉取', archive: '归档', extend: `延长 ${KEEP_DAYS} 天保留`, revoke: '收回授权' }[action]
      setSelected(new Set())
      notify(targets.length > 0 ? `已对 ${targets.length} 场会议执行${verb}` : `所选会议里没有可${verb}的`)
    },
    [rows, effective, ctx, notify],
  )

  /* ── 键盘 ────────────────────────────────────────────────── */

  const overlayOpen = detailId !== null || grantIds !== null || rangeOpen

  const onKey = useCallback(
    (action: MeetingKeyAction) => {
      if (action.type === 'close-overlay') {
        if (grantIds !== null) setGrantIds(null)
        else if (detailId !== null) setDetailId(null)
        else if (rangeOpen) setRangeOpen(false)
        return
      }
      if (action.type === 'focus-search') {
        searchRef.current?.focus()
        return
      }
      if (paged.length === 0 || !cursorMeeting) return
      switch (action.type) {
        case 'move':
          setCursor(Math.max(0, Math.min(safeCursor + action.delta, paged.length - 1)))
          break
        case 'toggle-select':
          toggleSelect(cursorMeeting.id, !effective.has(cursorMeeting.id))
          break
        case 'open-detail':
          setDetailId(cursorMeeting.id)
          break
        case 'stage':
          toggleStage(cursorMeeting.id, action.stage)
          break
        case 'open-grant':
          openGrant(cursorMeeting.id)
          break
        case 'extend':
          extend(cursorMeeting.id)
          break
        case 'preview':
          navigate(`/preview/${cursorMeeting.id}`)
          break
      }
    },
    [
      grantIds,
      detailId,
      rangeOpen,
      paged.length,
      cursorMeeting,
      safeCursor,
      effective,
      toggleSelect,
      toggleStage,
      openGrant,
      extend,
      navigate,
    ],
  )

  useMeetingKeys(onKey, { enabled: !overlayOpen })

  /* ── 渲染 ────────────────────────────────────────────────── */

  const detail = detailId === null ? undefined : rows.find((m) => m.id === detailId)
  const rangeLabel = RANGES.find((r) => r.days === rangeDays)?.label ?? '近 90 天'
  // 加载中仍然渲染分诊条与工具条（骨架 / 禁用态），理由是同一个：
  // 数据到了才冒出来一整排控件，整页会往下跳。
  //
  // 读不到（error）时必须整个收起来——**这一排在那种情况下会撒谎**：
  // 五格算的是 rows 的长度，读不到时 rows 是空的，于是它会画出
  // "0 归档失败"。而真相是"不知道有几场归档失败"，这两句话在一个
  // "归档失败＝一个月后永久丢失"的系统里差得很远。
  // 一场都没有（none-at-all）时零是真的，但搜索框和筛选片没有可筛的东西，
  // 一并收起来，跟原型一致。
  const dataVisible = !error && empty !== 'none-at-all'

  const toggleFilter = (id: FilterId) => {
    setFilters((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
    setCursor(0)
    setPage(1)
  }

  /**
   * 点分诊格：**同时把时间范围置成"全部时间"**。
   *
   * 分诊条的产品职责是"告诉你全系统有什么需要处理"，所以它的计数算在全量
   * `rows` 上。那就必须保证**点任何一格都真能到达它数出来的那些行**——否则
   * 选了"近 7 天"之后，"仅存 NAS"还显示 1（那一场在 40 天前），点进去却是
   * 一张空表，出口还是"清除筛选"，点了范围也不会变。
   *
   * 反过来把计数裁进当前时间窗（另一条路）也能消掉矛盾，但那等于让归档失败
   * ——本系统最严重的状态——可以被一个时间筛选器悄悄藏起来。
   *
   * 只在**打开**这一格时改范围：关掉它不该顺手动用户自己选的范围。
   */
  const toggleTriage = (id: TriageId) => {
    if (!filters.has(id)) setRangeDays(0)
    toggleFilter(id)
  }

  const clearFilters = () => {
    setFilters(new Set())
    setQuery('')
    setCursor(0)
    setPage(1)
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h2 className={styles.title}>会议记录</h2>
        <p className={styles.note}>
          归档成功后本地保留 {KEEP_DAYS} 天，这 {KEEP_DAYS} 天内被授权的程序可以取走；
          到期后本地文件删除，只留记录和 NAS 路径。<b>点标题看录像与纪要内容。</b>
        </p>
      </header>

      {dataVisible && (
        <TriageBar
          meetings={rows}
          now={now}
          active={filters as ReadonlySet<TriageId>}
          onToggle={toggleTriage}
          loading={loading}
        />
      )}

      {dataVisible && (
        <div className={styles.toolbar}>
          <Input
            ref={searchRef}
            type="search"
            className={styles.search}
            value={query}
            disabled={loading}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
              setPage(1)
            }}
            placeholder="搜标题 / 会议号 / 主持人      /"
            aria-label="搜索会议"
          />
          {CHIP_FILTERS.map((c) => (
            <Chip
              key={c.id}
              active={filters.has(c.id)}
              disabled={loading}
              onClick={() => toggleFilter(c.id)}
            >
              {c.label}
            </Chip>
          ))}
          {narrowed && (
            <Button variant="quiet" size="sm" onClick={clearFilters}>
              清除筛选
            </Button>
          )}
          <span className={styles.spacer} />
          <span className={styles.rangeWrap}>
            <Button
              disabled={loading}
              aria-haspopup="menu"
              aria-expanded={rangeOpen}
              onClick={() => setRangeOpen((v) => !v)}
            >
              {rangeLabel} ▾
            </Button>
            <Popover
              open={rangeOpen}
              onClose={() => setRangeOpen(false)}
              role="menu"
              label="录制时间范围"
              placement="bottom-end"
            >
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  type="button"
                  role="menuitemradio"
                  aria-checked={r.days === rangeDays}
                  className={styles.rangeOpt}
                  onClick={() => {
                    setRangeDays(r.days)
                    setRangeOpen(false)
                    setPage(1)
                    setCursor(0)
                  }}
                >
                  <span>{r.label}</span>
                  <span className={styles.rangeCount}>
                    {rows.filter((m) => r.days === 0 || daysAgo(m.startAt, now) <= r.days).length}
                  </span>
                </button>
              ))}
            </Popover>
          </span>
        </div>
      )}

      <MeetingTable
        rows={paged}
        consumers={consumers}
        now={now}
        selected={effective}
        cursorId={cursorId}
        onSelect={toggleSelect}
        onSelectPage={selectPage}
        onSelectAllMatching={selectAll}
        onSelectPageOnly={selectPageOnly}
        allMatchingSelected={allMatchingSelected}
        selectedCount={effective.size}
        totalMatching={matching.length}
        page={safePage}
        pageSize={pageSize}
        onPage={(p) => {
          setPage(p)
          setCursor(0)
        }}
        onPageSize={(s) => {
          setPageSize(s)
          setPage(1)
          setCursor(0)
        }}
        loading={loading}
        error={error}
        onRetry={res.retry}
        empty={empty}
        rangeDays={rangeDays}
        onClearFilters={clearFilters}
        onClearRange={() => {
          setRangeDays(0)
          setPage(1)
        }}
        onGoRules={() => navigate('/rules')}
        onGoJobs={() => navigate('/jobs')}
        onOpenTitle={(id) => navigate(`/preview/${id}`)}
        onOpenDetail={setDetailId}
        onToggleStage={toggleStage}
        onExtend={extend}
        onOpenGrant={openGrant}
        onRevoke={revoke}
      />

      <Legend />

      <BatchBar
        count={effective.size}
        allMatching={allMatchingSelected && matching.length > paged.length}
        onAction={runBatch}
        onGrant={() => setGrantIds([...effective])}
        onCancel={() => setSelected(new Set())}
      />

      <GrantPicker
        open={grantIds !== null}
        onClose={() => setGrantIds(null)}
        meetings={grantMeetings}
        consumers={consumers}
        now={now}
        onConfirm={confirmGrant}
      />

      <Drawer open={detail !== undefined} onClose={() => setDetailId(null)} title={detail?.title ?? '会议详情'}>
        {detail && <DetailBody m={detail} consumers={consumers} now={now} />}
      </Drawer>

      <Toast open={toast !== null} onClose={() => setToast(null)} message={toast?.text ?? ''} />
    </div>
  )
}

/** 圆点的图例。颜色不是唯一信息载体，但一张密度这么高的表还是需要一份对照。 */
function Legend() {
  const items: Array<{ state: StatusDotState; overridden?: boolean; text: string }> = [
    { state: 'done', text: STATUS_DOT_LABEL.done },
    { state: 'off', text: STATUS_DOT_LABEL.off },
    { state: 'blocked', text: STATUS_DOT_LABEL.blocked },
    { state: 'failed', text: '失败 · 到期会永久丢失' },
    { state: 'done', overridden: true, text: '人工改写过' },
  ]
  return (
    <div className={styles.legend}>
      {items.map((it, i) => (
        <span key={i} className={styles.legendItem}>
          <StatusDot state={it.state} label="图例" overridden={it.overridden} />
          {it.text}
        </span>
      ))}
    </div>
  )
}

/**
 * 详情抽屉在 F1 里只放**逐阶段的判定理由**——完整的四段详情、资产明细、
 * 操作历史是 F2 的活。放这三条是因为"为什么是这个状态"是这一页存在的理由，
 * 而理由的呈现规则（`why.by` 决定样式）必须在 F1 就定下来。
 */
function DetailBody({ m, consumers, now }: { m: Meeting; consumers: Consumer[]; now: Date }) {
  const left = m.keep.expiresAt !== null ? daysLeft(m.keep.expiresAt, now) : null
  return (
    <div className={styles.detail}>
      <p className={styles.detailMeta}>
        {m.code} · {fmtDateTime(m.startAt, now)} · {m.host}
      </p>

      <WhyRow label="拉取" state={m.fetch} why={m.why.fetch} overridden={m.hand.includes('fetch')} />
      <WhyRow
        label="归档到 NAS"
        state={m.archive}
        why={m.why.archive}
        overridden={m.hand.includes('archive')}
      />

      <section className={styles.detailSection}>
        <h3 className={styles.detailHead}>本地保留</h3>
        <p className={styles.detailText}>
          {m.keep.archivedAt === null || m.keep.expiresAt === null
            ? m.archive === 'failed'
              ? '归档失败，保留期未开始计时。归档不成功，本地到期后这场会议就永久没有了。'
              : '尚未归档，保留期未开始计时。'
            : m.keep.filesGone
              ? `本地文件已于 ${fmtDay(m.keep.expiresAt)} 到期清理，只剩 NAS 路径与记录。`
              : `归档于 ${fmtDay(m.keep.archivedAt)}，${fmtDay(m.keep.expiresAt)}到期，还剩 ${left} 天` +
                (m.keep.extended > 0 ? `（已延长 ${m.keep.extended} 次）` : '')}
        </p>
      </section>

      <section className={styles.detailSection}>
        <h3 className={styles.detailHead}>采集授权</h3>
        <p className={styles.detailText}>
          {m.grants.length > 0
            ? `已授权给 ${m.grants.map((id) => consumerName(consumers, id)).join('、')}`
            : '还没有授权给任何采集程序。'}
        </p>
        <WhyLine why={m.why.allow} />
      </section>

      <p className={styles.detailFoot}>
        资产明细、NAS 路径与操作历史在 F2 的完整详情里，本阶段先把判定理由定下来。
      </p>
    </div>
  )
}

function WhyRow({
  label,
  state,
  why,
  overridden,
}: {
  label: string
  state: StatusDotState
  why: Why
  overridden: boolean
}) {
  return (
    <section className={styles.detailSection}>
      <h3 className={styles.detailHead}>
        <StatusDot state={state} label={label} overridden={overridden} />
        {label}
        <span className={styles.detailState}>{STATUS_DOT_LABEL[state]}</span>
      </h3>
      <WhyLine why={why} />
    </section>
  )
}

function WhyLine({ why }: { why: Why }) {
  return (
    <p className={styles.why} data-tone={whyTone(why.by)} data-by={why.by}>
      <b>{WHY_LABEL[why.by]}</b>
      {why.text}
    </p>
  )
}
