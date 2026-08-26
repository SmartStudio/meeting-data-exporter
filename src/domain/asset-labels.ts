/**
 * 八类资产的中文名。**全项目唯一一份**（阶段 5 · A9 收拢）。
 *
 * 来源是 spec §6.2 那张表。键用契约的 `AssetKey`，不是网关的 `asset_type`——
 * 原型 HTML 里那套短名（`summary` / `aitr` / `digest`）一个字都不许进代码，
 * 同一批资产在这个项目里已经有过三套叫法，M3.5 为此吃过一次亏（dev-plan §5 C7）。
 *
 * ## 为什么单独一个文件
 *
 * 这张表原本在 `handlers/console/content.ts` 与 `handlers/console/meetings.ts`
 * 各有**一份一模一样的拷贝**，规则 schema 端点（A9）要用它时就该有第三份了。
 * 两份拷贝今天还一致，但同一件东西在三处各叫各的名字，是这个仓库反复在防的
 * 那种缺陷（spec §1.3、E-e 裁定「不开缓存表因为会变成两份真相」）：改名的那一次
 * 不会有任何东西报错，只是同一份资产在内容预览页叫「AI 纪要」、在规则编辑器里
 * 叫别的。
 */
import type { AssetKey } from '@yaowu/mde-engine'

export const ASSET_LABEL: Record<AssetKey, string> = {
  video: '录像',
  audio: '音频',
  transcript: '完整转写',
  ai_transcript: 'AI 转写',
  ai_minutes: 'AI 纪要',
  ai_topic_minutes: '话题纪要',
  ai_speaker_minutes: '发言人纪要',
  ai_ds_minutes: '会议摘要',
}
