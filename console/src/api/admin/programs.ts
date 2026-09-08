/**
 * 采集授权页专有的派生逻辑（spec.md §4.5 · §1.3 · §6.4）。
 *
 * ## 这里**没有**端点
 *
 * `listPrograms` / `createProgram` / `programInventory` 三条在
 * `api/admin/grants.ts` —— 那个域文件有两个消费者（会议记录页的详情抽屉与本页），
 * 所以归地基。这里只放"只有这一页用得到"的东西：把契约里的原始值折成界面上
 * 那几句话。
 *
 * ## 为什么这一页的每一句话都要现算
 *
 * spec §4.5 说卡片正中间那句「现在可取走 4 场会议的 AI 纪要 + 完整转写」
 * **是三个「与」求交之后的实际结果，不是配置值**：
 *
 * ```
 * 有授权（这场会议授权给了这个程序）
 *   且  在保留期内（本地文件还没被删）
 *   且  规则允许采集（权限规则栈判定 allow）
 * ```
 *
 * 三个条件由不同的人在不同的页面维护，所以求交这件事只能由后端每次重算，
 * 前端能做的只有一件：**不要拿别的东西冒充它**。`Consumer.scope`
 * （'AI 纪要 + 完整转写' 那个串）就是被冒充掉的那次——它是一个配置值，
 * 真实的 `GET /programs` 根本不下发它，这一轮已经连同 mock 一起删掉了。
 * 唯一的来源是 `GET /programs/:id/inventory` 的 `assetTypes`。
 */

import type { AssetKey } from '../types'
import { ApiError } from '../client'
import type { CreateProgramInput, InventoryItem, ProgramInventory, ServiceProgram } from './grants'

/* ── 六类资产的中文名 ─────────────────────────────────────────── */

/**
 * 与网关那份（`src/http/handlers/console/meetings.ts` 的 `ASSET_LABEL`）逐字一致。
 * 键用契约的 `AssetKey`，不是原型 HTML 里那套短名（`summary` / `aitr` / `digest`）——
 * 同一批资产在这个项目里已经有过三套叫法，M3.5 为此吃过一次亏。
 */
export const ASSET_LABEL: Record<AssetKey, string> = {
  video: '录像',
  audio: '音频',
  transcript: '逐字稿',
  ai_transcript: '逐字稿（智能优化版）',
  ai_minutes: '纪要',
  chapters: '时间轴',
}

/**
 * 后端加了第七类资产时**原样显示那个键**，不折成"其他"、更不丢掉——
 * 这一页回答的问题是"这个程序实际能取到什么"，少列一类就是答错。
 */
export function assetLabel(key: string): string {
  return ASSET_LABEL[key as AssetKey] ?? key
}

/**
 * 六个资产键，顺序即上面那张表的顺序。**从 `ASSET_LABEL` 派生**，不另抄一份
 * 数组：同一批资产在这个项目里已经有过三套叫法，第二份清单迟早与第一份分叉。
 * 自动授权的资产范围勾选框（`ProgramActions.tsx`）与原型模式的假后端都用它。
 */
export const ASSET_KEYS = Object.keys(ASSET_LABEL) as AssetKey[]

/** `['ai_minutes','transcript']` → `'纪要 + 逐字稿'`。空数组给空串（调用方要能分辨）。 */
export function assetTypesText(keys: readonly string[]): string {
  return keys.map(assetLabel).join(' + ')
}

/**
 * 逐场那一行的资产串。空数组说"无"而不是留白——留白看起来像没渲染出来，
 * 而"这一场一类资产都取不到"是一个真实的、需要被看见的结果。
 */
export function assetsOrDash(keys: readonly string[]): string {
  return keys.length === 0 ? '无' : assetTypesText(keys)
}

/* ── 卡片正中间那句话 ─────────────────────────────────────────── */

export type ReachLine =
  /** 能取走：spec §4.5 那句话本体。 */
  | { kind: 'reachable'; count: number; assetsText: string; expiringSoon: number; expiringSoonDays: number }
  /**
   * 能取走 N 场、却一类资产都没列出来。这在后端是自相矛盾的（清单里的资产类型
   * 是可取会议的并集），所以**单独成一档**而不是印出「可取走 2 场会议的」这样
   * 一句半截话——半截话看起来像排版坏了，实际是数据坏了。
   */
  | { kind: 'reachable-no-assets'; count: number }
  /** 一场都取不到。这不是"可取走 0 场"——0 场时该说的是另一句话，见 §4.5 原型。 */
  | { kind: 'none'; blockedCount: number }

export function reachLine(inv: ProgramInventory): ReachLine {
  if (inv.fetchableCount <= 0) return { kind: 'none', blockedCount: inv.blockedCount }
  if (inv.assetTypes.length === 0) return { kind: 'reachable-no-assets', count: inv.fetchableCount }
  return {
    kind: 'reachable',
    count: inv.fetchableCount,
    assetsText: assetTypesText(inv.assetTypes),
    expiringSoon: inv.expiringSoonCount,
    // 阈值随响应下发，前端不再抄一份 7（契约里写明了这一点）
    expiringSoonDays: inv.expiringSoonDays,
  }
}

/* ── "为什么取不到" ───────────────────────────────────────────── */

/**
 * spec §1.3：「界面必须随时能回答『为什么这场会议这个程序取不到』」。
 * 卡片上放不下逐场的理由，所以按 `code` 归并成几条，明细在「查看清单」里。
 */
export interface BlockerTally {
  code: string
  label: string
  remedy: string
  count: number
  /** 后端原话，取这一类里的第一条。理由的文本一律来自后端，前端不自己编。 */
  sample: string
}

const BLOCKER_LABEL: Record<string, string> = {
  not_granted: '未授权',
  local_purged: '本地文件已清理',
  no_local_files: '本地没有文件',
  rule_denied: '规则拒绝',
  meeting_unknown: '会议不存在',
  grant_scope_empty: '授权范围为空',
}

/** 没见过的 code 原样显示。冒充成已知的某一类，等于把一个我们没看懂的原因说成看懂了。 */
export function blockerLabel(code: string): string {
  return BLOCKER_LABEL[code] ?? code
}

const REMEDY_HINT: Record<string, string> = {
  grants: '到「会议记录」页把这几场授权给它',
  rules: '到「自动规则」页的采集权限规则栈里放行',
  nas: '本地文件已按保留期清理，到「归档存储」页看保留天数，或直接从 NAS 取',
  pipeline: '拉取 / 归档还没跑完，到「定时任务」页看这条链路',
}

/** 未知的 remedy 返回 `null`——编一句"去某处处理"比不说更糟。 */
export function remedyHint(remedy: string): string | null {
  return REMEDY_HINT[remedy] ?? null
}

/** 按 code 归并，多的排前面；同数时按 code 排，保证渲染顺序稳定。 */
export function tallyBlockers(items: readonly InventoryItem[]): BlockerTally[] {
  const byCode = new Map<string, BlockerTally>()
  for (const item of items) {
    for (const b of item.blockers) {
      const hit = byCode.get(b.code)
      if (hit) {
        hit.count += 1
        continue
      }
      byCode.set(b.code, {
        code: b.code,
        label: blockerLabel(b.code),
        remedy: b.remedy,
        count: 1,
        sample: b.reason,
      })
    }
  }
  return [...byCode.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
}

/* ── 程序自身的状态 ───────────────────────────────────────────── */

/**
 * 「这个程序还能不能来取」与「现在有几场可取」是两件事：凭据过期的程序哪怕
 * 清单上有 4 场，也一场都取不走。两者分开显示，不合并成一个"是否在用"。
 */
export type ProgramStanding = 'active' | 'disabled' | 'expired'

export function programStanding(p: ServiceProgram, nowSec: number): ProgramStanding {
  // 停用排在过期前面：它是有人做过的一个动作，比"时间到了"更需要先被看到。
  if (!p.enabled) return 'disabled'
  // `expiresAt === now` 仍算有效：过期是"过了"，不是"到了"。
  if (p.expiresAt !== null && p.expiresAt < nowSec) return 'expired'
  return 'active'
}

export const STANDING_LABEL: Record<ProgramStanding, string> = {
  active: '正常',
  disabled: '已停用',
  expired: '凭据已过期',
}

/* ── 接入向导第一步的校验 ─────────────────────────────────────── */

/** 契约原文：它同时是采集权限规则的 `subject_value` 与 URL 的一段。 */
export const PROGRAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_TEXT = 128

/** `expiresAt` 是 `<input type="date">` 的 `YYYY-MM-DD` 串，空串 = 永不过期。 */
export interface Draft {
  id: string
  name: string
  tmUserId: string
  expiresAt: string
}

export type DraftField = 'id' | 'name' | 'tmUserId' | 'expiresAt'

export interface FieldError {
  field: DraftField
  message: string
}

export const EMPTY_DRAFT: Draft = { id: '', name: '', tmUserId: '', expiresAt: '' }

/**
 * 到期日解析成"那一天的最后一秒"（本地时区）。
 * 用当天末尾而不是零点：管理员填 6 月 1 日的意思是"6 月 1 日当天还能用"，
 * 解析成 00:00 会让那一整天凭空消失。
 */
function parseExpiry(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d, 23, 59, 59)
  // `new Date(2030, 12, 40)` 不会报错，会滚到下一个月——回读一遍确认没滚。
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return Math.floor(date.getTime() / 1000)
}

/**
 * 前端这一遍校验不是为了替后端把关（后端有自己的一份，且那份才算数），
 * 是为了把错误落到**具体那一栏**上——后端只回一个 `invalid_program_id`，
 * 界面上没有它就只能整体飘一句红字。
 */
export function validateDraft(draft: Draft, nowSec: number): FieldError[] {
  const out: FieldError[] = []
  const id = draft.id.trim()
  const name = draft.name.trim()
  const tmUserId = draft.tmUserId.trim()

  if (id === '') out.push({ field: 'id', message: '程序 id 必填：它同时是规则里的主体名与 URL 的一段。' })
  else if (!PROGRAM_ID_RE.test(id)) {
    out.push({
      field: 'id',
      message: '首字符要是字母或数字，其余只能用字母、数字与 . _ -，总长不超过 64。',
    })
  }

  if (name === '') out.push({ field: 'name', message: '程序名称必填：授权列表与操作审计里显示的就是它。' })
  else if (name.length > MAX_TEXT) out.push({ field: 'name', message: `不超过 ${MAX_TEXT} 个字符。` })

  if (tmUserId === '') {
    out.push({ field: 'tmUserId', message: '操作者身份必填：这个程序调腾讯 API / 留痕时用的就是它。' })
  } else if (tmUserId.length > MAX_TEXT) {
    out.push({ field: 'tmUserId', message: `不超过 ${MAX_TEXT} 个字符。` })
  }

  const day = draft.expiresAt.trim()
  if (day !== '') {
    const at = parseExpiry(day)
    if (at === null) out.push({ field: 'expiresAt', message: '填不成一个日期。留空表示永不过期。' })
    else if (at <= nowSec) out.push({ field: 'expiresAt', message: '到期日要在将来。留空表示永不过期。' })
  }

  return out
}

export function draftToInput(draft: Draft): CreateProgramInput {
  const input: CreateProgramInput = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    tmUserId: draft.tmUserId.trim(),
  }
  const day = draft.expiresAt.trim()
  if (day !== '') {
    const at = parseExpiry(day)
    // 不填这个键 = 永不过期。发 `null` 会被后端当成一次非法取值。
    if (at !== null) input.expiresAt = at
  }
  return input
}

/* ── 后端拒绝时的说法 ─────────────────────────────────────────── */

const CREATE_ERROR: Record<string, string> = {
  invalid_program_id: '程序 id 不合法：首字符要是字母或数字，其余只能用字母、数字与 . _ -，总长不超过 64。',
  invalid_name: '程序名称不合法：不能为空，且不超过 128 个字符。',
  invalid_tm_userid: '操作者身份不合法：不能为空，且不超过 128 个字符。',
  invalid_expires_at: '到期时间不合法：必须是将来的一个整数秒。',
  program_id_taken: '这个程序 id 已经被占用了，换一个。',
  invalid_json: '请求体不是合法 JSON——这是前端的问题，请把这句话连同时间点报给维护者。',
}

function errorCode(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null
  const body = e.body
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const code = (body as { error: unknown }).error
    if (typeof code === 'string') return code
  }
  return null
}

/**
 * 已知错误码翻成人话；没见过的**原样退回 client 那句**——那句里带着端点名与
 * 状态码，比一句通用的"操作失败"能定位得多。
 */
export function createErrorText(e: unknown): string {
  const code = errorCode(e)
  if (code !== null && CREATE_ERROR[code] !== undefined) return CREATE_ERROR[code] as string
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * 自动授权那两个键被拒时的说法。
 *
 * 与 `createErrorText` 同一条规矩（已知码翻成人话、没见过的原样退回 client
 * 那句），只多一件事：`invalid_auto_grant_asset_types` 可能带 `issues`——
 * 后端逐条点名了哪个资产键认不出来。那几条比我们这句通用解释有用得多，
 * **不能吞掉**：吞了之后管理员只知道"范围不合法"，不知道是哪一类不合法。
 */
const AUTO_GRANT_ERROR: Record<string, string> = {
  invalid_auto_grant_asset_types:
    '资产范围不合法：要么不限制（以规则判定为准），要么给一个非空的资产类型列表。空列表存不进去——那是一个什么都不授权的自动授权。',
  invalid_patch:
    '这次请求同时改了两件事、或者一件都没改：停用开关与自动授权是两族请求体，一次只能发一族。这是前端的问题，请把这句话连同时间点报给维护者。',
}

export function autoGrantErrorText(e: unknown): string {
  const code = errorCode(e)
  const known = code === null ? undefined : AUTO_GRANT_ERROR[code]
  if (known === undefined) return createErrorText(e)
  const issues = errorIssues(e)
  return issues.length === 0 ? known : `${known}后端点名的是：${issues.join('；')}`
}

/** 响应体里的 `issues`（字符串数组）。没有、或不是字符串数组时给空数组。 */
function errorIssues(e: unknown): string[] {
  if (!(e instanceof ApiError)) return []
  const body = e.body
  if (body === null || typeof body !== 'object' || !('issues' in body)) return []
  const raw = (body as { issues: unknown }).issues
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * 清单读不到时的那句话。**"没查到"与"什么都取不到"是两回事**，所以这里绝不
 * 退化成一份空清单：空清单的意思是"这个程序现在一场都取不走"，是一个结论；
 * 拉不到清单则是我们没有结论。
 */
export function inventoryErrorText(e: unknown): string {
  if (errorCode(e) === 'program_not_found') {
    return '这个程序在后端已经不存在了（清单端点回 404）。列表可能是几秒前的旧数据，刷新一次看看。'
  }
  if (e instanceof ApiError && e.status === 0) {
    return `连不上后端：${e.message}`
  }
  return e instanceof Error ? e.message : String(e)
}

/* ── 接入方式那一段 ───────────────────────────────────────────── */

/**
 * 给对方抄的两条命令。端点与请求体照后端的真实形状写
 * （`src/http/handlers/auth.ts` 的 `serviceToken`：`{client_id, client_secret}`
 * → `{access_token, expires_in}`）。
 *
 * **刻意不写死令牌有效期**：那个数在后端（`ACCESS_TOKEN_TTL_SEC`，900 秒），
 * 抄一份到界面上就是第二处真相，而原型里那份已经抄错了（写的是 1 小时）。
 */
export function accessSnippet(origin: string, programId: string): string {
  return [
    '# 1. 用凭据换取令牌（有效期看响应里的 expires_in，单位秒）',
    `curl -X POST ${origin}/api/v1/auth/service-token \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d '{"client_id":"${programId}","client_secret":"<刚才那串明文>"}'`,
    '',
    '# 2. 列出对它开放的会议（只会返回已授权、在保留期内且规则放行的那些）',
    `curl ${origin}/api/v1/meetings \\`,
    "  -H 'Authorization: Bearer <access_token>'",
  ].join('\n')
}
