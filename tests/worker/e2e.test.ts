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
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2'
import { ALL_ASSET_KEYS, DEFAULT_ASSET_KEYS, createLocalStorage } from '@yaowu/mde-engine'
import type { AssetKey, MeetingSelector } from '@yaowu/mde-engine'
import { requireTestDatabaseUrl, withTestDb } from '../helpers/testdb'
import { POOL_CONNECTION_LIMIT, createPool, type Pool } from '../../src/store/db'
import type { Asset, Meeting } from '../../src/domain/types'
import type { Catalog } from '../../src/catalog/index'
import type { RecordsApi } from '../../src/tencent/records'
import { createArchivesStore } from '../../src/store/archives'
import { createInProcSource } from '../../src/worker/source-inproc'
import { createMysqlStore } from '../../src/worker/store-mysql'
import {
  assertArchiveRootUsable,
  assertConcurrencyFitsPool,
  parseWorkerArgs,
  poolQueueLimitFor,
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
  nasRoot: string,
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
    // 归档流水线（P2）依赖：与 storage 用同一个本地根目录，NAS 目的地另开一个临时目录
    archives: createArchivesStore(pool),
    localRoot: root,
    nasRoot,
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

/** 每个用例一套独立的库 + 本地归档目录 + NAS 目录 + 文件服务，跑完全部拆掉 */
async function withRig(
  files: Record<string, string>,
  fn: (rig: { pool: Pool; root: string; nasRoot: string; server: FileServer }) => Promise<void>,
): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  const root = await mkdtemp(join(tmpdir(), 'mde-worker-'))
  const nasRoot = await mkdtemp(join(tmpdir(), 'mde-worker-nas-'))
  const server = startFileServer(files)
  try {
    await fn({ pool, root, nasRoot, server })
  } finally {
    server.stop()
    await rm(root, { recursive: true, force: true })
    await rm(nasRoot, { recursive: true, force: true })
    await cleanup()
  }
}

const FILES = { '/file/f-sum-1': TRANSCRIPT_BODY, '/file/f-video-1': VIDEO_BODY }

describe('runWorkerOnce', () => {
  test('一轮把一场会议的两个资产拉进归档区，状态与哈希落进 MySQL', async () => {
    await withRig(FILES, async ({ pool, root, nasRoot, server }) => {
      const now = () => START + 100
      const deps = makeDeps(pool, root, nasRoot, server, [TRANSCRIPT_ASSET, VIDEO_ASSET], now)

      const res = await runWorkerOnce(deps, RANGE_SEL, KEYS, now)
      expect(res).toEqual({
        meetings: 1,
        tasks: 2,
        probes: { resolved: 0, abandoned: 0, newTasks: 0 },
        completed: 2,
        failed: 0,
        skipped: 0,
        // 归档流水线（P2）接入 runWorkerOnce 之后：两个资产都下载完成，
        // 本轮紧接着把它们都归档到 NAS 且哈希校验通过
        archived: { newlyArchived: 2, verificationFailed: 0, failed: 0 },
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
    await withRig(FILES, async ({ pool, root, nasRoot, server }) => {
      const now = () => START + 100
      const deps = makeDeps(pool, root, nasRoot, server, [TRANSCRIPT_ASSET, VIDEO_ASSET], now)

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
    await withRig(FILES, async ({ pool, root, nasRoot, server }) => {
      const now = () => START + 100
      const deps = makeDeps(pool, root, nasRoot, server, [TRANSCRIPT_ASSET], now)
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
    await withRig(FILES, async ({ pool, root, nasRoot, server }) => {
      const now = () => START + 100
      const deps = makeDeps(pool, root, nasRoot, server, [TRANSCRIPT_ASSET], now)
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
    await withRig(FILES, async ({ pool, root, nasRoot, server }) => {
      let clock = START + 100
      const now = () => clock
      const seenLease: number[] = []
      const deps = makeDeps(pool, root, nasRoot, server, [TRANSCRIPT_ASSET, VIDEO_ASSET], now, {
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

  test('归档步骤按 (meeting_id, sub_meeting_id) 精确枚举，不按 meeting_id 去重：同一 meeting_id 下两个 sub_meeting_id 都有完成资产时，一轮之后两个都被归档', async () => {
    // 这是 code review 抓出的 Critical 的回归用例：归档步骤最初错误复用了
    // Store.meetingsForPaths()（专为本地路径命名设计，按 meeting_id 去重，见
    // tests/worker/store-mysql.test.ts:393 那条钉住"后一行覆盖前一行"的既有用例）
    // 当枚举源。周期性会议共享 meeting_id、各场次有不同的 sub_meeting_id 是真实场景
    // （meetings 表主键就是 (meeting_id, sub_meeting_id)），去重会让除"胜出"那条之外
    // 的场次永远不被传给 archiveMeeting——静默地永远不归档、永远不进
    // meeting_archives、Task 8 的到期清理也永远看不到。
    await withRig(FILES, async ({ pool, root, nasRoot, server }) => {
      // 直接往 meeting_assets 插两条"已完成下载"的行，分属同一个 meeting_id 下的
      // 两个不同 sub_meeting_id——不经过 discover/下载：这个 bug 完全在归档步骤的
      // 枚举逻辑里，不需要、也不应该跟 createInProcSource 聚合周期性会议资产那个
      // （另一处、与本次修复无关的）行为纠缠在一起。
      await pool.execute(
        `INSERT INTO meeting_assets
           (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, bytes_written, created_at, updated_at)
         VALUES ('m-periodic', 's1', 'video', 'r-1', 'mp4', 'completed', 's1.bin', 0, 1000, 1000)`,
      )
      await pool.execute(
        `INSERT INTO meeting_assets
           (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, target_path, bytes_written, created_at, updated_at)
         VALUES ('m-periodic', 's2', 'video', 'r-1', 'mp4', 'completed', 's2.bin', 0, 1000, 1000)`,
      )
      await writeFile(join(root, 's1.bin'), 'content for s1')
      await writeFile(join(root, 's2.bin'), 'content for s2')

      const now = () => START + 100
      // 本轮不需要真的发现/下载任何东西：用一个查不到会议的空 source，让这一轮
      // 唯一有意义的活动落在归档步骤上。
      const emptySource = createInProcSource({
        recordsApi: { listMeetings: async () => [] },
        catalog: {
          listAssets: async () => [],
          resolveDownloadUrl: async () => { throw new Error('unexpected download in this test') },
        },
        now,
      })
      const deps = makeDeps(pool, root, nasRoot, server, [], now, { source: emptySource })

      const res = await runWorkerOnce(deps, RANGE_SEL, KEYS, now)
      expect(res.meetings).toBe(0)
      expect(res.tasks).toBe(0)

      // 两个 sub_meeting_id 都被归档了，不是只有一个
      expect(res.archived).toEqual({ newlyArchived: 2, verificationFailed: 0, failed: 0 })

      const archives = createArchivesStore(pool)
      expect(await archives.isAssetArchived({ meetingId: 'm-periodic', subMeetingId: 's1', assetType: 'video', remoteId: 'r-1', fileType: 'mp4' })).toBe(true)
      expect(await archives.isAssetArchived({ meetingId: 'm-periodic', subMeetingId: 's2', assetType: 'video', remoteId: 'r-1', fileType: 'mp4' })).toBe(true)
      expect(await archives.findMeetingArchive('m-periodic', 's1')).not.toBeNull()
      expect(await archives.findMeetingArchive('m-periodic', 's2')).not.toBeNull()
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

  test('旗标缺值时，错误指着那个旗标，而不是指向一句离题的话', () => {
    // 给了 --code 但没带值：不做检查的话会落进 range 分支报「requires --from and --to」，
    // 运维会以为自己忘了给 --code，其实是给了没带值——错误话指向了错误的地方。
    expect(() => parseWorkerArgs(['--code'], 4)).toThrow('flag --code requires a value')
    expect(() => parseWorkerArgs(['--code', '--concurrency', '2'], 4)).toThrow(
      'flag --code requires a value',
    )
    // 给了 --assets 但没带值：不做检查的话是 undefined.trim() 的 TypeError
    expect(() => parseWorkerArgs(['--assets'], 4)).toThrow('flag --assets requires a value')
    expect(() => parseWorkerArgs(['--from'], 4)).toThrow('flag --from requires a value')
    expect(() => parseWorkerArgs(['--meeting-id'], 4)).toThrow('flag --meeting-id requires a value')
  })

  // 以下四条补的是**成功路径**。此前这里只断言了「不给旗标时回落默认」与
  // 「给了旗标但缺值时报错」，而报告 §3 给运维的示例命令（`--assets all`、
  // `--concurrency` 覆盖 env 默认值、`--code` 配 `--from/--to` 缩窗）走的恰恰是
  // 中间那条谁都没断言过的路。都是纯解析，写用例几乎不要钱。

  test('--assets 真的把资产集换掉：all 展开成全八类，csv 按给的顺序取', () => {
    // `all` 是报告 §3 示例命令里用的那个值
    expect(parseWorkerArgs(['--code', 'c', '--assets', 'all'], 4).keys).toEqual(ALL_ASSET_KEYS)
    expect(parseWorkerArgs(['--code', 'c', '--assets', 'all'], 4).keys.length).toBe(8)
    // csv：只要给了这个旗标，就不能再回落到 DEFAULT_ASSET_KEYS
    const csv = parseWorkerArgs(['--code', 'c', '--assets', 'video,ai_minutes'], 4).keys
    expect(csv).toEqual(['video', 'ai_minutes'])
    expect(csv).not.toEqual(DEFAULT_ASSET_KEYS)
    // 未知键必须报错而不是被静默丢掉——静默丢掉等于少归档一类资产且没人知道
    expect(() => parseWorkerArgs(['--code', 'c', '--assets', 'video,nope'], 4)).toThrow(
      'unknown asset key: nope',
    )
  })

  test('--concurrency 覆盖 env 给的默认值（报告 §3 承诺的行为）', () => {
    // 第二个参数是 env 默认值。旗标必须赢，否则 MDE_WORKER_CONCURRENCY 一配死，
    // 临时调并发就只能改环境变量重启。
    expect(parseWorkerArgs(['--code', 'c', '--concurrency', '2'], 4).concurrency).toBe(2)
    expect(parseWorkerArgs(['--code', 'c'], 4).concurrency).toBe(4)
    // 旗标顺序无关：写在选择子前面同样生效
    expect(parseWorkerArgs(['--concurrency', '5', '--code', 'c'], 4).concurrency).toBe(5)
    // 这里**不**校验取值范围，那是 assertConcurrencyFitsPool 的活（启动期）。
    // 解析只负责把数字原样传出去，非数字变成 NaN 交给那道校验去报错。
    expect(Number.isNaN(parseWorkerArgs(['--code', 'c', '--concurrency', 'x'], 4).concurrency)).toBe(
      true,
    )
  })

  test('--code / --meeting-id 可以配 --from/--to 缩窗，窗口真的被带进选择子', () => {
    // 报告 §3 明写支持缩窗。此前唯一的点选用例断的是 from/to 都是 undefined，
    // 也就是说「带上窗口」这条路径一行断言都没有——真丢掉窗口的话，
    // 一个会议号会把该会议历史上所有场次都拉回来。
    expect(parseWorkerArgs(['--code', '881-123-40', '--from', '2026-08-01', '--to', '2026-08-02'], 4).sel).toEqual({
      kind: 'code',
      meetingCode: '881-123-40',
      from: Date.UTC(2026, 7, 1) / 1000,
      to: Date.UTC(2026, 7, 2) / 1000,
    })
    expect(parseWorkerArgs(['--meeting-id', 'm-1', '--from', '1787218200', '--to', '1787304600'], 4).sel).toEqual({
      kind: 'id',
      meetingId: 'm-1',
      from: 1787218200,
      to: 1787304600,
    })
    // 点选时窗口是**可选**的：只给一半也不该退化成 range 分支去报「requires --from and --to」
    expect(parseWorkerArgs(['--code', 'c', '--from', '2026-08-01'], 4).sel).toEqual({
      kind: 'code',
      meetingCode: 'c',
      from: Date.UTC(2026, 7, 1) / 1000,
      to: undefined,
    })
  })

  test('日期解析不掉：既不是 YYYY-MM-DD 又不是数字时报 bad date，而不是悄悄变成 NaN', () => {
    // NaN 会一路穿进 MeetingSelector，腾讯那边收到 NaN 时间窗的行为无人知晓，
    // 而这是运维最容易打错的一个值（2026/08/01、Aug 1 2026、08-01 都会走到这里）。
    expect(() => parseWorkerArgs(['--from', '2026/08/01', '--to', '2026-08-02'], 4)).toThrow(
      'bad date: 2026/08/01',
    )
    expect(() => parseWorkerArgs(['--from', '2026-08-01', '--to', 'tomorrow'], 4)).toThrow(
      'bad date: tomorrow',
    )
    // 月/日必须是两位：'2026-8-1' 不匹配那条正则，也不是数字
    expect(() => parseWorkerArgs(['--from', '2026-8-1', '--to', '2026-08-02'], 4)).toThrow(
      'bad date: 2026-8-1',
    )
  })
})

describe('连接池耗尽时的表现', () => {
  /** 占满整池，返回释放函数——三条用例都要先把 10 条连接全握在手里 */
  async function saturate(pool: Pool): Promise<() => void> {
    const held = await Promise.all(
      Array.from({ length: POOL_CONNECTION_LIMIT }, () => pool.getConnection()),
    )
    return () => held.forEach((c) => c.release())
  }

  test('闸门随并发度缩放，且定在稳态之上一点点', () => {
    // **稳态的等待者是 0**：discover / meetingsForPaths / runProbes 都在 runExecutor
    // 之前串行跑完，执行期每个执行体的 await 链严格串行，所以并发的取连接请求
    // = 并发度（awaited）+ ≤并发度（在途 touchProgress）= 2×并发度 ≤ 10 = 池上限，
    // 全都能拿到连接，排不出队。任何等待者都已经是异常，+2 只是抖动余量。
    //
    // 绑函数而不是绑一个硬编码的数，是因为这道闸门必须**随并发度缩放**：
    // 并发度 1 时是 4，而不是一个与配置无关的常数——撞线更早，异常更早显形。
    expect(poolQueueLimitFor(1)).toBe(4)
    expect(poolQueueLimitFor(4)).toBe(10)
    expect(poolQueueLimitFor(5)).toBe(12)
    for (const c of [1, 2, 3, 4, 5]) {
      expect(poolQueueLimitFor(c)).toBeGreaterThan(c * 2)
    }
  })

  test('worker 实际发货的那个 queueLimit：排不进队的请求当场报错', async () => {
    // 用 poolQueueLimitFor 而不是硬编码的数——否则这条用例证明的只是
    // 「mysql2 的 queueLimit 机制存在」，不是「worker 配的那个值能救它」。
    const limit = poolQueueLimitFor(1)
    const pool = createPool(requireTestDatabaseUrl(), { queueLimit: limit })
    try {
      const release = await saturate(pool)
      // handler 必须**在下面那条断言之前**挂上：断言一旦变红就直接抛出，
      // 这 limit 个 promise 会一直没人接，随后 finally 里的 pool.end() 用
      // 「Pool is closed.」拒绝它们 → limit 条 unhandled rejection 糊在同批
      // 其它用例的输出里，把一条本来清楚的失败变成一堆噪声。
      const queued = Array.from({ length: limit }, () =>
        pool.getConnection().then(
          (c) => ({ ok: true as const, c }),
          (e: unknown) => ({ ok: false as const, e }),
        ),
      )
      // 队列刚好满，再来一个必须立刻被拒绝而不是排上去
      await expect(pool.getConnection()).rejects.toThrow(/[Qq]ueue limit/)
      release()
      for (const q of queued) {
        const r = await q
        if (r.ok) r.c.release()
      }
    } finally {
      await pool.end()
    }
  }, 30_000)

  test('mysql2 的默认 queueLimit=0：同样的情形下静默地等下去，永远不报错', async () => {
    // 这条是上一条的负控制，也是台账第 4 条那个失效模式的实物证据：
    // 默认配置下池耗尽不是"慢"，是**一台看起来还活着、实际什么都不干的机器**。
    const pool = createPool(requireTestDatabaseUrl())
    try {
      const release = await saturate(pool)
      const extra = pool.getConnection()
      // **拒绝原因必须留下来。** 只写 settled=true 的话，这条断言变红时输出只有
      // 「expected true to be false」，一个字都没说为什么 settle 了；而最可能的
      // settle 原因根本不是被测行为变了，是环境——比如并发跑的测试库把 MySQL
      // 连接数顶到上限，getConnection 以 ER_CON_COUNT_ERROR 立刻拒绝。
      // 那种红必须一眼看得出是环境问题，否则下一个人会去查 mysql2 的队列实现。
      let settled = false
      let reason: unknown
      extra.then(
        () => { settled = true },
        (e: unknown) => { settled = true; reason = e },
      )
      await new Promise((r) => setTimeout(r, 200))
      expect({ settled, reason: reason instanceof Error ? reason.message : reason }).toEqual({
        settled: false,
        reason: undefined,
      })
      release()
      ;(await extra).release()
    } finally {
      await pool.end()
    }
  }, 30_000)

  test('闸门只兜住排队长度，兜不住等待时长——队列没满时照样静默等下去', async () => {
    // 这条把 queueLimit 的**射程**钉死，免得 poolQueueLimitFor 的注释里那句
    // 「一旦堆积立刻撞线报错」被读成「池耗尽从此不会挂起」。mysql2 没有取连接
    // 超时：只要队列还没满，排在上面的请求（真正阻塞推进的是 claimNext）
    // 就仍然无限期地等。撞线是**队列满的那一刻**才发生的事，不是池满那一刻。
    const pool = createPool(requireTestDatabaseUrl(), { queueLimit: poolQueueLimitFor(4) })
    try {
      const release = await saturate(pool)
      const waiting = pool.getConnection() // 队列深度 1，远没到 10
      // 同上：拒绝原因要留下来，否则这条红了看不出是被测行为变了还是环境炸了
      let settled = false
      let reason: unknown
      waiting.then(
        () => { settled = true },
        (e: unknown) => { settled = true; reason = e },
      )
      await new Promise((r) => setTimeout(r, 200))
      expect({ settled, reason: reason instanceof Error ? reason.message : reason }).toEqual({
        settled: false,
        reason: undefined,
      })
      release()
      ;(await waiting).release()
    } finally {
      await pool.end()
    }
  }, 30_000)
})

describe('assertConcurrencyFitsPool', () => {
  // 并发度配过头的表现是无限期静默挂起（mysql2 没有取连接超时），运行期兜不住，
  // 所以它必须在启动期就炸，而不是留一台看起来还活着、实际什么都不干的机器。
  test('并发度 × 2 超过池上限时当场报错，错误里写清楚为什么', () => {
    // 5 是**硬上限**（5×2 = 10，余量恰好为零），放行是对的；
    // 默认值取 4 而不是 5，是另一件事——上限是「不会立刻出事」，
    // 默认值是「还给发现阶段与收尾写库留了两条」。
    expect(() => assertConcurrencyFitsPool(4)).not.toThrow()
    expect(() => assertConcurrencyFitsPool(5)).not.toThrow()
    expect(() => assertConcurrencyFitsPool(6)).toThrow(/pool caps at 10/)
    expect(() => assertConcurrencyFitsPool(0)).toThrow(/positive integer/)
    expect(() => assertConcurrencyFitsPool(2.5)).toThrow(/positive integer/)
  })
})

describe('assertArchiveRootUsable', () => {
  test('已存在且可写的目录通过，并原样返回', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mde-root-'))
    try {
      expect(await assertArchiveRootUsable(dir)).toBe(dir)
      // 写探针必须清干净，不能在归档区里留垃圾
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('路径打错（目录不存在）当场报错，而不是把它造出来', async () => {
    // 这条是本校验存在的全部理由：MDE_ARCHIVE_ROOT=/mnt/archiv（少一个 e）
    // 若被 mkdir -p 静默造出来，整场会议会归档进一棵没人知道的目录树，退出码 0。
    // 本系统是「NAS 主存储、本地 30 天后删」，那等于一个月后永久丢失。
    const parent = await mkdtemp(join(tmpdir(), 'mde-root-'))
    const typo = join(parent, 'archiv')
    try {
      await expect(assertArchiveRootUsable(typo)).rejects.toThrow(/does not exist/)
      // 关键断言：报错之后它**仍然不存在**——没有被顺手建出来
      expect(await exists(typo)).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('指向一个文件、或未设置 / 空串时报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mde-root-'))
    const file = join(dir, 'not-a-dir')
    try {
      await writeFile(file, 'x')
      await expect(assertArchiveRootUsable(file)).rejects.toThrow(/not a directory/)
      await expect(assertArchiveRootUsable(undefined)).rejects.toThrow(/missing required config/)
      await expect(assertArchiveRootUsable('')).rejects.toThrow(/missing required config/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('目录存在但不可写时报错——只看权限位看不出只读挂载，要真写一次', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mde-root-'))
    try {
      await chmod(dir, 0o500) // r-x：能进能列，不能写
      await expect(assertArchiveRootUsable(dir)).rejects.toThrow(/not writable/)
    } finally {
      await chmod(dir, 0o700)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('挂死的挂载不会把启动期校验也挂住——写探针超时会喊出来', async () => {
    /**
     * 这条覆盖的是本任务反复要消灭的那个失效形态：**硬挂载掉线时 fs 调用是挂住
     * 而不是报错**，于是「校验全部前置」这道防线自己变成了一次无限期静默挂起。
     *
     * 挂死的网络挂载在本地造不出来，但**没有读者的 FIFO 可以**：`writeFile` 以
     * `O_WRONLY` 打开一个无读者的 FIFO 会**永久阻塞在 open**（POSIX 语义），
     * 超时必赢，不存在竞速——所以这条用例不是时间敏感的。
     *
     * 探针文件名是确定性的（带本进程 pid），测试因此能预先把它做成 FIFO。
     */
    const dir = await mkdtemp(join(tmpdir(), 'mde-root-'))
    const probe = join(dir, `.mde-worker-write-probe-${process.pid}`)
    try {
      const mkfifo = Bun.spawnSync(['mkfifo', probe])
      expect(mkfifo.exitCode).toBe(0) // 造不出 FIFO 就别假装测过了

      const err = await assertArchiveRootUsable(dir, 50).then(
        () => null,
        (e: unknown) => e,
      )

      // 三件事一起断言：确实报错了、是**超时**这一类而不是被翻译成「不可写」、
      // 且错误话里带着路径。把超时误报成「不可写」会让值班的人去查权限，
      // 而真正的毛病是那个挂载点已经没在回应了。
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).toBe('FsTimeoutError')
      expect((err as Error).message).toContain('timed out after 50ms')
      expect((err as Error).message).toContain(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
