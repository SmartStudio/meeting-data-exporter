import type { GatewayClient } from '../gateway/client'
import type { Store } from '../store'
import type { AssetKey, MeetingSelector } from '../domain/types'
import { ASSET_KEY_TO_FIELD, ASSET_WAIT_CAP_SEC } from '../domain/types'
import { judgeReadiness } from '../domain/readiness'
import { splitWindow } from '../domain/window'

export interface DiscoveryDeps { gw: GatewayClient; store: Store; now: () => number }

export async function discover(
  deps: DiscoveryDeps, sel: MeetingSelector, wantedKeys: AssetKey[], now: number,
): Promise<{ meetings: number; tasks: number }> {
  const meetings = await collectMeetings(deps.gw, sel)
  let tasks = 0
  const wantedFields = new Map(wantedKeys.map((k) => [ASSET_KEY_TO_FIELD[k], k]))
  for (const m of meetings) {
    deps.store.upsertMeeting(m, now)
    const assets = await deps.gw.listAssets(m.meetingId, sel.kind !== 'range' ? sel.from : undefined, sel.kind !== 'range' ? sel.to : undefined)
    const presentByField = new Map(assets.map((a) => [a.assetType, a]))
    for (const [field, key] of wantedFields) {
      const a = presentByField.get(field)
      const deadlineAt = (m.endTime ?? now) + ASSET_WAIT_CAP_SEC[key]
      const verdict = judgeReadiness({ present: !!a, state: a?.state, allowDownload: a?.allowDownload, now, deadlineAt })
      if (verdict === 'ready') {
        deps.store.upsertAsset({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, remoteId: a!.remoteId, bytesExpected: a!.bytesExpected, fileType: a!.fileType }, now)
        tasks++
      } else if (verdict === 'skip_disallowed') {
        // 建行后直接置 skipped（平台明示不可得，不留探测、不空等）
        deps.store.upsertAsset({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, remoteId: a!.remoteId }, now)
        deps.store.markSkippedByKey({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field }, 'download_not_allowed', now)
      } else if (verdict === 'skip_timeout') {
        deps.store.upsertProbe({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, deadlineAt, probeAfter: 0 })
        deps.store.abandonProbe({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field }, 'upstream_timeout')
      } else { // wait
        deps.store.upsertProbe({ meetingId: m.meetingId, subMeetingId: m.subMeetingId, assetType: field, deadlineAt, probeAfter: now })
      }
    }
  }
  return { meetings: meetings.length, tasks }
}

async function collectMeetings(gw: GatewayClient, sel: MeetingSelector) {
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
