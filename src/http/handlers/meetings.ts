import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DOWNLOAD_TOKEN_TTL_SEC, signDownloadToken, verifyDownloadToken } from '../../auth/tokens'
import { parseAssetId } from '../../domain/assetid'
import { type ActorIdentity, type Asset, type Meeting } from '../../domain/types'
import { allowsAsset, isVisible } from '../../policy/access'
import type { AllowDecision } from '../../policy/stacks'
import { archiveStateKey } from '../../store/archives'
import { STORED_LOOKUP_NOTE } from '../../store/stored-records'
import { MeetingNotFoundInRangeError } from '../../tencent/records'
import { DEFAULT_WINDOW_SEC } from '../../tencent/window'
import { isInsideRoot, parseRange } from '../byterange'
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
    record_type: m.recordType,
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

function meetingNotFound(err: MeetingNotFoundInRangeError): Response {
  return json(404, { error: 'meeting_not_found_in_range', message: err.message })
}

/** 与 recordsApi 未命中时同一形状、同一措辞的 404，供点不中场次与判定不可见两处复用 */
function storedMeetingNotFound(req: Request, meetingId: string): Response {
  const url = new URL(req.url)
  const from = parseIntParam(url.searchParams.get('from')) ?? null
  const to = parseIntParam(url.searchParams.get('to')) ?? null
  return meetingNotFound(new MeetingNotFoundInRangeError(meetingId, from, to, STORED_LOOKUP_NOTE))
}

/**
 * `/meetings/:meetingId` 与 `/meetings/:meetingId/assets` 共用的场次定位：按
 * meeting_id 取窗口内的全部录制记录，再由 `sub_meeting_id` 点名（见 `pickMeeting`）。
 *
 * 点不中与「查询根本没命中」回同一个 404（理由见 `pickMeeting`），所以措辞也用
 * recordsApi 抛的那个错误类。
 */
async function resolveMeeting(req: Request, ctx: RouteCtx, now: number): Promise<Meeting | Response> {
  const url = new URL(req.url)
  const from = parseIntParam(url.searchParams.get('from'))
  const to = parseIntParam(url.searchParams.get('to'))
  const meetingId = ctx.params.meetingId!

  let meetings: Meeting[]
  try {
    meetings = await ctx.deps.recordsApi.listMeetings({ kind: 'id', meetingId, from, to }, now)
  } catch (err) {
    if (err instanceof MeetingNotFoundInRangeError) return meetingNotFound(err)
    throw err
  }
  return pickMeeting(meetings, url.searchParams.get('sub_meeting_id')) ?? storedMeetingNotFound(req, meetingId)
}

/**
 * 这场会议已经落到网关本地归档的资产。调度器每轮下载完成后把行标成 completed 并
 * 写上 asset_id；网关不再实时问腾讯，也就不会列出「腾讯有、本地还没下完」的资产
 * ——引擎对缺席类型按 wait 处理，下一轮 `mde run` 会补上。
 *
 * `asset_id` 为空的行是这一列出现之前的旧数据，没有 id 就签不出下载地址，跳过并留日志。
 */
async function storedAssets(ctx: RouteCtx, meeting: Meeting): Promise<Asset[]> {
  const rows = await ctx.deps.archivesStore.listCompletedAssets(meeting.meetingId, meeting.subMeetingId)
  const assets: Asset[] = []
  for (const row of rows) {
    const parsed = parseAssetId(row.assetId ?? '')
    if (parsed === null) {
      console.warn(
        `[meetings] meeting_assets (${row.meetingId}/${row.subMeetingId}/${row.assetType}/${row.remoteId}) ` +
          `的 asset_id 为空或不合法，无法签发下载地址，已从清单里略过`,
      )
      continue
    }
    assets.push({
      assetId: row.assetId!,
      meetingId: row.meetingId,
      subMeetingId: row.subMeetingId,
      assetType: parsed.assetType,
      recordFileId: row.remoteId,
      fileType: row.fileType,
      bytesExpected: row.bytesExpected,
      allowDownload: true,
    })
  }
  return assets
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
 * 读的是 `meeting_cache`，即**调度器已经存下来的会议**，不是腾讯此刻有的会议
 * （见 store/stored-records.ts）：上线前 24 小时以前的会议要靠调度器补跑窗口才会出现。
 * 未传 from/to 时默认最近 31 天。
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
    if (err instanceof MeetingNotFoundInRangeError) return meetingNotFound(err)
    throw err
  }

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

  const meeting = await resolveMeeting(req, ctx, now)
  if (meeting instanceof Response) return meeting

  // 整场会议只判一次：可见性与「哪几类资产能列出来」用的是**同一个判定结果**。
  // 判两次不只是多花一次查询——两次之间规则若被改动，就会出现「会议可见但
  // 资产清单是空的」这种自相矛盾的响应。
  const decision = await decideMeeting(ctx, auth.identity, meeting, now)
  if (!isVisible(decision)) {
    // 与 resolveMeeting 点不中时的响应在形状与措辞上都不可区分
    return storedMeetingNotFound(req, ctx.params.meetingId!)
  }

  const assets = await storedAssets(ctx, meeting)
  const visibleAssets = filterAssetsByDecision(decision, assets)
  await ctx.deps.auditRecorder.recordListing(auth.identity, 1)

  return json(200, { ...meetingToJson(meeting), assets: visibleAssets.map(assetToJson) })
}

/**
 * GET /api/v1/meetings/:meetingId/assets?sub_meeting_id=&from=&to=
 *
 * 场次的挑选与 `getMeeting` 同一口径（`resolveMeeting`）：`sub_meeting_id` 给了就
 * 取那一条录制记录，不给取最新一条，点不中回 404 meeting_not_found_in_range。
 */
export async function listAssets(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = requireAuth(req, ctx.deps.jwtSecret, now)
  if (!auth.ok) return auth.response

  const meeting = await resolveMeeting(req, ctx, now)
  if (meeting instanceof Response) return meeting

  const assets = await storedAssets(ctx, meeting)
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

  // 判定通过才去看盘上有没有：先查文件再判定，会让 404/403 的先后把「资产存不存在」
  // 泄露给无权者
  const located = await ctx.deps.archivesStore.findCompletedAssetByAssetId(assetId)
  if (located === null) return json(404, { error: 'asset_not_found' })

  // 地址指回网关自己（见 assetContent）。令牌放在查询串里，是因为引擎下载器拿到
  // 这条 URL 后只会加一个 Range 头，与腾讯 CDN 直链同一种用法
  const token = signDownloadToken(assetId, ctx.deps.jwtSecret, now)
  return json(200, {
    url: `${ctx.deps.gatewayBaseUrl}/api/v1/assets/${encodeURIComponent(assetId)}/content?token=${token}`,
    expires_at: now + DOWNLOAD_TOKEN_TTL_SEC,
  })
}

/**
 * GET /api/v1/assets/:assetId/content?token=
 *
 * 采集程序拿 download-url 给的地址来这里取字节。**不走 Bearer**：引擎下载器
 * （packages/engine/src/downloader）只 `fetch(url, { headers: { range } })`，凭证
 * 只能在 URL 里。令牌证明了「网关签发、给这一个资产、未过期」，策略判定在
 * download-url 那一步已经做过。
 *
 * 文件先找本地归档（`meeting_assets.target_path`，相对 MDE_ARCHIVE_ROOT），本地
 * 被保留策略清掉后回退 NAS（`archived_assets.nas_path`，相对 MDE_NAS_ROOT）。两处
 * 都做根目录包含检查：路径来自库，库里一条写坏的记录不该能读到根目录之外。
 *
 * Range 语义与管理端媒体流（handlers/console/media.ts）同一套：引擎断点续传靠
 * 206 + Content-Range，起点越界回 416 让它丢掉 .part 重来。
 */
export async function assetContent(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const assetId = ctx.params.assetId!
  // 令牌指向的资产必须就是路径上这一个：否则一张合法令牌能换着路径读别的文件
  if (verifyDownloadToken(token, ctx.deps.jwtSecret, now) !== assetId) return json(403, { error: 'forbidden' })

  const localRoot = ctx.deps.localArchiveRoot
  if (localRoot === null) return json(503, { error: 'archive_root_unconfigured' })

  const located = await ctx.deps.archivesStore.findCompletedAssetByAssetId(assetId)
  if (located === null) return json(404, { error: 'asset_not_found' })

  const candidates: Array<{ root: string; path: string }> = [{ root: localRoot, path: located.targetPath }]
  if (located.nasPath !== null && ctx.deps.nasRoot !== null) {
    candidates.push({ root: ctx.deps.nasRoot, path: located.nasPath })
  }

  let abs: string | null = null
  let size = 0
  for (const c of candidates) {
    const candidate = resolve(c.root, c.path)
    if (!isInsideRoot(c.root, candidate)) {
      // 路径只进日志不进响应：对调用方它就是没有这个资产
      console.warn(`[assets] 拒绝越界读取：${assetId} 的记录路径解析为 ${candidate}，不在 ${resolve(c.root)} 之内`)
      continue
    }
    try {
      const st = await stat(candidate)
      if (!st.isFile()) continue
      abs = candidate
      size = st.size
      break
    } catch {
      continue
    }
  }
  if (abs === null) return json(404, { error: 'asset_not_found' })

  const range = parseRange(req.headers.get('range'), size)
  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
    })
  }
  const start = range.kind === 'full' ? 0 : range.start
  const end = range.kind === 'full' ? size - 1 : range.end
  const headers = new Headers({
    'content-type': Bun.file(abs).type,
    'accept-ranges': 'bytes',
    'content-length': String(end - start + 1),
    'cache-control': 'private, no-store',
  })
  if (range.kind === 'partial') headers.set('content-range', `bytes ${start}-${end}/${size}`)

  // slice 出来的是惰性 Blob，录像几个 GB 也不进内存；end 是闭区间，slice 第二参是开区间
  return new Response(Bun.file(abs).slice(start, end + 1), {
    status: range.kind === 'partial' ? 206 : 200,
    headers,
  })
}
