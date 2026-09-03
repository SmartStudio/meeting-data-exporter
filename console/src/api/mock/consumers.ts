import { ASSET_KEYS } from '../admin/programs'
import type { AssetKey, Consumer, Meeting } from '../types'

/**
 * 迁自原型的 `CONSUMERS`。
 *
 * 原来还有一个 `scope` 字段（'AI 纪要 + 完整转写' 一类），阶段 5 · F4 连同
 * `Consumer.scope` 一起删了：真实的 `GET /api/v1/admin/programs` 不下发它，
 * 留着就是拿一个配置串冒充"这个程序实际能取到什么"（spec.md §4.5）。
 */
export const CONSUMERS: Consumer[] = [
  { id: 'kb-indexer', name: '知识库索引器' },
  { id: 'daily-digest', name: '简报机器人' },
  { id: 'dw-sync', name: '数据仓库同步' },
]

/* ── 程序自身的可写状态（`PATCH /programs/:id` 改的就是它）───────── */

/**
 * 一个程序身上两族可写字段的当前值。
 *
 * `enabled` 与 `autoGrant` 分属**两族请求体**（后端二选一，同时发或都不发都是
 * 400 `invalid_patch`），但它们落在同一行里，所以这里也放在同一个对象上。
 */
export interface ProtoProgramState {
  enabled: boolean
  autoGrant: boolean
  /** null = 不额外限制；非空数组 = 白名单。**`[]` 进不来**，见 `readAutoGrantPatch` */
  autoGrantAssetTypes: string[] | null
}

/**
 * 种子：**一个开着自动授权、两个关着**。
 *
 * 三个都关着的话，采集授权页在原型模式下就只画得出「开启自动授权」那一侧——
 * 徽标、「关闭自动授权」的按钮与那张关闭确认面板一次都不会被 a11y 门槛扫到。
 * 开着的那个还限了资产范围，于是「不限制」与「只授权这几类」两种取值也各有一份。
 */
export function initialProgramStates(): Record<string, ProtoProgramState> {
  return {
    'kb-indexer': { enabled: true, autoGrant: true, autoGrantAssetTypes: ['ai_minutes', 'transcript'] },
    'daily-digest': { enabled: true, autoGrant: false, autoGrantAssetTypes: null },
    'dw-sync': { enabled: true, autoGrant: false, autoGrantAssetTypes: null },
  }
}

/** `GET /programs` 的下发形状。响应里没有任何凭据字段。 */
export function buildPrograms(
  states: Record<string, ProtoProgramState>,
  nowSec: number,
): Array<Record<string, unknown>> {
  return CONSUMERS.map((c) => {
    const st = states[c.id] ?? { enabled: true, autoGrant: false, autoGrantAssetTypes: null }
    return {
      id: c.id,
      name: c.name,
      tmUserId: `tm-${c.id}`,
      enabled: st.enabled,
      expiresAt: null,
      createdAt: nowSec - 86400 * 90,
      autoGrant: st.autoGrant,
      autoGrantAssetTypes: st.autoGrantAssetTypes,
    }
  })
}

/** 读一族请求体的结果：要么是新的取值，要么是一个 400 的响应体。 */
export type PatchRead<T> = { ok: true; value: T } | { ok: false; body: Record<string, unknown> }

/**
 * 读 `{ autoGrant, autoGrantAssetTypes }` 这一族。
 *
 * `[]` 单独回一句话：它是这条端点上唯一一个"看起来合法、实际没有意义"的取值
 *（什么都不授权的自动授权），后端为此专门回了 400，假后端也照回，
 * 否则界面上那条禁用规则在原型模式下就没有对照。
 * 认不出的资产键逐个点名进 `issues`——只说"范围不合法"，管理员不知道是哪一类。
 */
export function readAutoGrantPatch(body: Record<string, unknown>): PatchRead<{
  autoGrant: boolean
  autoGrantAssetTypes: string[] | null
}> {
  if (typeof body.autoGrant !== 'boolean') {
    // 共享契约没给这个码起名字（前端的签名把它挡在编译期），假后端也不装作
    // 知道后端会回哪一个：这里回一个自明的码，界面上照样原样显示出来。
    return { ok: false, body: { error: 'invalid_auto_grant', hint: 'autoGrant 必须是 true 或 false' } }
  }
  const raw = body.autoGrantAssetTypes
  if (raw === undefined || raw === null) {
    return { ok: true, value: { autoGrant: body.autoGrant, autoGrantAssetTypes: null } }
  }
  const hint = '省略或 null = 不限制；给数组就必须非空，且每一项都是八类资产键之一。'
  if (!Array.isArray(raw)) {
    return { ok: false, body: { error: 'invalid_auto_grant_asset_types', hint } }
  }
  if (raw.length === 0) {
    return {
      ok: false,
      body: {
        error: 'invalid_auto_grant_asset_types',
        hint: '空数组等于一个什么都不授权的自动授权，存不进去。不想限制就别传这个键。',
      },
    }
  }
  const issues = raw
    .filter((k) => typeof k !== 'string' || !ASSET_KEYS.includes(k as AssetKey))
    .map((k) => `认不出的资产类型「${String(k)}」`)
  if (issues.length > 0) {
    return { ok: false, body: { error: 'invalid_auto_grant_asset_types', hint, issues } }
  }
  return { ok: true, value: { autoGrant: body.autoGrant, autoGrantAssetTypes: raw as string[] } }
}

/**
 * 「这个程序实际能取到什么」——`GET /programs/:id/inventory`。
 *
 * `assetTypes` 是**三个「与」求交之后的结果**（授权范围 ∩ 规则允许 ∩ 实际存在），
 * 不是某一处的配置值。spec §4.5 那句话的全部价值在这里，所以这份种子里它逐个
 * 程序不同，且窄于"八类全给"。
 */
const REACH: Record<string, AssetKey[]> = {
  'kb-indexer': ['ai_minutes', 'transcript'],
  'daily-digest': ['ai_minutes', 'ai_topic_minutes', 'transcript'],
  'dw-sync': ['ai_ds_minutes'],
}

/** 「快到期」的口径，与后端同一个数。 */
const EXPIRING_SOON_DAYS = 7

/**
 * 一场已授权的会议为什么现在取不到。
 *
 * 每一条都要带上 `remedy`（去哪儿修）——「取不到」而不说去哪儿修，管理员只能
 * 一页页翻。这几个 code 与后端的枚举逐字一致。
 */
function blockersFor(m: Meeting): Array<{ code: string; remedy: string; reason: string }> {
  const out: Array<{ code: string; remedy: string; reason: string }> = []
  if (m.allow === 'deny') {
    out.push({
      code: 'rule_denied',
      remedy: 'rules',
      reason: m.why.allow.text,
    })
  }
  if (m.keep.filesGone) {
    out.push({
      code: 'local_purged',
      remedy: 'nas',
      reason: '本地文件已在保留期结束时清理，NAS 上的副本不通过采集接口对外提供。',
    })
  } else if (m.keep.archivedAt === null) {
    out.push({
      code: 'no_local_files',
      remedy: 'pipeline',
      reason: m.why.archive.text,
    })
  }
  return out
}

function item(m: Meeting, program: string, nowSec: number, shiftSec: number): Record<string, unknown> {
  const expiresAt = m.keep.expiresAt === null ? null : m.keep.expiresAt + shiftSec
  const idMatch = /#(\d+)/.exec(m.why.allow.text)
  return {
    meetingId: m.id,
    subMeetingId: '',
    assetTypes: REACH[program] ?? [],
    expiresAt,
    expiringSoon:
      expiresAt !== null && expiresAt - nowSec <= EXPIRING_SOON_DAYS * 86_400 && expiresAt > nowSec,
    overridden: m.hand.length > 0,
    decision: {
      effect: m.allow,
      reason: m.why.allow.text,
      ruleId: idMatch === null ? null : Number(idMatch[1]),
      note: null,
      source: m.why.allow.by === 'rule' || m.why.allow.by === 'deny' ? 'rule' : 'default',
    },
    blockers: blockersFor(m),
  }
}

/**
 * **只看已经授权给它的那几场**。
 *
 * 「被挡下」说的是"授权在，但现在取不到"（采集授权页那句「另有 N 场已授权但
 * 现在取不到」），不是"全库里它没被授权的那些"——后者是一个几乎等于全库的数，
 * 放进这个清单只会把真正需要处理的那几场淹掉。
 */
export function buildInventory(
  programId: string,
  meetings: readonly Meeting[],
  opts: { nowSec: number; shiftSec: number },
): Record<string, unknown> {
  const granted = meetings.filter((m) => m.grants.includes(programId))
  const reachable = granted.filter((m) => m.allow === 'allow' && !m.keep.filesGone && m.keep.archivedAt !== null)
  const blocked = granted.filter((m) => !reachable.includes(m))

  const fetchable = reachable.map((m) => item(m, programId, opts.nowSec, opts.shiftSec))
  return {
    programId,
    now: opts.nowSec,
    fetchableCount: fetchable.length,
    blockedCount: blocked.length,
    expiringSoonCount: fetchable.filter((i) => i.expiringSoon === true).length,
    expiringSoonDays: EXPIRING_SOON_DAYS,
    assetTypes: REACH[programId] ?? [],
    fetchable,
    blocked: blocked.map((m) => item(m, programId, opts.nowSec, opts.shiftSec)),
  }
}
