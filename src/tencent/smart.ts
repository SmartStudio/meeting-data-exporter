import type { TencentClient } from './client'
import { TencentApiError } from './errors'

/**
 * 腾讯「智能录制管理」两个接口的封装：
 *   GET /v1/smart/minutes/{record_file_id}   智能纪要（109458）
 *   GET /v1/smart/chapters?record_file_id=   智能章节（105658）
 *
 * 两者走 AK/SK，**不要 STS-Token**——STS 文档（127651）列的「数据敏感」接口只有
 * 「查询单个录制详情」与「查询录制转写详情」两个。2026-09-08 对生产租户实调验证。
 *
 * 纪要固定用平台默认模板（不传 llm / minute_type）：腾讯录制页的「纪要文本」下载
 * 就是当前模板那一份，这里与它对齐；不提供模板选择（spec 2.3）。
 *
 * 没开智能录制的文件平台回 500182，errors.ts 归为 asset_permanent；这里把
 * asset_permanent 一律翻成 null（「这一类不存在」），其余错误原样抛——client 已经
 * 对 transient 重试过 5 次，再吞就是静默丢数据。
 */

/** 路径带变量，必须给稳定配额键，否则按 path 匹配一次都对不上（见 client.ts） */
export const SMART_MINUTES_QUOTA_KEY = '/v1/smart/minutes/{record_file_id}'

export interface SmartChapter {
  chapterId: string
  /** 平台给的是 base64(UTF-8)，这里已解码 */
  name: string
  /** 章节起点，毫秒 */
  startMs: number
}

export interface SmartApi {
  /** markdown 正文（含待办段）；平台判「没开智能化/未生成」时 null */
  getMinutes(recordFileId: string): Promise<string | null>
  /** 章节列表；同上 null。空列表也当 null */
  getChapters(recordFileId: string): Promise<SmartChapter[] | null>
}

interface RawMinutes { meeting_minute?: { minute?: string; todo?: string } }
interface RawChapters {
  chapter_list?: Array<{ chapter_id?: string; chapter_name?: string; pic_url?: string; start_time?: string }>
}

function isUnavailable(err: unknown): boolean {
  return err instanceof TencentApiError && err.classification === 'asset_permanent'
}

function decodeName(b64: string | undefined): string {
  if (!b64) return ''
  return Buffer.from(b64, 'base64').toString('utf8')
}

export function createSmartApi(client: TencentClient, operatorId: string): SmartApi {
  const op = { operator_id: operatorId, operator_id_type: 1 }
  return {
    async getMinutes(recordFileId) {
      let res: RawMinutes
      try {
        res = await client.get<RawMinutes>(
          `/v1/smart/minutes/${recordFileId}`,
          { ...op, text_type: 2 },
          { quotaKey: SMART_MINUTES_QUOTA_KEY },
        )
      } catch (err) {
        if (isUnavailable(err)) return null
        throw err
      }
      const minute = (res.meeting_minute?.minute ?? '').trim()
      if (minute === '') return null
      const todo = (res.meeting_minute?.todo ?? '').trim()
      return todo === '' ? `${minute}\n` : `${minute}\n\n## 待办\n\n${todo}\n`
    },

    async getChapters(recordFileId) {
      let res: RawChapters
      try {
        res = await client.get<RawChapters>('/v1/smart/chapters', { ...op, record_file_id: recordFileId })
      } catch (err) {
        if (isUnavailable(err)) return null
        throw err
      }
      const out: SmartChapter[] = []
      for (const c of res.chapter_list ?? []) {
        if (!c.chapter_id) continue
        const startMs = Number(c.start_time ?? '')
        out.push({ chapterId: c.chapter_id, name: decodeName(c.chapter_name), startMs: Number.isFinite(startMs) ? startMs : 0 })
      }
      return out.length === 0 ? null : out
    },
  }
}

/**
 * `chapters.json` 的唯一序列化。**不含 pic_url**：那个链接带签名与时间戳，两次调用
 * 字节不同，会让「列资产」与「下载」两次拿到的内容对不上。
 */
export function serializeChapters(recordFileId: string, chapters: readonly SmartChapter[]): string {
  return JSON.stringify({ schemaVersion: 1, recordFileId, chapters }, null, 2) + '\n'
}
