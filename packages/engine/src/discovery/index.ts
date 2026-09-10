import type { AssetSource } from '../source/types'
import type { Store } from '../store'
import type { AssetKey, MeetingSelector } from '../domain/types'
import { ASSET_KEY_TO_GATEWAY_TYPE, ASSET_WAIT_CAP_SEC, expectedAssetKeys } from '../domain/types'
import { judgeReadiness } from '../domain/readiness'
import { isSiblingAbsent } from '../domain/sibling'
import { splitWindow } from '../domain/window'

export interface DiscoveryDeps { gw: AssetSource; store: Store }

export async function discover(
  deps: DiscoveryDeps, sel: MeetingSelector, wantedKeys: AssetKey[], now: number,
): Promise<{ meetings: number; tasks: number }> {
  const meetings = await collectMeetings(deps.gw, sel)
  let tasks = 0
  for (const m of meetings) {
    await deps.store.upsertMeeting(m, now)
    const assets = await deps.gw.listAssets(m.meetingId, m.subMeetingId, sel.kind !== 'range' ? sel.from : undefined, sel.kind !== 'range' ? sel.to : undefined)
    // 按录制类型裁剪：转写记录只可能有逐字稿与纪要，其余类型既不建任务也不建探测
    // （见 domain/types.ts 的 expectedAssetKeys）。
    const wantedFields = new Map(expectedAssetKeys(m.recordType, wantedKeys).map((k) => [ASSET_KEY_TO_GATEWAY_TYPE[k], k]))
    for (const [field, key] of wantedFields) {
      const present = assets.filter((a) => a.assetType === field)
      // 同源产物：video 已就绪而 audio 缺席 —— 这场的音频不是「还没出来」，是根本没生成，
      // 探测等的是一个不会到来的答案（见 domain/sibling.ts）。所以不建探测；存量那条
      // probing 行就地放弃。这里刻意不 upsertProbe 再 abandon——不留没人要看的一行。
      if (isSiblingAbsent(field, assets)) {
        await deps.store.abandonProbeIfProbing({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field }, 'not_generated')
        continue
      }
      const rep = present[0]  // 同一 meeting 的同类多段共享 allow_download/state，取代表判定类型级就绪
      const deadlineAt = (m.endTime ?? now) + ASSET_WAIT_CAP_SEC[key]
      const verdict = judgeReadiness({ present: present.length > 0, state: rep?.state, allowDownload: rep?.allowDownload, now, deadlineAt })
      if (verdict === 'ready') {
        for (const a of present) {
          await deps.store.upsertAsset({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, remoteId: a.remoteId, assetId: a.assetId, bytesExpected: a.bytesExpected, fileType: a.fileType }, now)
          tasks++
        }
      } else if (verdict === 'skip_disallowed') {
        // 建行后直接置 skipped（平台明示不可得，不留探测、不空等）
        for (const a of present) {
          await deps.store.upsertAsset({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, remoteId: a.remoteId, assetId: a.assetId }, now)
        }
        await deps.store.markSkippedByKey({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field }, 'download_not_allowed', now)
      } else if (verdict === 'skip_timeout') {
        await deps.store.upsertProbe({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, deadlineAt, probeAfter: 0 })
        await deps.store.abandonProbe({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field }, 'upstream_timeout')
      } else { // wait
        await deps.store.upsertProbe({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, deadlineAt, probeAfter: now })
      }
    }
  }
  return { meetings: meetings.length, tasks }
}

async function collectMeetings(gw: AssetSource, sel: MeetingSelector) {
  // range 模式按 31 天切窗；点选模式网关自带默认窗口
  const windows = sel.kind === 'range' ? splitWindow(sel.from, sel.to) : [null]
  const all = []
  for (const w of windows) {
    const s = w ? ({ kind: 'range', from: w.from, to: w.to } as const) : sel
    let cursor: string | undefined
    do {
      const page = await gw.listMeetings(s, cursor)
      all.push(...page.meetings)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }
  return all
}
