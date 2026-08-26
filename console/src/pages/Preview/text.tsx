import type { ReactNode, RefObject } from 'react'
import { useEffect } from 'react'
import type { WhyKind } from '@/api/types'
import type { ContentAsset, TranscriptCue } from '@/api/admin/content'
import { MINUTES_TEMPLATES } from '@/api/admin/content'

/**
 * 内容预览页的小工具：文本呈现、当前分段的定位、几条写死的初始规则。
 *
 * 放在一个文件里而不是散在四个组件里，是因为它们全都**有一个正确答案**，
 * 而且都被测试盯着。散开之后第二个人会在别处再写一遍略微不同的版本。
 */

/* ── 后端下发的 `**强调**` ────────────────────────────────────────── */

/**
 * 后端的几段说明文字里带 Markdown 的粗体记号（`**禁止采集**`）。原样打印出来
 * 就是一串星号——看起来像个 bug，而它出现的位置恰恰是琥珀警示条这种最需要
 * 被信任的地方。
 *
 * 只认这一种记号，不引 Markdown 渲染器：这里要的是"把星号变成粗体"，
 * 不是"让后端的文案能写 HTML"——那是一条不该开的注入路径。
 */
export function Emphasis({ text }: { text: string }): ReactNode {
  const parts = text.split(/\*\*([^*]+)\*\*/g)
  return parts.map((part, i) =>
    // 奇数位是被 ** 包住的那一段（split 带捕获组时的固定形状）
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part,
  )
}

/** 搜索命中高亮。空查询原样返回，不做无谓的切分。 */
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim()
  if (q === '') return text
  const out: ReactNode[] = []
  let rest = text
  let key = 0
  for (;;) {
    const at = rest.indexOf(q)
    if (at < 0) break
    if (at > 0) out.push(rest.slice(0, at))
    out.push(<mark key={key++}>{q}</mark>)
    rest = rest.slice(at + q.length)
  }
  out.push(rest)
  return out
}

/* ── 判定理由的呈现 ──────────────────────────────────────────────── */

/**
 * 与会议记录页的 `WHY_LABEL` 同一套词。**刻意复制而不是 import**：
 * 那个文件（`pages/Meetings/index.tsx`）正被 F2 同时改着，从别人的独占区里
 * import 一个符号，等于把两个并行任务绑在一起。七个字的重复，换掉一次合并冲突。
 */
export const WHY_LABEL: Record<WhyKind, string> = {
  rule: '来自规则',
  hand: '人工改写',
  fail: '失败',
  expired: '已到期',
  wait: '前置未完成',
  na: '不适用',
  deny: '规则禁止',
}

/* ── 写死的初始规则（spec §4.4）───────────────────────────────────── */

/**
 * 打开时的播放位置：**会议中段，不是 0:00**。
 *
 * spec §4.4 逐字写死了这条：「打开时落在会议中段（不是 0:00）——章节、字幕、
 * 转写三处当场对得上，不用等播放器走两分钟才看出它们是联动的」。
 * 这不是一个默认值品味问题，是这一页要证明的那件事。
 */
export function initialPosition(durationSec: number): number {
  return Math.max(0, Math.floor(durationSec / 2))
}

/**
 * 默认选中的纪要模板：**索引里第一个真的有正文的那一类**。
 *
 * 打开就停在一个"这场会议没有这类纪要"的空面板，人会以为整页坏了。
 * 一类正文都没有时退回第一个模板——那时面板上显示的是后端给的、说得出
 * 为什么的空态文案，仍然不是一片空白。
 */
export function pickDefaultTemplate(assets: readonly ContentAsset[]): string {
  const parsed = MINUTES_TEMPLATES.find((t) =>
    assets.some((a) => a.assetKey === t.key && a.availability === 'parsed'),
  )
  return (parsed ?? MINUTES_TEMPLATES[0]!).key
}

/* ── 当前分段 ────────────────────────────────────────────────────── */

/**
 * 走时时让当前那一段自己滚进视野（spec §4.4「播放时转写自动高亮并跟随滚动」）。
 *
 * `scrollIntoView` 在 jsdom 里压根不存在，所以这里是可选调用——测试环境缺一个
 * 浏览器 API 不该让整棵树崩掉。`block: 'nearest'` 是关键：用默认的 `start`
 * 会把整页也一起滚动，人正在看的纪要会被拽走。
 */
export function useFollowCurrent(ref: RefObject<HTMLElement | null>, position: number): void {
  useEffect(() => {
    const el = ref.current?.querySelector('[aria-current="true"]')
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [ref, position])
}

/**
 * 当前播放位置落在第几段转写上：**最后一个 `at <= pos` 的分段**。
 * 一段都没走到（位置在第一段之前）返回 -1，调用方据此显示"还没到第一段"，
 * 而不是把第 0 段错标成当前。
 */
export function currentCueIndex(cues: readonly TranscriptCue[], pos: number): number {
  let hit = -1
  for (let i = 0; i < cues.length; i++) {
    if (cues[i]!.at <= pos) hit = i
    else break
  }
  return hit
}
