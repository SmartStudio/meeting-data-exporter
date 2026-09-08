import type { CSSProperties, ReactNode, RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { WhyKind } from '@/api/types'
import type { TranscriptCue } from '@/api/admin/content'

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
 * 打开时的播放位置：**0:00**。
 *
 * ## 这条 2026-08-30 翻过案
 *
 * spec §4.4 原来逐字写死的是「打开时落在会议中段（不是 0:00）——章节、字幕、转写
 * 三处当场对得上，不用等播放器走两分钟才看出它们是联动的」。
 *
 * 那是**给静态原型截图看的**理由：一张截图上的播放器停在 0:00，字幕区是空的,
 * 看不出三处联动。接上真实数据、真的有人来用之后，同一条规则变成一个纯粹的坑——
 * 打开一场会议，进度条已经在正中间，前一半看起来像是被跳过了。用户原话：
 * 「播放时都是进度是从中间一半开始播不是从头开始」。
 *
 * 联动**没有变弱**：它本来就是真的，只是不再靠一个假的起始位置去演示自己。
 * 保留这个函数而不是直接写 0，是因为「打开时停在哪」是一条会被再次讨论的产品
 * 规则——它该有一个说得出理由的落点，不是散在组件里的一个字面量。
 */
export function initialPosition(_durationSec: number): number {
  return 0
}

/* ── 当前分段 ────────────────────────────────────────────────────── */

/**
 * 走时时让当前那一段滚进视野（spec §4.4「播放时转写自动高亮并跟随滚动」）。
 *
 * ## 为什么**不能**用 `scrollIntoView`
 *
 * 上一版是 `el.scrollIntoView({ block: 'nearest' })`，注释里写着「`nearest` 就不会
 * 把整页也滚走」。**这句话是错的**，而且是这一页最贵的一个错误：
 *
 * `scrollIntoView` 会沿祖先链把**每一个**可滚动容器都滚一遍，一直滚到文档本身。
 * `block: 'nearest'` 决定的是每个滚动容器**滚多少**（够看见就停），不是**滚哪几个**。
 * 分段列表自己是 `max-height: 60vh; overflow-y: auto` 没错，但列表滚完之后浏览器
 * 继续往上走，把 window 也滚了。
 *
 * 1440×900 下实测（真 Chromium、真构建产物、114 段）：
 *
 * - 一按播放，`window.scrollY` 在 3.75 秒内从 0 被推到 544——录像被顶出屏幕，
 *   人没滚过一下。
 * - 人手动滚回顶部想看画面，**下一段一到就被拽回 544**。这就是「一直在抖动」:
 *   不是列表在抖，是页面和人在抢滚动条。
 *
 * ## 现在的做法
 *
 * 只写容器自己的 `scrollTop`。给 `scrollTop` 赋值**不会**波及祖先，这是它和
 * `scrollIntoView` 唯一但决定性的区别。对齐算法照抄 `nearest` 的语义：整段已经
 * 在框里就一动不动（走时每秒一次，反复写同一个值会打断人正在进行的惯性滚动）;
 * 上边出界贴上边，下边出界贴下边；比框还高的一段已经占满了框，也不动——
 * 强行对齐会在人读到一半时把它跳走。
 */
export function useFollowCurrent(ref: RefObject<HTMLElement | null>, position: number): void {
  useEffect(() => {
    const box = ref.current
    const el = box?.querySelector<HTMLElement>('[aria-current="true"]')
    if (box == null || el == null) return
    const b = box.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.top >= b.top && r.bottom <= b.bottom) return
    if (r.top <= b.top && r.bottom >= b.bottom) return
    box.scrollTop += r.top < b.top ? r.top - b.top : r.bottom - b.bottom
  }, [ref, position])
}

/**
 * 取新数据的那一帧，把容器高度冻在**上一次量到的高度**上。
 *
 * ## 这修的是什么
 *
 * 用户报「点纪要里的模板 / 文件格式，整个预览页会抖动一下、像重新加载了」。
 * 1440×900 真浏览器实测，抖的是布局，不是加载：
 *
 * | 动作 | 文档高度 | `window.scrollY` |
 * |---|---|---|
 * | 切模板 AI 纪要 → 发言人纪要 | 1088 → **1007** → 1611 | 188 → **107** → 188 |
 * | 切文件格式 全部 → txt（前后同高） | 1611 → **1007** → 1611 | 188 → **107** → 188 |
 * | 切大 tab 转写文字 → 纪要 | 2194 → **1007** → 1088 | 185 → **107** → 185 |
 *
 * 中间那一列就是骨架屏：`useResource` 每次 deps 变都先 `setRes({ state: 'loading' })`,
 * 已经排好的正文整块被换成一个 151px 的骨架，面板矮下去几百 px，页面跟着变矮,
 * 浏览器把滚动位置**钳**到新的最大可滚量（188 → 107），150ms 后正文回来页面变高,
 * 滚动位置又被拉回去。一次点击 = 两次布局跳变。
 *
 * 最后一行是决定性的：`全部 → txt` 前后内容**完全一样高**，净变化 0，照样抖一次。
 * 所以抖动与"内容变了"无关，纯粹是 loading 那一帧造成的。
 *
 * 录像**没有**重新加载：同一个 DOM 节点，`currentTime` 不变，`loadstart` /
 * `emptied` / `loadeddata` 三个事件计数全是 0。"重新加载"是这个缺陷造出来的观感。
 *
 * ## 为什么不是「切换时先留着上一次的正文」
 *
 * 那是这一页最不能做的一件事：单选已经跳到「发言人纪要」，下面挂着的却是 AI 纪要
 * 的正文——在一个「判定理由必须可回溯」的产品里，150ms 的谎也是谎。冻的是高度,
 * 不是内容：旧正文照常撤走，骨架屏照常转，只是脚下的地不塌。
 *
 * 请求与留痕一条都不少（spec §2「每调一次就写一行审计」），这里没有引入任何缓存。
 *
 * ## 量到 0 就不记
 *
 * jsdom 不做排版，`offsetHeight` 恒 0。记下 0 会让 `min-height: 0px` 一路挂在真实
 * 的 style 上，看着像生效其实什么都没冻——**一个报告"通过"却什么都没做的开关**。
 * 只认正数，真浏览器里高度为 0 本来也没有冻的必要。
 *
 * ## 高度记在**外面**
 *
 * `memory` 由调用方持有，不是这个 hook 自己的 `useRef`。第一版记在里面，于是
 * 「从转写文字切回纪要」照样抖 78px（y 185 → 107 → 185）——那一下 `MinutesTab`
 * 是**重新挂载**的，组件内的记忆跟着上一次卸载一起没了，冻无可冻。
 *
 * 记忆挂在 `Preview/index.tsx` 的 `Body` 上：它跨 tab 切换活着，换会议时才随
 * `index` 回到 loading 一起卸掉——所以不会拿上一场会议的高度冻这一场。视口改过
 * 之后那个数会偏，但它只是一次取数期间的 `min-height`，数据一到就撤，偏一点也
 * 只是让那 150ms 的骨架屏高一些或矮一些，不会留在界面上。
 */
export function useHeightFloor(
  loading: boolean,
  memory: RefObject<number | null>,
): {
  ref: RefObject<HTMLDivElement | null>
  style: CSSProperties | undefined
} {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (loading) return
    const h = ref.current?.offsetHeight ?? 0
    if (h > 0) memory.current = h
  })
  return {
    ref,
    style: loading && memory.current !== null ? { minHeight: `${memory.current}px` } : undefined,
  }
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
