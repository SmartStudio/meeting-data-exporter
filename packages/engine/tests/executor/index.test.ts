import { expect, test, spyOn } from 'bun:test'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { downloadBackoff, runExecutor, runProbes } from '../../src/executor'
import { meetingPathKey } from '../../src/domain/types'
// 用真实 store + 假 downloadAsset（注入）+ 临时目录

test('并发池领任务并下载，全部 completed；幂等重跑零下载', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  for (const rid of ['r1', 'r2', 'r3']) await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: rid, bytesExpected: 10, fileType: 'mp4' }, 1)
  let downloads = 0
  const fakeDownload = async () => { downloads++; return { status: 'completed' as const, contentHash: null, bytesWritten: 10 } }
  const deps: any = { store, download: fakeDownload, gw: {}, storage: { ensureFreeSpace: async () => true }, meetingsByPathKey: new Map([[meetingPathKey('m1', ''), { meetingId: 'm1', subMeetingId: '', subject: 's', startTime: 100, meetingCode: null, endTime: null }]]) }
  const r1 = await runExecutor(deps, { concurrency: 2, leaseSec: 300 }, () => 1000)
  expect(r1.completed).toBe(3)
  expect(downloads).toBe(3)
  const r2 = await runExecutor(deps, { concurrency: 2, leaseSec: 300 }, () => 2000)  // 幂等
  expect(r2.completed).toBe(0)
  expect(downloads).toBe(3)   // 第二次零下载
})

test('磁盘不足 → 该任务 skipped(disk_full)，不写半截', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)
  const deps: any = { store, download: async () => ({ status: 'completed', contentHash: null, bytesWritten: 10 }), gw: {}, storage: { ensureFreeSpace: async () => false }, meetingsByPathKey: new Map([[meetingPathKey('m1', ''), { meetingId: 'm1', subMeetingId: '', subject: 's', startTime: 100, meetingCode: null, endTime: null }]]) }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
  expect(r.skipped).toBe(1)
})

test('同一会议同类多段文本 → 输出路径不碰撞', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  for (const rid of ['rf1', 'rf2']) await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: rid, fileType: 'pdf' }, 1)
  const paths: string[] = []
  const deps: any = { store, download: async (t: any) => { paths.push(t.relPath); return { status: 'completed', contentHash: null, bytesWritten: 7 } }, gw: {}, storage: { ensureFreeSpace: async () => true }, meetingsByPathKey: new Map([[meetingPathKey('m1', ''), { meetingId: 'm1', subMeetingId: '', subject: 's', startTime: 100, meetingCode: null, endTime: null }]]) }
  const r = await runExecutor(deps, { concurrency: 2, leaseSec: 300 }, () => 1000)
  expect(r.completed).toBe(2)
  expect(new Set(paths).size).toBe(2)                        // 两个路径不同 —— 不碰撞
  expect(paths.some((p) => p.endsWith('transcript_2.pdf'))).toBe(true)
})

test('两个场次各落各的目录：buildRelPath 按 (meeting_id, sub_meeting_id) 查', async () => {
  const s = createStore(openDb(':memory:'))
  await s.upsertMeeting({ meetingId: 'm1', subMeetingId: 'rec-1', meetingCode: '881', subject: 's', hostUserId: 'h', startTime: 0, endTime: 0 }, 1)
  await s.upsertMeeting({ meetingId: 'm1', subMeetingId: 'rec-2', meetingCode: '881', subject: 's', hostUserId: 'h', startTime: 86400, endTime: 86400 }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: 'rec-1', assetType: 'meeting_summary', remoteId: 'r1', fileType: 'txt' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: 'rec-2', assetType: 'meeting_summary', remoteId: 'r2', fileType: 'txt' }, 1)

  const paths: string[] = []
  const deps: any = {
    store: s,
    download: async (t: any) => { paths.push(t.relPath); return { status: 'completed', contentHash: null, bytesWritten: 1 } },
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: await s.meetingsForPaths(),
  }
  await runExecutor(deps, { concurrency: 1, leaseSec: 60 }, () => 1)

  // 两个目录，且各自的文件名都不带 _2 后缀——分组变小之后同类只剩一个
  expect(paths.sort()).toEqual([
    '1970/01/1970-01-01_0000_881/transcript.txt',
    '1970/01/1970-01-02_0000_881/transcript.txt',
  ])
})

/**
 * 同一分钟的两条录制记录（腾讯的「转写_」孪生记录：media_start_time 与正常录制
 * 完全相同）。主题不进目录名，会议号也一样，所以两场会议会算出同名目录——
 * 各自的 transcript.txt 互相覆盖。第二条的目录名带序号后缀才分得开。
 */
test('同一分钟的两条录制记录：第二条落进带 _2 后缀的目录，互不覆盖', async () => {
  const s = createStore(openDb(':memory:'))
  const base = { meetingId: 'm1', meetingCode: '881', subject: 's', hostUserId: 'h', endTime: 0 }
  await s.upsertMeeting({ ...base, subMeetingId: 'rec-1', startTime: 0 }, 1)
  await s.upsertMeeting({ ...base, subMeetingId: 'rec-2', subject: '转写_s', startTime: 30 }, 1)   // 同一分钟
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: 'rec-1', assetType: 'meeting_summary', remoteId: 'r1', fileType: 'txt' }, 1)
  await s.upsertAsset({ meetingId: 'm1', subMeetingId: 'rec-2', assetType: 'meeting_summary', remoteId: 'r2', fileType: 'txt' }, 1)

  const paths: string[] = []
  const deps: any = {
    store: s,
    download: async (t: any) => { paths.push(t.relPath); return { status: 'completed', contentHash: null, bytesWritten: 1 } },
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: await s.meetingsForPaths(),
  }
  await runExecutor(deps, { concurrency: 1, leaseSec: 60 }, () => 1)

  expect(paths.sort()).toEqual([
    '1970/01/1970-01-01_0000_881/transcript.txt',
    '1970/01/1970-01-01_0000_881_2/transcript.txt',
  ])
})

// ---------------------------------------------------------------------------
// 回归：touchProgress 写库失败不该吞错——Task 3 code review 发现的问题
// （见 packages/engine/src/executor/index.ts 的 onProgress 回调注释）：
// 早期实现用 `void deps.store.touchProgress(...)` 丢弃了这个 Promise，写库失败
// 时错误被彻底吞掉，MySQL 宿主下这条路是按下载块高频触发的池化连接 UPDATE，
// deadlock / connection reset 都很现实。修复后改成 `.catch(e => console.warn(...))`：
// 下载仍然完成（进度回写是尽力而为，不该中断下载），但错误必须留下痕迹。
// ---------------------------------------------------------------------------
test('touchProgress 写库失败不中断下载，但错误会被 console.warn 记录，不是静默吞掉', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)

  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    // 其余方法透传真实 store，只让 touchProgress 强制失败，模拟写库出错（如连接池超时）
    const flakyStore = { ...store, async touchProgress() { throw new Error('boom') } }
    const deps: any = {
      store: flakyStore,
      download: async (_task: any, onProgress: any) => {
        onProgress(5)               // 触发 touchProgress，其 rejection 由 .catch 接住
        await Promise.resolve()     // 让上面那个 microtask（console.warn）先跑完，再往下断言
        return { status: 'completed', contentHash: null, bytesWritten: 5 }
      },
      gw: {},
      storage: { ensureFreeSpace: async () => true },
      meetingsByPathKey: new Map([[meetingPathKey('m1', ''), {
        meetingId: 'm1', subMeetingId: '', subject: 's',
        startTime: 100, meetingCode: null, endTime: null,
      }]]),
    }
    const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
    expect(r.completed).toBe(1)        // 下载仍然完成，没被进度写库失败打断
    expect(warnSpy).toHaveBeenCalled() // 但错误留下了痕迹，没被静默吞掉
  } finally {
    warnSpy.mockRestore()
  }
})

// ---------------------------------------------------------------------------
// completed 那一刻把**真实文件大小**落库。
//
// 真实环境里平台不给 bytes_expected（2026-08-26 联调实测），而 touchProgress 写进
// bytes_written 的是每 8MB 一次的进度检查点——最后一次检查点与文件真实大小之间
// 永远差着最后那不足 8MB 的一截。markCompleted 必须用下载器报回来的累加值覆盖它，
// 否则「这个文件多大」这个事实全流程无人知道。
// ---------------------------------------------------------------------------
test('markCompleted 把下载器报的真实字节数写进 bytes_written，覆盖掉进度检查点', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  // 平台没声明大小——真实环境的形态
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', fileType: 'mp4' }, 1)

  const CHECKPOINT = 8 * 1024 * 1024        // 最后一次 8MB 进度回调
  const REAL = CHECKPOINT + 12_345          // 真实文件大小：检查点之后还写了不到 8MB
  const deps: any = {
    store,
    download: async (_t: any, onProgress: any) => {
      onProgress(CHECKPOINT)                // 先让检查点落库
      await Promise.resolve()
      return { status: 'completed', contentHash: null, bytesWritten: REAL }
    },
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: new Map([[meetingPathKey('m1', ''), {
      meetingId: 'm1', subMeetingId: '', subject: 's',
      startTime: 100, meetingCode: null, endTime: null,
    }]]),
  }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)

  expect(r.completed).toBe(1)
  const row = (await store.assetsForMeeting('m1', ''))[0]!
  expect(row.status).toBe('completed')
  expect(row.bytes_written).toBe(REAL)      // 不是 CHECKPOINT
})


// ---------------------------------------------------------------------------
// 失败重试的整条曲线：5 → 10 → 20 → 40 分钟，第 5 次转 dead。
//
// 这条用例钉的是修复之前那个洞：`failed` 曾经是事实上的终态（claim 领不到、
// upsert 不重置、resetFailed 服务端没人调），于是 attempts 永远停在 1，
// MAX_ATTEMPTS 那道门根本走不到——一个视频只要网络抖一次就永久卡住，
// 而且在任何界面上都看不见。
//
// 用可推进的假时钟而不是真时间：曲线本身就是"等多久"，真等 75 分钟不现实。
// 每一轮把时钟推到上一轮写下的重试时间之后一秒，等价于"退避到点了"。
// ---------------------------------------------------------------------------
test('下载一直失败：按 5/10/20/40 分钟退避重试，第 5 次转 dead', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', bytesExpected: 10, fileType: 'mp4' }, 1)

  let clock = 1000
  let downloads = 0
  const deps: any = {
    store,
    download: async () => { downloads++; return { status: 'failed' as const, error: 'HTTP 500' } },
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: new Map([[meetingPathKey('m1', ''), {
      meetingId: 'm1', subMeetingId: '', subject: 's',
      startTime: 100, meetingCode: null, endTime: null,
    }]]),
  }
  const row = async () => (await store.assetsForMeeting('m1', ''))[0]!

  // 前四次失败：状态回 failed，lease_expires_at 是下一次可领的时刻
  for (const [attempt, backoff] of [[1, 300], [2, 600], [3, 1200], [4, 2400]] as const) {
    const at = clock
    const r = await runExecutor(deps, { concurrency: 1, leaseSec: 900 }, () => clock)
    expect(r.failed).toBe(1)
    const a = await row()
    expect(a.status).toBe('failed')
    expect(a.attempts).toBe(attempt)
    expect(a.lease_expires_at).toBe(at + backoff)
    // 同一轮里执行体会再领一次——退避没到点，它领不到，于是这一轮就此收工。
    // （领得到的话这个 for 循环里 downloads 会暴涨，下面那个断言会当场炸。）
    clock = a.lease_expires_at! + 1
  }
  expect(downloads).toBe(4)

  // 第五次：claimNext 把 attempts 顶到 5 = MAX_ATTEMPTS，失败即放弃
  const last = await runExecutor(deps, { concurrency: 1, leaseSec: 900 }, () => clock)
  expect(last.failed).toBe(1)
  const dead = await row()
  expect(dead.status).toBe('dead')
  expect(dead.attempts).toBe(5)
  expect(dead.last_error).toBe('HTTP 500')
  expect(dead.lease_expires_at).toBeNull()   // 终态：不再有"下次什么时候领"

  // 从第一次失败到放弃，一共 5 + 10 + 20 + 40 = 75 分钟
  expect(clock - 1000).toBe(75 * 60 + 4)     // 四次各多推的那 1 秒
  // dead 之后再跑多少轮都不会有人碰它——这正是"必须让操作员看见"的理由，
  // 失败项那一条在 tests/worker/scheduler.test.ts
  await runExecutor(deps, { concurrency: 1, leaseSec: 900 }, () => clock + 86_400)
  expect(downloads).toBe(5)
})

test('downloadBackoff 的曲线与上限', () => {
  // 实际会用到的只有前四个：第 5 次失败直接转 dead，不再退避
  expect([1, 2, 3, 4].map(downloadBackoff)).toEqual([300, 600, 1200, 2400])
  // 上限从第 5 次起生效（裸算是 4800）。它是给将来调大 MAX_ATTEMPTS 的人兜底的：
  // 没有它，第 8 次失败要等 10 小时
  expect(downloadBackoff(5)).toBe(3600)
  expect(downloadBackoff(8)).toBe(3600)
})

test('runProbes 反查资产时带上探测行的场次——同 meeting_id 别的场次的资产不该把它判成就绪', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: 'rec-1', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: 'rec-2', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 300, endTime: 400 }, 1)
  // 只有 rec-1 在等 video；rec-2 那一场的 video 早就在了
  await store.upsertProbe({ meetingId: 'm1', subMeetingId: 'rec-1', assetType: 'video', deadlineAt: 99999, probeAfter: 0 })

  const seen: Array<[string, string]> = []
  const gw = {
    listAssets: async (id: string, sub: string) => {
      seen.push([id, sub])
      return sub === 'rec-2'
        ? [{ assetId: 'm1:rec-2:video:0', assetType: 'video', remoteId: 'rf2', state: 3, allowDownload: true, bytesExpected: 1, fileType: 'mp4' }]
        : []
    },
  }
  const deps: any = { store, gw, download: async () => ({ status: 'completed', contentHash: null, bytesWritten: 1 }), storage: { ensureFreeSpace: async () => true }, meetingsByPathKey: new Map() }

  const r = await runProbes(deps, () => 1000)
  expect(seen).toEqual([['m1', 'rec-1']])
  expect(r.resolved).toBe(0)          // rec-2 的那一段不算 rec-1 就绪
  expect((await store.counts()).pending).toBe(0)
})

// ---------------------------------------------------------------------------
// 「平台没有这个文件」不是失败，是一个确定的答案。
//
// 走退避 → dead 的代价不是多试五次，是**留下一条永远处理不掉的失败项**：dead 是
// 终态，`recordDeadAssets` 每轮把它重记一遍，运维在「失败项 · 需要处理」上看到的
// 是一件永远没人能修好的事。skipped 是「确认取不到」，清单里写得明明白白，
// 而且不计入归档判定（completed 数 > archived 数），不再拖住会议的「已归档」。
// ---------------------------------------------------------------------------
test('下载器报 permanent：转 skipped(upstream_missing)，不进 failed 也不进 dead', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', fileType: 'mp4' }, 1)
  const deps: any = {
    store,
    download: async () => ({ status: 'failed' as const, error: 'http 404', permanent: true }),
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: new Map([[meetingPathKey('m1', ''), { meetingId: 'm1', subMeetingId: '', subject: 's', startTime: 100, meetingCode: null, endTime: null }]]),
  }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
  expect(r).toEqual({ completed: 0, failed: 0, skipped: 1 })

  const row = (await store.assetsForMeeting('m1', ''))[0]!
  expect(row.status).toBe('skipped')
  expect(row.last_error).toBe('upstream_missing')
  expect(row.lease_expires_at).toBeNull()
  expect(row.attempts).toBe(1)                              // 第一次就定案，没有五次退避
  expect(await store.claimNext(99_999, 300)).toBeNull()      // 队列下一轮也不会再领它
})

test('permanent 只对带这个标记的结果生效：普通 failed 照旧走退避', async () => {
  const store = createStore(openDb(':memory:'))
  await store.upsertMeeting({ meetingId: 'm1', subMeetingId: '', meetingCode: '88', subject: 's', hostUserId: 'h', startTime: 100, endTime: 200 }, 1)
  await store.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', fileType: 'mp4' }, 1)
  const deps: any = {
    store,
    download: async () => ({ status: 'failed' as const, error: 'http 500' }),
    gw: {},
    storage: { ensureFreeSpace: async () => true },
    meetingsByPathKey: new Map([[meetingPathKey('m1', ''), { meetingId: 'm1', subMeetingId: '', subject: 's', startTime: 100, meetingCode: null, endTime: null }]]),
  }
  const r = await runExecutor(deps, { concurrency: 1, leaseSec: 300 }, () => 1000)
  expect(r.failed).toBe(1)
  expect((await store.assetsForMeeting('m1', ''))[0]!.status).toBe('failed')
})
