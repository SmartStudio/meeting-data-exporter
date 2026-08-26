import type { Meeting } from '../types'
import { CONSUMERS } from './consumers'
import { MEETINGS, MOCK_NOW } from './meetings'
import { applyNasDown } from './system'

/**
 * 原型模式（`?proto=1`）的假后端。
 *
 * ## 它为什么是一个 `fetch` 拦截器，而不是一个页面级的数据源
 *
 * F1 的做法是 `pages/Meetings/index.tsx` 直接 `import { mockApi }`，于是
 * 「看起来能跑、其实是假数据」这件事只隔着一个 import。F2 把它翻过来：
 * **页面永远只认真 API**，原型模式换掉的是网络层。结果是
 *
 * - `src/` 里除 `main.tsx` 那一行守卫过的动态 import 之外，没有任何文件碰得到
 *   `api/mock/`（`tests/mock-gate.test.ts` 用相等断言看着这件事）；
 * - 换来的是每一页都能在没有后端时跑起来，不只是会议记录页；
 * - 默认路径上它连**下载**都不会发生（动态 import ⇒ 代码分割）。
 *
 * ## 它是「假后端」，不是「前端的推导」
 *
 * 这个文件里确实有状态推导（关掉拉取之后 `fetch` 变 `'off'`、`why` 换成人工
 * 改写的那一句）。**这不违反裁定 G-c**：G-c 禁的是前端在真实数据上推导下一个
 * 状态，而这里扮演的正是那个本该做推导的后端。它的产出只在 `?proto=1` 下出现，
 * 顶栏同时挂着「原型 · 全部数字为示例」的标记。
 *
 * ## 时间会跟着今天走
 *
 * 种子数据的「今天」钉在 `MOCK_NOW`（2026-08-23）。原样用会让演示在几天后
 * 变成一堆过期会议，`7 天内到期` 恒为 0。所以装载时整体平移到当下——
 * 相对关系（归档于 2 天前、还剩 28 天）保持不变，这正是要演示的东西。
 */

/** 平移量：种子里的 `MOCK_NOW` 对齐到装载那一刻。 */
let shiftSec = 0

/** 可变的世界。写操作真的改它，这样演示里点一下有反应。 */
let world: Meeting[] = []

/** 顶栏那个手动系统状态。`nas-down` 会改数据形态（spec §7.2），别的不改。 */
let systemState = 'ok'

export function setProtoSystemState(state: string): void {
  systemState = state
}

function shift(sec: number | null): number | null {
  return sec === null ? null : sec + shiftSec
}

/** 按当前系统状态取一份世界快照。`nas-down` 的数据变形是 spec §7.2 的一部分。 */
function snapshot(): Meeting[] {
  const base = structuredClone(world)
  return systemState === 'nas-down' ? applyNasDown(base) : base
}

/* ── 种子 → 下发形状 ──────────────────────────────────────────── */

/**
 * 契约（`ApiMeeting`）比 F1 的 `Meeting` 多七个字段。少一个前端就崩，
 * 所以这里逐个补齐，不靠"前端会忽略"糊过去。
 */
function wire(m: Meeting): Record<string, unknown> {
  const archived = m.keep.archivedAt !== null
  return {
    id: m.id,
    meetingId: m.id,
    subMeetingId: '',
    title: m.title,
    code: m.code,
    startAt: shift(m.startAt),
    durationSec: m.durationSec,
    host: m.host,
    missing: [],
    assets: m.assets,
    unknownAssetTypes: [],
    fetch: m.fetch,
    archive: m.archive,
    grants: m.grants,
    hand: m.hand,
    keep: {
      archivedAt: shift(m.keep.archivedAt),
      expiresAt: shift(m.keep.expiresAt),
      extended: m.keep.extended,
      // 种子里没有这三个字段（它们是后端的事实），按 F1 的语义补出来
      extendedSource: m.keep.extended > 0 ? 'audit' : 'none',
      extendedDays: m.keep.extended * 30,
      retentionDays: archived ? 30 : null,
      filesGone: m.keep.filesGone,
    },
    nasPath: m.nasPath,
    sizeBytes: m.sizeBytes,
    allow: m.allow,
    why: m.why,
    history: [],
  }
}

/* ── 筛选：与后端 `MeetingQuery` 同一套语义 ───────────────────── */

function daysLeftFrom(expiresAt: number, nowSec: number): number {
  return Math.max(0, Math.ceil((expiresAt - nowSec) / 86400))
}

const TRIAGE_TESTS: Record<string, (m: Meeting, nowSec: number) => boolean> = {
  archiveFailed: (m) => m.archive === 'failed',
  expiringIn7d: (m, now) =>
    m.keep.expiresAt !== null && !m.keep.filesGone && daysLeftFrom(m.keep.expiresAt, now) <= 7,
  awaitingGrant: (m) =>
    m.allow === 'allow' && m.archive === 'done' && m.grants.length === 0 && !m.keep.filesGone,
  inProgress: (m) => m.fetch === 'running' || m.archive === 'running',
  nasOnly: (m) => m.keep.filesGone,
}

function matches(m: Meeting, q: URLSearchParams, nowSec: number): boolean {
  const search = (q.get('search') ?? '').trim().toLowerCase()
  if (search !== '' && !`${m.title}${m.code}${m.host}`.toLowerCase().includes(search)) return false

  const triage = q.get('triage')
  if (triage !== null && triage !== '') {
    const test = TRIAGE_TESTS[triage]
    if (test === undefined) return false
    if (!test(m, nowSec)) return false
  }

  const tri = (name: string, actual: boolean): boolean => {
    const raw = q.get(name)
    if (raw === null || raw === '') return true
    return (raw === 'true') === actual
  }
  return (
    tri('hasGrant', m.grants.length > 0) &&
    tri('hasOverride', m.hand.length > 0) &&
    tri('inRetention', !m.keep.filesGone)
  )
}

/* ── 路由 ─────────────────────────────────────────────────────── */

const PREFIX = '/api/v1/admin'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function find(id: string): Meeting | undefined {
  return world.find((m) => m.id === id)
}

/** 人工改写之后那一段的理由。**这是假后端在说话**，不是前端在拼 `why`。 */
function handWhy(text: string): { by: 'hand'; text: string } {
  return { by: 'hand', text }
}

function putOverride(m: Meeting, body: Record<string, unknown>): Response {
  const kind = String(body.kind ?? '')
  const effect = String(body.effect ?? '')
  const reason = String(body.reason ?? '').trim()
  if (kind === '') return json({ error: 'missing_kind' }, 400)
  if (effect === '') return json({ error: 'missing_effect' }, 400)
  if (reason === '') return json({ error: 'missing_reason' }, 400)
  if (!('assetTypes' in body)) return json({ error: 'missing_asset_types' }, 400)

  if (!m.hand.includes(kind as Meeting['hand'][number])) {
    m.hand = [...m.hand, kind as Meeting['hand'][number]]
  }
  if (kind === 'fetch') {
    m.fetch = effect === 'skip' ? 'off' : m.fetch
    m.why = { ...m.why, fetch: handWhy(`人工改写：${reason}`) }
  } else if (kind === 'archive') {
    m.archive = effect === 'skip' ? 'off' : m.archive
    m.why = { ...m.why, archive: handWhy(`人工改写：${reason}`) }
  } else if (kind === 'allow') {
    m.allow = effect === 'deny' ? 'deny' : 'allow'
    if (m.allow === 'deny') m.grants = []
    m.why = { ...m.why, allow: handWhy(`人工改写：${reason}`) }
  }
  return json({
    id: 1,
    meetingId: m.id,
    subMeetingId: '',
    kind,
    effect,
    assetTypes: body.assetTypes ?? null,
    reason,
    createdAt: Math.floor(Date.now() / 1000),
    revokedAt: null,
  })
}

function revokeOverride(m: Meeting, kind: string): Response {
  const had = m.hand.includes(kind as Meeting['hand'][number])
  m.hand = m.hand.filter((k) => k !== kind)
  // 撤销改写之后回到"流水线说了算"的状态。真后端是重新求值，这里按种子的
  // 事实推：有资产就算拉到了，有 NAS 路径就算归档过。
  if (kind === 'fetch' && m.fetch === 'off') {
    m.fetch = Object.keys(m.assets).length === 0 ? 'none' : 'done'
    m.why = { ...m.why, fetch: { by: 'rule', text: '人工改写已撤销，回到拉取规则栈的判定。' } }
  }
  if (kind === 'archive' && m.archive === 'off') {
    m.archive = m.nasPath === null ? 'none' : 'done'
    m.why = { ...m.why, archive: { by: 'rule', text: '人工改写已撤销，回到归档规则栈的判定。' } }
  }
  if (kind === 'allow') {
    m.allow = 'allow'
    m.why = { ...m.why, allow: { by: 'rule', text: '人工改写已撤销，回到采集权限栈的判定。' } }
  }
  return json({ revoked: had })
}

function handle(method: string, url: URL, body: Record<string, unknown>): Response | null {
  const path = url.pathname
  const nowSec = Math.floor(Date.now() / 1000)

  if (path === `${PREFIX}/auth/me` && method === 'GET') {
    // `role` 是 A8 之后契约的一部分（`GET /auth/me` 必发）。少了它前端按
    // `readonly` 处理（安全的一侧），于是原型模式整个变成只读——演示和
    // a11y 门槛里那几个"点开抽屉/授权/延长"的场景会当场点不动。
    return json({ adminId: 'proto', username: '原型模式', role: 'admin' })
  }

  if (path === `${PREFIX}/programs` && method === 'GET') {
    return json(
      CONSUMERS.map((c) => ({
        id: c.id,
        name: c.name,
        tmUserId: `tm-${c.id}`,
        enabled: true,
        expiresAt: null,
        createdAt: nowSec - 86400 * 90,
      })),
    )
  }

  if (path === `${PREFIX}/meetings/triage` && method === 'GET') {
    const all = snapshot()
    const count = (k: string): number => all.filter((m) => TRIAGE_TESTS[k]!(m, nowSec)).length
    return json({
      archiveFailed: count('archiveFailed'),
      expiringIn7d: count('expiringIn7d'),
      awaitingGrant: count('awaitingGrant'),
      inProgress: count('inProgress'),
      nasOnly: count('nasOnly'),
    })
  }

  if (path === `${PREFIX}/meetings` && method === 'GET') {
    const hits = snapshot().filter((m) => matches(m, url.searchParams, nowSec))
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    return json({
      rows: hits.slice(offset, offset + limit).map(wire),
      total: hits.length,
      limit,
      offset,
    })
  }

  const meetingMatch = /^\/api\/v1\/admin\/meetings\/([^/]+)(\/.*)?$/.exec(path)
  if (meetingMatch) {
    const id = decodeURIComponent(meetingMatch[1] ?? '')
    const tail = meetingMatch[2] ?? ''
    const live = find(id)
    if (live === undefined) return json({ error: 'meeting_not_found' }, 404)
    // 读路径要经过 nas-down 的形态变换；写路径直接改底层的那一份
    const shown = snapshot().find((m) => m.id === id) ?? live

    if (tail === '' && method === 'GET') {
      return json({ ...wire(shown), history: shown.history.map((h) => ({ at: shift(h.at), text: h.text })) })
    }
    if (tail === '/history' && method === 'GET') {
      return json({
        meeting: {
          id: shown.id,
          title: shown.title,
          code: shown.code,
          startAt: shift(shown.startAt),
          source: 'meetings',
        },
        rows: shown.history.map((h, i) => ({
          id: i + 1,
          at: shift(h.at),
          actor: { kind: 'human', type: 'admin', id: 'proto' },
          action: 'demo',
          actionLabel: '演示记录',
          object: { id: shown.id, idKind: 'meeting', meetingId: shown.id, title: shown.title, code: shown.code },
          asset: null,
          detail: h.text,
          result: { decision: 'allow', kind: 'allow', reason: null },
          matchedRuleId: null,
          clientKind: 'console',
          text: h.text,
        })),
        window: { since: shift(shown.startAt), sinceSource: 'meetings', text: null },
      })
    }
    if (tail === '/extend' && method === 'POST') {
      if (live.keep.expiresAt === null) return json({ error: 'archive_not_found' }, 404)
      if (live.keep.filesGone) return json({ error: 'already_purged', purgedAt: nowSec }, 409)
      const days = typeof body.days === 'number' ? body.days : 30
      live.keep = {
        ...live.keep,
        expiresAt: live.keep.expiresAt + days * 86400,
        extended: live.keep.extended + 1,
      }
      return json({
        meetingId: live.id,
        subMeetingId: '',
        addedDays: days,
        extendedDays: live.keep.extended * days,
        archivedAt: shift(live.keep.archivedAt) ?? nowSec,
        expiresAt: shift(live.keep.expiresAt) ?? nowSec,
      })
    }
    if (tail === '/grants' && method === 'POST') {
      const programId = String(body.programId ?? '')
      if (programId === '') return json({ error: 'missing_program_id' }, 400)
      if (!('assetTypes' in body)) return json({ error: 'missing_asset_types' }, 400)
      if (!CONSUMERS.some((c) => c.id === programId)) return json({ error: 'program_not_found' }, 404)
      if (!live.grants.includes(programId)) live.grants = [...live.grants, programId]
      return json({
        id: 1,
        meetingId: live.id,
        subMeetingId: '',
        programId,
        assetTypes: body.assetTypes ?? null,
        grantedAt: nowSec,
        revokedAt: null,
      })
    }
    const revokeGrant = /^\/grants\/(.+)$/.exec(tail)
    if (revokeGrant && method === 'DELETE') {
      const programId = decodeURIComponent(revokeGrant[1] ?? '')
      const had = live.grants.includes(programId)
      live.grants = live.grants.filter((g) => g !== programId)
      return json({ revoked: had })
    }
    if (tail === '/override' && method === 'PUT') return putOverride(live, body)
    const revokeKind = /^\/override\/(.+)$/.exec(tail)
    if (revokeKind && method === 'DELETE') {
      return revokeOverride(live, decodeURIComponent(revokeKind[1] ?? ''))
    }
  }

  return null
}

/* ── 安装 ─────────────────────────────────────────────────────── */

let installed = false

/**
 * 接管 `fetch` 里打向 `/api/v1/admin/` 的请求。**只在 `?proto=1` 下调用**
 * （`src/main.tsx` 那一处守卫），其余请求原样交给真的 `fetch`。
 *
 * 没答上来的端点回 **501 + 一句说清楚的话**，不是 404 也不是空对象：
 * 后面几页接线时打到一条原型模式还没实现的端点，应该当场看见这件事，
 * 而不是拿到一个"看起来像空数据"的 200。
 */
export function installProtoApi(): () => void {
  if (installed) return () => undefined
  installed = true
  shiftSec = Math.floor(Date.now() / 1000) - MOCK_NOW
  world = structuredClone(MEETINGS)

  const real = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, globalThis.location?.origin ?? 'http://proto.local')
    if (!url.pathname.startsWith(`${PREFIX}/`)) return real(input, init)

    const method = (init?.method ?? 'GET').toUpperCase()
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string' && init.body !== '') {
      try {
        const parsed: unknown = JSON.parse(init.body)
        if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>
      } catch {
        body = {}
      }
    }

    const res = handle(method, url, body)
    if (res !== null) return res
    return json(
      {
        error: 'proto_not_implemented',
        detail: `原型模式还没有实现 ${method} ${url.pathname}。它不是后端的错，是 api/mock/install.ts 少了一条。`,
      },
      501,
    )
  }

  // 返回一个卸载函数：测试要能把 `fetch` 还回去，否则第一条用例跑完之后
  // 后面每一条拿到的都是原生 fetch（它连相对路径都解析不了）。
  return () => {
    globalThis.fetch = real
    installed = false
  }
}

/** 测试用：把世界恢复成种子，并重置系统状态。 */
export function resetProtoWorld(): void {
  shiftSec = Math.floor(Date.now() / 1000) - MOCK_NOW
  world = structuredClone(MEETINGS)
  systemState = 'ok'
}
