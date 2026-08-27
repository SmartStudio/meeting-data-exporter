import { sign } from '../../src/tencent/signer'
import type { RawAddressFile } from '../../src/tencent/addresses'
import type { RawDetail } from '../../src/catalog/assets'

/**
 * fixture 的规范形状，字段名与 `/v1/records`（用户维度）的响应一致——
 * src/tencent/records.ts 内部的 `RawUserRecordMeeting` 未导出（属实现细节），
 * 故这里按平台响应形状重新声明一份。
 *
 * `/v1/corp/records`（企业维度）的响应由同一份 fixture 转换而来：那个接口的
 * 主持人字段叫 **`userid`** 而不是 `host_user_id`，转换在下面的 `toCorpShape()`
 * 里做——两个接口 wire 形状不同这件事，假服务这一侧也要如实反映。
 */
export interface FakeRecordMeeting {
  meeting_record_id: string
  meeting_id: string
  meeting_code: string
  host_user_id: string
  /** 毫秒级时间戳（与平台一致），src/tencent/records.ts 内部会做 msToSec 转换 */
  media_start_time: number
  subject: string
  /** 平台枚举：1 录制中 / 2 转码中 / 3 转码完成 */
  state: number
}

export interface FakeTencentCredentials {
  secretId: string
  secretKey: string
}

/**
 * 可变 fixture 存储：测试用例在服务器启动后仍可以继续往里追加/修改数据
 * （例如先注册会议，再单独为其下的某个 record_file 补充详情），
 * 因为这些字段都是同一个引用对象上的可变容器。
 */
export interface FakeTencentState {
  records: FakeRecordMeeting[]
  addressesByRecordId: Map<string, RawAddressFile[]>
  addressDetailByFileId: Map<string, RawDetail>
  /** POST /v1/app/sts-token 的固定返回值——真实平台是异步下发，这里的 req_id 由用例自行选定 */
  stsReqId: string
}

export function createFakeTencentState(): FakeTencentState {
  return {
    records: [],
    addressesByRecordId: new Map(),
    addressDetailByFileId: new Map(),
    stsReqId: 'req-fake-default',
  }
}

export interface FakeTencentRequestLogEntry {
  method: string
  path: string
  /** 该请求的签名是否通过重算校验；用于断言"签名校验确实在发挥作用"而非空判断 */
  signatureValid: boolean
}

export interface FakeTencentServer {
  /** 供测试装配 TencentClientConfig.baseUrl 使用 */
  url: string
  /** 每一条到达的请求（无论签名是否通过），供测试断言真实调用了哪些端点、调用了几次 */
  requestLog: FakeTencentRequestLogEntry[]
  stop(): void
}

/** 与 src/tencent/errors.ts 的 FATAL 分类一致：签名错误应立即失败，不建议重试 */
const SIGNATURE_ERROR_CODE = 9042

function errorEnvelope(code: number, message: string): { error_info: { error_code: number; message: string } } {
  return { error_info: { error_code: code, message } }
}

/**
 * 把一条 fixture 转成 `/v1/corp/records` 的响应形状：主持人字段改名为 `userid`，
 * 且**不带** `host_user_id`——留着它会让「实现照搬了旧字段名」的 bug 在这里蒙混过关。
 */
function toCorpShape(r: FakeRecordMeeting): Record<string, unknown> {
  const { host_user_id: host, ...rest } = r
  return { ...rest, userid: host }
}

/**
 * 假腾讯会议服务：只实现网关实际会用到的五个端点——`/v1/records`、
 * `/v1/corp/records`、`/v1/addresses`、`/v1/addresses/:id`、`/v1/app/sts-token`——返回固定 fixture，
 * 但对每一个到达的请求都用 src/tencent/signer.ts 的同一套算法重新计算一遍
 * 签名，不匹配就返回 9042（与真实平台在 src/tencent/errors.ts 里的 FATAL
 * 分类一致：配置/签名问题重试无意义，应立即失败）。
 *
 * 这不是装饰性检查：如果这里被写成无条件放行，端到端测试就无法真正覆盖
 * signer.ts 的正确性——网关会用错误的签名发起请求而完全不自知。
 */
export function startFakeTencentServer(
  creds: FakeTencentCredentials,
  state: FakeTencentState,
): FakeTencentServer {
  const requestLog: FakeTencentRequestLogEntry[] = []

  function isValidSignature(method: string, headers: Headers, url: URL, rawBody: string): boolean {
    if (method !== 'GET' && method !== 'POST') return false

    const secretId = headers.get('x-tc-key')
    const nonce = headers.get('x-tc-nonce')
    const timestamp = headers.get('x-tc-timestamp')
    const signature = headers.get('x-tc-signature')
    if (!secretId || !nonce || !timestamp || !signature) return false
    if (secretId !== creds.secretId) return false

    const expected = sign({
      secretId: creds.secretId,
      secretKey: creds.secretKey,
      method,
      nonce,
      timestamp,
      // buildUrl() 把完整查询串编入 url 本身（见 src/tencent/url.ts 的注释：
      // 参与签名的 URI 必须与实际请求 URL 逐字节一致），因此这里直接复用
      // 服务端收到的 pathname + search，天然与客户端签名时使用的一致。
      requestUri: `${url.pathname}${url.search}`,
      body: rawBody,
    })
    return expected === signature
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const rawBody = req.method === 'POST' ? await req.text() : ''
      const valid = isValidSignature(req.method, req.headers, url, rawBody)
      requestLog.push({ method: req.method, path: url.pathname, signatureValid: valid })

      if (!valid) {
        return Response.json(errorEnvelope(SIGNATURE_ERROR_CODE, 'signature mismatch'), { status: 401 })
      }

      if (req.method === 'GET' && url.pathname === '/v1/records') {
        const meetingId = url.searchParams.get('meeting_id')
        const meetingCode = url.searchParams.get('meeting_code')
        const startTimeSec = Number(url.searchParams.get('start_time'))
        const endTimeSec = Number(url.searchParams.get('end_time'))

        let matched = state.records.filter(
          (r) => r.media_start_time >= startTimeSec * 1000 && r.media_start_time <= endTimeSec * 1000,
        )
        if (meetingId) matched = matched.filter((r) => r.meeting_id === meetingId)
        if (meetingCode) matched = matched.filter((r) => r.meeting_code === meetingCode)

        return Response.json({ total_page: 1, record_meetings: matched })
      }

      if (req.method === 'GET' && url.pathname === '/v1/corp/records') {
        // 这个接口**没有** meeting_id / meeting_code 参数。假服务在这里比真平台更严：
        // 带了就报错，而不是默默忽略——否则「精确查询误走了企业维度接口」这种回归
        // 会表现为「返回了全公司的会议」，而不是一个当场可见的失败。
        if (url.searchParams.get('meeting_id') || url.searchParams.get('meeting_code')) {
          return Response.json(
            errorEnvelope(-1, 'fake-tencent: /v1/corp/records has no meeting_id/meeting_code param'),
            { status: 400 },
          )
        }
        // 同样比真平台严：query_record_type 不显式传时，真平台按 **1（只有云录制）**
        // 处理，会静默漏掉上传录制与客户端录制。漏传是要在测试里当场暴露的错误。
        if (url.searchParams.get('query_record_type') === null) {
          return Response.json(
            errorEnvelope(-1, 'fake-tencent: /v1/corp/records requires an explicit query_record_type'),
            { status: 400 },
          )
        }

        const startTimeSec = Number(url.searchParams.get('start_time'))
        const endTimeSec = Number(url.searchParams.get('end_time'))
        const matched = state.records.filter(
          (r) => r.media_start_time >= startTimeSec * 1000 && r.media_start_time <= endTimeSec * 1000,
        )
        return Response.json({ total_page: 1, record_meetings: matched.map(toCorpShape) })
      }

      if (req.method === 'GET' && url.pathname === '/v1/addresses') {
        const recordId = url.searchParams.get('meeting_record_id')
        const files = (recordId ? state.addressesByRecordId.get(recordId) : undefined) ?? []
        return Response.json({ total_page: 1, record_files: files })
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/addresses/')) {
        const fileId = decodeURIComponent(url.pathname.slice('/v1/addresses/'.length))
        const detail: RawDetail = state.addressDetailByFileId.get(fileId) ?? { record_file_id: fileId }
        return Response.json(detail)
      }

      if (req.method === 'POST' && url.pathname === '/v1/app/sts-token') {
        return Response.json({ req_id: state.stsReqId })
      }

      return Response.json(errorEnvelope(-1, `fake-tencent: unhandled endpoint ${url.pathname}`), { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requestLog,
    stop: () => server.stop(true),
  }
}
