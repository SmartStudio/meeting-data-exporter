import type { Meeting } from '../types'
import { buildAudit, type AuditQuery } from './audit'
import { buildInventory, CONSUMERS } from './consumers'
import { buildChapters, buildContent } from './content'
import { applyTencentDown, buildJobs, makeQueuedRun, withQueued, type QueuedRun } from './jobs'
import { MEETINGS, MOCK_NOW } from './meetings'
import {
  buildMatches,
  buildPreview,
  buildRules,
  buildRulesSchema,
  byPrecedence,
  type ProtoRule,
} from './rules'
import { buildStorage, cleanupItem, expiredNotPurged, initialRetention, type RetentionConfig } from './storage'
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
 * ## 它答的是**全部读端点**，不是会议记录页那四条
 *
 * F2 建这一层时只答了 `auth/me` · `programs` · `meetings/triage` · `meetings`——
 * 那时只有会议记录页接了线。等六个页面陆续接上，`?proto=1` 下它们全都拿 501，
 * 屏幕上是六屏"读取失败"。这件事的代价不止是演示不好看：
 * **`scripts/a11y-check.ts` 扫的就是原型模式下的页面**，扫到错误态就等于那一页
 * 的无障碍与对比度根本没进门槛（F8 之前六个页面全是这个状态）。
 *
 * 所以这一层现在覆盖全部读端点，种子分散在同目录的几个域文件里
 * （`rules` / `jobs` / `storage` / `audit` / `content` / `consumers`），
 * 这个文件只管路由。**各页的数字互相对得上**：归档失败的那几场会议、任务页的
 * 失败项、存储页的 `failedMeetings` 是同一件事的三个视角，都从会议世界推出来——
 * 三处对不上，演示就在自己打自己。
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

/** 顶栏那个手动系统状态。`nas-down` / `tencent-down` 会改数据形态（spec §7.2），别的不改。 */
let systemState = 'ok'

export function setProtoSystemState(state: string): void {
  systemState = state
}

/**
 * 演示世界的**部署形态**，用 `?world=` 调（默认 `ok`，另有 `degraded`）。
 *
 * 它与顶栏那个系统状态是**两件正交的事**，所以是两个旋钮：系统状态说的是
 * "此刻外部依赖通不通"（NAS 断了、拉不通腾讯），部署形态说的是"这台机器上
 * 长期就是这样"（保留天数被写成了非法值、网关还是没接 `job_failures` 的老版本）。
 * 把后者塞进 `nas-down` 里一起演，等于宣称配置写错是 NAS 断连造成的——
 * 这个仓库里"改状态就要一起改理由"的规矩，反过来也成立：**没有因果关系的两件事
 * 不能绑在一个开关上**。
 *
 * 目前只有归档存储页读得到它：那一页的三种形态（正常 / NAS 不可达 / 配置非法）
 * 各是一组不同的颜色，a11y 门槛三种都要扫到。
 */
let worldVariant = 'ok'

export function setProtoWorldVariant(name: string): void {
  worldVariant = name
  retention = initialRetention(name)
}

function variantFromUrl(): string {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('world') ?? 'ok'
  } catch {
    return 'ok'
  }
}

/* ── 可变的世界（会议之外的那几份） ───────────────────────────── */

/** 三栈规则。写端点真的改它，删掉一条之后列表里就没有了。 */
let rules: ProtoRule[] = []
/** 新建规则的自增 id，与库里的自增主键同一个意思。 */
let nextRuleId = 900
/** 保留窗口的配置。`POST /storage/retention-days` 改的就是它。 */
let retention: RetentionConfig = initialRetention('ok')
/** 手动触发排进队里的运行。**它们不会开跑**——调度器在另一个进程里。 */
let queuedRuns: QueuedRun[] = []

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
    // mock 的 `Meeting.host` 存的是人名（'邹研发' / '王总'），不是 userid——
    // 真网关那一列是 `woaJARCQAA…` 这样的 32 位串。两者形状不同，所以这里显式
    // 当作「已经查到姓名」下发；不写这一行，lib/host.ts 会把一个已经是姓名的
    // 东西降级成「未知主持人 · 邹研发」。
    //
    // 顺带记一笔：预览页把 userid 原样上屏的 bug 之所以躲过了所有基于 mock 的
    // 检查（含 a11y 的 preview 四个形态），正是因为这里的替身比真实依赖宽容。
    hostName: m.host,
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

  /* ── 自动规则（三栈 + 影响预览） ─────────────────────────────── */

  // 必须排在下面那条 `/rules/:id` 之前吗？不必——那条只匹配数字 id。但少了
  // 这一条，规则页在 `?proto=1` 下就只剩一条「字段清单读不出来」的横幅
  if (path === `${PREFIX}/rules/schema` && method === 'GET') {
    return json(buildRulesSchema())
  }

  if (path === `${PREFIX}/rules/preview` && method === 'POST') {
    return json(buildPreview(body, snapshot(), rules))
  }

  if (path === `${PREFIX}/rules` && method === 'GET') {
    const kind = url.searchParams.get('kind')
    const hits = kind === null || kind === '' ? rules : rules.filter((r) => r.kind === kind)
    // 含停用的规则：停用一条之后它必须还在界面上，否则再也开不回来
    return json({ rules: [...hits].sort(byPrecedence) })
  }

  if (path === `${PREFIX}/rules` && method === 'POST') {
    const created: ProtoRule = {
      id: (nextRuleId += 1),
      kind: String(body.kind ?? 'fetch'),
      priority: typeof body.priority === 'number' ? body.priority : 0,
      enabled: true,
      join: String(body.join ?? 'and'),
      conds: body.conds ?? [],
      subjectType: (body.subjectType as string | null) ?? null,
      subjectValue: (body.subjectValue as string | null) ?? null,
      assetTypes: Array.isArray(body.assetTypes) ? (body.assetTypes as string[]) : ['*'],
      effect: String(body.effect ?? ''),
      note: (body.note as string | null) ?? null,
      createdBy: '原型模式',
      createdAt: nowSec,
      updatedAt: nowSec,
      issues: [],
    }
    rules = [...rules, created]
    return json({ rule: created }, 201)
  }

  const ruleMatch = /^\/api\/v1\/admin\/rules\/(\d+)(\/.*)?$/.exec(path)
  if (ruleMatch) {
    const id = Number(ruleMatch[1])
    const tail = ruleMatch[2] ?? ''
    const rule = rules.find((r) => r.id === id)
    if (rule === undefined) return json({ error: 'rule_not_found' }, 404)

    if (tail === '/matches' && method === 'GET') {
      return json(buildMatches(rule, snapshot(), shiftSec))
    }
    if (tail === '' && method === 'PATCH') {
      // 只有 enabled 一个键的 patch 走不做内容校验的分支：出事时"把这条规则关掉"
      // 必须永远能成功，否则最该关掉的那条坏规则会变成关不掉的
      for (const key of ['kind', 'priority', 'enabled', 'join', 'conds', 'subjectType', 'subjectValue', 'assetTypes', 'effect', 'note'] as const) {
        if (key in body) (rule as unknown as Record<string, unknown>)[key] = body[key]
      }
      rule.updatedAt = nowSec
      return json({ rule })
    }
    if (tail === '' && method === 'DELETE') {
      rules = rules.filter((r) => r.id !== id)
      // 200 而不是 204：回的是被删那条的完整内容，删完再查也查不回来
      return json({ rule })
    }
  }

  /* ── 定时任务 ─────────────────────────────────────────────────── */

  if (path === `${PREFIX}/jobs` && method === 'GET') {
    const base = withQueued(buildJobs(nowSec, snapshot()), queuedRuns)
    return json(systemState === 'tencent-down' ? applyTencentDown(base, nowSec) : base)
  }

  const jobRun = /^\/api\/v1\/admin\/jobs\/([^/]+)\/run$/.exec(path)
  if (jobRun && method === 'POST') {
    const name = decodeURIComponent(jobRun[1] ?? '')
    const job = buildJobs(nowSec, snapshot()).jobs.find((j) => j.name === name)
    if (job === undefined) return json({ error: 'job_not_found' }, 404)
    const queued = makeQueuedRun(name, (nextRuleId += 1), nowSec)
    queuedRuns = [...queuedRuns, queued]
    return json(
      {
        runId: queued.run.id,
        jobName: name,
        label: job.label,
        // 恒为 queued——这一刻任务还没跑，界面上不许说成"已完成"
        status: 'queued',
        message: '已排进队列。调度器在 worker 进程里，下一个 tick 才会认领它。',
      },
      202,
    )
  }

  /* ── 归档存储 ─────────────────────────────────────────────────── */

  if (path === `${PREFIX}/storage` && method === 'GET') {
    return json(
      buildStorage(snapshot(), retention, {
        nasUp: systemState !== 'nas-down',
        legacyGateway: worldVariant === 'degraded',
        nowSec,
      }),
    )
  }

  if (path === `${PREFIX}/storage/retention-days` && method === 'POST') {
    const days = typeof body.days === 'number' ? body.days : Number.NaN
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      // 越界是 400 且带上区间，界面照它说话，不在前端另写一份
      return json({ error: 'invalid_days', min: 1, max: 365 }, 400)
    }
    const previous = retention.source === 'setting' ? retention.defaultDays : null
    retention = { defaultDays: days, source: 'setting', raw: String(days), cleanupPaused: retention.cleanupPaused }
    return json({ defaultDays: days, previousDefaultDays: previous })
  }

  if (path === `${PREFIX}/storage/cleanup-pause` && method === 'POST') {
    retention = { ...retention, cleanupPaused: body.paused === true }
    // 写后重读：回的是库里此刻的真值，不是把请求里那个值抄回来
    return json({ cleanupPaused: retention.cleanupPaused })
  }

  if (path === `${PREFIX}/storage/cleanup-now` && method === 'POST') {
    const items = snapshot().filter((m) => expiredNotPurged(m)).map(cleanupItem)
    if (body.confirm !== true) {
      return json({
        dryRun: true,
        cleanupPaused: retention.cleanupPaused,
        items,
        totalBytes: items.reduce((n, it) => n + (it.localBytes as number), 0),
      })
    }
    const paused = retention.cleanupPaused
    return json({
      dryRun: false,
      paused,
      // 被暂停就一个都不删；**已经删掉的不会因为随后按下暂停而收回**，所以这两个桶分开
      purged: paused ? [] : items,
      verificationFailed: [],
      failed: [],
    })
  }

  /* ── 操作审计 ─────────────────────────────────────────────────── */

  if (path === `${PREFIX}/audit` && method === 'GET') {
    const p = url.searchParams
    const numOr = (key: string): number | undefined => {
      const raw = p.get(key)
      return raw === null || raw === '' ? undefined : Number(raw)
    }
    const listOr = (key: string): string[] | undefined => {
      const all = p.getAll(key).filter((s) => s !== '')
      return all.length === 0 ? undefined : all
    }
    const q: AuditQuery = {
      from: numOr('from'),
      to: numOr('to'),
      actorId: p.get('actorId') ?? undefined,
      actorKind: listOr('actorKind'),
      action: listOr('action'),
      decision: p.get('decision') ?? undefined,
      limit: numOr('limit') ?? 50,
      offset: numOr('offset') ?? 0,
    }
    if (q.limit > 200) return json({ error: 'invalid_limit', max: 200 }, 400)
    return json(buildAudit(q, nowSec))
  }

  /* ── 采集清单 ─────────────────────────────────────────────────── */

  const inventory = /^\/api\/v1\/admin\/programs\/([^/]+)\/inventory$/.exec(path)
  if (inventory && method === 'GET') {
    const id = decodeURIComponent(inventory[1] ?? '')
    // 404 = 程序不存在，与"一场都没授权"的 200 空清单分得开
    if (!CONSUMERS.some((c) => c.id === id)) return json({ error: 'program_not_found' }, 404)
    return json(buildInventory(id, snapshot(), { nowSec, shiftSec }))
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
        // 这一段历史里没登记中文标签的动作。演示世界里每一行都登记过，
        // 所以是空数组——**空数组不是 null**，前端不必区分「没有」与「没算」
        unlabeledActions: [],
      })
    }
    if (tail === '/content' && method === 'GET') {
      const type = url.searchParams.get('type')
      const format = url.searchParams.get('format')
      return json(
        buildContent(shown, {
          shiftSec,
          // 空串是一次真实取值（"筛一个空的格式"），不是"不筛"——两者要分开
          type: type === null || type === '' ? undefined : type,
          format: format === null || format === '' ? undefined : format,
        }),
      )
    }
    if (tail === '/content/chapters' && method === 'GET') {
      return json(buildChapters(shown, shiftSec))
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

/**
 * 演示旋钮挂在 `window.__mdeProto` 上的名字。
 *
 * **为什么需要它**：页面碰不到 `api/mock/`（`tests/mock-gate.test.ts` 用相等
 * 断言盯着这件事，那是设计不是遗漏），所以顶栏那个「系统状态」下拉改得动的
 * 只有 React 里的一个值——它驱动得了那条全局横幅，却驱动不了数据层。于是
 * `applyNasDown` 这样的数据变形在浏览器里一直没人调得到，只有单元测试跑过它。
 *
 * `scripts/a11y-check.ts` 需要「NAS 断连时归档存储页长什么样」这一屏，
 * 所以这里给它一个外部入口。**只在 `?proto=1` 下存在**（这个模块只有那时才
 * 被加载），默认路径上连下载都不会发生。
 */
const HOOK = '__mdeProto'

function exposeHook(): void {
  ;(globalThis as unknown as Record<string, unknown>)[HOOK] = {
    setSystemState: setProtoSystemState,
    setWorldVariant: setProtoWorldVariant,
    reset: resetProtoWorld,
  }
}

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
  resetProtoWorld()
  exposeHook()

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

/**
 * 把世界恢复成种子，并重置两个旋钮。装载时与每条测试之前各跑一次。
 *
 * 会议之外那几份（规则 / 保留窗口配置 / 手动排的队）也在这里重置——它们同样
 * 是可写的，少重置一份，上一条用例删掉的那条规则就会漏进下一条。
 */
export function resetProtoWorld(): void {
  shiftSec = Math.floor(Date.now() / 1000) - MOCK_NOW
  world = structuredClone(MEETINGS)
  systemState = 'ok'
  worldVariant = variantFromUrl()
  rules = buildRules(Math.floor(Date.now() / 1000))
  nextRuleId = 900
  retention = initialRetention(worldVariant)
  queuedRuns = []
}
