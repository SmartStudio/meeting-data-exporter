import type { Meeting } from '../domain/types'
import { MeetingNotFoundInRangeError, normalizeMeetingCode, type RecordsApi } from '../tencent/records'
import type { MeetingCacheStore } from './meetings'

/**
 * 网关进程看会议的唯一出口：只读 `meeting_cache`，一次腾讯都不调。
 *
 * 活路 `createRecordsApi` 仍归调度器用——它每 15 分钟把最近 24 小时的会议写透进
 * 缓存，网关手里于是已有采集程序要的全部数据。此前网关对每次列会议都实时枚举
 * `/v1/corp/records`（10 次/分，每页 20 场），31 天窗口要翻几分钟，2026-09-20
 * 生产实测请求在 8 秒后就被切断。
 *
 * 代价：列表说的是「调度器已经存下来的会议」，不是「腾讯此刻有的会议」。上线前
 * 24 小时以前的会议要靠调度器补跑窗口，未命中的提示要把这一点说出来。
 */
export const STORED_LOOKUP_NOTE =
  "The gateway serves meetings from its own store, filled by the scheduler every 15 minutes " +
  'for the last 24 hours (MDE_SCHEDULER_FETCH_LOOKBACK_HOURS). Older meetings must be ' +
  'backfilled by re-running the scheduler over that window (or from the console) before ' +
  'they become visible here.'

export function createStoredRecordsApi(cache: MeetingCacheStore): RecordsApi {
  return {
    async listMeetings(selector) {
      if (selector.kind === 'range') return cache.listByRange(selector.from, selector.to)

      // 与活路同一条归一：人手输入的会议号常带横杠，缓存里存的是纯数字串
      const hit =
        selector.kind === 'code'
          ? await cache.listByMeetingCode(normalizeMeetingCode(selector.meetingCode), selector.from, selector.to)
          : await cache.listByMeetingId(selector.meetingId, selector.from, selector.to)
      if (hit.length > 0) return hit

      const identifier = selector.kind === 'code' ? selector.meetingCode : selector.meetingId
      throw new MeetingNotFoundInRangeError(identifier, selector.from ?? null, selector.to ?? null, STORED_LOOKUP_NOTE)
    },
  }
}
