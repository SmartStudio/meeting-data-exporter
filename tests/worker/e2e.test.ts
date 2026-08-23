/**
 * 归档 worker 的端到端冒烟：**真 MySQL + 真本地磁盘 + 真 HTTP 下载**，
 * 只有腾讯边界（recordsApi / catalog）是桩。
 *
 * 为什么必须真到这个程度：在本测试之前，六个任务各自证明了自己的零件是对的，
 * 但没有任何测试证明过「引擎能在网关进程里工作」。装配错误恰恰只在装配处显形——
 * 例如 assetId 在 source-inproc 与 store 之间对不上、relPath 拼错、`.part`
 * 没被 finalize、下载器的 Range 续传在真实 fetch 下不生效。
 * 桩掉任何一层都会让这些错误照样"通过"。
 *
 * 下载走的是本文件启动的真 HTTP 服务（Bun.serve），因为 downloader 内部直接用
 * `fetch`——只桩 catalog 拿不到 URL 之后那一半逻辑（Range 续传、416/403 换链接、
 * 流式落盘、finalize）。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { DEFAULT_ASSET_KEYS, createLocalStorage } from '@yaowu/mde-engine'
import type { AssetKey, MeetingSelector } from '@yaowu/mde-engine'
import { withTestDb } from '../helpers/testdb'
import { POOL_CONNECTION_LIMIT, createPool, type Pool } from '../../src/store/db'
import type { Asset, Meeting } from '../../src/domain/types'
import type { Catalog } from '../../src/catalog/index'
import type { RecordsApi } from '../../src/tencent/records'
import { createInProcSource } from '../../src/worker/source-inproc'
import { createMysqlStore } from '../../src/worker/store-mysql'
import {
  assertConcurrencyFitsPool,
  parseWorkerArgs,
  runWorkerOnce,
  type WorkerDeps,
} from '../../src/worker/index'

// 2026-08-20T09:30:00Z。落盘路径里的 year/month/date/hhmm 全部由它派生，
// 所以下面写死的期望路径是可以手算复核的，不是从实现里抄回来的。
const START = 1787218200
const END = START + 3600

/** 主题里故意留一个 `/` 与多余空白：cleanDirName 会把它清成 `-`，路径不该出现意外的层级 */
const MEETING: Meeting = {
  meetingId: 'm-e2e',
  subMeetingId: '',
  meetingRecordId: 'rec-1',
  meetingCode: '881-123-40',
  subject: '周会 / Q3 复盘',
  hostUserId: 'u-host',
  startTime: START,
  endTime: END,
  state: 'completed',
}

/** `<year>/<month>/<cleanDirName>/` —— 手算：2026 / 08 / 2026-08-20_0930_<清洗主题>_<code> */
const DIR = '2026/08/2026-08-20_0930_周会 - Q3 复盘_881-123-40'
const TRANSCRIPT_REL = `${DIR}/transcript.txt`
const VIDEO_REL = `${DIR}/recording_f-video-1.mp4`

const TRANSCRIPT_BODY = 'hello world'
/** 'hello world' 的 sha256——写死字面量，才能证明 content_hash 算的是内容而不是别的东西 */
const TRANSCRIPT_SHA256 = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
const VIDEO_BODY = 'MP4-BINARY-PAYLOAD'

const TRANSCRIPT_ASSET: Asset = {
  assetId: 'rec-1:f-sum-1:meeting_summary:txt',
  meetingId: MEETING.meetingId,
  subMeetingId: '',
  assetType: 'meeting_summary',
  recordFileId: 'f-sum-1',
  fileType: 'txt',
  bytesExpected: TRANSCRIPT_BODY.length,
  allowDownload: true,
}
const VIDEO_ASSET: Asset = {
  assetId: 'rec-1:f-video-1:video:0',
  meetingId: MEETING.meetingId,
  subMeetingId: '',
  assetType: 'video',
  recordFileId: 'f-video-1',
  fileType: 'mp4',
  bytesExpected: VIDEO_BODY.length,
  allowDownload: true,
}

/**
 * 请求日志记到 `status` 与 `sent` 这一层，是因为只记 `range` 证明不了续传：
 * Range 头是客户端发的，服务端完全可以无视它、返回 200 全量，客户端于是丢弃
 * `.part` 从头重下——最终文件内容一模一样，只看内容或只看请求头的断言全都照过。
 * 「服务端真的只发了尾巴那几个字节」才是续传发生过的证据。
 */
interface ServedRequest {
  path: string
  range: string | null
  status: number
  sent: number
}

interface FileServer {
  origin: string
  requests: ServedRequest[]
  /** 非 null 时 200 响应只发前 N 字节，用来制造一次「下到一半断了」 */
  truncateTo: number | null
  /** true 时服务端无视 Range 头一律返回 200 全量——用来验证续传断言不是摆设 */
  ignoreRange: boolean
  stop: () => void
}

/**
 * 支持 Range 的最小文件服务。真实的腾讯对象存储支持 206，续传逻辑必须跑在
 * 一个真会返回 206 的服务上才算被验证过。
 */
function startFileServer(files: Record<string, string>): FileServer {
  const state: FileServer = {
    origin: '',
    requests: [],
    truncateTo: null,
    ignoreRange: false,
    stop: () => {},
  }
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const range = req.headers.get('range')
      const log = (status: number, sent: number): void => {
        state.requests.push({ path: url.pathname, range, status, sent })
      }
      const body = files[url.pathname]
      if (body === undefined) {
        log(404, 0)
        return new Response('not found', { status: 404 })
      }
      const full = Buffer.from(body, 'utf8')
      if (range !== null && !state.ignoreRange) {
        const m = /^bytes=(\d+)-$/.exec(range)
        if (m === null) {
          log(400, 0)
          return new Response('bad range', { status: 400 })
        }
        const start = Number(m[1])
        if (start >= full.length) {
          log(416, 0)
          return new Response('', { status: 416 })
        }
        const slice = full.subarray(start)
        log(206, slice.length)
        return new Response(slice, {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${full.length - 1}/${full.length}` },
        })
      }
      const out = state.truncateTo === null ? full : full.subarray(0, state.truncateTo)
      log(200, out.length)
      return new Response(out, { status: 200 })
    },
  })
  state.origin = server.url.origin
  state.stop = () => server.stop(true)
  return state
}

function stubRecordsApi(): RecordsApi {
  return { listMeetings: async () => [MEETING] }
}

/** catalog 是腾讯边界：listAssets 返回 fixture，resolveDownloadUrl 指向本地文件服务 */
function stubCatalog(
  server: FileServer,
  assets: Asset[],
  hooks: { onResolve?: () => Promise<void> } = {},
): Catalog {
  return {
    listAssets: async () => assets,
    resolveDownloadUrl: async (a) => {
      await hooks.onResolve?.()
      // 用 recordFileId 拼 URL：它是 source-inproc 从 assetId 里解析出来的，
      // 拼错了就会 404，等于顺带校验 assetId 在装配链路上没有走样
      return { url: `${server.origin}/file/${a.recordFileId}`, expiresAt: 1 << 30 }
    },
  }
}

function makeDeps(
  pool: Pool,
  root: string,
  server: FileServer,
  assets: Asset[],
  now: () => number,
  over: Partial<WorkerDeps> & { onResolve?: () => Promise<void> } = {},
): WorkerDeps {
  const { onResolve, ...rest } = over
  return {
    store: createMysqlStore(pool),
    source: createInProcSource({
      recordsApi: stubRecordsApi(),
      catalog: stubCatalog(server, assets, { onResolve }),
      now,
    }),
    storage: createLocalStorage(root),
    concurrency: 2,
    leaseSec: 900,
    ...rest,
  }
}

const RANGE_SEL: MeetingSelector = { kind: 'range', from: START - 86400, to: END + 86400 }
const KEYS: AssetKey[] = ['transcript', 'video']

async function rowsByType(pool: Pool): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM meeting_assets ORDER BY asset_type',
  )
  return rows
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 每个用例一套独立的库 + 归档目录 + 文件服务，跑完全部拆掉 */
async function withRig(
  files: Record<string, string>,
  fn: (rig: { pool: Pool; root: string; server: FileServer }) => Promise<void>,
): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  const root = await mkdtemp(join(tmpdir(), 'mde-worker-'))
  const server = startFileServer(files)
  try {
    await fn({ pool, root, server })
  } finally {
    server.stop()
    await rm(root, { recursive: true, force: true })
    await cleanup()
  }
}

const FILES = { '/file/f-sum-1': TRANSCRIPT_BODY, '/file/f-video-1': VIDEO_BODY }

describe('runWorkerOnce', () => {
  test('一轮把一场会议的两个资产拉进归档区，状态与哈希落进 MySQL', async () => {
    await withRig(FILES, async ({ pool, root, server }) => {
      const now = () => START + 100
      const deps = makeDeps(pool, root, server, [TRANSCRIPT_ASSET, VIDEO_ASSET], now)

      const res = await runWorkerOnce(deps, RANGE_SEL, KEYS, now)
      expect(res).toEqual({
        meetings: 1,
        tasks: 2,
        probes: { resolved: 0, abandoned: 0, newTasks: 0 },
        completed: 2,
        failed: 0,
        skipped: 0,
      })

      // ① 文件真的落在归档区，且路径是按 <year>/<month>/<cleanDirName>/<文件名> 拼出来的那个
      expect(await readFile(join(root, TRANSCRIPT_REL), 'utf8')).toBe(TRANSCRIPT_BODY)
      expect(await readFile(join(root, VIDEO_REL), 'utf8')).toBe(VIDEO_BODY)

      // ② 没有残留 .part（finalize 真的执行了，而不是内容恰好写在临时文件里）
      expect(await exists(join(root, `${TRANSCRIPT_REL}.part`))).toBe(false)
      expect(await exists(join(root, `${VIDEO_REL}.part`))).toBe(false)

      // ③ MySQL 里逐条状态、target_path、content_hash
      const rows = await rowsByType(pool)
      expect(rows.length).toBe(2)
      const summary = rows.find((r) => r.asset_type === 'meeting_summary')!
      const video = rows.find((r) => r.asset_type === 'video')!

      expect(summary.status).toBe('completed')
      expect(summary.target_path).toBe(TRANSCRIPT_REL)
      // 文本类算整文件 sha256
      expect(summary.content_hash).toBe(TRANSCRIPT_SHA256)
      expect(summary.lease_expires_at).toBeNull()
      expect(summary.last_error).toBeNull()
      expect(summary.attempts).toBe(1)

      expect(video.status).toBe('completed')
      expect(video.target_path).toBe(VIDEO_REL)
      // video/audio 不整读算哈希（2GB 录制会吃爆内存），content_hash 必须是 null
      expect(video.content_hash).toBeNull()

      // ④ 会议元数据也进了 meetings 表——拼路径的事实源就是它
      const [ms] = await pool.query<RowDataPacket[]>('SELECT * FROM meetings')
      expect(ms.length).toBe(1)
      expect(ms[0]!.meeting_id).toBe('m-e2e')
      expect(Number(ms[0]!.start_time)).toBe(START)

      // ⑤ 每个文件恰好被取了一次
      expect(server.requests.map((r) => r.path).sort()).toEqual(['/file/f-sum-1', '/file/f-video-1'])
    })
  }, 30_000)

  test('同一场会议跑第二遍不重新下载：已 completed 的行不再被领取', async () => {
    await withRig(FILES, async ({ pool, root, server }) => {
      const now = () => START + 100
      const deps = makeDeps(pool, root, server, [TRANSCRIPT_ASSET, VIDEO_ASSET], now)

      await runWorkerOnce(deps, RANGE_SEL, KEYS, now)
      const afterFirst = server.requests.length
      expect(afterFirst).toBe(2)
      const firstMtime = (await stat(join(root, TRANSCRIPT_REL))).mtimeMs

      const res2 = await runWorkerOnce(deps, RANGE_SEL, KEYS, now)

      // tasks 统计的是"本轮发现的就绪资产数"，不是"新增的活"——第二遍照样是 2。
      // 真正说明幂等的是下面三条，别把 tasks=2 误读成又下了一遍。
      expect(res2.tasks).toBe(2)
      expect(res2.completed).toBe(0)
      expect(res2.failed).toBe(0)
      expect(res2.skipped).toBe(0)

      // ① 文件服务一次新请求都没收到 —— 没有重新下载
      expect(server.requests.length).toBe(afterFirst)
      // ② 落盘文件没被动过（没有被重写、也没有被 .part 覆盖）
      expect((await stat(join(root, TRANSCRIPT_REL))).mtimeMs).toBe(firstMtime)
      expect(await readFile(join(root, TRANSCRIPT_REL), 'utf8')).toBe(TRANSCRIPT_BODY)
      // ③ attempts 没涨 —— claimNext 压根没碰这两行（attempts 只在领取时 +1）
      const rows = await rowsByType(pool)
      expect(rows.map((r) => r.status)).toEqual(['meeting_summary', 'video'].map(() => 'completed'))
      expect(rows.map((r) => r.attempts)).toEqual([1, 1])
    })
  }, 30_000)

  test('断点续传：上一轮只下到一半，下一轮带 Range 接着下而不是从头来', async () => {
    await withRig(FILES, async ({ pool, root, server }) => {
      const now = () => START + 100
      const deps = makeDeps(pool, root, server, [TRANSCRIPT_ASSET], now)
      const keys: AssetKey[] = ['transcript']

      // 第一轮：服务端只发前 5 字节，downloader 因 size mismatch 判失败，.part 保留
      server.truncateTo = 5
      const r1 = await runWorkerOnce(deps, RANGE_SEL, keys, now)
      expect(r1.completed).toBe(0)
      expect(r1.failed).toBe(1)
      expect(server.requests).toEqual([
        { path: '/file/f-sum-1', range: null, status: 200, sent: 5 },
      ])
      expect((await stat(join(root, `${TRANSCRIPT_REL}.part`))).size).toBe(5)
      expect(await exists(join(root, TRANSCRIPT_REL))).toBe(false)
      const failed = (await rowsByType(pool))[0]!
      expect(failed.status).toBe('failed')
      expect(String(failed.last_error)).toContain('size mismatch')

      // 第二轮：把失败的行重置成 pending（等价于运维执行 retry），服务端恢复正常
      server.truncateTo = null
      await deps.store.resetFailed(now())
      server.requests.length = 0

      const r2 = await runWorkerOnce(deps, RANGE_SEL, keys, now)
      expect(r2.completed).toBe(1)

      // ① 第二轮请求带 Range，服务端以 206 只发了尾巴那 6 字节 —— 真续传。
      //    只断言 range 头是不够的：服务端无视 Range 返回 200 全量时，客户端会丢弃
      //    .part 从头重下，内容照样正确、range 头照样在。sent=6 才排除了这种情况。
      expect(server.requests).toEqual([
        { path: '/file/f-sum-1', range: 'bytes=5-', status: 206, sent: 6 },
      ])
      // ② 拼起来的内容完整且正确（哈希是对全文算的，接错位会立刻露馅）
      expect(await readFile(join(root, TRANSCRIPT_REL), 'utf8')).toBe(TRANSCRIPT_BODY)
      const done = (await rowsByType(pool))[0]!
      expect(done.status).toBe('completed')
      expect(done.content_hash).toBe(TRANSCRIPT_SHA256)
      expect(done.attempts).toBe(2)
      expect(await exists(join(root, `${TRANSCRIPT_REL}.part`))).toBe(false)
    })
  }, 30_000)

  test('服务端无视 Range 时退回全量重下——上一条用例的 sent=6 因此是有判别力的', async () => {
    // 这条不是为了测「无视 Range」这个场景本身，是给上一条用例当负控制：
    // 如果没有它，谁也说不清 sent=6 那个断言换成一个不支持续传的服务端会不会照样绿。
    await withRig(FILES, async ({ pool, root, server }) => {
      const now = () => START + 100
      const deps = makeDeps(pool, root, server, [TRANSCRIPT_ASSET], now)
      const keys: AssetKey[] = ['transcript']

      server.truncateTo = 5
      await runWorkerOnce(deps, RANGE_SEL, keys, now)
      expect((await stat(join(root, `${TRANSCRIPT_REL}.part`))).size).toBe(5)

      server.truncateTo = null
      server.ignoreRange = true
      await deps.store.resetFailed(now())
      server.requests.length = 0
      const r2 = await runWorkerOnce(deps, RANGE_SEL, keys, now)

      expect(r2.completed).toBe(1)
      // 客户端照样发了 Range，服务端无视 → 200 全量 11 字节，与续传的 206/6 判然不同
      expect(server.requests).toEqual([
        { path: '/file/f-sum-1', range: 'bytes=5-', status: 200, sent: 11 },
      ])
      // 内容仍然正确（downloader 丢掉 .part 从头写），所以只看内容永远发现不了区别
      expect(await readFile(join(root, TRANSCRIPT_REL), 'utf8')).toBe(TRANSCRIPT_BODY)
    })
  }, 30_000)

  test('租约锚在活时钟上：后领取的任务拿到更晚的 lease_expires_at', async () => {
    // 这条用例是 runWorkerOnce 取 `now: () => number` 而不是 `now: number` 的守卫。
    // 冻结时钟下 lease_expires_at 恒等于「本轮开始时刻 + leaseSec」，一轮跑够久
    // （大文件很正常）之后，别的实例按自己的活时钟一看就判定租约过期，把还在下载中的
    // 任务抢走——两个进程同时写同一个 .part。把时钟换成函数这条用例才可能通过。
    await withRig(FILES, async ({ pool, root, server }) => {
      let clock = START + 100
      const now = () => clock
      const seenLease: number[] = []
      const deps = makeDeps(pool, root, server, [TRANSCRIPT_ASSET, VIDEO_ASSET], now, {
        concurrency: 1, // 串行领取，任一时刻只有一行是 running
        onResolve: async () => {
          const [rows] = await pool.query<RowDataPacket[]>(
            "SELECT lease_expires_at FROM meeting_assets WHERE status='running'",
          )
          expect(rows.length).toBe(1)
          seenLease.push(Number(rows[0]!.lease_expires_at))
          clock += 600 // 模拟这一条下载耗时 10 分钟
        },
      })

      const res = await runWorkerOnce(deps, RANGE_SEL, KEYS, now)
      expect(res.completed).toBe(2)
      expect(seenLease.length).toBe(2)
      expect(seenLease[0]).toBe(START + 100 + 900)
      expect(seenLease[1]).toBe(START + 100 + 600 + 900)
    })
  }, 30_000)
})

describe('parseWorkerArgs', () => {
  test('--from/--to 支持 YYYY-MM-DD 与 unix 秒，默认资产集是 DEFAULT_ASSET_KEYS', () => {
    const a = parseWorkerArgs(['--from', '2026-08-01', '--to', '1787218200'], 4)
    expect(a.sel).toEqual({ kind: 'range', from: Date.UTC(2026, 7, 1) / 1000, to: 1787218200 })
    expect(a.keys).toEqual(DEFAULT_ASSET_KEYS)
    expect(a.concurrency).toBe(4)
  })

  test('--code 与 --meeting-id 是两个不同的选择子，不合并成一个 --meeting', () => {
    expect(parseWorkerArgs(['--code', '881-123-40'], 4).sel).toEqual({
      kind: 'code',
      meetingCode: '881-123-40',
      from: undefined,
      to: undefined,
    })
    expect(parseWorkerArgs(['--meeting-id', 'm-1'], 4).sel).toEqual({
      kind: 'id',
      meetingId: 'm-1',
      from: undefined,
      to: undefined,
    })
    // 同时给两个是矛盾输入，静默挑一个等于拉回另一场会
    expect(() => parseWorkerArgs(['--code', 'c', '--meeting-id', 'm'], 4)).toThrow(
      'mutually exclusive',
    )
  })

  test('既没给点选、又没给完整时间窗时报错，而不是默默拉一个空范围', () => {
    expect(() => parseWorkerArgs(['--from', '2026-08-01'], 4)).toThrow('--from and --to')
    expect(() => parseWorkerArgs([], 4)).toThrow('--from and --to')
    expect(() => parseWorkerArgs(['--nope'], 4)).toThrow('unknown flag')
  })
})

describe('连接池耗尽时的表现', () => {
  /** 占满整池，返回释放函数——两条用例都要先把 10 条连接全握在手里 */
  async function saturate(pool: Pool): Promise<() => void> {
    const held = await Promise.all(
      Array.from({ length: POOL_CONNECTION_LIMIT }, () => pool.getConnection()),
    )
    return () => held.forEach((c) => c.release())
  }

  test('worker 传的有限 queueLimit：排不进队的请求当场报错', async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL!, { queueLimit: 1 })
    try {
      const release = await saturate(pool)
      // 队列只容得下 1 个，第 2 个必须立刻被拒绝
      const queued = pool.getConnection()
      await expect(pool.getConnection()).rejects.toThrow(/[Qq]ueue limit/)
      release()
      ;(await queued).release()
    } finally {
      await pool.end()
    }
  }, 30_000)

  test('mysql2 的默认 queueLimit=0：同样的情形下静默地等下去，永远不报错', async () => {
    // 这条是上一条的负控制，也是台账第 4 条记的那个失效模式的实物证据：
    // 默认配置下池耗尽不是"慢"，是**一台看起来还活着、实际什么都不干的机器**——
    // 没有超时、没有报错、没有日志。worker 因此必须显式传一个有限值。
    const pool = createPool(process.env.TEST_DATABASE_URL!)
    try {
      const release = await saturate(pool)
      const extra = pool.getConnection()
      let settled = false
      extra.then(
        () => { settled = true },
        () => { settled = true },
      )
      await new Promise((r) => setTimeout(r, 200))
      expect(settled).toBe(false)
      release()
      ;(await extra).release()
    } finally {
      await pool.end()
    }
  }, 30_000)
})

describe('assertConcurrencyFitsPool', () => {
  // 并发度配过头的表现是无限期静默挂起（mysql2 默认 queueLimit=0 + waitForConnections），
  // 所以它必须在启动期就炸，而不是留一台看起来还活着、实际什么都不干的机器。
  test('并发度 × 2 超过池上限时当场报错，错误里写清楚为什么', () => {
    expect(() => assertConcurrencyFitsPool(4)).not.toThrow()
    expect(() => assertConcurrencyFitsPool(5)).not.toThrow()
    expect(() => assertConcurrencyFitsPool(6)).toThrow(/pool caps at 10/)
    expect(() => assertConcurrencyFitsPool(0)).toThrow(/positive integer/)
    expect(() => assertConcurrencyFitsPool(2.5)).toThrow(/positive integer/)
  })
})
