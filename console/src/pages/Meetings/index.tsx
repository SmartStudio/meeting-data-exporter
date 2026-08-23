import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { mockApi, MOCK_NOW } from '@/api/mock'
import type { Consumer, Meeting, Why, WhyKind } from '@/api/types'
import { useMeetings, useSystemState } from '@/app/SystemStatus'
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
import { consumerName, grantCellKind } from './MeetingRow'
import { TRIAGE_DEFS, TriageBar, type TriageId } from './TriageBar'
import styles from './Meetings.module.css'

/** 本地保留窗口的长度。延长一次多加一个完整窗口。 */
const KEEP_DAYS = 30

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
  // hand＝有人手动改写了规则；deny＝有一条规则明确拒绝。
  // expired / wait / na 是生命周期原因，不是谁的过错，保持中性。
  if (by === 'hand' || by === 'deny') return 'warn'
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

function addDays(unixSec: number, days: number): number {
  const d = new Date(unixSec * 1000)
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes()).getTime() / 1000,
  )
}

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
  useEffect(() => {
    setRows(serverRows ?? [])
  }, [serverRows])

  const consumers: Consumer[] = consumersRes.state === 'ready' ? consumersRes.data : []

  const [filters, setFilters] = useState<ReadonlySet<FilterId>>(new Set())
  const [query, setQuery] = useState('')
  const [rangeDays, setRangeDays] = useState(90)
  const [rangeOpen, setRangeOpen] = useState(false)

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [selectAllMatching, setSelectAllMatching] = useState(false)
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

  const inRange = useMemo(
    () => rows.filter((m) => rangeDays === 0 || daysAgo(m.startAt, now) <= rangeDays),
    [rows, rangeDays, now],
  )

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase()
    return inRange.filter((m) => {
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
  }, [inRange, filters, query, now])

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
          totalInRange: inRange.length,
          totalMatching: matching.length,
          rangeDays,
        })

  /* ── 写操作（F1 只改本地状态）───────────────────────────── */

  const patch = useCallback((id: string, fn: (m: Meeting) => Meeting) => {
    setRows((prev) => prev.map((m) => (m.id === id ? fn(m) : m)))
  }, [])

  const withHand = (m: Meeting, stage: 'fetch' | 'archive'): Meeting['hand'] =>
    m.hand.includes(stage) ? m.hand : [...m.hand, stage]

  const clearedKeep: Meeting['keep'] = { archivedAt: null, expiresAt: null, extended: 0, filesGone: false }

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
      const nowSec = Math.floor(now.getTime() / 1000)
      const handWhy: Why = {
        by: 'hand',
        text: `陈运维 刚刚手动${on ? '关闭' : '执行'}了${stage === 'fetch' ? '拉取' : '归档到 NAS'}，覆盖了规则。`,
      }

      patch(id, (prev) => {
        if (stage === 'fetch') {
          return {
            ...prev,
            fetch: on ? 'off' : 'done',
            // 关掉拉取，后面所有阶段跟着失效——没拉下来的东西谈不上归档和授权。
            archive: on ? 'off' : prev.archive,
            grants: on ? [] : prev.grants,
            keep: on ? clearedKeep : prev.keep,
            hand: withHand(prev, 'fetch'),
            why: {
              ...prev.why,
              fetch: handWhy,
              allow: on ? { by: 'wait', text: '已人工关闭拉取，没有可授权的资产。' } : prev.why.allow,
            },
          }
        }
        return {
          ...prev,
          archive: on ? 'off' : 'done',
          grants: on ? [] : prev.grants,
          keep: on
            ? clearedKeep
            : { archivedAt: nowSec, expiresAt: addDays(nowSec, KEEP_DAYS), extended: 0, filesGone: false },
          hand: withHand(prev, 'archive'),
          why: {
            ...prev.why,
            archive: handWhy,
            allow: on
              ? { by: 'wait', text: '已人工关闭归档，保留期未开始计时。' }
              : prev.allow === 'allow'
                ? { by: 'rule', text: '权限规则准许采集，但还没有授权给任何程序——外部现在取不到。' }
                : prev.why.allow,
          },
        }
      })
      notify(`${on ? '已关闭' : '已执行'}${stage === 'fetch' ? '拉取' : '归档'} · ${m.title}`)
    },
    [rows, now, notify, patch],
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
      patch(id, (prev) => ({
        ...prev,
        keep: {
          ...prev.keep,
          expiresAt: prev.keep.expiresAt === null ? null : addDays(prev.keep.expiresAt, KEEP_DAYS),
          extended: prev.keep.extended + 1,
        },
      }))
      notify(`「${m.title}」本地保留期延长 ${KEEP_DAYS} 天`)
    },
    [rows, notify, patch],
  )

  const applyGrants = useCallback(
    (m: Meeting, next: string[]): Meeting => ({
      ...m,
      grants: next,
      why: {
        ...m.why,
        allow:
          m.allow === 'allow'
            ? next.length > 0
              ? { by: 'rule', text: `权限规则准许采集，已授权给 ${next.map((id) => consumerName(consumers, id)).join('、')}。` }
              : { by: 'rule', text: '权限规则允许采集，但还没有授权给任何程序——外部现在取不到。' }
            : m.why.allow,
      },
    }),
    [consumers],
  )

  const revoke = useCallback(
    (id: string, consumerId: string) => {
      const m = rows.find((x) => x.id === id)
      if (!m) return
      patch(id, (prev) => applyGrants(prev, prev.grants.filter((g) => g !== consumerId)))
      notify(`已收回 ${consumerName(consumers, consumerId)} 对「${m.title}」的授权`)
    },
    [rows, consumers, notify, patch, applyGrants],
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
      let n = 0
      setRows((prev) =>
        prev.map((m) => {
          if (!ids.has(m.id)) return m
          if (grantCellKind(m).kind !== 'grantable') return m
          n += 1
          // 单场是"改成这些程序"（勾选框预置了它现有的授权）；
          // 批量是"再加上这些程序"，不覆盖各场原有的授权。
          const next = single ? consumerIds : Array.from(new Set([...m.grants, ...consumerIds]))
          return applyGrants(m, next)
        }),
      )
      setGrantIds(null)
      if (!single) setSelected(new Set())
      const names = consumerIds.map((id) => consumerName(consumers, id)).join('、')
      notify(consumerIds.length === 0 ? `已收回 ${n} 场会议的全部授权` : `已把 ${n} 场会议授权给 ${names}`)
    },
    [grantIds, consumers, notify, applyGrants],
  )

  /* ── 选择 ────────────────────────────────────────────────── */

  const toggleSelect = useCallback((id: string, next: boolean) => {
    setSelected((prev) => {
      const s = new Set(prev)
      if (next) s.add(id)
      else s.delete(id)
      return s
    })
    if (!next) setSelectAllMatching(false)
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
      if (!next) setSelectAllMatching(false)
    },
    [paged],
  )

  const selectAll = useCallback(() => {
    setSelected(new Set(matching.map((m) => m.id)))
    setSelectAllMatching(true)
    notify(`已选中符合当前筛选的全部 ${matching.length} 场（含未显示的页）`)
  }, [matching, notify])

  const selectPageOnly = useCallback(() => {
    const keep = new Set(paged.map((m) => m.id))
    setSelected((prev) => new Set([...prev].filter((id) => keep.has(id))))
    setSelectAllMatching(false)
  }, [paged])

  /* ── 批量 ────────────────────────────────────────────────── */

  const runBatch = useCallback(
    (action: BatchAction) => {
      const nowSec = Math.floor(now.getTime() / 1000)
      let n = 0
      setRows((prev) =>
        prev.map((m) => {
          if (!selected.has(m.id)) return m
          if (action === 'fetch' && m.fetch !== 'none' && m.fetch !== 'done') {
            n += 1
            return { ...m, fetch: 'done', hand: withHand(m, 'fetch') }
          }
          if (action === 'archive' && m.fetch === 'done' && m.archive !== 'done') {
            n += 1
            return {
              ...m,
              archive: 'done',
              hand: withHand(m, 'archive'),
              keep: { archivedAt: nowSec, expiresAt: addDays(nowSec, KEEP_DAYS), extended: 0, filesGone: false },
            }
          }
          if (action === 'extend' && m.keep.expiresAt !== null && !m.keep.filesGone) {
            n += 1
            return {
              ...m,
              keep: {
                ...m.keep,
                expiresAt: m.keep.expiresAt === null ? null : addDays(m.keep.expiresAt, KEEP_DAYS),
                extended: m.keep.extended + 1,
              },
            }
          }
          if (action === 'revoke' && m.grants.length > 0) {
            n += 1
            return applyGrants(m, [])
          }
          return m
        }),
      )
      const verb = { fetch: '拉取', archive: '归档', extend: `延长 ${KEEP_DAYS} 天保留`, revoke: '收回授权' }[action]
      setSelected(new Set())
      setSelectAllMatching(false)
      notify(n > 0 ? `已对 ${n} 场会议执行${verb}` : `所选会议里没有可${verb}的`)
    },
    [selected, now, notify, applyGrants],
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
          toggleSelect(cursorMeeting.id, !selected.has(cursorMeeting.id))
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
      selected,
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
          onToggle={(id) => toggleFilter(id)}
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
                    setSelected(new Set())
                    setSelectAllMatching(false)
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
        selected={selected}
        cursorId={cursorId}
        onSelect={toggleSelect}
        onSelectPage={selectPage}
        onSelectAllMatching={selectAll}
        onSelectPageOnly={selectPageOnly}
        selectAllMatching={selectAllMatching}
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
        count={selected.size}
        allMatching={selectAllMatching}
        onAction={runBatch}
        onGrant={() => setGrantIds([...selected])}
        onCancel={() => {
          setSelected(new Set())
          setSelectAllMatching(false)
        }}
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
