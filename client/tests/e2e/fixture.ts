/**
 * 端到端假后端：一个假网关（auth/meetings/assets/download-url）+ 一个字节服务器（支持 Range，
 * 可对指定 assetId 注入若干次 403，用于模拟链接过期）。均以 port:0 启动，测试结束需调用 stop()。
 *
 * 字段名严格对齐 client/src/gateway/client.ts 的线上契约（snake_case 请求体/响应体）。
 */

export interface RawMeeting {
  meeting_id: string
  sub_meeting_id?: string
  meeting_code?: string
  subject?: string
  host_user_id?: string
  start_time?: number
  end_time?: number
}
export interface RawAsset {
  asset_id: string
  asset_type: string
  remote_id?: string
  state?: number
  allow_download?: boolean
  file_type?: string | null
  bytes_expected?: number | null
}

export interface FakeBackendCalls {
  token: number
  /** 每次 /api/v1/meetings 请求看到的 `${from}-${to}` 窗口（用于验证 31 天切分） */
  meetingsWindows: Set<string>
  /** 每次 /assets 请求命中的 meetingId 序列 */
  assets: string[]
  /** 每个 assetId 的 /download-url 调用次数（用于验证链接过期后的换链） */
  downloadUrl: Map<string, number>
  /** 每个 assetId 在字节服务器上的命中次数（任意状态码，用于验证幂等零下载） */
  byteHits: Map<string, number>
  /** 每个 assetId 在字节服务器上收到的 Range 请求起始偏移序列（用于验证续传/416） */
  byteRangeStarts: Map<string, number[]>
}

export interface FakeBackend {
  gatewayBase: string
  byteBase: string
  calls: FakeBackendCalls
  setMeetings(list: RawMeeting[]): void
  setAssets(meetingId: string, assets: RawAsset[]): void
  setContent(assetId: string, bytes: Uint8Array<ArrayBuffer>): void
  /** 接下来 n 次对该 assetId 的字节服务器请求返回 403（模拟下载链接过期） */
  setFlaky(assetId: string, failCount: number): void
  /** 首个签发的 access_token 在下一次业务调用中被拒一次（401），之后正常——用于验证透明续期 */
  expireFirstTokenOnce(): void
  stop(): void
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function startFakeBackend(opts: { tokenExpiresIn?: number } = {}): FakeBackend {
  const tokenExpiresIn = opts.tokenExpiresIn ?? 3600

  let meetings: RawMeeting[] = []
  const assetsByMeeting = new Map<string, RawAsset[]>()
  const contents = new Map<string, Uint8Array<ArrayBuffer>>()
  const flaky = new Map<string, number>()

  let firstToken: string | null = null
  let firstTokenRejected = false
  let expireOnce = false

  const calls: FakeBackendCalls = {
    token: 0,
    meetingsWindows: new Set(),
    assets: [],
    downloadUrl: new Map(),
    byteHits: new Map(),
    byteRangeStarts: new Map(),
  }

  function checkAuth(req: Request): Response | null {
    const header = req.headers.get('authorization') ?? ''
    const bearer = header.replace(/^Bearer\s+/, '')
    if (expireOnce && firstToken !== null && bearer === firstToken && !firstTokenRejected) {
      firstTokenRejected = true
      return json({ error: 'token_expired' }, 401)
    }
    return null
  }

  const gatewayServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const pathname = url.pathname

      if (req.method === 'POST' && pathname === '/api/v1/auth/service-token') {
        calls.token++
        const tok = `tok${calls.token}`
        if (calls.token === 1) firstToken = tok
        return json({ access_token: tok, expires_in: tokenExpiresIn })
      }

      if (req.method === 'GET' && pathname === '/api/v1/meetings') {
        const unauth = checkAuth(req); if (unauth) return unauth
        const q = url.searchParams
        const from = q.has('from') ? Number(q.get('from')) : undefined
        const to = q.has('to') ? Number(q.get('to')) : undefined
        const meetingCode = q.get('meeting_code') ?? undefined
        const meetingId = q.get('meeting_id') ?? undefined
        if (from !== undefined && to !== undefined) calls.meetingsWindows.add(`${from}-${to}`)
        let list = meetings
        if (meetingCode) list = list.filter((m) => m.meeting_code === meetingCode)
        else if (meetingId) list = list.filter((m) => m.meeting_id === meetingId)
        else if (from !== undefined && to !== undefined) list = list.filter((m) => { const st = m.start_time ?? 0; return st >= from && st < to })
        return json({ meetings: list, next_cursor: null })
      }

      const assetsMatch = /^\/api\/v1\/meetings\/([^/]+)\/assets$/.exec(pathname)
      if (req.method === 'GET' && assetsMatch) {
        const unauth = checkAuth(req); if (unauth) return unauth
        const meetingId = decodeURIComponent(assetsMatch[1]!)
        calls.assets.push(meetingId)
        return json({ assets: assetsByMeeting.get(meetingId) ?? [] })
      }

      const dlMatch = /^\/api\/v1\/assets\/([^/]+)\/download-url$/.exec(pathname)
      if (req.method === 'POST' && dlMatch) {
        const unauth = checkAuth(req); if (unauth) return unauth
        const assetId = decodeURIComponent(dlMatch[1]!)
        const n = (calls.downloadUrl.get(assetId) ?? 0) + 1
        calls.downloadUrl.set(assetId, n)
        const content = contents.get(assetId)
        return json({
          url: `${byteBase()}/blob?id=${encodeURIComponent(assetId)}&v=${n}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          file_type: null,
          bytes_expected: content ? content.length : null,
        })
      }

      return json({ error: 'not_found' }, 404)
    },
  })

  const byteServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/blob') return new Response('not found', { status: 404 })
      const id = url.searchParams.get('id') ?? ''
      calls.byteHits.set(id, (calls.byteHits.get(id) ?? 0) + 1)
      const content = contents.get(id)
      if (!content) return new Response('unknown asset', { status: 404 })

      const failLeft = flaky.get(id) ?? 0
      if (failLeft > 0) { flaky.set(id, failLeft - 1); return new Response('link expired', { status: 403 }) }

      const range = req.headers.get('range')
      if (range) {
        const m = /bytes=(\d+)-/.exec(range)
        const start = m ? Number(m[1]) : 0
        const starts = calls.byteRangeStarts.get(id) ?? []; starts.push(start); calls.byteRangeStarts.set(id, starts)
        if (start >= content.length) return new Response('range not satisfiable', { status: 416, headers: { 'content-range': `bytes */${content.length}` } })
        return new Response(content.slice(start), { status: 206, headers: { 'content-range': `bytes ${start}-${content.length - 1}/${content.length}` } })
      }
      return new Response(content, { status: 200 })
    },
  })

  function byteBase(): string { return `http://localhost:${byteServer.port}` }

  return {
    gatewayBase: `http://localhost:${gatewayServer.port}`,
    byteBase: byteBase(),
    calls,
    setMeetings(list) { meetings = list },
    setAssets(meetingId, assets) { assetsByMeeting.set(meetingId, assets) },
    setContent(assetId, bytes) { contents.set(assetId, bytes) },
    setFlaky(assetId, failCount) { flaky.set(assetId, failCount) },
    expireFirstTokenOnce() { expireOnce = true },
    stop() { gatewayServer.stop(true); byteServer.stop(true) },
  }
}
