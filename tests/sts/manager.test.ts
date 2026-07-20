import { expect, test } from 'bun:test'
import { createStsManager, StsTokenUnavailableError } from '../../src/sts/manager'
import type { StsStore, StsTokenRecord } from '../../src/store/sts'

function memStore(): StsStore & { records: Map<string, StsTokenRecord & { state: string }> } {
  const records = new Map<string, StsTokenRecord & { state: string }>()
  return {
    records,
    async createRequest(reqId) {
      records.set(reqId, { reqId, tokenCipher: '', expireTs: 0, state: 'pending' })
    },
    async fulfill(reqId, cipher, expireTs) {
      const r = records.get(reqId)
      if (!r) throw new Error(`unknown req_id: ${reqId}`)
      records.set(reqId, { reqId, tokenCipher: cipher, expireTs, state: 'fulfilled' })
    },
    async getActive(now) {
      const valid = [...records.values()].filter((r) => r.state === 'fulfilled' && r.expireTs > now)
      valid.sort((a, b) => b.expireTs - a.expireTs)
      return valid[0] ?? null
    },
    async expireStale() { return 0 },
  }
}

const deps = (store: StsStore, posts: string[] = []) => ({
  store,
  client: {
    get: async <T,>() => ({}) as T,
    post: async <T,>(_p: string, body: object) => {
      posts.push(JSON.stringify(body))
      return { req_id: `req-${posts.length}` } as T
    },
    currentQps: () => 5,
  },
  operatorId: 'admin',
  webhookToken: 'a'.repeat(25),
  aesKey: 'b'.repeat(43),
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ''),
  verify: () => true,
  decryptEvent: (_k: string, c: string) => c,
})

test('无有效 token 时 getToken 抛出可识别错误', async () => {
  const m = createStsManager(deps(memStore()))
  await expect(m.getToken(1000)).rejects.toThrow(StsTokenUnavailableError)
})

test('ensureFresh 在无 token 时发起申请', async () => {
  const posts: string[] = []
  const m = createStsManager(deps(memStore(), posts))
  await m.ensureFresh(1000)
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0]!).valid_time).toBe(24)
})

test('剩余有效期大于 1/3 时不重复申请', async () => {
  const store = memStore()
  const posts: string[] = []
  const m = createStsManager(deps(store, posts))
  await store.createRequest('r1', 0)
  await store.fulfill('r1', 'enc(tok)', 1000 + 24 * 3600, 0)
  await m.ensureFresh(1000)
  expect(posts).toHaveLength(0)
})

test('剩余有效期低于 1/3 时提前续期', async () => {
  const store = memStore()
  const posts: string[] = []
  const m = createStsManager(deps(store, posts))
  await store.createRequest('r1', 0)
  await store.fulfill('r1', 'enc(tok)', 1000 + 3600, 0) // 剩 1 小时 < 24h/3
  await m.ensureFresh(1000)
  expect(posts).toHaveLength(1)
})

test('handleWebhook 验签失败时拒绝且不写入', async () => {
  const store = memStore()
  const d = { ...deps(store), verify: () => false }
  const m = createStsManager(d)
  await expect(
    m.handleWebhook({ timestamp: '1', nonce: 'n', signature: 'bad', encrypted: 'x' }, 1000),
  ).rejects.toThrow('webhook verification failed')
  expect(store.records.size).toBe(0)
})

test('handleWebhook 成功后 token 可用', async () => {
  const store = memStore()
  const m = createStsManager(deps(store))
  await store.createRequest('req-9', 0)
  const event = JSON.stringify({
    event: 'common.sts-token',
    payload: [{ operator: { userid: 'admin' }, token_info: { req_id: 'req-9', sts_token: 'tok-9', expire_ts: 99999 } }],
  })
  await m.handleWebhook({ timestamp: '1', nonce: 'n', signature: 'ok', encrypted: event }, 1000)
  expect(await m.getToken(2000)).toBe('tok-9')
})

test('新旧 token 并存时返回过期最晚的', async () => {
  const store = memStore()
  const m = createStsManager(deps(store))
  await store.createRequest('old', 0)
  await store.fulfill('old', 'enc(old-tok)', 5000, 0)
  await store.createRequest('new', 0)
  await store.fulfill('new', 'enc(new-tok)', 9000, 0)
  expect(await m.getToken(1000)).toBe('new-tok')
})
