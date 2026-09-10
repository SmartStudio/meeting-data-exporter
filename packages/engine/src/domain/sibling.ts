/**
 * 「同源产物」规则：哪些资产是同一份处理结果里**一起**发布的。
 *
 * 目前只有一条 —— audio 与 video。腾讯 `/v1/addresses` 对每个 record_file 同时给出
 * `download_address`（video）与 `audio_address`（audio），两者是同一份云录制转码完成后
 * 一起发布的；租户没配「同时生成音频」时 `audio_address` **永远不会出现**，而不是晚点出现。
 *
 * 不认这条规则的代价（2026-09-10 本机 mde_acceptance 实测）：全库一行
 * asset_type='audio' 的资产都没有，却躺着 89 条 abandoned/upstream_timeout 的 audio 探测
 * ——每场普通云录制都白探 3 次、空等 6 小时，最后在库里落一个假的失败原因。
 *
 * chapters / ai_minutes **不适用**：它们来自智能接口，生成时机与录制转码各走各的，
 * 「video 有了而它没有」完全可能只是还没算完。
 */

/** 判定只用得到这两个字段。故意不收 `SourceAsset`——domain 层不认识 source 层。 */
export interface SiblingAsset { assetType: string; state?: number | null }

/**
 * 同源兄弟已就绪、而它自己缺席 → 它永远不会出现（可以不建探测、已有的探测就地放弃）。
 *
 * `assetType` 收的是**网关 asset_type**；audio / video 两侧同名（见 domain/types.ts 的
 * `ASSET_KEY_TO_GATEWAY_TYPE`），所以传 AssetKey 也对。
 *
 * 「就绪」的口径与 `judgeReadiness` 的第 ② 条一字不差：在清单里，且 state 为 null 或 3。
 * 刻意**不看** video 的 allow_download——那说的是「能不能下」，这里问的是「有没有生成」，
 * 一份不许下载的录像同样证明了转码已经完成、音频没跟着出来。
 */
export function isSiblingAbsent(assetType: string, assets: readonly SiblingAsset[]): boolean {
  if (assetType !== 'audio') return false
  if (assets.some((a) => a.assetType === 'audio')) return false
  const video = assets.find((a) => a.assetType === 'video')
  if (!video) return false                          // video 也没出来：两个都还在等，照旧探测
  return video.state == null || video.state === 3   // video 还在转码（state 1/2）→ audio 可能随它一起来
}
