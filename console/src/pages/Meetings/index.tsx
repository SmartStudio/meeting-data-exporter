import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { OverrideKind, ServiceProgram } from '@/api/admin/grants'
import { grantMeeting, putOverride, revokeGrant, revokeOverride } from '@/api/admin/grants'
import type { AdminMeeting } from '@/api/admin/meetings'
import { EXTEND_DEFAULT_DAYS, extendRetention } from '@/api/admin/meetings'
import { READONLY_WHY, useReadonly } from '@/app/session'
import { fmtDay } from '@/lib/format'
import { useMeetingKeys, type MeetingKeyAction } from '@/lib/keys'
import { Button } from '@/ui/Button'
import { Chip } from '@/ui/Chip'
import { Drawer } from '@/ui/Drawer'
import { Input } from '@/ui/Input'
import { PageShell } from '@/ui/PageShell'
import { Popover } from '@/ui/Popover'
import { Toast } from '@/ui/Toast'
import { BatchBar, type BatchAction } from './BatchBar'
import { grantCellKind, meetingTitle, refOf, type Stage } from './display'
import { GrantPicker } from './GrantPicker'
import { MeetingDetail } from './MeetingDetail'
import { emptyKind, MeetingTable } from './MeetingTable'
import { OverrideSheet } from './OverrideSheet'
import { parseQuery, serializeQuery } from './queryUrl'
import { defOf, TriageBar, TRIAGE_DEFS, type TriageId } from './TriageBar'
import { DEFAULT_QUERY, NO_PROGRAMS, NO_ROWS, useMeetingsData, type MeetingsQuery } from './useMeetings'
import { batchSummary, tally, useWrites, wkey } from './writes'
import styles from './Meetings.module.css'

/**
 * 会议记录页——控制台密度最高的一页。
 *
 * 它要同时回答三个问题：现在有什么需要处理（分诊条）、每场会议处在哪个阶段
 * （表格）、以及为什么是这个状态（判定理由 + 详情抽屉）。
 *
 * ## F2：从 mock 换到真 API，三处形态差异
 *
 * 1. **分页、筛选、排序全在服务端**。前端不再持有"全部会议"，因此
 *    - 分诊五格走它自己的端点（翻页不变，有回归测试钉着）；
 *    - 空态的成因从三种收成两种（见 `MeetingTable.emptyKind`）；
 *    - 分诊条一次只能筛一格（后端的 `?triage=` 只收一个取值）。
 * 2. **「今天」是 `new Date()`**，不再是钉死的 `MOCK_NOW`。它在每次数据到达时
 *    刷新一次——长时间开着的标签页里，"还剩 3 天"不该停在昨天的算法上。
 * 3. **时间范围筛选删掉了**。`GET /api/v1/admin/meetings` 没有这个参数，而在
 *    前端补一个内存版本只会在第一页成立：翻到第二页就失效，用户还看不出来。
 *    这条记为后端缺口。
 *
 * ## 页面主操作暂时留在页面内
 *
 * 顶栏（`app/GlobalBar.tsx`）正在长一个「页面主操作插槽」，这一页的主操作
 * 将来搬进去。**现在不接**——那个文件还在改，接一半的插槽比不接更难拆。
 * 在那之前，这一页的写入口都留在页面内确定的位置上：批量动作在选中后浮起的
 * `BatchBar`，单场动作在行内与详情抽屉里。这一页目前**没有**「导出清单」
 * 这一类页级主操作，后端也没有对应端点——不预留一个点了弹「还没做」的按钮
 * （裁定 G-g）。
 *
 * ## 写操作：发请求 + 重取，不做乐观更新（裁定 G-c）
 *
 * 页面里没有任何一处推导"这次写操作之后状态会变成什么"。所有写操作都经过
 * `writes.ts` 的 `run()`：标 pending → 发请求 → 成功后 `refetch()` → 失败落到
 * 一条看得见的错误条。**界面上的判定理由一律来自后端下发的 `why`。**
 */

/** 工具条里三个服务端支持的三态筛选。`undefined` = 不筛选。 */
const TRI_FILTERS = [
  {
    key: 'inRetention' as const,
    label: '保留期内',
    yes: '只看本地文件还在的',
    no: '只看本地已清理的',
  },
  { key: 'hasGrant' as const, label: '已授权', yes: '只看已授权给程序的', no: '只看还没授权的' },
  {
    key: 'hasOverride' as const,
    label: '有人工改写',
    yes: '只看被人工改写过的',
    no: '只看没被改写过的',
  },
]

type TriKey = (typeof TRI_FILTERS)[number]['key']

function isNarrowed(q: MeetingsQuery): boolean {
  return (
    q.search.trim() !== '' ||
    q.triage !== null ||
    q.hasGrant !== undefined ||
    q.hasOverride !== undefined ||
    q.inRetention !== undefined
  )
}

/** 筛选条件的指纹。它一变，选择集就作废——选中的行可能已经不在结果里了。 */
function filterKey(q: MeetingsQuery): string {
  return [q.search.trim(), q.triage, q.hasGrant, q.hasOverride, q.inRetention, q.pageSize].join('|')
}

export default function MeetingsPage() {
  const navigate = useNavigate()
  const location = useLocation()

  // 查询条件（页码、筛选、搜索词）**住在 URL 里**，不住在 state 里：跳去预览页再
  // 回来、刷新、后退，落的都是同一页。换算规则与理由见 `queryUrl.ts`。
  // `query` 只在查询串**内容**变化时换新对象——`useMeetingsData` 拿它当重取依据，
  // 同一个地址被 navigate 两次不该多取一次列表。
  const [params, setParams] = useSearchParams()
  const paramsKey = params.toString()
  const query = useMemo(() => parseQuery(new URLSearchParams(paramsKey)), [paramsKey])
  const queryRef = useRef(query)
  queryRef.current = query
  /**
   * 与 `useState` 的 setter 同形（接对象或函数），但写的是地址栏。用 `replace`：
   * 翻页、改筛选是同一页内的动作，不该在历史里堆出一串 `/meetings?page=2`、
   * `page=3`……让后退键要按七次才回得到上一个页面。
   */
  const setQuery = useCallback(
    (next: MeetingsQuery | ((q: MeetingsQuery) => MeetingsQuery)) => {
      const q = typeof next === 'function' ? next(queryRef.current) : next
      const s = serializeQuery(q)
      if (s.toString() === serializeQuery(queryRef.current).toString()) return
      setParams(s, { replace: true })
    },
    [setParams],
  )
  const [searchText, setSearchText] = useState(() => query.search)
  const [nonce, setNonce] = useState(0)

  // 搜索防抖：不防的话每敲一个字符就是一次请求，而后端那条 SQL 是 LIKE 全表。
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery((q) => (q.search === searchText ? q : { ...q, search: searchText, page: 1 }))
    }, 300)
    return () => clearTimeout(t)
  }, [searchText])

  const { list, triage, programs: programsRes } = useMeetingsData(query, nonce)

  const pageData = list.state === 'ready' ? list.data : null
  const rows: readonly AdminMeeting[] = pageData?.rows ?? NO_ROWS
  const total = pageData?.total ?? 0
  const programs: readonly ServiceProgram[] =
    programsRes.state === 'ready' ? programsRes.data : NO_PROGRAMS

  // 「今天」跟着数据走：每次新的一页到达就重新取一次时钟。渲染期派生而不是
  // 用 effect——effect 要等这一帧提交完才跑，那一帧里 `now` 还是上一次的。
  const [now, setNow] = useState(() => new Date())
  const [seen, setSeen] = useState<unknown>(null)
  if (pageData !== null && pageData !== seen) {
    setSeen(pageData)
    setNow(new Date())
  }

  /* ── 选择 ────────────────────────────────────────────────── */

  /**
   * **选中的是行本身，不只是 id。** 服务端分页之后前端手里只有当前这一页，
   * 光存 id 的话，翻到第二页再按批量，就没有办法知道第一页那几场的
   * `meetingId` / `subMeetingId`（写操作要用它们定位），也没有办法判断
   * 哪几场会被跳过。
   *
   * 筛选一变就整个作废（见 `filterKey`）：改了筛选之后，之前选中的行可能
   * 已经不在结果里了，而"看得见的数字和真正被改掉的行对不上"在这一页是
   * 不可逆的代价——批量按钮里有一个是授权。
   */
  const [selected, setSelected] = useState<ReadonlyMap<string, AdminMeeting>>(() => new Map())
  const fkey = filterKey(query)
  const [seenFkey, setSeenFkey] = useState(fkey)
  if (fkey !== seenFkey) {
    setSeenFkey(fkey)
    setSelected(new Map())
  }

  const [cursor, setCursor] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [grantIds, setGrantIds] = useState<string[] | null>(null)
  const [overrideAt, setOverrideAt] = useState<{ id: string; kind: OverrideKind } | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
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

  /**
   * **键盘绕得过按钮。** 这一页的写操作除了按钮之外还有键位（spec §9：
   * `1`/`2` 改阶段、`3` 授权、`e` 延长），而键位不看按钮的 `disabled`。
   * 只把按钮禁掉、不管这一条，只读账号敲一下 `e` 就会发出一条注定 403 的请求。
   *
   * 所以每个写操作的入口先过这一关。**不是静默 return**——点了没反应比慢一点
   * 更糟：这里弹一句和按钮 title 同源的话，说清为什么什么都没发生。
   */
  const readonly = useReadonly()
  const denyReadonly = useCallback((): boolean => {
    if (!readonly) return false
    notify(READONLY_WHY)
    return true
  }, [readonly, notify])

  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  const writes = useWrites(refetch, notify)
  const { run, isPending, busy } = writes

  const rowOf = useCallback(
    (id: string): AdminMeeting | undefined => rows.find((m) => m.id === id) ?? selected.get(id),
    [rows, selected],
  )

  /* ── 写操作 ──────────────────────────────────────────────── */

  const extend = useCallback(
    (id: string) => {
      if (denyReadonly()) return
      const m = rowOf(id)
      if (!m) return
      // 前置条件说人话。**这不是在推导状态**，是在避免发一条注定 404/409 的请求，
      // 并且当场解释为什么点不动。
      if (m.keep.expiresAt === null) {
        notify('这场会议还没归档成功，保留期尚未开始计时。')
        return
      }
      if (m.keep.filesGone) {
        notify('本地文件已清理，无法延长。历史数据请到 NAS 取。')
        return
      }
      void run(wkey(id, 'extend'), '延长本地保留期', async () => {
        const res = await extendRetention(refOf(m), EXTEND_DEFAULT_DAYS)
        return `「${meetingTitle(m)}」本地保留期延长 ${res.addedDays} 天，${fmtDay(res.expiresAt)}到期`
      })
    },
    [rowOf, notify, run, denyReadonly],
  )

  /**
   * 圆点即开关，但开关两侧不对称——这是真 API 的形态决定的，不是设计选择：
   *
   * - **关掉**一个阶段 = 写一条人工改写（`PUT /override`），而后端要求 `reason`
   *   非空。所以它打开一个要写理由的面板，不是一次点击。
   * - **恢复**这个阶段 = 撤销那条改写（`DELETE /override/:kind`），不需要理由，
   *   所以它就是一次点击。
   *
   * 「重跑这一阶段」这个 F1 语义没有对应的端点（只有整条定时任务的 `POST
   * /jobs/:name/run`），所以这里不假装做得到。记为后端缺口。
   */
  const toggleStage = useCallback(
    (id: string, stage: Stage) => {
      if (denyReadonly()) return
      const m = rowOf(id)
      if (!m) return
      if (m.hand.includes(stage)) {
        void run(wkey(id, stage), `撤销${stage === 'fetch' ? '拉取' : '归档'}的人工改写`, async () => {
          await revokeOverride(refOf(m), stage)
          return `已撤销「${meetingTitle(m)}」${stage === 'fetch' ? '拉取' : '归档'}阶段的人工改写`
        })
        return
      }
      setOverrideAt({ id, kind: stage })
    },
    [rowOf, run, denyReadonly],
  )

  const openGrant = useCallback(
    (id: string) => {
      if (denyReadonly()) return
      const m = rowOf(id)
      if (!m) return
      const kind = grantCellKind(m).kind
      const excuse: Partial<Record<typeof kind, string>> = {
        denied: '规则禁止这场会议被采集。要放行的话，在详情抽屉里做一次人工改写。',
        expired: '本地文件已清理，授权已失效。历史数据请到 NAS 取。',
        na: '这场会议没有录制，没有可授权的资产。',
        wait: '需要先归档成功，保留期开始计时后才能授权。',
        unknown: '后端下发了认不出的采集权限取值，在弄清楚之前不放行授权。',
      }
      const why = excuse[kind]
      if (why !== undefined) {
        notify(why)
        return
      }
      setGrantIds([id])
    },
    [rowOf, notify, denyReadonly],
  )

  const revoke = useCallback(
    (id: string, programId: string) => {
      if (denyReadonly()) return
      const m = rowOf(id)
      if (!m) return
      void run(wkey(id, `revoke:${programId}`), '收回授权', async () => {
        const res = await revokeGrant(refOf(m), programId)
        return res.revoked
          ? `已收回 ${programId} 对「${meetingTitle(m)}」的授权`
          : `${programId} 当时就没有生效的授权，没有改动`
      })
    },
    [rowOf, run, denyReadonly],
  )

  const saveOverride = useCallback(
    (input: { effect: string; reason: string }) => {
      if (denyReadonly()) return
      if (overrideAt === null) return
      const m = rowOf(overrideAt.id)
      if (!m) return
      const kind = overrideAt.kind
      setOverrideAt(null)
      void run(wkey(m.id, kind), '人工改写', async () => {
        await putOverride(refOf(m), {
          kind,
          effect: input.effect,
          // 这一页不收窄授权范围（那是采集授权页的事）。`null` = 不额外限制，
          // 以规则栈为准；**这个键必须显式给出**，缺了后端 400。
          assetTypes: null,
          reason: input.reason,
        })
        return `已改写「${meetingTitle(m)}」的${kind === 'fetch' ? '拉取' : kind === 'archive' ? '归档' : '采集授权'}`
      })
    },
    [overrideAt, rowOf, run, denyReadonly],
  )

  const grantMeetings = useMemo(
    () => (grantIds === null ? [] : grantIds.map((id) => rowOf(id)).filter((m): m is AdminMeeting => !!m)),
    [grantIds, rowOf],
  )

  const confirmGrant = useCallback(
    (programIds: string[]) => {
      if (denyReadonly()) return
      const targets = grantMeetings.filter((m) => grantCellKind(m).kind === 'grantable')
      const single = grantMeetings.length === 1
      setGrantIds(null)
      if (targets.length === 0) {
        notify('所选会议里没有可授权的。')
        return
      }
      void run(wkey('batch', 'grant'), '授权', async () => {
        const jobs: Array<Promise<unknown>> = []
        for (const m of targets) {
          // 单场是"改成这些程序"（勾选框预置了它现有的授权），所以要把去掉的
          // 那几个真的撤掉；批量是"再加上这些程序"，不动各场原有的授权。
          const add = programIds.filter((p) => !m.grants.includes(p))
          for (const p of add) jobs.push(grantMeeting(refOf(m), { programId: p, assetTypes: null }))
          if (single) {
            const drop = m.grants.filter((p) => !programIds.includes(p))
            for (const p of drop) jobs.push(revokeGrant(refOf(m), p))
          }
        }
        if (jobs.length === 0) return '授权没有变化'
        const { ok, failed, firstError } = tally(await Promise.allSettled(jobs))
        if (failed > 0 && ok === 0) throw firstError
        return batchSummary(`授权（共 ${jobs.length} 次改动）`, ok, failed)
      })
      if (!single) setSelected(new Map())
    },
    [grantMeetings, notify, run, denyReadonly],
  )

  /* ── 批量 ────────────────────────────────────────────────── */

  const runBatch = useCallback(
    (action: BatchAction) => {
      if (denyReadonly()) return
      const picked = [...selected.values()]
      if (picked.length === 0) return
      if (action === 'extend') {
        const targets = picked.filter((m) => m.keep.expiresAt !== null && !m.keep.filesGone)
        if (targets.length === 0) {
          notify(`所选会议里没有可延长的——保留期要归档成功之后才开始计时。`)
          return
        }
        void run(wkey('batch', 'extend'), '批量延长保留期', async () => {
          const results = await Promise.allSettled(
            targets.map((m) => extendRetention(refOf(m), EXTEND_DEFAULT_DAYS)),
          )
          const { ok, failed, firstError } = tally(results)
          if (failed > 0 && ok === 0) throw firstError
          setSelected(new Map())
          return batchSummary(`延长 ${EXTEND_DEFAULT_DAYS} 天保留`, ok, failed)
        })
        return
      }
      const targets = picked.filter((m) => m.grants.length > 0)
      if (targets.length === 0) {
        notify('所选会议里没有已授权的。')
        return
      }
      void run(wkey('batch', 'revoke'), '批量收回授权', async () => {
        const jobs = targets.flatMap((m) => m.grants.map((p) => revokeGrant(refOf(m), p)))
        const { ok, failed, firstError } = tally(await Promise.allSettled(jobs))
        if (failed > 0 && ok === 0) throw firstError
        setSelected(new Map())
        return batchSummary(`收回授权（共 ${jobs.length} 条）`, ok, failed)
      })
    },
    [selected, notify, run, denyReadonly],
  )

  /* ── 选择的操作 ──────────────────────────────────────────── */

  const toggleSelect = useCallback(
    (id: string, next: boolean) => {
      const m = rowOf(id)
      setSelected((prev) => {
        const s = new Map(prev)
        if (next && m) s.set(id, m)
        else s.delete(id)
        return s
      })
    },
    [rowOf],
  )

  const selectPage = useCallback(
    (next: boolean) => {
      setSelected((prev) => {
        const s = new Map(prev)
        for (const m of rows) {
          if (next) s.set(m.id, m)
          else s.delete(m.id)
        }
        return s
      })
    },
    [rows],
  )

  /**
   * 进预览页时把**这一页的地址**（含查询串）带在 `location.state.from` 上，
   * 预览页的「返回会议列表」回的就是它——第 7 页进去，第 7 页出来。
   */
  const openPreview = useCallback(
    (id: string) => {
      navigate(`/preview/${encodeURIComponent(id)}`, {
        state: { from: `${location.pathname}${location.search}` },
      })
    },
    [navigate, location.pathname, location.search],
  )

  /* ── 筛选的操作 ──────────────────────────────────────────── */

  const patchQuery = useCallback((patch: Partial<MeetingsQuery>) => {
    setQuery((q) => ({ ...q, ...patch, page: patch.page ?? 1 }))
    setCursor(0)
  }, [])

  /**
   * 点分诊格。**一次只能筛一格**——后端的 `?triage=` 只收一个取值，
   * 前端把两格求交是内存筛选，翻页就失效。再点同一格取消。
   */
  const toggleTriage = useCallback(
    (id: TriageId) => {
      setQuery((q) => {
        const bucket = defOf(id).bucket
        return { ...q, triage: q.triage === bucket ? null : bucket, page: 1 }
      })
      setCursor(0)
    },
    [],
  )

  const activeTriage: TriageId | null = useMemo(() => {
    const def = TRIAGE_DEFS.find((d) => d.bucket === query.triage)
    return def?.id ?? null
  }, [query.triage])

  const cycleTri = useCallback(
    (key: TriKey, value: boolean | undefined) => {
      patchQuery({ [key]: value } as Partial<MeetingsQuery>)
    },
    [patchQuery],
  )

  const clearFilters = useCallback(() => {
    setSearchText('')
    setQuery((q) => ({ ...DEFAULT_QUERY, pageSize: q.pageSize }))
    setCursor(0)
  }, [])

  /* ── 键盘 ────────────────────────────────────────────────── */

  const paged = rows
  const safeCursor = paged.length === 0 ? 0 : Math.min(cursor, paged.length - 1)
  const cursorMeeting = paged[safeCursor]
  const cursorId = cursorMeeting?.id ?? null

  const overlayOpen = detailId !== null || grantIds !== null || overrideAt !== null || filterOpen

  const onKey = useCallback(
    (action: MeetingKeyAction) => {
      if (action.type === 'close-overlay') {
        if (overrideAt !== null) setOverrideAt(null)
        else if (grantIds !== null) setGrantIds(null)
        else if (detailId !== null) setDetailId(null)
        else if (filterOpen) setFilterOpen(false)
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
          openPreview(cursorMeeting.id)
          break
      }
    },
    [
      overrideAt,
      grantIds,
      detailId,
      filterOpen,
      paged.length,
      cursorMeeting,
      safeCursor,
      selected,
      toggleSelect,
      toggleStage,
      openGrant,
      extend,
      openPreview,
    ],
  )

  useMeetingKeys(onKey, { enabled: !overlayOpen })

  /* ── 渲染 ────────────────────────────────────────────────── */

  const loading = list.state === 'loading'
  const error = list.state === 'error' ? list.error : null
  const narrowed = isNarrowed(query)
  const empty = loading || error ? null : emptyKind({ total, narrowed })
  // 加载中仍然渲染分诊条与工具条（骨架 / 禁用态）：数据到了才冒出来一整排
  // 控件，整页会往下跳。读不到（error）时也仍然渲染分诊条——它有自己的端点，
  // 列表读不到不代表计数读不到，而把它一并收起来等于多藏一份可用的信息。
  const toolbarVisible = !error && empty !== 'none-at-all'
  const triageCounts = triage.state === 'ready' ? triage.data : null
  const triageUnreadable = triage.state === 'error'

  const detail = detailId === null ? null : (rowOf(detailId) ?? null)
  const overrideMeeting = overrideAt === null ? null : (rowOf(overrideAt.id) ?? null)
  const offPage = [...selected.keys()].filter((id) => !rows.some((m) => m.id === id)).length

  return (
    // **页头不再挂副标题**（阶段 7）。那句「归档到 NAS 之后本地文件还会留一段
    // 时间……」是一条**制度说明**，不是这一页的内容：它一个月不变，读者一辈子
    // 只需要读一次，却天天占着标题正下方——整页信息密度最高的那条横线上方。
    // 它降级成表格下面的一句脚注（`.lifecycleNote`）：仍然删不得（不知道
    // "本地会删、NAS 不删"的人会把「仅存 NAS」读成"数据丢了"），但排在它
    // 该在的位置上——紧跟着「本地保留」那一列，谁真的疑惑就在那儿看得到。
    <PageShell title="会议记录">
      <TriageBar
        counts={triageCounts}
        active={activeTriage}
        onToggle={toggleTriage}
        loading={triage.state === 'loading'}
        unreadable={triageUnreadable}
      />

      {toolbarVisible && (
        <div className={styles.toolbar}>
          {/* 键位提示**不在 placeholder 里**。此前是 `"…主持人      /"`——
              用六个空格把那个斜杠顶到右边，换一次字号就错位，而且渲染出来
              看着像一个没写完的字符串。现在它是输入框右侧一枚独立的 <kbd>，
              位置由布局决定，不由空格数决定。 */}
          <span className={styles.searchWrap}>
            <Input
              ref={searchRef}
              type="search"
              className={styles.search}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="搜标题 / 会议号 / 主持人"
              aria-label="搜索会议"
            />
            <kbd className={styles.searchKey} aria-hidden="true">
              /
            </kbd>
          </span>
          {TRI_FILTERS.map((f) => (
            <Chip key={f.key} active={query[f.key] !== undefined} onClick={() => setFilterOpen(true)}>
              {f.label}
              {query[f.key] === true && '：是'}
              {query[f.key] === false && '：否'}
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
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((v) => !v)}
            >
              筛选 ▾
            </Button>
            <Popover
              open={filterOpen}
              onClose={() => setFilterOpen(false)}
              role="menu"
              label="筛选条件"
              placement="bottom-end"
            >
              {TRI_FILTERS.map((f) => (
                <div key={f.key} className={styles.triGroup}>
                  <p className={styles.triHead}>{f.label}</p>
                  {[
                    { value: undefined, label: '不筛选' },
                    { value: true, label: f.yes },
                    { value: false, label: f.no },
                  ].map((opt) => (
                    <button
                      key={String(opt.value)}
                      type="button"
                      role="menuitemradio"
                      aria-checked={query[f.key] === opt.value}
                      className={styles.rangeOpt}
                      onClick={() => cycleTri(f.key, opt.value)}
                    >
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              ))}
              <p className={styles.triNote}>
                这三项由服务端筛，翻页照样有效。<b>时间范围</b>那个筛选器删掉了——
                后端没有这个参数，前端补一个只在第一页成立。
              </p>
            </Popover>
          </span>
        </div>
      )}

      {writes.failure !== null && (
        <div className={styles.writeError} role="alert" data-testid="write-error">
          <div>
            <b>{writes.failure.title}</b>
            {writes.failure.hint !== null && <p className={styles.writeHint}>{writes.failure.hint}</p>}
            <p className={styles.writeDetail}>{writes.failure.detail}</p>
          </div>
          <Button variant="quiet" size="sm" onClick={writes.dismissFailure}>
            知道了
          </Button>
        </div>
      )}

      {programsRes.state === 'error' && (
        <p className={styles.softError} role="status">
          采集程序列表读不到，「已授权给」这一栏只会显示程序 id。（{programsRes.error.message}）
        </p>
      )}

      <MeetingTable
        rows={rows}
        programs={programs}
        now={now}
        selected={new Set(selected.keys())}
        cursorId={cursorId}
        isPending={isPending}
        onSelect={toggleSelect}
        onSelectPage={selectPage}
        total={total}
        page={query.page}
        pageSize={query.pageSize}
        onPage={(p) => {
          setQuery((q) => ({ ...q, page: p }))
          setCursor(0)
        }}
        onPageSize={(s) => patchQuery({ pageSize: s })}
        loading={loading}
        error={error}
        onRetry={list.retry}
        empty={empty}
        onClearFilters={clearFilters}
        onGoRules={() => navigate('/rules')}
        onGoJobs={() => navigate('/jobs')}
        onOpenTitle={openPreview}
        onOpenDetail={setDetailId}
        onToggleStage={toggleStage}
        onExtend={extend}
        onOpenGrant={openGrant}
        onRevoke={revoke}
      />

      {/* 制度说明降级成脚注：小一号、次要色、紧跟在它解释的那一列下面。
          它解释的是「本地保留」与「仅存 NAS」这两栏的含义，所以位置是表格
          下面而不是标题下面。 */}
      <p className={styles.lifecycleNote} data-testid="lifecycle-note">
        归档到 NAS 之后本地文件还会留一段时间，被授权的程序在这段时间里可以取走；到期后本地删除，记录与
        NAS 路径永久保留。
      </p>

      <BatchBar
        count={selected.size}
        offPage={offPage}
        busy={busy}
        onAction={runBatch}
        onGrant={() => setGrantIds([...selected.keys()])}
        onCancel={() => setSelected(new Map())}
      />

      <GrantPicker
        open={grantIds !== null}
        onClose={() => setGrantIds(null)}
        meetings={grantMeetings}
        programs={programs}
        now={now}
        busy={busy}
        onConfirm={confirmGrant}
      />

      <OverrideSheet
        open={overrideAt !== null}
        onClose={() => setOverrideAt(null)}
        meeting={overrideMeeting}
        kind={overrideAt?.kind ?? 'fetch'}
        busy={busy}
        onConfirm={saveOverride}
      />

      <Drawer
        open={detail !== null}
        onClose={() => setDetailId(null)}
        title={detail === null ? '会议详情' : meetingTitle(detail)}
      >
        {detail !== null && (
          <MeetingDetail
            fallback={detail}
            nonce={nonce}
            programs={programs}
            now={now}
            isPending={isPending}
            onExtend={extend}
            onOpenGrant={openGrant}
            onRevoke={revoke}
            onOverride={(kind) => setOverrideAt({ id: detail.id, kind })}
            onClearOverride={(kind) => {
              void run(wkey(detail.id, kind), '撤销人工改写', async () => {
                await revokeOverride(refOf(detail), kind)
                return `已撤销「${meetingTitle(detail)}」的人工改写`
              })
            }}
          />
        )}
      </Drawer>

      <Toast open={toast !== null} onClose={() => setToast(null)} message={toast?.text ?? ''} />
    </PageShell>
  )
}

