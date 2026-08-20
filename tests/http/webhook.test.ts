import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createCipheriv, createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp, WEBHOOK_AES_KEY, WEBHOOK_TOKEN } from './testApp'
import { StsTokenUnavailableError } from '../../src/sts/manager'

let pool: Pool
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  pool = db.pool
  cleanup = db.cleanup
})
afterAll(() => cleanup())

const NOW = 1_700_000_000

/** 复刻 tests/sts/crypto.test.ts 的签名算法，webhook 测试需要构造合法请求 */
function makeSig(token: string, ts: string, nonce: string, data: string): string {
  return createHash('sha1').update([token, ts, nonce, data].sort().join('')).digest('hex')
}

/** AES-256-CBC + PKCS#7，key 前 16 字节作 IV（官方《事件加解密》） */
function encryptRaw(aesKey: string, plain: Buffer): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

/** 官方明文结构：`msg + $key`——JSON 之后直接拼 $key，无 16+4 字节前缀 */
function encryptEvent(aesKey: string, json: string): string {
  return encryptRaw(aesKey, Buffer.from(`${json}TailKey0123456789`, 'utf8'))
}

function stsEventJson(reqId: string, stsToken: string, expireTs: number): string {
  return JSON.stringify({
    event: 'common.sts-token',
    trace_id: 'trace-1',
    payload: [
      {
        operate_time: NOW * 1000,
        operator: { userid: 'operator-1', user_name: 'operator' },
        token_info: { req_id: reqId, sts_token: stsToken, expire_ts: expireTs },
      },
    ],
  })
}

/**
 * 按腾讯官方《回调服务要求》构造 POST 回调：三个验签参数在 **Header**，
 * 密文在 body 的 **`data`** 字段。
 */
function webhookRequest(opts: {
  timestamp?: string
  nonce?: string
  signature?: string
  encrypted: string
}): Request {
  const timestamp = opts.timestamp ?? String(NOW)
  const nonce = opts.nonce ?? 'nonce-1'
  return new Request('https://gw/webhook/tencent-meeting', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      timestamp,
      nonce,
      signature: opts.signature ?? makeSig(WEBHOOK_TOKEN, timestamp, nonce, opts.encrypted),
    },
    body: JSON.stringify({ data: opts.encrypted }),
  })
}

async function seedPendingRequest(reqId: string, requestedAt = NOW): Promise<void> {
  await pool.execute(
    `INSERT INTO sts_token_requests (req_id, state, requested_at) VALUES (?, 'pending', ?)`,
    [reqId, requestedAt],
  )
}

test('验签失败返回 401 且不改变 token 状态', async () => {
  const { app, deps } = buildTestApp(pool, { now: () => NOW })
  await seedPendingRequest('req-bad-sig')

  const encrypted = encryptEvent(WEBHOOK_AES_KEY, stsEventJson('req-bad-sig', 'tok-bad-sig', NOW + 3600))
  const req = webhookRequest({ encrypted, signature: 'not-the-real-signature' })

  const res = await app(req)
  expect(res.status).toBe(401)
  expect((await res.json()).error).toBe('verification_failed')

  // 状态未被改变：仍是 pending，getToken 依旧不可用
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT state, token_cipher FROM sts_token_requests WHERE req_id = ?',
    ['req-bad-sig'],
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]!.state).toBe('pending')
  expect(rows[0]!.token_cipher).toBeNull()

  await expect(deps.stsManager.getToken(NOW + 10)).rejects.toThrow(StsTokenUnavailableError)
})

test('篡改密文同样返回 401 且不落库（signature 是对密文算的，篡改密文即让签名失配）', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  await seedPendingRequest('req-tampered')

  const encrypted = encryptEvent(WEBHOOK_AES_KEY, stsEventJson('req-tampered', 'tok-tampered', NOW + 3600))
  const timestamp = String(NOW)
  const nonce = 'nonce-tampered'
  const validSig = makeSig(WEBHOOK_TOKEN, timestamp, nonce, encrypted)

  const req = new Request('https://gw/webhook/tencent-meeting', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      timestamp,
      nonce,
      signature: validSig,
    },
    body: JSON.stringify({ data: `${encrypted}TAMPERED` }),
  })

  const res = await app(req)
  expect(res.status).toBe(401)

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT state FROM sts_token_requests WHERE req_id = ?',
    ['req-tampered'],
  )
  expect(rows[0]!.state).toBe('pending')
})

test('header 与 query 都没有 timestamp/nonce/signature 时返回 401，不尝试处理请求体', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw/webhook/tencent-meeting', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'whatever' }),
    }),
  )
  expect(res.status).toBe(401)
})

test('验签通过后 token 落库', async () => {
  const { app, deps } = buildTestApp(pool, { now: () => NOW })
  await seedPendingRequest('req-ok-1')

  const encrypted = encryptEvent(WEBHOOK_AES_KEY, stsEventJson('req-ok-1', 'tok-ok-1', NOW + 3600))
  const req = webhookRequest({ encrypted })

  const res = await app(req)
  expect(res.status).toBe(200)
  // 官方要求响应体逐字为该字符串，不能带引号/换行——返回 JSON 会被腾讯判为失败并重试三次
  expect(await res.text()).toBe('successfully received callback')
  expect(res.headers.get('content-type')).toContain('text/plain')

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT state FROM sts_token_requests WHERE req_id = ?',
    ['req-ok-1'],
  )
  expect(rows[0]!.state).toBe('fulfilled')

  expect(await deps.stsManager.getToken(NOW + 10)).toBe('tok-ok-1')
})

test('重复投递同一 req_id 幂等：两次都成功且状态一致', async () => {
  const { app, deps } = buildTestApp(pool, { now: () => NOW })
  await seedPendingRequest('req-dup-1')

  // expire_ts 故意取一个比本文件其它测试更晚的值：sts_token_requests 表在
  // 整个测试文件内共享（withTestDb 每个文件一个隔离库，但文件内的多个 test
  // 共用同一个库），getActive() 语义是"返回过期最晚的一条"，必须让本测试
  // 写入的 token 明显晚于其它测试写入的，才能确定 getToken() 读到的就是它。
  const encrypted = encryptEvent(WEBHOOK_AES_KEY, stsEventJson('req-dup-1', 'tok-dup-1', NOW + 99_000))
  const timestamp = String(NOW)
  const nonce = 'nonce-dup'
  const signature = makeSig(WEBHOOK_TOKEN, timestamp, nonce, encrypted)

  const makeReq = (): Request =>
    new Request('https://gw/webhook/tencent-meeting', {
      method: 'POST',
      headers: { 'content-type': 'application/json', timestamp, nonce, signature },
      body: JSON.stringify({ data: encrypted }),
    })

  const first = await app(makeReq())
  expect(first.status).toBe(200)

  const second = await app(makeReq())
  expect(second.status).toBe(200)

  expect(await deps.stsManager.getToken(NOW + 10)).toBe('tok-dup-1')

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT state FROM sts_token_requests WHERE req_id = ?',
    ['req-dup-1'],
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]!.state).toBe('fulfilled')
})

test('未知 req_id（网关这边没有对应的待处理申请）时 handleWebhook 抛错，路由层映射为 500 而非静默吞掉', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const encrypted = encryptEvent(WEBHOOK_AES_KEY, stsEventJson('req-unknown', 'tok-x', NOW + 3600))
  const req = webhookRequest({ encrypted })

  const res = await app(req)
  // 这不是验签失败（签名是合法的），而是配对失败——store.fulfill 对未知 req_id 抛出
  // 普通 Error，路由层没有为它定义专门语义，走兜底 500。记录这个行为而非让它悄悄
  // 变成一个看似成功的 200。
  expect(res.status).toBe(500)
})

// ---------------------------------------------------------------------------
// GET：事件订阅配置时的 URL 有效性校验
// 官方《回调服务要求》：GET ?check_str=... + Header 三参数 → 验签 → 解密 →
// 3 秒内以纯文本回显明文。没有它，腾讯后台连事件订阅都保存不上。
// ---------------------------------------------------------------------------

const CHALLENGE = 'Ru1kR4nd0mCheckString-2026'

function makeCheckStr(plain = CHALLENGE): string {
  return encryptRaw(WEBHOOK_AES_KEY, Buffer.from(plain, 'utf8'))
}

function verifyRequest(opts: {
  checkStrRaw: string
  timestamp?: string
  nonce?: string
  signature?: string
  /** 签名针对哪个字符串计算；默认与 checkStrRaw 相同 */
  signOver?: string
}): Request {
  const timestamp = opts.timestamp ?? String(NOW)
  const nonce = opts.nonce ?? 'nonce-verify'
  const signature =
    opts.signature ?? makeSig(WEBHOOK_TOKEN, timestamp, nonce, opts.signOver ?? opts.checkStrRaw)
  return new Request(`https://gw/webhook/tencent-meeting?check_str=${opts.checkStrRaw}`, {
    method: 'GET',
    headers: { timestamp, nonce, signature },
  })
}

test('GET URL 校验：验签通过后以纯文本回显解密明文', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const checkStr = makeCheckStr()

  const res = await app(
    verifyRequest({ checkStrRaw: encodeURIComponent(checkStr), signOver: checkStr }),
  )

  expect(res.status).toBe(200)
  expect(await res.text()).toBe(CHALLENGE)
  expect(res.headers.get('content-type')).toContain('text/plain')
})

/**
 * base64 密文里可能含 `+`。若腾讯不对它做百分号转义，`URLSearchParams` 会把 `+`
 * 解成空格从而毁掉密文——实现因此把「原始未解码值」也列为候选交给验签裁决。
 * 这里构造一个必定含 `+` 的密文来锁定该行为。
 */
test('GET URL 校验：check_str 含未转义的 + 时，原始值候选仍能通过', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })

  let checkStr = ''
  for (let i = 0; i < 200 && !checkStr.includes('+'); i++) {
    checkStr = makeCheckStr(`${CHALLENGE}-${i}`)
  }
  expect(checkStr).toContain('+')

  // 未做任何转义地拼进 query：URLSearchParams 解出来的值里 '+' 会变成空格
  const res = await app(verifyRequest({ checkStrRaw: checkStr }))

  expect(res.status).toBe(200)
  expect(await res.text()).toContain(CHALLENGE)
})

test('GET URL 校验：签名不匹配返回 401，不回显任何内容', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const checkStr = encodeURIComponent(makeCheckStr())

  const res = await app(verifyRequest({ checkStrRaw: checkStr, signature: 'not-the-real-signature' }))

  expect(res.status).toBe(401)
  expect((await res.json()).error).toBe('verification_failed')
})

test('GET URL 校验：缺少 check_str 返回 401', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw/webhook/tencent-meeting', {
      method: 'GET',
      headers: { timestamp: String(NOW), nonce: 'n', signature: 'whatever' },
    }),
  )
  expect(res.status).toBe(401)
})

test('POST 回退：三参数在 query 而非 header 时依然可用（文档与实际不符时的安全网）', async () => {
  const { app, deps } = buildTestApp(pool, { now: () => NOW })
  await seedPendingRequest('req-query-fallback')

  const encrypted = encryptEvent(
    WEBHOOK_AES_KEY,
    stsEventJson('req-query-fallback', 'tok-query-fallback', NOW + 111_000),
  )
  const timestamp = String(NOW)
  const nonce = 'nonce-query-fallback'
  const url = new URL('https://gw/webhook/tencent-meeting')
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('signature', makeSig(WEBHOOK_TOKEN, timestamp, nonce, encrypted))

  const res = await app(
    new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: encrypted }),
    }),
  )

  expect(res.status).toBe(200)
  expect(await res.text()).toBe('successfully received callback')
  expect(await deps.stsManager.getToken(NOW + 10)).toBe('tok-query-fallback')
})

/**
 * 另一种可能：腾讯对**线路上的编码形态**签名，而密文需要解码后才能用。
 * 若把「验签用哪个」与「解密用哪个」绑成同一个值，这种组合会出现
 * 「验签通过但解密失败」——候选拆成配对就是为了覆盖它。
 */
test('GET URL 校验：签名算的是编码后形态、密文是解码后形态时也能通过', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const checkStr = makeCheckStr()
  const wire = encodeURIComponent(checkStr)

  const res = await app(verifyRequest({ checkStrRaw: wire, signOver: wire }))

  expect(res.status).toBe(200)
  expect(await res.text()).toBe(CHALLENGE)
})
