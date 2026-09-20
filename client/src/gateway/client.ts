import type { Meeting, MeetingSelector, AssetSource, SourceAsset, DownloadUrl } from '@yaowu/mde-engine'

export class GatewayError extends Error {
  constructor(readonly httpStatus: number, readonly code: string, msg?: string) {
    super(msg ?? `gateway error ${httpStatus}: ${code}`); this.name = 'GatewayError'
  }
}
export class MeetingNotFoundInRangeError extends Error {
  constructor(msg?: string) { super(msg ?? 'meeting not found in range'); this.name = 'MeetingNotFoundInRangeError' }
}

export function createGatewayClient(
  cfg: { gatewayUrl: string; clientId: string; clientSecret: string },
  deps: { fetch: typeof fetch; now: () => number },
): AssetSource {
  let token: { value: string; expiresAt: number } | null = null

  async function fetchToken(): Promise<string> {
    const res = await deps.fetch(`${cfg.gatewayUrl}/api/v1/auth/service-token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    })
    if (!res.ok) throw new GatewayError(res.status, 'auth_failed')
    const body = (await res.json()) as { access_token: string; expires_in: number }
    token = { value: body.access_token, expiresAt: deps.now() + body.expires_in - 30 }
    return body.access_token
  }
  async function ensureToken(): Promise<string> {
    if (token && token.expiresAt > deps.now()) return token.value
    return fetchToken()
  }
  /** 带 Bearer 调用；遇 401 重取一次 token 后重试当次调用（透明续期） */
  async function authed(path: string, init?: RequestInit): Promise<Response> {
    let bearer = await ensureToken()
    let res = await deps.fetch(`${cfg.gatewayUrl}${path}`, withAuth(init, bearer))
    if (res.status === 401) { token = null; bearer = await fetchToken(); res = await deps.fetch(`${cfg.gatewayUrl}${path}`, withAuth(init, bearer)) }
    return res
  }
  function withAuth(init: RequestInit | undefined, bearer: string): RequestInit {
    return { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' } }
  }
  /**
   * 网关的错误体是 `{ error, message }` 两段：`error` 是**机器码**（分支判定用），
   * `message` 是**判定理由**（给人看的）。这里必须把 message 一并带上——丢掉它，
   * 终端上就只剩一句笼统的「meeting not found in range」，而网关那句话里恰恰
   * 写着这次判定是怎么来的：网关只读调度器存进 `meeting_cache` 的会议，不问腾讯
   * （见网关侧 store/stored-records.ts 的 STORED_LOOKUP_NOTE）。也就是说未命中
   * 是**调度器还没存这场会议**，加宽 --from/--to 没用，要让调度器补跑那段窗口。
   * 丢掉 message，使用者就无从知道该往哪个方向查。
   */
  async function parseError(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
    if (body.error === 'meeting_not_found_in_range') throw new MeetingNotFoundInRangeError(body.message)
    throw new GatewayError(res.status, body.error ?? 'unknown', body.message)
  }

  return {
    async listMeetings(sel, cursor, limit) {
      const q = new URLSearchParams()
      if (sel.kind === 'range') { q.set('from', String(sel.from)); q.set('to', String(sel.to)) }
      if (sel.kind === 'code') { q.set('meeting_code', sel.meetingCode); if (sel.from) q.set('from', String(sel.from)); if (sel.to) q.set('to', String(sel.to)) }
      if (sel.kind === 'id') { q.set('meeting_id', sel.meetingId); if (sel.from) q.set('from', String(sel.from)); if (sel.to) q.set('to', String(sel.to)) }
      if (cursor) q.set('cursor', cursor); if (limit) q.set('limit', String(limit))
      const res = await authed(`/api/v1/meetings?${q}`)
      if (!res.ok) return parseError(res)
      const b = (await res.json()) as { meetings: RawMeeting[]; next_cursor: string | null }
      return { meetings: b.meetings.map(toMeeting), nextCursor: b.next_cursor }
    },
    async listAssets(meetingId, subMeetingId, from, to) {
      const q = new URLSearchParams()
      // 空串不带这个参数：网关那边「没给」= 取最新一条，与旧客户端的行为一致
      if (subMeetingId) q.set('sub_meeting_id', subMeetingId)
      if (from) q.set('from', String(from)); if (to) q.set('to', String(to))
      const res = await authed(`/api/v1/meetings/${encodeURIComponent(meetingId)}/assets?${q}`)
      if (!res.ok) return parseError(res)
      const b = (await res.json()) as { assets: RawAsset[] }
      return b.assets.map((a) => ({ assetId: a.asset_id, assetType: a.asset_type, remoteId: a.remote_id ?? a.asset_id, state: a.state, allowDownload: a.allow_download, fileType: a.file_type ?? null, bytesExpected: a.bytes_expected ?? null }))
    },
    async getDownloadUrl(assetId) {
      const res = await authed(`/api/v1/assets/${encodeURIComponent(assetId)}/download-url`, { method: 'POST' })
      if (!res.ok) return parseError(res)
      const b = (await res.json()) as { url: string; expires_at: number; file_type?: string | null; bytes_expected?: number | null }
      return { url: b.url, expiresAt: b.expires_at, fileType: b.file_type ?? null, bytesExpected: b.bytes_expected ?? null }
    },
  }
}

interface RawMeeting { meeting_id: string; sub_meeting_id?: string; meeting_code?: string; subject?: string; record_type?: number; host_user_id?: string; start_time?: number; end_time?: number }
interface RawAsset { asset_id: string; asset_type: string; remote_id?: string; state?: number; allow_download?: boolean; file_type?: string | null; bytes_expected?: number | null }
function toMeeting(r: RawMeeting): Meeting {
  return { meetingId: r.meeting_id, subMeetingId: r.sub_meeting_id ?? '', meetingCode: r.meeting_code ?? null, subject: r.subject ?? null, recordType: r.record_type ?? null, hostUserId: r.host_user_id ?? null, startTime: r.start_time ?? null, endTime: r.end_time ?? null }
}
