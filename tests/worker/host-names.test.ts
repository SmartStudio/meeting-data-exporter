import { expect, test } from 'bun:test'
import { TencentApiError } from '../../src/tencent/errors'
import { USER_DETAIL_QUOTA_KEY } from '../../src/tencent/client'
import type { MeetingHostIdsStore, TmUserRow, TmUsersStore } from '../../src/store/tm-users'
import { MAX_PER_ROUND, STALE_SEC, syncHostNames } from '../../src/worker/host-names'

/**
 * 主持人姓名同步（`src/worker/host-names.ts`）。
 *
 * 这里**不碰数据库也不碰网络**：store 与腾讯客户端都是假的。这一层的全部价值在
 * 「什么错该写 NULL、什么错该跳过」这条判据上，而那条判据的两个方向代价不对称——
 * 漏写只是这一轮没补上姓名，写错（把一次限流记成「查无此人」）会让一个真实存在的
 * 人整整一天显示成「未知主持人」，且没有任何地方会报错。所以每一类错误各钉一条。
 *
 * 真实的 SQL 语义在 tests/store/tm-users.test.ts 里测，不在这里重复。
 */

const NOW = 1_700_000_000

/** 记下每次 upsert 的假 store。`listMissing` 直接把入参原样返回，判据由那边的测试管 */
function fakeStore(opts: { missing?: string[] } = {}): TmUsersStore & { written: TmUserRow[] } {
  const written: TmUserRow[] = []
  return {
    written,
    listMissing: async (ids) => (opts.missing === undefined ? [...ids] : opts.missing),
    upsertMany: async (rows) => {
      written.push(...rows)
    },
    namesFor: async () => new Map(),
  }
}

function fakeMeetings(ids: string[]): MeetingHostIdsStore {
  return { listHostUserIds: async () => ids }
}

/** 按 userid 给答案的假客户端。答案可以是响应体，也可以是要抛的错 */
function fakeClient(answers: Record<string, unknown>): {
  get: <T>(path: string, query: Record<string, unknown>, opts?: { quotaKey?: string }) => Promise<T>
  calls: Array<{ path: string; query: Record<string, unknown>; quotaKey: string | undefined }>
} {
  const calls: Array<{ path: string; query: Record<string, unknown>; quotaKey: string | undefined }> = []
  return {
    calls,
    get: async <T,>(
      path: string,
      query: Record<string, unknown>,
      opts?: { quotaKey?: string },
    ): Promise<T> => {
      calls.push({ path, query, quotaKey: opts?.quotaKey })
      const id = decodeURIComponent(path.slice('/v1/users/'.length))
      const answer = answers[id]
      if (answer instanceof Error) throw answer
      return answer as T
    },
  }
}

const deps = (over: {
  client: ReturnType<typeof fakeClient>
  store: TmUsersStore
  meetings: MeetingHostIdsStore
  maxPerRound?: number
}) => ({
  client: over.client,
  operatorId: 'admin',
  store: over.store,
  meetings: over.meetings,
  now: NOW,
  // 测试里不打印：这个函数每轮都会记一行摘要，跑测试时它只是噪音
  log: () => {},
  ...(over.maxPerRound === undefined ? {} : { maxPerRound: over.maxPerRound }),
})

// ── 正路 ────────────────────────────────────────────────────────────────

test('查到姓名就落库，请求带 operator_id 与成员详情的配额键', async () => {
  const client = fakeClient({ 'tm-1': { username: '张三' } })
  const store = fakeStore()
  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings(['tm-1']) }))

  expect(round).toMatchObject({ hosts: 1, due: 1, attempted: 1, named: 1, absent: 0, failed: 0 })
  expect(store.written).toEqual([{ tmUserId: 'tm-1', username: '张三', fetchedAt: NOW }])

  expect(client.calls[0]!.path).toBe('/v1/users/tm-1')
  expect(client.calls[0]!.query).toEqual({ operator_id: 'admin', operator_id_type: 1 })
  // path 里带变量，按 path 匹配不上任何一条分钟级配额——不指到常量键上，
  // 这个接口就是完全不限流的（而且不会有任何报错，见 client.ts 的 quotaKey）
  expect(client.calls[0]!.quotaKey).toBe(USER_DETAIL_QUOTA_KEY)
})

test('userid 进 URL 路径要转义——它是从数据库里读出来的', async () => {
  const client = fakeClient({ 'a/b?c': { username: '李四' } })
  const store = fakeStore()
  await syncHostNames(deps({ client, store, meetings: fakeMeetings(['a/b?c']) }))
  expect(client.calls[0]!.path).toBe('/v1/users/a%2Fb%3Fc')
  expect(store.written[0]!.username).toBe('李四')
})

test('一轮最多问 maxPerRound 个——它与录制下载共用同一条令牌桶', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `tm-${i}`)
  const answers: Record<string, unknown> = {}
  for (const id of ids) answers[id] = { username: id }
  const client = fakeClient(answers)
  const store = fakeStore()

  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings(ids) }))
  expect(round.due).toBe(120)
  expect(round.attempted).toBe(MAX_PER_ROUND)
  expect(client.calls).toHaveLength(MAX_PER_ROUND)
  // 剩下的靠下一轮补，或者跑一次 scripts/sync-host-names.ts
  expect(round.named).toBe(MAX_PER_ROUND)
})

test('没有人要补时一次接口都不调，也不写库', async () => {
  const client = fakeClient({})
  const store = fakeStore({ missing: [] })
  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings(['tm-1']) }))

  expect(round).toMatchObject({ hosts: 1, due: 0, attempted: 0 })
  expect(client.calls).toHaveLength(0)
  expect(store.written).toHaveLength(0)
})

test('meetings 表里一个主持人都没有时直接收工', async () => {
  const client = fakeClient({})
  const store = fakeStore()
  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings([]) }))
  expect(round).toMatchObject({ hosts: 0, due: 0, attempted: 0 })
  expect(client.calls).toHaveLength(0)
})

test('默认的 staleSec 是一天，且落库时刻用的是传进来的 now', async () => {
  const client = fakeClient({ 'tm-1': { username: '张三' } })
  const seen: Array<{ now: number; staleSec: number }> = []
  const store: TmUsersStore = {
    listMissing: async (ids, now, staleSec) => {
      seen.push({ now, staleSec })
      return [...ids]
    },
    upsertMany: async () => {},
    namesFor: async () => new Map(),
  }
  await syncHostNames(deps({ client, store, meetings: fakeMeetings(['tm-1']) }))
  expect(seen).toEqual([{ now: NOW, staleSec: STALE_SEC }])
})

// ── 「查无此人」这一支：写 NULL ───────────────────────────────────────────

test('腾讯说记录不存在时写 username=NULL——那一行就是「一天内别再问」', async () => {
  // 4049「记录不存在」：errors.ts 把它归成 asset_permanent，客户端当场抛、不重试
  const client = fakeClient({ 'tm-1': new TencentApiError(4049, 400, 'record not found') })
  const store = fakeStore()
  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings(['tm-1']) }))

  expect(round).toMatchObject({ absent: 1, named: 0, failed: 0 })
  expect(store.written).toEqual([{ tmUserId: 'tm-1', username: null, fetchedAt: NOW }])
})

test('HTTP 404 也算「没有这个成员」——那是 REST 语义，不依赖具体错误码', async () => {
  const client = fakeClient({ 'tm-1': new TencentApiError(999_999, 404, 'not found') })
  const store = fakeStore()
  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings(['tm-1']) }))
  expect(round.absent).toBe(1)
  expect(store.written[0]!.username).toBeNull()
})

test('200 但没有 username 时也写 NULL，绝不写空串', async () => {
  const client = fakeClient({ 'tm-1': { username: '  ' } })
  const store = fakeStore()
  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings(['tm-1']) }))

  expect(round.absent).toBe(1)
  // 空串会被读侧当成「已知姓名」渲染成一行空白，比「未知主持人」更难查
  expect(store.written).toEqual([{ tmUserId: 'tm-1', username: null, fetchedAt: NOW }])
})

// ── 「没问成」这一支：什么都不写 ─────────────────────────────────────────

test('限频以外的瞬时错误：跳过这一个，不写表，继续问下一个', async () => {
  const client = fakeClient({
    'tm-1': new TencentApiError(960_000, 500, 'network'),
    'tm-2': { username: '李四' },
  })
  const store = fakeStore()
  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings(['tm-1', 'tm-2']) }))

  expect(round).toMatchObject({ attempted: 2, named: 1, absent: 0, failed: 1 })
  // 关键在这里：失败的那个**没有**落一行 NULL。落了的话，一个真实存在的人
  // 会因为一次网络抖动整整一天显示成「未知主持人」
  expect(store.written).toEqual([{ tmUserId: 'tm-2', username: '李四', fetchedAt: NOW }])
})

test('不是 TencentApiError 的异常（fetch 炸了）一律按「没问成」处理', async () => {
  const client = fakeClient({ 'tm-1': new Error('connect ECONNREFUSED') })
  const store = fakeStore()
  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings(['tm-1']) }))
  expect(round).toMatchObject({ failed: 1, absent: 0 })
  expect(store.written).toHaveLength(0)
})

test('调用超限（190310）当场收工——继续问只会让全局令牌桶收敛得更狠', async () => {
  const client = fakeClient({
    'tm-1': { username: '张三' },
    'tm-2': new TencentApiError(190_310, 500, 'rate limited'),
    'tm-3': { username: '王五' },
  })
  const store = fakeStore()
  const round = await syncHostNames(
    deps({ client, store, meetings: fakeMeetings(['tm-1', 'tm-2', 'tm-3']) }),
  )

  expect(round.attempted).toBe(2)
  expect(round.stoppedEarly).toContain('190310')
  expect(client.calls).toHaveLength(2)
  // 收工之前已经问到的照样落库：丢掉它们等于下一轮再问一遍同样的问题
  expect(store.written).toEqual([{ tmUserId: 'tm-1', username: '张三', fetchedAt: NOW }])
})

test('权限一类的致命错误当场收工：每个 id 都会同样失败，问下去只是烧配额', async () => {
  // 500063「该应用没有调用该接口的权限点」——自建应用没勾这个权限点时腾讯返回它
  const client = fakeClient({
    'tm-1': new TencentApiError(500_063, 400, 'no permission'),
    'tm-2': { username: '李四' },
  })
  const store = fakeStore()
  const round = await syncHostNames(deps({ client, store, meetings: fakeMeetings(['tm-1', 'tm-2']) }))

  expect(round.attempted).toBe(1)
  expect(round.failed).toBe(1)
  expect(round.stoppedEarly).not.toBeNull()
  expect(client.calls).toHaveLength(1)
  expect(store.written).toHaveLength(0)
})
