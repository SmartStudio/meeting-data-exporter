import { ASSET_TYPES, type AssetType } from './types'

export interface ParsedAssetId {
  meetingRecordId: string
  recordFileId: string
  assetType: AssetType
  /**
   * 末段定位键。多数情况下是 file_type（如 "pdf"/"docx"），条目缺 file_type 时是
   * `idx<n>` 回退，video/audio 固定为 "0"，M3.5 之前签发的历史 assetId 里是纯数字
   * 下标（见 catalog/assets.ts 的 extractAssets）。**不保证是数字**——不要当成
   * 数组下标去用；真正按它定位下载地址的逻辑在 catalog/index.ts 的 pickUrl，
   * 这里只做格式校验。
   */
  selector: string
}

const ASSET_TYPE_SET = new Set<string>(ASSET_TYPES)

/** 与 catalog.assets.ts 里 selector 的实际取值一致：file_type 字符串 / `idx<n>` / 历史数字下标 */
const SELECTOR_RE = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * 解析网关签发的 assetId：`<meetingRecordId>:<recordFileId>:<assetType>:<selector>`
 * （见 catalog/assets.ts 的 extractAssets）。
 *
 * 格式不合法返回 null——**不抛异常**，调用方对「不是本网关签发的 id」有各自的处理
 * 方式（HTTP 层返回 400，catalog 层抛 InvalidAssetIdError，worker 层是内部错误）。
 *
 * 只要求**至少**四段：前两段取作 meetingRecordId / recordFileId，第三、四段取作
 * assetType / selector；多出的段落忽略。selector 的合法字符集里不含冒号，实践中
 * 不会出现超过四段的合法 assetId。
 */
export function parseAssetId(assetId: string): ParsedAssetId | null {
  const parts = assetId.split(':')
  if (parts.length < 4) return null
  const [meetingRecordId, recordFileId, assetType, selector] = parts as [string, string, string, string]
  if (!meetingRecordId || !recordFileId || !assetType || !selector) return null
  if (!ASSET_TYPE_SET.has(assetType)) return null
  if (!SELECTOR_RE.test(selector)) return null
  return { meetingRecordId, recordFileId, assetType: assetType as AssetType, selector }
}
