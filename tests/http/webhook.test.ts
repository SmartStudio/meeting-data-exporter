import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
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

/** 复刻 tests/sts/crypto.test.ts 的加密算法（16 随机字节 + 4 字节大端长度 + JSON + 尾部） */
function encryptEvent(aesKey: string, json: string): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const msg = Buffer.from(json, 'utf8')
  const msgLen = Buffer.alloc(4)
  msgLen.writeUInt32BE(msg.length, 0)
  const plain = Buffer.concat([randomBytes(16), msgLen, msg, Buffer.from('tail-corpid', 'utf8')])
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
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

function webhookRequest(opts: {
  timestamp?: string
  nonce?: string
  signature?: string
  encrypted: string
}): Request {
  const timestamp = opts.timestamp ?? String(NOW)
  const nonce = opts.nonce ?? 'nonce-1'
  const url = new URL('https://gw/webhook/tencent-meeting')
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('signature', opts.signature ?? makeSig(WEBHOOK_TOKEN, timestamp, nonce, opts.encrypted))
  return new Request(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypt: opts.encrypted }),
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

  const url = new URL('https://gw/webhook/tencent-meeting')
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('signature', validSig)
  const req = new Request(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypt: `${encrypted}TAMPERED` }),
  })

  const res = await app(req)
  expect(res.status).toBe(401)

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT state FROM sts_token_requests WHERE req_id = ?',
    ['req-tampered'],
  )
  expect(rows[0]!.state).toBe('pending')
})

test('缺少 timestamp/nonce/signature 查询参数时返回 401，不尝试处理请求体', async () => {
  const { app } = buildTestApp(pool, { now: () => NOW })
  const res = await app(
    new Request('https://gw/webhook/tencent-meeting', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ encrypt: 'whatever' }),
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
  expect((await res.json()).ok).toBe(true)

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

  const makeReq = (): Request => {
    const url = new URL('https://gw/webhook/tencent-meeting')
    url.searchParams.set('timestamp', timestamp)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('signature', signature)
    return new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ encrypt: encrypted }),
    })
  }

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
