import { sign } from '../../src/tencent/signer'
import type { RawAddressFile } from '../../src/tencent/addresses'

/**
 * fixture 的规范形状。主持人字段沿用 `host_user_id` 只是 fixture 自己的命名，
 * **不是任何一个接口的 wire 形状**：网关唯一会调的会议列表接口
 * `/v1/corp/records` 把主持人放在 `userid`，转换在下面的 `toCorpShape()` 里做。
 *
 * 两者故意不同名，这样「实现照搬了 host_user_id」这个 bug 在假服务这一侧就蒙混
 * 不过去——主持人会静默变成 undefined，而那正是 M3.5 栽过的那一类故障。
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
  /** GET /v1/smart/minutes/:id 的 markdown；没登记的文件回 500182 */
  smartMinutesByFileId: Map<string, string>
  /** GET /v1/smart/chapters?record_file_id= 的原始章节；没登记的文件回 500182 */
  smartChaptersByFileId: Map<string, Array<{ chapter_id: string; chapter_name: string; start_time: string; pic_url?: string }>>
}

export function createFakeTencentState(): FakeTencentState {
  return {
    records: [],
    addressesByRecordId: new Map(),
    smartMinutesByFileId: new Map(),
    smartChaptersByFileId: new Map(),
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
 * 假腾讯会议服务：只实现网关实际会用到的端点——`/v1/corp/records`、
 * `/v1/addresses`、`/v1/smart/minutes/:id`、`/v1/smart/chapters`——返回固定
 * fixture，但对每一个到达的请求都用 src/tencent/signer.ts 的同一套算法重新计算一遍
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

      // `/v1/records`（用户维度）是**陷阱**，不是端点。
      //
      // 网关已经把它整条删掉了（见 src/tencent/records.ts 的文件头）：它只返回
      // operator 自己主持的会议，2026-08-27 靠它做精确查询当场炸出一个 P0——
      // 拉到别人主持的会议就抛 MeetingNotFoundInRangeError，整轮 worker 中止。
      //
      // 这里返回错误而不是删掉分支：万一哪天有人把这条路加回来，测试要在**这一刻**
      // 红，而不是因为假服务恰好也不认识这个路径、返回 404、被当成别的毛病。
      if (req.method === 'GET' && url.pathname === '/v1/records') {
        return Response.json(
          errorEnvelope(
            -1,
            'fake-tencent: /v1/records is gone — it only ever returns the operator\'s own ' +
              'meetings. Every meeting lookup, range or exact, must go through /v1/corp/records.',
          ),
          { status: 400 },
        )
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

      // 智能录制管理两个接口。**没登记的文件一律 500182**，与真平台一致：
      // 「该文件未打开智能录制开关」是常态，不是故障——catalog 把它当成
      // 「这一类不存在」，而不是让整轮 listAssets 失败。
      if (req.method === 'GET' && url.pathname.startsWith('/v1/smart/minutes/')) {
        const fileId = decodeURIComponent(url.pathname.slice('/v1/smart/minutes/'.length))
        const md = state.smartMinutesByFileId.get(fileId)
        if (md === undefined) return Response.json(errorEnvelope(500182, '该文件未打开智能录制开关，请联系文件所有者'), { status: 400 })
        return Response.json({ meeting_minute: { minute: md, todo: '' } })
      }

      if (req.method === 'GET' && url.pathname === '/v1/smart/chapters') {
        const fileId = url.searchParams.get('record_file_id') ?? ''
        const list = state.smartChaptersByFileId.get(fileId)
        if (list === undefined) return Response.json(errorEnvelope(500182, '该文件未打开智能录制开关，请联系文件所有者'), { status: 400 })
        return Response.json({ chapter_list: list })
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
