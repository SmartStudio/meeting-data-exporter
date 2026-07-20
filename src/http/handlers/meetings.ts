import { ASSET_TYPES, type ActorIdentity, type Asset, type AssetType, type Meeting } from '../../domain/types'
import { MeetingNotFoundInRangeError } from '../../tencent/records'
import { AssetUrlMissingError, InvalidAssetIdError } from '../../catalog/index'
import { StsTokenUnavailableError } from '../../sts/manager'
import { DEFAULT_WINDOW_SEC } from '../../tencent/window'
import { clientKindOf, requireAuth } from '../middleware'
import { json } from '../respond'
import type { RouteCtx } from '../router'

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100

function meetingToJson(m: Meeting): Record<string, unknown> {
  return {
    meeting_id: m.meetingId,
    sub_meeting_id: m.subMeetingId,
    meeting_code: m.meetingCode,
    subject: m.subject,
    host_user_id: m.hostUserId,
    start_time: m.startTime,
    end_time: m.endTime,
    state: m.state,
  }
}

function assetToJson(a: Asset): Record<string, unknown> {
  return {
    asset_id: a.assetId,
    meeting_id: a.meetingId,
    sub_meeting_id: a.subMeetingId,
    asset_type: a.assetType,
    file_type: a.fileType,
    bytes_expected: a.bytesExpected,
    allow_download: a.allowDownload,
  }
}

/** 数字型查询参数：非法输入一律视为未提供，交由调用方补默认值 */
function parseIntParam(v: string | null): number | undefined {
  if (v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/**
 * 「列会议」处的过滤是 UI 便利、不是安全边界（真正的边界在 download-url）：
 * 只要该会议下至少有一类资产对该 actor 判定为 allow，就认为这场会议应该展示。
 */
async function isMeetingVisible(ctx: RouteCtx, actor: ActorIdentity, meeting: Meeting): Promise<boolean> {
  for (const assetType of ASSET_TYPES) {
    const decision = await ctx.deps.policyEngine.decide({ actor, meeting, assetType })
    if (decision.effect === 'allow') return true
  }
  return false
}

/**
 * GET /api/v1/meetings?from=&to=&meeting_code=&meeting_id=&cursor=&limit=
 *
 * 未传 from/to 时默认最近 31 天（与平台单次查询上限一致，不触发切分）。
 * meeting_code 命中多场时返回数组，不擅自择一。
 * 指定 meeting_id/meeting_code 但范围内未命中：返回 meeting_not_found_in_range，
 * 而不是一个容易被误读为「没权限」或「不存在」的笼统错误。
 */
export async function listMeetings(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = requireAuth(req, ctx.deps.jwtSecret, now)
  if (!auth.ok) return auth.response

  const url = new URL(req.url)
  const from = parseIntParam(url.searchParams.get('from'))
  const to = parseIntParam(url.searchParams.get('to'))
  const meetingCode = url.searchParams.get('meeting_code')
  const meetingId = url.searchParams.get('meeting_id')
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, parseIntParam(url.searchParams.get('limit')) ?? DEFAULT_LIST_LIMIT),
  )
  const cursor = Math.max(0, parseIntParam(url.searchParams.get('cursor')) ?? 0)

  const selector = meetingCode
    ? ({ kind: 'code', meetingCode, from, to } as const)
    : meetingId
      ? ({ kind: 'id', meetingId, from, to } as const)
      : ({ kind: 'range', from: from ?? now - DEFAULT_WINDOW_SEC, to: to ?? now } as const)

  let meetings: Meeting[]
  try {
    meetings = await ctx.deps.recordsApi.listMeetings(selector, now)
  } catch (err) {
    if (err instanceof MeetingNotFoundInRangeError) {
      return json(404, { error: 'meeting_not_found_in_range', message: err.message })
    }
    throw err
  }

  await Promise.all(meetings.map((m) => ctx.deps.meetingsCache.upsert(m, now)))

  const visible: Meeting[] = []
  for (const m of meetings) {
    if (await isMeetingVisible(ctx, auth.identity, m)) visible.push(m)
  }

  await ctx.deps.auditRecorder.recordListing(auth.identity, visible.length)

  const page = visible.slice(cursor, cursor + limit)
  const nextCursor = cursor + limit < visible.length ? String(cursor + limit) : null

  return json(200, { meetings: page.map(meetingToJson), next_cursor: nextCursor })
}

/**
 * GET /api/v1/meetings/:meetingId?from=&to=
 *
 * 单场会议详情，含（已按策略过滤的）资产清单。若同一 meeting_id 在窗口内
 * 命中多条记录（理论上限于周期性会议的多次实例复用同一 meeting_id），
 * 取时间最新的一条作为主记录——这是一个尽力而为的简化，详见任务报告。
 */
export async function getMeeting(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = requireAuth(req, ctx.deps.jwtSecret, now)
  if (!auth.ok) return auth.response

  const url = new URL(req.url)
  const from = parseIntParam(url.searchParams.get('from'))
  const to = parseIntParam(url.searchParams.get('to'))

  let meetings: Meeting[]
  try {
    meetings = await ctx.deps.recordsApi.listMeetings(
      { kind: 'id', meetingId: ctx.params.meetingId!, from, to },
      now,
    )
  } catch (err) {
    if (err instanceof MeetingNotFoundInRangeError) {
      return json(404, { error: 'meeting_not_found_in_range', message: err.message })
    }
    throw err
  }

  await Promise.all(meetings.map((m) => ctx.deps.meetingsCache.upsert(m, now)))
  const meeting = [...meetings].sort((a, b) => b.startTime - a.startTime)[0]!

  const assets = await ctx.deps.catalog.listAssets(meeting)
  const visibleAssets = await filterAssetsByPolicy(ctx, auth.identity, meeting, assets)
  await ctx.deps.auditRecorder.recordListing(auth.identity, 1)

  return json(200, { ...meetingToJson(meeting), assets: visibleAssets.map(assetToJson) })
}

/**
 * GET /api/v1/meetings/:meetingId/assets?from=&to=
 *
 * STS-Token 不可用时，catalog.listAssets 已经在更底层把 ai_* 资产直接排除
 * （字段缺失即不产生该资产，见 catalog/index.ts），video/audio/meeting_summary
 * 不受影响——这里无需任何额外处理即可满足该约束。
 */
export async function listAssets(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = requireAuth(req, ctx.deps.jwtSecret, now)
  if (!auth.ok) return auth.response

  const url = new URL(req.url)
  const from = parseIntParam(url.searchParams.get('from'))
  const to = parseIntParam(url.searchParams.get('to'))

  let meetings: Meeting[]
  try {
    meetings = await ctx.deps.recordsApi.listMeetings(
      { kind: 'id', meetingId: ctx.params.meetingId!, from, to },
      now,
    )
  } catch (err) {
    if (err instanceof MeetingNotFoundInRangeError) {
      return json(404, { error: 'meeting_not_found_in_range', message: err.message })
    }
    throw err
  }

  await Promise.all(meetings.map((m) => ctx.deps.meetingsCache.upsert(m, now)))
  const meeting = [...meetings].sort((a, b) => b.startTime - a.startTime)[0]!

  const assets = await ctx.deps.catalog.listAssets(meeting)
  const visibleAssets = await filterAssetsByPolicy(ctx, auth.identity, meeting, assets)
  await ctx.deps.auditRecorder.recordListing(auth.identity, visibleAssets.length)

  return json(200, { assets: visibleAssets.map(assetToJson) })
}

async function filterAssetsByPolicy(
  ctx: RouteCtx,
  actor: ActorIdentity,
  meeting: Meeting,
  assets: Asset[],
): Promise<Asset[]> {
  const out: Asset[] = []
  for (const a of assets) {
    const decision = await ctx.deps.policyEngine.decide({ actor, meeting, assetType: a.assetType })
    if (decision.effect === 'allow') out.push(a)
  }
  return out
}

const ASSET_TYPE_SET = new Set<string>(ASSET_TYPES)

interface ParsedAssetId {
  meetingRecordId: string
  recordFileId: string
  assetType: AssetType
}

/**
 * assetId 格式：<meetingRecordId>:<recordFileId>:<assetType>:<index>（见
 * catalog/assets.ts）。这里只解析出 download-url 端点自己需要的三段，
 * index 段的存在性只做校验、不单独返回——真正解析下载地址的逻辑仍完全
 * 委托给 catalog.resolveDownloadUrl，本函数不重复实现那部分。
 */
function parseAssetId(assetId: string): ParsedAssetId | null {
  const parts = assetId.split(':')
  if (parts.length < 4) return null
  const [meetingRecordId, recordFileId, assetType, index] = parts
  if (!meetingRecordId || !recordFileId || !assetType || !index) return null
  if (!ASSET_TYPE_SET.has(assetType)) return null
  if (!/^\d+$/.test(index)) return null
  return { meetingRecordId, recordFileId, assetType: assetType as AssetType }
}

/**
 * POST /api/v1/assets/:assetId/download-url
 *
 * 唯一的真正安全边界（跨任务约束 #4）：无论客户端此前是否看到过这个
 * assetId，这里都要用当前时刻的真实 Meeting 重新跑一次 policyEngine.decide，
 * 不信任令牌里缓存的任何判定结果、也不信任「客户端能拼出这个 assetId」这件
 * 事本身。meetingRecordId 在缓存中查不到（伪造的，或从未被任何人列出过）
 * 与「策略判定为 deny」统一返回 403——不区分「不存在」与「无权限」，
 * 避免向调用方泄露资产是否存在。
 */
export async function downloadUrl(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = requireAuth(req, ctx.deps.jwtSecret, now)
  if (!auth.ok) return auth.response

  const assetId = ctx.params.assetId!
  const parsed = parseAssetId(assetId)
  if (!parsed) return json(400, { error: 'invalid_asset_id' })

  const clientKind = clientKindOf(req)

  const meeting = await ctx.deps.meetingsCache.getByRecordId(parsed.meetingRecordId)
  if (!meeting) {
    await ctx.deps.auditRecorder.recordDownloadUrl({
      actor: auth.identity,
      meetingId: parsed.meetingRecordId,
      assetId,
      assetType: parsed.assetType,
      decision: 'deny',
      matchedRuleId: null,
      clientKind,
    })
    return json(403, { error: 'forbidden' })
  }

  const decision = await ctx.deps.policyEngine.decide({
    actor: auth.identity,
    meeting,
    assetType: parsed.assetType,
  })

  await ctx.deps.auditRecorder.recordDownloadUrl({
    actor: auth.identity,
    meetingId: meeting.meetingId,
    assetId,
    assetType: parsed.assetType,
    decision: decision.effect,
    matchedRuleId: decision.matchedRuleId,
    clientKind,
  })

  if (decision.effect === 'deny') return json(403, { error: 'forbidden' })

  const asset: Asset = {
    assetId,
    meetingId: meeting.meetingId,
    subMeetingId: meeting.subMeetingId,
    assetType: parsed.assetType,
    recordFileId: parsed.recordFileId,
    fileType: null,
    bytesExpected: null,
    allowDownload: true,
  }

  try {
    const { url, expiresAt } = await ctx.deps.catalog.resolveDownloadUrl(asset)
    return json(200, { url, expires_at: expiresAt })
  } catch (err) {
    if (err instanceof AssetUrlMissingError) return json(404, { error: 'asset_not_found' })
    if (err instanceof InvalidAssetIdError) return json(400, { error: 'invalid_asset_id' })
    if (err instanceof StsTokenUnavailableError) {
      return json(503, { error: 'sts_token_unavailable' })
    }
    throw err
  }
}
