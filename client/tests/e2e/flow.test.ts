import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { parseArgs } from '../../src/cli'
import { cmdRun } from '../../src/cli/commands/run'
import { cmdExecute } from '../../src/cli/commands/execute'
import { cmdDiscover } from '../../src/cli/commands/discover'
import { openDb } from '../../src/store/db'
import { createStore } from '../../src/store'
import { cleanDirName } from '../../src/domain/filename'
import { assetKeyToFilename, type AssetKey } from '../../src/domain/types'
import { startFakeBackend, type RawAsset, type RawMeeting } from './fixture'

/**
 * 端到端 §16 十条必测：真实 CLI 命令（cmdRun/cmdDiscover/cmdExecute）+ 真实假网关（Bun.serve）
 * + 真实 sqlite store + 真实本地文件系统。每条用例独立临时目录、独立假后端，finally 中清理。
 *
 * 场景 8/9（探测超时/探测就绪）与场景 6（崩溃恢复）无法在测试内推进真实墙钟时间，
 * 按任务说明直接经 store 公共方法（upsertMeeting/upsertProbe/bumpProbe，或对 sqlite 的等价写入）
 * 种子出所需的中间状态，再用 cmdExecute 真实驱动后续行为——被驱动的行为本身是真实的。
 */

function epoch(y: number, m: number, d: number, hh = 3, mm = 0): number {
  return Date.UTC(y, m - 1, d, hh, mm) / 1000
}
function isoDate(epochSec: number): string {
  const dt = new Date(epochSec * 1000)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}
function makeContent(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Array.from({ length: n }, (_, i) => i % 256))
}
/** 复刻 src/executor/index.ts 的 buildRelPath，用于测试独立算出预期相对路径以便预置 .part / 断言落地文件 */
function expectedRelPath(meeting: RawMeeting, key: AssetKey, remoteId: string, ext: string): string {
  const d = new Date((meeting.start_time ?? 0) * 1000)
  const yyyy = String(d.getUTCFullYear()), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0')
  const hhmm = String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0')
  const dir = cleanDirName(`${yyyy}-${mm}-${dd}`, hhmm, meeting.subject ?? '', meeting.meeting_code ?? meeting.meeting_id)
  const fname = assetKeyToFilename(key, remoteId, ext)
  return `${yyyy}/${mm}/${dir}/${fname}`
}
async function tmp(): Promise<string> { return mkdtemp(join(tmpdir(), 'mde-e2e-')) }
function env(base: string): Record<string, string> { return { MDE_GATEWAY_URL: base, MDE_CLIENT_ID: 'cid', MDE_CLIENT_SECRET: 'sec' } }
function dbPathOf(root: string): string { return join(root, '.mde/queue.sqlite') }

// ---------------------------------------------------------------------------
// 1 + 2. 默认资产集 / 幂等
// ---------------------------------------------------------------------------
test('01+02 默认资产集：无 --assets 时下载 4 类默认资产；二次 execute 零重复下载（幂等）', async () => {
  const root = await tmp()
  const backend = startFakeBackend()
  try {
    const meeting: RawMeeting = { meeting_id: 'm-default', meeting_code: '10001', subject: '默认资产集会议', start_time: epoch(2026, 7, 15), end_time: epoch(2026, 7, 15) + 3600 }
    backend.setMeetings([meeting])

    const video = makeContent(4000), audio = makeContent(3000), transcript = makeContent(500), aiTranscript = makeContent(600)
    backend.setContent('a-video', video); backend.setContent('a-audio', audio)
    backend.setContent('a-transcript', transcript); backend.setContent('a-ai-transcript', aiTranscript)
    backend.setAssets(meeting.meeting_id, [
      { asset_id: 'a-video', asset_type: 'download_address', remote_id: 'rf-video', allow_download: true, file_type: 'mp4', bytes_expected: video.length },
      { asset_id: 'a-audio', asset_type: 'audio_address', remote_id: 'rf-audio', allow_download: true, file_type: 'm4a', bytes_expected: audio.length },
      { asset_id: 'a-transcript', asset_type: 'meeting_summary', remote_id: 'rf-transcript', allow_download: true, file_type: 'txt', bytes_expected: transcript.length },
      { asset_id: 'a-ai-transcript', asset_type: 'ai_meeting_transcripts', remote_id: 'rf-ai', allow_download: true, file_type: 'txt', bytes_expected: aiTranscript.length },
      // 不在默认清单内的资产类型：证明未被请求下载
      { asset_id: 'a-minutes', asset_type: 'ai_minutes', remote_id: 'rf-minutes', allow_download: true, file_type: 'txt', bytes_expected: 10 },
    ] as RawAsset[])

    const e = env(backend.gatewayBase)
    const code = await cmdRun(parseArgs(['run', '--from', '2026-07-01', '--to', '2026-07-31', '--out', root]), e)
    expect(code).toBe(0)

    const db = openDb(dbPathOf(root)); const store = createStore(db)
    expect(store.counts().completed).toBe(4)
    expect(Object.values(store.counts()).reduce((a, b) => a + b, 0)).toBe(4)   // 恰好 4 个任务，ai_minutes 未建行

    for (const [key, remoteId, expected] of [
      ['video', 'rf-video', video] as const, ['audio', 'rf-audio', audio] as const,
      ['transcript', 'rf-transcript', transcript] as const, ['ai_transcript', 'rf-ai', aiTranscript] as const,
    ]) {
      const ext = key === 'video' ? 'mp4' : key === 'audio' ? 'm4a' : 'txt'
      const rel = expectedRelPath(meeting, key, remoteId, ext)
      const f = Bun.file(join(root, rel))
      expect(await f.exists()).toBe(true)
      expect((await f.arrayBuffer()).byteLength).toBe(expected.length)
    }

    // 幂等：二次 execute 不应再触发任何字节服务器请求
    const before = backend.calls.byteHits.get('a-video') ?? 0
    const code2 = await cmdExecute(parseArgs(['execute', '--out', root]), e)
    expect(code2).toBe(0)
    expect(backend.calls.byteHits.get('a-video') ?? 0).toBe(before)
    expect(store.counts().completed).toBe(4)
  } finally { backend.stop(); await rm(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 3. 断点续传
// ---------------------------------------------------------------------------
test('03 断点续传：中断的 .part 在重跑后续传完成，字节内容完整一致', async () => {
  const root = await tmp()
  const backend = startFakeBackend()
  try {
    const meeting: RawMeeting = { meeting_id: 'm-resume', meeting_code: '20002', subject: '续传测试会议', start_time: epoch(2026, 7, 10), end_time: epoch(2026, 7, 10) + 3600 }
    backend.setMeetings([meeting])
    const content = makeContent(20000)
    backend.setContent('a-resume', content)
    backend.setAssets(meeting.meeting_id, [{ asset_id: 'a-resume', asset_type: 'download_address', remote_id: 'rf-resume', allow_download: true, file_type: 'mp4', bytes_expected: content.length }])

    const e = env(backend.gatewayBase)
    const dcode = await cmdDiscover(parseArgs(['discover', '--from', '2026-07-01', '--to', '2026-07-31', '--out', root]), e)
    expect(dcode).toBe(0)

    const rel = expectedRelPath(meeting, 'video', 'rf-resume', 'mp4')
    const partPath = join(root, rel) + '.part'
    await mkdir(dirname(partPath), { recursive: true })
    await Bun.write(partPath, content.slice(0, 8000))   // 中断在 40% 处

    const code = await cmdExecute(parseArgs(['execute', '--out', root]), e)
    expect(code).toBe(0)

    const final = new Uint8Array(await Bun.file(join(root, rel)).arrayBuffer())
    expect(final.length).toBe(content.length)
    expect(final).toEqual(content)
    const starts = backend.calls.byteRangeStarts.get('a-resume') ?? []
    expect(starts.some((s) => s > 0)).toBe(true)   // 证明确实发生了 Range 续传，而非整档重下

    const store = createStore(openDb(dbPathOf(root)))
    expect(store.counts().completed).toBe(1)
  } finally { backend.stop(); await rm(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 4. 链接过期（403）
// ---------------------------------------------------------------------------
test('04 链接过期：首链 403 → 客户端换新链续传，最终完整下载', async () => {
  const root = await tmp()
  const backend = startFakeBackend()
  try {
    const meeting: RawMeeting = { meeting_id: 'm-expire', meeting_code: '30003', subject: '链接过期测试会议', start_time: epoch(2026, 7, 12), end_time: epoch(2026, 7, 12) + 3600 }
    backend.setMeetings([meeting])
    const content = makeContent(6000)
    backend.setContent('a-expire', content)
    backend.setFlaky('a-expire', 1)
    backend.setAssets(meeting.meeting_id, [{ asset_id: 'a-expire', asset_type: 'download_address', remote_id: 'rf-expire', allow_download: true, file_type: 'mp4', bytes_expected: content.length }])

    const e = env(backend.gatewayBase)
    const code = await cmdRun(parseArgs(['run', '--from', '2026-07-01', '--to', '2026-07-31', '--out', root]), e)
    expect(code).toBe(0)

    const rel = expectedRelPath(meeting, 'video', 'rf-expire', 'mp4')
    expect((await Bun.file(join(root, rel)).arrayBuffer()).byteLength).toBe(content.length)
    expect(backend.calls.downloadUrl.get('a-expire') ?? 0).toBeGreaterThanOrEqual(2)   // 换过链
    expect(backend.calls.byteHits.get('a-expire') ?? 0).toBeGreaterThanOrEqual(2)      // 403 一次 + 成功一次
  } finally { backend.stop(); await rm(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 5. 本地 .part 大于远端（416）
// ---------------------------------------------------------------------------
test('05 416：本地 .part 大于远端内容 → 丢弃重下，最终字节数正确', async () => {
  const root = await tmp()
  const backend = startFakeBackend()
  try {
    const meeting: RawMeeting = { meeting_id: 'm-416', meeting_code: '40004', subject: '416测试会议', start_time: epoch(2026, 7, 14), end_time: epoch(2026, 7, 14) + 3600 }
    backend.setMeetings([meeting])
    const content = makeContent(5000)
    backend.setContent('a-416', content)
    backend.setAssets(meeting.meeting_id, [{ asset_id: 'a-416', asset_type: 'download_address', remote_id: 'rf-416', allow_download: true, file_type: 'mp4', bytes_expected: content.length }])

    const e = env(backend.gatewayBase)
    const dcode = await cmdDiscover(parseArgs(['discover', '--from', '2026-07-01', '--to', '2026-07-31', '--out', root]), e)
    expect(dcode).toBe(0)

    const rel = expectedRelPath(meeting, 'video', 'rf-416', 'mp4')
    const partPath = join(root, rel) + '.part'
    await mkdir(dirname(partPath), { recursive: true })
    await Bun.write(partPath, makeContent(content.length + 500))   // 本地 .part 比远端大 500 字节

    const code = await cmdExecute(parseArgs(['execute', '--out', root]), e)
    expect(code).toBe(0)

    const final = await Bun.file(join(root, rel)).arrayBuffer()
    expect(final.byteLength).toBe(content.length)   // 而非 oversized 的 5500
    const starts = backend.calls.byteRangeStarts.get('a-416') ?? []
    expect(starts.some((s) => s >= content.length)).toBe(true)   // 证明确实触发过一次超范围请求（416）

    const store = createStore(openDb(dbPathOf(root)))
    expect(store.counts().completed).toBe(1)
  } finally { backend.stop(); await rm(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 6. 崩溃恢复：running 且租约过期的行被下次 execute 领取
// ---------------------------------------------------------------------------
test('06 崩溃恢复：running 且租约已过期的行被下一次 execute 重新领取并完成', async () => {
  const root = await tmp()
  const backend = startFakeBackend()
  try {
    const meeting: RawMeeting = { meeting_id: 'm-crash', meeting_code: '50005', subject: '崩溃恢复测试会议', start_time: epoch(2026, 7, 16), end_time: epoch(2026, 7, 16) + 3600 }
    backend.setMeetings([meeting])
    const content = makeContent(3000)
    backend.setContent('a-crash', content)
    backend.setAssets(meeting.meeting_id, [{ asset_id: 'a-crash', asset_type: 'download_address', remote_id: 'rf-crash', allow_download: true, file_type: 'mp4', bytes_expected: content.length }])

    const e = env(backend.gatewayBase)
    const dcode = await cmdDiscover(parseArgs(['discover', '--from', '2026-07-01', '--to', '2026-07-31', '--out', root]), e)
    expect(dcode).toBe(0)

    // 模拟“上一次进程在下载途中被杀死”：留下一行 running 且租约已过期的记录（不经 Store 接口，直接写库，
    // 因为这是崩溃后遗留的异常状态，公共 Store 接口本身不提供构造它的方法）
    const db = openDb(dbPathOf(root))
    const past = Math.floor(Date.now() / 1000) - 1000
    db.query(`UPDATE assets SET status='running', lease_expires_at=?, attempts=1 WHERE meeting_id=?`).run(past, meeting.meeting_id)
    const before = db.query(`SELECT status, lease_expires_at FROM assets WHERE meeting_id=?`).get(meeting.meeting_id) as any
    expect(before.status).toBe('running')

    const code = await cmdExecute(parseArgs(['execute', '--out', root]), e)
    expect(code).toBe(0)

    const store = createStore(openDb(dbPathOf(root)))
    expect(store.counts().completed).toBe(1)
    const rel = expectedRelPath(meeting, 'video', 'rf-crash', 'mp4')
    expect((await Bun.file(join(root, rel)).arrayBuffer()).byteLength).toBe(content.length)
  } finally { backend.stop(); await rm(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 7. 31 天切分
// ---------------------------------------------------------------------------
test('07 31天切分：>31天范围产生多个 discover 窗口，且全部会议被发现', async () => {
  const root = await tmp()
  const backend = startFakeBackend()
  try {
    const fromEpoch = epoch(2020, 1, 1)
    const toEpoch = fromEpoch + 75 * 86400   // 75 天跨度 → 3 个 ≤31 天窗口
    const fromStr = isoDate(fromEpoch), toStr = isoDate(toEpoch)

    const meetings: RawMeeting[] = [
      { meeting_id: 'w1', meeting_code: '60001', subject: 'window1', start_time: fromEpoch + 1000, end_time: fromEpoch + 2000 },
      { meeting_id: 'w2', meeting_code: '60002', subject: 'window2', start_time: fromEpoch + 35 * 86400, end_time: fromEpoch + 35 * 86400 + 1000 },
      { meeting_id: 'w3', meeting_code: '60003', subject: 'window3', start_time: fromEpoch + 65 * 86400, end_time: fromEpoch + 65 * 86400 + 1000 },
    ]
    backend.setMeetings(meetings)

    const e = env(backend.gatewayBase)
    const code = await cmdDiscover(parseArgs(['discover', '--from', fromStr, '--to', toStr, '--out', root]), e)
    expect(code).toBe(0)

    expect(backend.calls.meetingsWindows.size).toBeGreaterThan(1)   // 确实拆成了多个窗口请求
    const db = openDb(dbPathOf(root))
    const row = db.query(`SELECT COUNT(*) c FROM meetings`).get() as { c: number }
    expect(row.c).toBe(3)   // 三个窗口里的会议都被发现，无遗漏无重复
  } finally { backend.stop(); await rm(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 8. 探测超时
// ---------------------------------------------------------------------------
test('08 探测超时：到期仍未就绪的探测被判定 abandoned，不建任务、不崩溃', async () => {
  const root = await tmp()
  const backend = startFakeBackend()
  try {
    const meetingId = 'm-timeout'
    const nowSec = Math.floor(Date.now() / 1000)
    const db = openDb(dbPathOf(root)); const store = createStore(db)
    store.upsertMeeting({ meetingId, subMeetingId: '', meetingCode: '70001', subject: '超时探测会议', hostUserId: null, startTime: nowSec - 200000, endTime: nowSec - 200000 }, nowSec)
    store.upsertProbe({ meetingId, subMeetingId: '', assetType: 'download_address', deadlineAt: nowSec - 10, probeAfter: nowSec - 5 })
    backend.setAssets(meetingId, [])   // 资产从未出现在网关清单里

    const e = env(backend.gatewayBase)
    const code = await cmdExecute(parseArgs(['execute', '--out', root]), e)
    expect(code).toBe(0)   // 无崩溃、正常退出

    expect(Object.values(store.counts()).reduce((a, b) => a + b, 0)).toBe(0)   // 没有建任何 asset 行
    const probeRow = db.query(`SELECT state FROM asset_probes WHERE meeting_id=? AND asset_type=?`).get(meetingId, 'download_address') as { state: string }
    expect(probeRow.state).toBe('abandoned')
  } finally { backend.stop(); await rm(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 9. 探测就绪
// ---------------------------------------------------------------------------
test('09 探测就绪：资产第一次探测缺席，延迟出现后被后续探测发现并下载', async () => {
  const root = await tmp()
  const backend = startFakeBackend()
  try {
    const meetingId = 'm-ready-later'
    const meeting: RawMeeting = { meeting_id: meetingId, meeting_code: '80001', subject: '延迟纪要会议', start_time: epoch(2026, 7, 18), end_time: epoch(2026, 7, 18) + 3600 }
    const nowSec = Math.floor(Date.now() / 1000)
    const db = openDb(dbPathOf(root)); const store = createStore(db)
    store.upsertMeeting({ meetingId, subMeetingId: '', meetingCode: meeting.meeting_code!, subject: meeting.subject!, hostUserId: null, startTime: meeting.start_time!, endTime: meeting.end_time! }, nowSec)
    store.upsertProbe({ meetingId, subMeetingId: '', assetType: 'ai_meeting_transcripts', deadlineAt: nowSec + 3600, probeAfter: nowSec - 5 })
    backend.setAssets(meetingId, [])   // 第一次探测：仍未出现

    const e = env(backend.gatewayBase)
    const code1 = await cmdExecute(parseArgs(['execute', '--out', root]), e)
    expect(code1).toBe(0)
    expect(Object.values(store.counts()).reduce((a, b) => a + b, 0)).toBe(0)   // 仍在等待，未建任务
    let probeRow = db.query(`SELECT state FROM asset_probes WHERE meeting_id=? AND asset_type=?`).get(meetingId, 'ai_meeting_transcripts') as { state: string }
    expect(probeRow.state).toBe('probing')

    // 延迟后资产就绪 + 到达下一轮探测时间点（用 bumpProbe 模拟到达下一次 cron 触发点，而非真实等待退避时长）
    const content = makeContent(700)
    backend.setContent('a-ready-later', content)
    backend.setAssets(meetingId, [{ asset_id: 'a-ready-later', asset_type: 'ai_meeting_transcripts', remote_id: 'rf-ready-later', allow_download: true, file_type: 'txt', bytes_expected: content.length }])
    store.bumpProbe({ meetingId, subMeetingId: '', assetType: 'ai_meeting_transcripts' }, nowSec - 1)

    const code2 = await cmdExecute(parseArgs(['execute', '--out', root]), e)
    expect(code2).toBe(0)
    expect(store.counts().completed).toBe(1)
    probeRow = db.query(`SELECT state FROM asset_probes WHERE meeting_id=? AND asset_type=?`).get(meetingId, 'ai_meeting_transcripts') as { state: string }
    expect(probeRow.state).toBe('resolved')

    const rel = expectedRelPath(meeting, 'ai_transcript', 'rf-ready-later', 'txt')
    expect(await Bun.file(join(root, rel)).exists()).toBe(true)
  } finally { backend.stop(); await rm(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 10. 令牌过期
// ---------------------------------------------------------------------------
test('10 令牌过期：业务调用中途 401 → 网关客户端透明续期，流程仍完整完成', async () => {
  const root = await tmp()
  const backend = startFakeBackend({ tokenExpiresIn: 5 })
  try {
    const meeting: RawMeeting = { meeting_id: 'm-token', meeting_code: '90001', subject: '令牌过期测试会议', start_time: epoch(2026, 7, 20), end_time: epoch(2026, 7, 20) + 3600 }
    backend.setMeetings([meeting])
    backend.expireFirstTokenOnce()
    const content = makeContent(900)
    backend.setContent('a-token', content)
    backend.setAssets(meeting.meeting_id, [{ asset_id: 'a-token', asset_type: 'download_address', remote_id: 'rf-token', allow_download: true, file_type: 'mp4', bytes_expected: content.length }])

    const e = env(backend.gatewayBase)
    const code = await cmdRun(parseArgs(['run', '--from', '2026-07-01', '--to', '2026-07-31', '--out', root]), e)
    expect(code).toBe(0)

    expect(backend.calls.token).toBeGreaterThanOrEqual(2)   // 首个 token 被拒 → 透明重取
    const rel = expectedRelPath(meeting, 'video', 'rf-token', 'mp4')
    expect((await Bun.file(join(root, rel)).arrayBuffer()).byteLength).toBe(content.length)
  } finally { backend.stop(); await rm(root, { recursive: true, force: true }) }
})
