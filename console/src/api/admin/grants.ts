/**
 * 采集程序与逐会议授权 / 人工改写（grants.ts 的 7 条端点）。
 *
 * **这个域文件有两个消费者**——会议记录页的详情抽屉（授权/撤销/人工改写）与
 * 采集授权页（同一组端点）——所以它归地基（F0）而不是归其中某一页：
 * 两边各写一份的话，`?sub=` 这个约定就会有两种拼法，而不一致的那一处
 * 恰好是周期性会议，最不容易被测到。
 *
 * ## `?sub=` 的约定封在这里
 *
 * 后端路由上只有 `:meetingId`，两个 DELETE 又没有请求体，所以周期性会议的
 * **场次 id 只有查询串 `?sub=` 这一种传法**（缺省 = 空串 = 主场次）。
 * 调用方一律传 `{ meetingId, subMeetingId }`，拼串是这个文件的事——
 * 不要让七个调用点各自去记这个约定。
 *
 * ## 类型定义在这里，不进 `api/types.ts`（计划 G-b）
 *
 * `ServiceProgram` / `ProgramInventory` / `MeetingGrant` / `MeetingOverride`
 * 只有这一个域用得到。往 `api/types.ts` 里塞就是把它变成第二个汇聚点，
 * 七页各加一组类型 = 七路冲突。真正跨页共享的（`Meeting` / `Why` / `AssetKey`）
 * 已经在 `types.ts` 里了。
 */

import type { AssetKey } from '../types'
import { apiGet, apiSend } from '../client'
import { reader } from '../validate'

/* ── 类型 ───────────────────────────────────────────────────────── */

/**
 * 一场会议（或周期性会议的一个场次）的定位。
 *
 * `subMeetingId` 省略或空串 = 主场次。别把空串写成 `?sub=`——后端读到的是
 * 一个"空串场次"，与"没有场次"在 SQL 上恰好一样，但拼出来的 URL 不一样，
 * 而不一样的 URL 会在审计里留下两种记录。
 */
export interface MeetingRef {
  meetingId: string
  subMeetingId?: string
}

export interface ServiceProgram {
  id: string
  name: string
  /** 这个程序调腾讯 API / 留痕时的操作者身份 */
  tmUserId: string
  enabled: boolean
  /** unix 秒；null = 永不过期 */
  expiresAt: number | null
  createdAt: number
  /**
   * 程序级自动授权（方案 2）。开着的时候由后台任务 `auto_grant` 把规则已判
   * 「准许」、文件还在本地、尚无生效授权、且**从来没被人工撤销过**的会议
   * 真的写进 `meeting_grants`——判定逻辑一个字没改，只是多了一个「系统代为
   * 授权」的来源。
   */
  autoGrant: boolean
  /**
   * 自动授权的资产范围。`null` = 不额外限制（以规则判定为准）；非空数组 =
   * 白名单，取值是六类资产键。**`[]` 存不进去**——「什么都不授权的自动授权」
   * 没有意义，后端回 400 `invalid_auto_grant_asset_types`。
   */
  autoGrantAssetTypes: string[] | null
}

/**
 * 新建程序的响应。`secret` **只在这一次响应里出现**，库里只存 argon2id 哈希——
 * 丢了不能找回，只能轮换。界面上必须说清"这是唯一一次能看到它的机会"。
 */
export interface CreatedProgram extends ServiceProgram {
  secret: string
  secretShownOnce: boolean
  /** 后端那一句「这是唯一一次能看到它的机会」。建号与轮换用的是同一句，
   *  所以两处都读它、都不自己改写——改写就会变成两句不一样的话。 */
  secretNote: string
}

/**
 * 轮换凭据的响应（`POST /programs/:id/rotate-secret`，A8 新增）。
 *
 * **明文只在这一次响应里出现**，库里只存哈希。没有、也不会有「再看一次」的
 * 端点——那等于把 hash 存储的意义抵消掉。所以界面上必须在用户离开这一屏之前
 * 让他意识到这件事，而不是关掉之后才发现。
 */
export interface RotatedSecret {
  id: string
  name: string
  rotatedAt: number
  secret: string
  secretShownOnce: boolean
  secretNote: string
}

export interface CreateProgramInput {
  /** `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；它同时是采集权限规则的 subject_value 与 URL 的一段 */
  id: string
  name: string
  tmUserId: string
  /** 不填 = 永不过期；填了必须是未来的整数秒 */
  expiresAt?: number
}

/**
 * 采集清单里一条会议的判定。`source` / `effect` 用 string 而不是收窄的联合：
 * 后端加一个新的判定来源时，前端应当把它原样显示出来，而不是因为不在枚举里
 * 就崩掉或者悄悄折成"其他"。
 */
export interface InventoryDecision {
  effect: string
  reason: string
  ruleId: number | null
  note: string | null
  source: string
}

/** `code`：not_granted / local_purged / no_local_files / rule_denied / meeting_unknown / grant_scope_empty
 *  `remedy`：grants / nas / rules / pipeline。同上，留 string，不收窄。 */
export interface InventoryBlocker {
  code: string
  remedy: string
  reason: string
}

export interface InventoryItem {
  meetingId: string
  subMeetingId: string
  assetTypes: AssetKey[]
  expiresAt: number | null
  expiringSoon: boolean
  overridden: boolean
  decision: InventoryDecision | null
  blockers: InventoryBlocker[]
}

/**
 * 「这个程序实际能取到什么」。
 *
 * `assetTypes` 是**三个「与」求交之后的实际结果**，不是配置值——采集授权页
 * 那句话的全部价值在这里（spec §4.5）。`Consumer.scope` 那个配置串不是它。
 */
export interface ProgramInventory {
  programId: string
  now: number
  fetchableCount: number
  blockedCount: number
  expiringSoonCount: number
  expiringSoonDays: number
  assetTypes: AssetKey[]
  fetchable: InventoryItem[]
  blocked: InventoryItem[]
}

export interface MeetingGrant {
  id: number
  meetingId: string
  subMeetingId: string
  programId: string
  /** null = 不额外限制（以规则栈为准）；[] = 什么都不授权；非空数组 = 白名单 */
  assetTypes: AssetKey[] | null
  grantedAt: number
  revokedAt: number | null
}

export type OverrideKind = 'fetch' | 'archive' | 'allow'

export interface MeetingOverride {
  id: number
  meetingId: string
  subMeetingId: string
  kind: string
  effect: string
  assetTypes: AssetKey[] | null
  reason: string
  createdAt: number
  revokedAt: number | null
}

export interface GrantInput {
  programId: string
  /** **必须显式给出**：后端缺这个键会 400 `missing_asset_types`。三态含义见 `MeetingGrant.assetTypes` */
  assetTypes: AssetKey[] | null
}

export interface OverrideInput {
  kind: OverrideKind
  /** 取值随 kind 变：fetch 是 all/skip，allow 是 allow/deny，archive 是目录模板串 */
  effect: string
  assetTypes: AssetKey[] | null
  /** 会进判定理由与审计，不能为空/空白 */
  reason: string
}

export interface RevokeResult {
  /** false = 当时没有生效的授权/改写（noop，仍是 200，不是错误） */
  revoked: boolean
}

/* ── 路径 ───────────────────────────────────────────────────────── */

const BASE = '/api/v1/admin'

/**
 * `:meetingId` 段是 `consoleMeetingId(meetingId, subMeetingId)` 编码后的串，
 * 里面会有逗号——不编码的话 `m-1,s-7` 里那个逗号在某些代理上会被当分隔符。
 */
function subQuery(ref: MeetingRef): string {
  const sub = ref.subMeetingId ?? ''
  return sub === '' ? '' : `?sub=${encodeURIComponent(sub)}`
}

function meetingPath(ref: MeetingRef, suffix: string): string {
  return `${BASE}/meetings/${encodeURIComponent(ref.meetingId)}${suffix}${subQuery(ref)}`
}

/* ── 校验 ───────────────────────────────────────────────────────── */

function readProgram(
  r: ReturnType<typeof reader>,
  raw: unknown,
  where: string,
): ServiceProgram {
  const o = r.object(raw, where)
  return {
    id: r.str(o, 'id', where),
    name: r.str(o, 'name', where),
    tmUserId: r.str(o, 'tmUserId', where),
    enabled: r.bool(o, 'enabled', where),
    expiresAt: r.numOrNull(o, 'expiresAt', where),
    createdAt: r.num(o, 'createdAt', where),
    autoGrant: r.bool(o, 'autoGrant', where),
    // null 与字符串数组之外的形状（比如 `[]` 之外的 `{}`、或数组里混进数字）
    // 走的是这个文件里现有的那条解析错误路径：`ApiShapeError` 带端点名与字段路径。
    autoGrantAssetTypes: r.strListOrNull(o, 'autoGrantAssetTypes', where),
  }
}

function readInventoryItem(
  r: ReturnType<typeof reader>,
  raw: unknown,
  where: string,
): InventoryItem {
  const o = r.object(raw, where)
  const decisionRaw = r.objOrNull(o, 'decision', where)
  const decision: InventoryDecision | null =
    decisionRaw === null
      ? null
      : {
          effect: r.str(decisionRaw, 'effect', `${where}.decision`),
          reason: r.str(decisionRaw, 'reason', `${where}.decision`),
          ruleId: r.numOrNull(decisionRaw, 'ruleId', `${where}.decision`),
          note: r.strOrNull(decisionRaw, 'note', `${where}.decision`),
          source: r.str(decisionRaw, 'source', `${where}.decision`),
        }
  return {
    meetingId: r.str(o, 'meetingId', where),
    subMeetingId: r.str(o, 'subMeetingId', where),
    assetTypes: r.strList(o, 'assetTypes', where) as AssetKey[],
    expiresAt: r.numOrNull(o, 'expiresAt', where),
    expiringSoon: r.bool(o, 'expiringSoon', where),
    overridden: r.bool(o, 'overridden', where),
    decision,
    blockers: r.objList(o, 'blockers', where).map((b, i) => ({
      code: r.str(b, 'code', `${where}.blockers[${i}]`),
      remedy: r.str(b, 'remedy', `${where}.blockers[${i}]`),
      reason: r.str(b, 'reason', `${where}.blockers[${i}]`),
    })),
  }
}

function readRevoked(endpoint: string, raw: unknown): RevokeResult {
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return { revoked: r.bool(o, 'revoked', '') }
}

/* ── 七条端点 ────────────────────────────────────────────────────── */

/** `GET /api/v1/admin/programs`。响应里没有任何凭据字段。 */
export async function listPrograms(): Promise<ServiceProgram[]> {
  const endpoint = `GET ${BASE}/programs`
  const raw = await apiGet<unknown>(`${BASE}/programs`)
  const r = reader(endpoint)
  return r.array(raw, '').map((item, i) => readProgram(r, item, `[${i}]`))
}

/** `POST /api/v1/admin/programs`。201，明文 secret 只在这一次响应里出现。 */
export async function createProgram(input: CreateProgramInput): Promise<CreatedProgram> {
  const endpoint = `POST ${BASE}/programs`
  // expiresAt 不填时不发这个键：发 `expiresAt: undefined` 会被 JSON.stringify
  // 丢掉（碰巧对），发 `expiresAt: null` 则会被后端当成一次非法取值。
  const body: Record<string, unknown> = {
    id: input.id,
    name: input.name,
    tmUserId: input.tmUserId,
  }
  if (input.expiresAt !== undefined) body.expiresAt = input.expiresAt
  const raw = await apiSend<unknown>('POST', `${BASE}/programs`, body)
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    ...readProgram(r, o, ''),
    secret: r.str(o, 'secret', ''),
    secretShownOnce: r.bool(o, 'secretShownOnce', ''),
    secretNote: r.str(o, 'secretNote', ''),
  }
}

/**
 * `PATCH /api/v1/admin/programs/:id` —— 停用 / 启用一个采集程序（A8 新增）。
 *
 * 两件必须在界面上说清的事（A8 报告原话）：
 * 1. 停用**不删任何授权**。停用可逆，「停用再启用」不会丢配置。
 * 2. 停用**立刻生效**，包括那个程序手上已经签发、还没过期的访问令牌——
 *    判定在 `AccessGate`，不是只在拿凭据换令牌那一层。
 *
 * `enabled` 必须是真布尔值：后端对 `"false"` / `0` / `null` 一律回 400，
 * **不会折成某一侧**。这里的签名把这件事挡在编译期。
 */
export async function setProgramEnabled(programId: string, enabled: boolean): Promise<ServiceProgram> {
  const endpoint = `PATCH ${BASE}/programs/:id`
  const path = `${BASE}/programs/${encodeURIComponent(programId)}`
  const raw = await apiSend<unknown>('PATCH', path, { enabled })
  return readProgram(reader(endpoint), raw, '')
}

export interface AutoGrantInput {
  /** 必须是真布尔：后端对 `"true"` / `1` / `null` 一律回 400，不会折成某一侧。 */
  autoGrant: boolean
  /** `null` = 不额外限制（以规则判定为准）；非空数组 = 白名单。`[]` 后端回 400。 */
  autoGrantAssetTypes: string[] | null
}

/**
 * `PATCH /api/v1/admin/programs/:id` —— 开 / 关程序级自动授权。
 *
 * 与 `setProgramEnabled` 是**同一条端点的两个请求体家族**，二选一：
 * `{ enabled }` 是一族，`{ autoGrant, autoGrantAssetTypes }` 是另一族，
 * 同时出现或都不出现都会被后端回 400 `invalid_patch`。所以这里分成两个函数，
 * 每个函数只发自己那一族的键——一个 `patchProgram(partial)` 迟早会有人把两族
 * 拼在一起发出去。
 *
 * 三条规矩在界面上说清（`pages/Consumers/ProgramActions.tsx` 的确认面板）：
 * 跑的时机、人工撤销过的不再自动补回、关掉开关不收回已有授权。
 */
export async function setProgramAutoGrant(
  programId: string,
  input: AutoGrantInput,
): Promise<ServiceProgram> {
  const endpoint = `PATCH ${BASE}/programs/:id`
  const path = `${BASE}/programs/${encodeURIComponent(programId)}`
  // 两个键都发：`autoGrantAssetTypes` 省略与显式 null 在后端是同一个意思
  //（不限制），但省略会让请求体随开关状态时有时无，抓包时看不出发生过什么。
  const raw = await apiSend<unknown>('PATCH', path, {
    autoGrant: input.autoGrant,
    autoGrantAssetTypes: input.autoGrantAssetTypes,
  })
  return readProgram(reader(endpoint), raw, '')
}

/**
 * `POST /api/v1/admin/programs/:id/rotate-secret` —— 轮换凭据（A8 新增）。
 *
 * **旧凭据当场失效**，对接方的定时任务会在下一次换令牌时开始 401。所以按钮
 * 按下之前要有二次确认。轮换**不改 `enabled`**。
 */
export async function rotateProgramSecret(programId: string): Promise<RotatedSecret> {
  const endpoint = `POST ${BASE}/programs/:id/rotate-secret`
  const path = `${BASE}/programs/${encodeURIComponent(programId)}/rotate-secret`
  const raw = await apiSend<unknown>('POST', path)
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    id: r.str(o, 'id', ''),
    name: r.str(o, 'name', ''),
    rotatedAt: r.num(o, 'rotatedAt', ''),
    secret: r.str(o, 'secret', ''),
    secretShownOnce: r.bool(o, 'secretShownOnce', ''),
    secretNote: r.str(o, 'secretNote', ''),
  }
}

/** `GET /api/v1/admin/programs/:id/inventory`。404 = 程序不存在（与"一场都没授权"的 200 空清单分得开）。 */
export async function programInventory(programId: string): Promise<ProgramInventory> {
  const path = `${BASE}/programs/${encodeURIComponent(programId)}/inventory`
  const endpoint = `GET ${BASE}/programs/:id/inventory`
  const raw = await apiGet<unknown>(path)
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    programId: r.str(o, 'programId', ''),
    now: r.num(o, 'now', ''),
    fetchableCount: r.num(o, 'fetchableCount', ''),
    blockedCount: r.num(o, 'blockedCount', ''),
    expiringSoonCount: r.num(o, 'expiringSoonCount', ''),
    expiringSoonDays: r.num(o, 'expiringSoonDays', ''),
    assetTypes: r.strList(o, 'assetTypes', '') as AssetKey[],
    fetchable: r
      .objList(o, 'fetchable', '')
      .map((item, i) => readInventoryItem(r, item, `fetchable[${i}]`)),
    blocked: r.objList(o, 'blocked', '').map((item, i) => readInventoryItem(r, item, `blocked[${i}]`)),
  }
}

/**
 * `POST /api/v1/admin/meetings/:meetingId/grants`。
 * 幂等：范围相同返回旧行，范围不同则撤旧插新，返回**当前生效的那一条**。
 */
export async function grantMeeting(ref: MeetingRef, input: GrantInput): Promise<MeetingGrant> {
  const endpoint = `POST ${BASE}/meetings/:meetingId/grants`
  const raw = await apiSend<unknown>('POST', meetingPath(ref, '/grants'), {
    programId: input.programId,
    assetTypes: input.assetTypes,
  })
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    id: r.num(o, 'id', ''),
    meetingId: r.str(o, 'meetingId', ''),
    subMeetingId: r.str(o, 'subMeetingId', ''),
    programId: r.str(o, 'programId', ''),
    assetTypes: r.strListOrNull(o, 'assetTypes', '') as AssetKey[] | null,
    grantedAt: r.num(o, 'grantedAt', ''),
    revokedAt: r.numOrNull(o, 'revokedAt', ''),
  }
}

/** `DELETE /api/v1/admin/meetings/:meetingId/grants/:programId`。 */
export async function revokeGrant(ref: MeetingRef, programId: string): Promise<RevokeResult> {
  const path = meetingPath(ref, `/grants/${encodeURIComponent(programId)}`)
  const raw = await apiSend<unknown>('DELETE', path)
  return readRevoked(`DELETE ${BASE}/meetings/:meetingId/grants/:programId`, raw)
}

/** `PUT /api/v1/admin/meetings/:meetingId/override`。改写后该阶段在界面上标 `hand`。 */
export async function putOverride(ref: MeetingRef, input: OverrideInput): Promise<MeetingOverride> {
  const endpoint = `PUT ${BASE}/meetings/:meetingId/override`
  const raw = await apiSend<unknown>('PUT', meetingPath(ref, '/override'), {
    kind: input.kind,
    effect: input.effect,
    assetTypes: input.assetTypes,
    reason: input.reason,
  })
  const r = reader(endpoint)
  const o = r.object(raw, '')
  return {
    id: r.num(o, 'id', ''),
    meetingId: r.str(o, 'meetingId', ''),
    subMeetingId: r.str(o, 'subMeetingId', ''),
    kind: r.str(o, 'kind', ''),
    effect: r.str(o, 'effect', ''),
    assetTypes: r.strListOrNull(o, 'assetTypes', '') as AssetKey[] | null,
    reason: r.str(o, 'reason', ''),
    createdAt: r.num(o, 'createdAt', ''),
    revokedAt: r.numOrNull(o, 'revokedAt', ''),
  }
}

/** `DELETE /api/v1/admin/meetings/:meetingId/override/:kind`。 */
export async function revokeOverride(ref: MeetingRef, kind: OverrideKind): Promise<RevokeResult> {
  const path = meetingPath(ref, `/override/${encodeURIComponent(kind)}`)
  const raw = await apiSend<unknown>('DELETE', path)
  return readRevoked(`DELETE ${BASE}/meetings/:meetingId/override/:kind`, raw)
}
