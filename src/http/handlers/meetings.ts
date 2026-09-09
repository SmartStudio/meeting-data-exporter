import { parseAssetId } from '../../domain/assetid'
import { type ActorIdentity, type Asset, type Meeting } from '../../domain/types'
import { allowsAsset, isVisible } from '../../policy/access'
import type { AllowDecision } from '../../policy/stacks'
import { archiveStateKey } from '../../store/archives'
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
    remote_id: a.recordFileId,
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
 * 从同 meeting_id 的多条录制记录里挑出这次要的那一条。
 *
 * `sub_meeting_id` 给了就按 `meetingRecordId` 精确取——周期会议的每一场是一条记录，
 * 点名要哪一场只能靠它（spec §2.2）。没给保持既有口径：`startTime` 最新的那条，
 * 这是「问一个 meeting_id 要详情」的合理默认，也不改变任何旧调用方的行为。
 *
 * 挑不出来返回 null，由调用方按「范围外未命中」的同一个形状回 404——区分
 * 「不存在」与「无权限」本身就是一种信息泄露，两条路必须长得一样。
 */
function pickMeeting(meetings: Meeting[], subMeetingId: string | null): Meeting | null {
  if (subMeetingId !== null && subMeetingId !== '') {
    return meetings.find((m) => m.meetingRecordId === subMeetingId) ?? null
  }
  return [...meetings].sort((a, b) => b.startTime - a.startTime)[0] ?? null
}

/**
 * 这场会议对该 actor 的采集权限判定。**一场会议只判一次**——判定结果里带着
 * 「放行哪几类资产」，具体某一类取不取得到由 `allowsAsset` 作用在结果之上
 * （计划 §3.4.1 D-e：asset_types 是命中规则的载荷，不是筛选条件）。
 *
 * `arch` 条件要的归档状态在这里查：**不猜、不填 false**，见
 * `ArchivesStore.listArchivedMeetingKeys` 的注释。
 */
async function decideMeeting(
  ctx: RouteCtx,
  actor: ActorIdentity,
  meeting: Meeting,
  now: number,
): Promise<AllowDecision> {
  const archived = (await ctx.deps.archives.listArchivedMeetingKeys([meeting])).has(
    archiveStateKey(meeting.meetingId, meeting.subMeetingId),
  )
  return ctx.deps.accessGate.decide({ actor, meeting, archived, now })
}

/**
 * 批量版：列会议时一次问清整批的归档状态与人工改写，再整批求值。
 * 逐场各查一次会让列会议变成 N 次数据库往返。
 */
async function filterVisibleMeetings(
  ctx: RouteCtx,
  actor: ActorIdentity,
  meetings: readonly Meeting[],
  now: number,
): Promise<Meeting[]> {
  const archivedKeys = await ctx.deps.archives.listArchivedMeetingKeys(meetings)
  // decideMany 而不是逐场 decide：规则与人工改写各取一次。逐场取的话，同一次
  // 列会议里前后两场可能按不同的规则集判，列表里两行的理由会互相矛盾
  const decisions = await ctx.deps.accessGate.decideMany(
    meetings.map((meeting) => ({
      actor,
      meeting,
      archived: archivedKeys.has(archiveStateKey(meeting.meetingId, meeting.subMeetingId)),
      now,
    })),
  )
  return meetings.filter((_, i) => isVisible(decisions[i]!))
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

  // meeting_cache 的写入不在这里：`recordsApi` 每次从 `/v1/corp/records` 拿到会议
  // 就整批写进去（见 tencent/records.ts 的 fetchWindow）。写入点散在各个处理器里
  // 必然漂移，而 download-url 端点与精确查询两个读者都押在「列过的会议一定在表里」。

  const visible = await filterVisibleMeetings(ctx, auth.identity, meetings, now)

  await ctx.deps.auditRecorder.recordListing(auth.identity, visible.length)

  const page = visible.slice(cursor, cursor + limit)
  const nextCursor = cursor + limit < visible.length ? String(cursor + limit) : null

  return json(200, { meetings: page.map(meetingToJson), next_cursor: nextCursor })
}

/**
 * GET /api/v1/meetings/:meetingId?sub_meeting_id=&from=&to=
 *
 * 单场会议详情，含（已按策略过滤的）资产清单。同一 meeting_id 在窗口内可能
 * 命中多条录制记录（周期会议的每一场是一条），要哪一场由 `sub_meeting_id`
 * 点名；不给则取 startTime 最新的那条（见 `pickMeeting`）。
 *
 * 整场可见性检查（与 listMeetings 完全一致的口径：采集权限判定为 allow
 * 且至少放行一类资产）在这里同样是必需的——否则会议本身的属性
 * （subject / host_user_id / start_time / end_time）会在完全不做权限判断的
 * 情况下无条件返回，构成元数据泄露。未通过可见性检查时统一返回 404
 * meeting_not_found_in_range（而非 403），与「范围外未命中」共用同一响应
 * 形状：区分「不存在」与「无权限」本身就是一种信息泄露，不应新增这种可
 * 探测信号。
 */
export async function getMeeting(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = requireAuth(req, ctx.deps.jwtSecret, now)
  if (!auth.ok) return auth.response

  const url = new URL(req.url)
  const from = parseIntParam(url.searchParams.get('from'))
  const to = parseIntParam(url.searchParams.get('to'))
  const meetingIdParam = ctx.params.meetingId!

  let meetings: Meeting[]
  try {
    meetings = await ctx.deps.recordsApi.listMeetings({ kind: 'id', meetingId: meetingIdParam, from, to }, now)
  } catch (err) {
    if (err instanceof MeetingNotFoundInRangeError) {
      return json(404, { error: 'meeting_not_found_in_range', message: err.message })
    }
    throw err
  }

  // 缓存写入由 recordsApi 统一负责（见上面 listMeetings 处的说明）
  const meeting = pickMeeting(meetings, url.searchParams.get('sub_meeting_id'))
  if (meeting === null) {
    const notFound = new MeetingNotFoundInRangeError(meetingIdParam, from ?? now - DEFAULT_WINDOW_SEC, to ?? now)
    return json(404, { error: 'meeting_not_found_in_range', message: notFound.message })
  }

  // 整场会议只判一次：可见性与「哪几类资产能列出来」用的是**同一个判定结果**。
  // 判两次不只是多花一次查询——两次之间规则若被改动，就会出现「会议可见但
  // 资产清单是空的」这种自相矛盾的响应。
  const decision = await decideMeeting(ctx, auth.identity, meeting, now)
  if (!isVisible(decision)) {
    // 与真正「范围外未命中」时抛出的 MeetingNotFoundInRangeError 使用完全相同的
    // from/to 缺省口径（见 tencent/records.ts），使两种情况下的响应体在形状与
    // 措辞上都不可区分。
    const notFound = new MeetingNotFoundInRangeError(meetingIdParam, from ?? now - DEFAULT_WINDOW_SEC, to ?? now)
    return json(404, { error: 'meeting_not_found_in_range', message: notFound.message })
  }

  const assets = await ctx.deps.catalog.listAssets(meeting)
  const visibleAssets = filterAssetsByDecision(decision, assets)
  await ctx.deps.auditRecorder.recordListing(auth.identity, 1)

  return json(200, { ...meetingToJson(meeting), assets: visibleAssets.map(assetToJson) })
}

/**
 * GET /api/v1/meetings/:meetingId/assets?sub_meeting_id=&from=&to=
 *
 * 场次的挑选与 `getMeeting` 同一口径（`pickMeeting`）：`sub_meeting_id` 给了就
 * 取那一条录制记录，不给取最新一条，点不中回 404 meeting_not_found_in_range。
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

  // 缓存写入由 recordsApi 统一负责（见上面 listMeetings 处的说明）
  const meeting = pickMeeting(meetings, url.searchParams.get('sub_meeting_id'))
  if (meeting === null) {
    const notFound = new MeetingNotFoundInRangeError(ctx.params.meetingId!, from ?? now - DEFAULT_WINDOW_SEC, to ?? now)
    return json(404, { error: 'meeting_not_found_in_range', message: notFound.message })
  }

  const assets = await ctx.deps.catalog.listAssets(meeting)
  const decision = await decideMeeting(ctx, auth.identity, meeting, now)
  const visibleAssets = filterAssetsByDecision(decision, assets)
  await ctx.deps.auditRecorder.recordListing(auth.identity, visibleAssets.length)

  return json(200, { assets: visibleAssets.map(assetToJson) })
}

/**
 * 列资产时的过滤，与列会议同一口径（同样是 UI 便利，不是安全边界）。
 *
 * 入参是**已经算好的整场判定**，不是 actor + meeting：整场会议判一次，
 * 再拿这一个结果逐个资产问「这一类在不在它放行的范围里」。旧实现是每个资产
 * 各跑一次判定，因为旧引擎把 asset_types 当筛选条件（`engine.ts` 的
 * `assetMatches`）；新语义下资产类型是命中规则的载荷（计划 §3.4.1 D-e），
 * 逐资产重跑不但白跑，还会掩盖「是哪条规则放行了这场会议」这个必须说得出口的事实。
 */
function filterAssetsByDecision(decision: AllowDecision, assets: Asset[]): Asset[] {
  if (decision.effect !== 'allow') return []
  return assets.filter((a) => allowsAsset(decision, a.assetType).allowed)
}

/**
 * POST /api/v1/assets/:assetId/download-url
 *
 * **唯一的真正安全边界**（跨任务约束 #4）：无论客户端此前是否看到过这个
 * assetId，这里都要用**当前时刻的真实 Meeting** 重新跑一次采集权限判定，
 * 不信任令牌里缓存的任何判定结果、也不信任「客户端能拼出这个 assetId」这件
 * 事本身。meetingRecordId 在缓存中查不到（伪造的，或从未被任何人列出过）
 * 与「判定为 deny」统一返回 403——不区分「不存在」与「无权限」，
 * 避免向调用方泄露资产是否存在。
 *
 * 换成三栈引擎后这条性质**一个字都没变**，只是判定语义换了：整场会议判一次，
 * 再由 `allowsAsset` 决定这一类资产在不在放行范围内。两种拒绝在审计与
 * 判定理由里是分得开的——「命中了某条 allow 规则但它不放行这一类」与
 * 「一条规则都没命中，走兜底 deny」（计划 §3.4.1 D-e）。
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
      // 这一支的拒绝理由与规则无关，是「这个 meetingRecordId 我们根本没见过」。
      // 对外仍然统一回 403（不泄露资产存不存在），但审计里必须分得开——
      // 否则事后看到一条没有 matched_rule 的 deny，说不出是被规则挡的还是查无此物。
      reason: '缓存里没有这个 meetingRecordId：它没被任何人列出过，或是伪造的',
    })
    return json(403, { error: 'forbidden' })
  }

  const decision = await decideMeeting(ctx, auth.identity, meeting, now)
  const asset = allowsAsset(decision, parsed.assetType)

  await ctx.deps.auditRecorder.recordDownloadUrl({
    actor: auth.identity,
    // 与上面缓存未命中分支保持同一维度：未命中时只拿得到 meetingRecordId（真正
    // 的 Tencent meeting_id 无从得知），因此两条路径统一填 meetingRecordId，
    // 避免同一列在两个分支混入不同维度的 ID（详见 audit_log.meeting_id 的
    // 列注释，migrations/001_init.sql）。
    meetingId: parsed.meetingRecordId,
    assetId,
    assetType: parsed.assetType,
    decision: asset.allowed ? 'allow' : 'deny',
    // 命中的规则 id，即便这次是 deny：新语义下「某条 allow 规则命中了，但它不
    // 放行这一类资产」也是一种拒绝，审计里能看见是哪条规则在管这场会议，比
    // 一律记 null 说得清。没有任何规则参与判定时（兜底、或身份不是采集程序）才是 null。
    matchedRuleId: decision.ruleId,
    clientKind,
    // 判定引擎自己给的那句话，原样入账（audit_log.detail，阶段 4 · T15）。
    // 从前它在这里被丢掉：`matched_rule` 答得出「命中了第几条」，答不出
    // 「为什么这条不放行这一类资产」，而 spec §4.10 要的正是后者。
    reason: asset.reason,
  })

  if (!asset.allowed) return json(403, { error: 'forbidden' })

  const target: Asset = {
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
    const { url, expiresAt } = await ctx.deps.catalog.resolveDownloadUrl(target)
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
