/**
 * 主持人一格该显示什么。**两个页面共用**（会议记录、内容预览），所以住在
 * `lib/` 而不是某一页的 `display.ts` 里——`pages/Jobs/view.ts` 的文件头写过
 * 这条约定：第二个页面要用就该搬出来。
 *
 * ## 为什么需要这个函数
 *
 * `host` 是主持人的 **userid**，真实取值长这样：
 * `woaJARCQAAt_hKBw--YKZeVjEaIMGFQQ`。会议记录页此前直接渲染它，于是每一行都有
 * 一串 32 位机器码，占掉表格约五分之一的宽度，而且**这些行带批量勾选框**
 * ——只认得 id 的人没法在勾选前确认自己勾的是谁的会议。内容预览页的抬头
 * （`主持 {host}`）当时漏掉了，同一串 id 在另一页原样上屏，这次一并收进来。
 *
 * ## 四条路径，且「查不到姓名」那条是常态
 *
 * 0. 平台就没给主持人（`host === ''`，设备账号发起的快速会议）→ 说「无主持人」。
 *    它与下一条不是一回事：这场会议的元数据是取到了的，只是没有人主持；
 * 1. 库里就没有主持人（`missing` 里有 `host`）→ 说「未取到」，不是空白；
 * 2. **查不到姓名**（`hostName === null`）→ 降级：说清这是「未知主持人」，
 *    再挂一截 id 的尾巴让两行区分得开，全量 id 放进 `title` 供复制。
 *    身份映射在本部署里一行都没有，所以**这条就是当前唯一会跑到的路径**；
 * 3. 查到了 → 显示姓名，全量 id 仍进 `title`（排查时只有它有用）。
 *
 * ## 为什么降级不是「直接显示 id」，也不是「显示一个占位符」
 *
 * 直接显示 id：那正是要修的问题——一串主键被当成人名读。
 * 只显示「未知主持人」：一屏里十几行长得一模一样，分不出这是不是同一个人，
 * 而「这几场是不是同一个人主持的」恰好是勾选前要判断的事。
 * 所以取尾 6 位——足够把不同的人分开，又短到不会被误读成姓名。
 */

/**
 * 入参收成结构类型而不是 `AdminMeeting`：内容预览页拿到的是 `ContentMeeting`
 * （抬头三段，没有资产与判定），两者共有的就是这三个字段。绑死其中一个类型，
 * 另一页就只能抄一份——那正是这次要消灭的东西。
 */
export interface HostSource {
  host: string
  /** 身份映射查出来的姓名。查不到是 null——**不要**在这里回落成 `host` */
  hostName: string | null
  /** 元数据没拉回来的列名。「主持人是空的」与「元数据没拉回来」靠它区分 */
  missing: readonly string[]
}

export interface HostView {
  /** 主文本。姓名，或者「未知主持人」/「未取到」 */
  text: string
  /** 跟在主文本后面那截 id 尾巴。查到姓名或压根没有 id 时是 null */
  tail: string | null
  /** 原生 title：全量 id 供复制。没有 id 可给时是 null */
  title: string | null
  /** `text` 是不是一个真的姓名。样式据它决定，别让「未知主持人」长得像人名 */
  resolved: boolean
}

/** 尾巴取几位。6 位 base64 ≈ 3.6 万种取值，一屏之内撞车的概率可以忽略 */
const HOST_TAIL_LEN = 6
/** 短到这个长度以内的 id 整串显示——给它掐头去尾反而更难认 */
const HOST_SHORT_MAX = 12

export function shortHostId(host: string): string {
  return host.length <= HOST_SHORT_MAX ? host : `…${host.slice(-HOST_TAIL_LEN)}`
}

export const HOST_MISSING_LABEL = '未取到'
export const HOST_UNKNOWN_LABEL = '未知主持人'
export const HOST_NONE_LABEL = '无主持人'
/** 挂在「无主持人」上的解释。设备账号是 2026-09-03 实际碰到的那一种，不是唯一可能 */
export const HOST_NONE_TITLE = '腾讯会议没有返回主持人：设备账号发起的会议就是这样'

export function hostView(m: HostSource): HostView {
  if (m.missing.includes('host')) {
    return { text: HOST_MISSING_LABEL, tail: null, title: null, resolved: false }
  }
  if (m.host === '') {
    return { text: HOST_NONE_LABEL, tail: null, title: HOST_NONE_TITLE, resolved: false }
  }
  if (m.hostName !== null && m.hostName !== '') {
    return { text: m.hostName, tail: null, title: `主持人 ID：${m.host}`, resolved: true }
  }
  return {
    text: HOST_UNKNOWN_LABEL,
    tail: shortHostId(m.host),
    title: `主持人 ID：${m.host}\n姓名查不到——企业通讯录还没有同步过来`,
    resolved: false,
  }
}

/** 一行文本形式的主持人。用在详情、授权面板、预览抬头这类不分两段排版的地方 */
export function hostLabel(m: HostSource): string {
  const v = hostView(m)
  // 离开「主持人」那一列之后就没有列头了，光说「未取到」不知道说的是哪一样东西
  if (v.text === HOST_MISSING_LABEL) return `主持人${HOST_MISSING_LABEL}`
  if (v.text === HOST_NONE_LABEL) return HOST_NONE_LABEL
  return v.tail === null ? v.text : `${v.text} · ${v.tail}`
}
