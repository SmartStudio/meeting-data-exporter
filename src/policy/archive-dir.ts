/**
 * 归档栈的判定 → NAS 上的一个具体目录（控制台阶段 3 · T9）。
 *
 * archive 栈的 effect 不是枚举，是**管理员填的一段目录模板**（`meetings/{年}/{月}`）。
 * `stacks.ts` 只负责选出「哪条规则说了算、它的 effect 是什么」，把那段模板变成一个
 * 真实路径是这里的活——它需要会议字段，而求值器只认事实、不认领域对象。
 *
 * ## 这一层的全部风险
 *
 * **渲染出来的路径不是管理员想的那个。** 模板是自由文本，四个占位符可以拼错
 * （`{年份}`）、可以带 `..`、可以是绝对路径、可以渲染成空。这些情况一律判
 * **不归档 + 说得出为什么**，不「尽力而为地拼一个差不多的」：把一场会议的录像写到
 * 管理员没想到的地方，比不写更糟——不写还能从理由里查出来并补一条规则，写错了
 * 没人会发现，直到几年后有人去那个目录找它。
 *
 * ## 模板是**相对 NAS 根目录**的
 *
 * `MDE_NAS_ROOT` 是部署给的挂载点，模板只描述它下面的层级。绝对模板会让
 * `MDE_NAS_ROOT` 变成一个没有作用的配置——挂载点换了地方，归档还往老路径写，
 * 而这件事没有任何地方会报出来。这条约束也已经**结构性地**被写在归档链路里了：
 * `writeNasSidecars`（`src/worker/nas-sidecars.ts`）用 `relative(nasRoot, nasDir)`
 * 算 sidecar 的落点，nasDir 一旦
 * 跑到 nasRoot 之外，那两个 JSON 会被写到 NAS 根之外去。所以这里不是新加一条洁癖
 * 规矩，是把既有的隐式前提变成一次显式的、报得出理由的检查。
 *
 * ⚠️ 原型（`docs/console/prototype/gate-console.html`）与计划 §2.2 里的示例模板写成
 * `/nas/meetings/{年}/{月}/{会议号}-{标题}/` 这种**绝对**形式。按上面这条，那种模板
 * 会被判为不合法（理由里直接告诉管理员改成相对形式）。原型是设计稿、库里还没有任何
 * 一条真的 archive 规则，所以这不是在破坏已有数据；但规则编辑器（阶段 5 · F3）
 * 的占位符提示与示例**必须**跟着写成相对形式，否则管理员照着示例填一条，得到的是
 * 「一场都没归档」。
 *
 * ## 未知占位符判失败，不原样保留
 *
 * 原样保留会产出一个字面带 `{年份}` 的目录——它**看起来像成功了**：目录建出来了、
 * 文件写进去了、日志一片绿。而管理员写 `{年份}` 时想要的是「按年份分开」，实际得到
 * 的是所有会议挤在同一个字面目录里，这个差别要等到有人去 NAS 上翻文件才会暴露。
 * 判失败则当场给出一句「`{年份}` 不是可用的占位符，可用的是……」，管理员改一个字
 * 就好了。**两种做法的代价差在「什么时候发现」，不在「谁更严格」。**
 */

import { isAbsolute, resolve, sep } from 'node:path'
import { cleanSubjectSegment } from '@yaowu/mde-engine'
import type { ArchiveDecision } from './stacks'

/** 渲染模板要用的那几个会议字段（`Meeting` 的值满足它） */
export interface ArchiveDirMeeting {
  subject: string | null
  /** unix 秒；缺失按 0 处理——与 `meetingDirPath` 逐字一致，见 `renderPlaceholder` */
  startTime: number | null
  meetingCode: string | null
}

export interface ArchiveDirContext {
  /** NAS 挂载点（MDE_NAS_ROOT）。模板相对它解析，结果必须留在它之内 */
  nasRoot: string
  meeting: ArchiveDirMeeting
  /** 会议号缺失时顶上的值，调用方传 meeting_id——与本地归档区同一口径 */
  fallbackCode: string
}

export type ArchiveDirOutcome =
  | { archive: true; nasDir: string; reason: string; undecidable?: undefined }
  /**
   * 不归档。`undecidable` 把这里面的两类分开——**它们在运维上完全不同**：
   *
   * - `false`：**规则就是这么定的**（命中一条 `skip`，或一条都没匹配走兜底）。
   *   正常运转，`skip` 本来就是归档栈的兜底（spec §4.6）。
   * - `true`：**判不出来**。模板渲染不出合法路径（管理员的规则写坏了），
   *   或压根没法求值。归档栈的意图没能被执行，命中这条规则的会议**一场都归不了档**，
   *   而且不会自己好转。
   *
   * 合并成一个数字的话，一条写坏的规则在轮末汇总里与「今天没有会议需要归档」
   * 长得一模一样。
   */
  | { archive: false; nasDir?: undefined; reason: string; undecidable: boolean }

/** 模板里可用的占位符。理由文案与规则编辑器的提示都从这里取，不各写一份 */
export const ARCHIVE_DIR_PLACEHOLDERS = ['年', '月', '会议号', '标题'] as const

const PLACEHOLDER_LIST = ARCHIVE_DIR_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')

/** `{...}` 的所有出现。占位符名里不允许再有花括号，所以不需要处理嵌套 */
const PLACEHOLDER_RE = /\{([^{}]*)\}/g

/**
 * 一个占位符渲染成**一个路径片段**。分隔符只能来自模板本身，不能来自会议数据——
 * 数据里冒出来的 `/` 会凭空多出一层目录，那不是管理员写在模板里的结构。
 * `{标题}` 因此过 `cleanSubjectSegment`（它把 `/` `\` `:` 这些都换成 `-`）。
 *
 * `{会议号}` 不过清洗：腾讯会议的会议号是数字与短横线，且它已经被
 * `cleanDirName` 原样用在本地目录名里了，在这里单独清洗反而与本地不一致。
 * 真出现带分隔符的会议号，兜底是下面那道「必须留在 nasRoot 之内」的检查——
 * 结果只会多一层子目录，仍然在管理员指定的目录树内。
 *
 * 时间一律按 **UTC** 拆解，`startTime` 缺失按 0 处理（于是落进 `1970/01`）：
 * 这两条都是照抄 `meetingDirPath`，不是这里的选择。本地归档区就是这么落盘的，
 * NAS 侧换一种「更合理」的处理方式，只会让同一场会议在两处对不上。
 */
function renderPlaceholder(name: string, ctx: ArchiveDirContext): string | null {
  const d = new Date((ctx.meeting.startTime ?? 0) * 1000)
  switch (name) {
    case '年':
      return String(d.getUTCFullYear())
    case '月':
      return String(d.getUTCMonth() + 1).padStart(2, '0')
    case '会议号':
      return ctx.meeting.meetingCode ?? ctx.fallbackCode
    case '标题':
      return cleanSubjectSegment(ctx.meeting.subject ?? '')
    default:
      return null
  }
}

type Render = { ok: true; path: string } | { ok: false; problem: string }

/** 模板 → 相对路径字符串。未知占位符在这里就判失败（见文件头） */
export function renderArchiveTemplate(template: string, ctx: ArchiveDirContext): Render {
  const unknown: string[] = []
  const rendered = template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const value = renderPlaceholder(name, ctx)
    if (value === null) {
      unknown.push(whole)
      return whole
    }
    return value
  })

  if (unknown.length > 0) {
    return {
      ok: false,
      problem:
        `模板里的 ${unknown.join('、')} 不是可用的占位符` +
        `（可用的是 ${PLACEHOLDER_LIST}）`,
    }
  }
  return { ok: true, path: rendered }
}

/**
 * 渲染完的相对路径要过的三道检查。**每一道都必须给出一句人能照着改的话**：
 * 这句话会一路传到会议行的判定理由里（spec §4.2/§4.3），说错了比不说更贵。
 */
function validate(rendered: string, nasRoot: string): { ok: true; nasDir: string } | { ok: false; problem: string } {
  const trimmed = rendered.trim()
  if (trimmed === '') {
    return { ok: false, problem: '渲染后是空串，指不到任何目录' }
  }
  if (isAbsolute(trimmed)) {
    return {
      ok: false,
      problem:
        `渲染后是绝对路径「${trimmed}」。归档目录模板是**相对 NAS 根目录**的，` +
        '请去掉开头的「/」（例如 meetings/{年}/{月}）',
    }
  }
  // `..` 单独判，不指望 resolve 之后的包含性检查兜住：
  // nasRoot 自己带符号链接时，`resolve` 算出来的字符串仍在 nasRoot 之下，
  // 而实际写入会跟着链接走出去。段级检查与路径解析无关，先做它。
  if (trimmed.split('/').some((seg) => seg === '..')) {
    return {
      ok: false,
      problem: `渲染后含有「..」路径穿越（「${trimmed}」），归档目录不许走出 NAS 根目录`,
    }
  }

  const nasDir = resolve(nasRoot, trimmed)
  const root = resolve(nasRoot)
  if (nasDir === root) {
    // 「只剩分隔符」（`///`、`.`）落在这里：它不是穿越，但它把所有会议堆进 NAS 根
    // 本身，与「按某种结构归档」这件事的意图相反，而且 sidecar 会直接写在挂载点上。
    return { ok: false, problem: `渲染后没有任何目录层级（「${trimmed}」指向 NAS 根目录本身）` }
  }
  if (!nasDir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    return { ok: false, problem: `渲染结果「${nasDir}」不在 NAS 根目录 ${root} 之内` }
  }
  return { ok: true, nasDir }
}

/**
 * 归档栈的判定 → 这场会议归档到哪个目录，或者为什么不归档。
 *
 * 判 `skip`（含兜底）与模板不合法**都返回 `archive: false`**，但 `undecidable` 不同：
 * 前者是规则就这么定的，后者是规则的意图没能被执行。
 * 调用方不需要分辨这两者：对归档流水线来说它们是同一件事——这一轮不搬这场会议，
 * 而且有一句可查的理由。**任何「判断不出来」的路径都要落到安全侧并留下理由**，
 * 一场会议悄悄没被归档是这个系统里最难排查的一类现象。
 */
export function resolveArchiveDir(decision: ArchiveDecision, ctx: ArchiveDirContext): ArchiveDirOutcome {
  if (decision.effect === 'skip') {
    // 判定理由已经是一句人话（「……决定：不归档」/「没有任何归档规则匹配……」），
    // 不在外面再包一层，包了只会让同一件事有两种说法。
    return { archive: false, reason: decision.reason, undecidable: false }
  }

  const rendered = renderArchiveTemplate(decision.effect, ctx)
  if (!rendered.ok) return { archive: false, reason: badTemplate(decision, rendered.problem), undecidable: true }

  const checked = validate(rendered.path, ctx.nasRoot)
  if (!checked.ok) return { archive: false, reason: badTemplate(decision, checked.problem), undecidable: true }

  return { archive: true, nasDir: checked.nasDir, reason: decision.reason }
}

/**
 * 坏模板的理由。**必须带上是哪条规则**：`decision.reason` 里已经有规则编号与 note
 * （`stacks.ts` 的 `ruleLabel`），管理员读完这句话要知道去改哪一条，而不是知道
 * 「有个模板坏了」。
 */
function badTemplate(decision: ArchiveDecision, problem: string): string {
  return `${decision.reason}；但${problem}，按不归档处理`
}
