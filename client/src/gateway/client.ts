import type { Meeting, MeetingSelector, AssetSource, SourceAsset, DownloadUrl } from '@yaowu/mde-engine'

export class GatewayError extends Error {
  constructor(readonly httpStatus: number, readonly code: string, msg?: string) {
    super(msg ?? `gateway error ${httpStatus}: ${code}`); this.name = 'GatewayError'
  }
}
export class MeetingNotFoundInRangeError extends Error {
  constructor() { super('meeting not found in range'); this.name = 'MeetingNotFoundInRangeError' }
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
  async function parseError(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (body.error === 'meeting_not_found_in_range') throw new MeetingNotFoundInRangeError()
    throw new GatewayError(res.status, body.error ?? 'unknown')
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
    async listAssets(meetingId, from, to) {
      const q = new URLSearchParams(); if (from) q.set('from', String(from)); if (to) q.set('to', String(to))
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

interface RawMeeting { meeting_id: string; sub_meeting_id?: string; meeting_code?: string; subject?: string; host_user_id?: string; start_time?: number; end_time?: number }
interface RawAsset { asset_id: string; asset_type: string; remote_id?: string; state?: number; allow_download?: boolean; file_type?: string | null; bytes_expected?: number | null }
function toMeeting(r: RawMeeting): Meeting {
  return { meetingId: r.meeting_id, subMeetingId: r.sub_meeting_id ?? '', meetingCode: r.meeting_code ?? null, subject: r.subject ?? null, hostUserId: r.host_user_id ?? null, startTime: r.start_time ?? null, endTime: r.end_time ?? null }
}
