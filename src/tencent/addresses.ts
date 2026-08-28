import type { RawDetail, RawFileEntry } from '../catalog/assets'
import type { TencentClient } from './client'

/** 平台上限；批量接口默认/最大 50，与 /v1/corp/records 的 20 不同 */
const LIST_PAGE_SIZE = 50

/**
 * GET /v1/addresses 单条记录：不含 ai_* 字段——那五类纪要仅 51180（detailByFileId）返回。
 * 免 STS-Token，链接时效 6 小时。
 */
export interface RawAddressFile {
  record_file_id: string
  download_address?: string
  download_address_file_type?: string
  audio_address?: string
  audio_address_file_type?: string
  meeting_summary?: RawFileEntry[]
  /** false 时 ai_* 全部返回空；由调用方转交给 extractAssets 的 allowDownload 参数 */
  allow_download?: boolean
}

interface RawListResponse {
  total_page?: number
  record_files?: RawAddressFile[]
}

export interface AddressesApi {
  /** GET /v1/addresses：按 meeting_record_id 批量取地址，不需要 STS-Token，链接 6 小时 */
  listByRecordId(meetingRecordId: string): Promise<RawAddressFile[]>
  /** GET /v1/addresses/{record_file_id}：单文件详情，需 STS-Token，链接仅 5 分钟 */
  detailByFileId(recordFileId: string, stsToken: string): Promise<RawDetail>
}

export function createAddressesApi(client: TencentClient, operatorId: string): AddressesApi {
  return {
    async listByRecordId(meetingRecordId) {
      const out: RawAddressFile[] = []
      let page = 1
      let totalPage = 1

      do {
        const res = await client.get<RawListResponse>('/v1/addresses', {
          operator_id: operatorId,
          operator_id_type: 1,
          meeting_record_id: meetingRecordId,
          page,
          page_size: LIST_PAGE_SIZE,
        })
        totalPage = res.total_page ?? 1
        out.push(...(res.record_files ?? []))
        page++
      } while (page <= totalPage)

      return out
    },

    async detailByFileId(recordFileId, stsToken) {
      return client.get<RawDetail>(
        `/v1/addresses/${recordFileId}`,
        {
          operator_id: operatorId,
          operator_id_type: 1,
        },
        { stsToken },
      )
    },
  }
}
