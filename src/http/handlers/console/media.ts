/**
 * A6 · 管理端媒体流端点（阶段 6）。spec.md §4.4「内容预览」的录像/音频那一半。
 *
 * ```
 * GET /api/v1/admin/meetings/:meetingId/media/:assetType/:remoteId/:fileType
 * ```
 *
 * ## 〇、这条端点推翻了 T10 验收第 3 条的一半，所以先把界划清楚
 *
 * T10 验收 3 的原话是「录像与音频**不入库、也不由本接口代理内容**」，理由是
 * 「单个文件可以有几个 GB，让多实例的网关去转发一份等于把网关当 CDN 用」。
 * `handlers/console/content.ts` 的 `buildMedia` 至今照这条办：只给去向，不给字节。
 *
 * **那条理由针对的是「从腾讯 CDN 转发」，不是「读一个已经归档在本机 NAS 目录里的
 * 文件」。** 这两件事在成本上不是同一个量级，也不是同一种风险：
 *
 * | | 代理腾讯 CDN（**仍然不做**） | 读已归档的本地文件（**本文件做**） |
 * | --- | --- | --- |
 * | 字节从哪来 | 公网回源，网关先下行再上行，**同一份数据走两遍公网** | 本机挂载的 NAS，内核 sendfile/零拷贝，不出机房 |
 * | 网关的角色 | 一个没有缓存、没有边缘节点、还要付两份带宽的 CDN | 一个文件服务器，和它已经在做的「读转写正文」同一类 |
 * | 多实例 | N 个实例各自回源一份，放大 N 倍 | N 个实例读的是同一个挂载点，不放大 |
 * | 直链的替代品 | 有：`POST /api/v1/assets/:assetId/download-url` 直接签平台直链 | **没有**：NAS 上的文件平台不认，签不出任何直链 |
 * | 保留期过后 | 平台侧链接早就失效 | 文件还在 NAS 上，永久保留（spec §4.9） |
 *
 * 最后两行才是这条端点真正的理由：**本地已清理（§4.10）之后，NAS 上那份录像没有
 * 任何一条既有路径能播放它**。`download-url` 签的是平台直链，平台侧那份早就没了；
 * `content.ts` 的 `media.assets[].nasPath` 给的是一个字符串，管理员只能拿着它去
 * 登录 NAS。于是「内容预览页」这一页对着一场已归档会议，画面看不到、声音听不到——
 * 用户报的就是这个。
 *
 * 而它与控制台**已经在做的事**是同一类：同一个管理员、同一条 spec §2「管理员仍然
 * 能看 + 留痕」、同一份归档记录。转写正文早就这么读了（走 `asset_contents`），
 * 录像只是大一点、且不该整份进内存——所以下面用 `Bun.file().slice()` 流式发，
 * 一个字节都不落到堆上。
 *
 * **没被推翻的那一半仍然成立，不要顺手一起改**：
 * - 录像与音频**照旧不入库**（`asset_contents` 是 MEDIUMTEXT，见 007 表头）。
 * - **照旧不从腾讯 CDN 代理**。要平台直链就走 `download-url`，那条路一行不动。
 * - `content.ts` 的 `media` 块**照旧只给去向**——那个端点是 JSON 索引，不发字节。
 *
 * ## 一、只服务 video / audio
 *
 * 文本类走 `GET .../content`。从这里放出去等于开第二条读正文的路，而两条路的
 * **审计口径会分叉**：content 端点按「看了哪一类」记，这里按「播了哪一段」记，
 * 同一次查看在审计流里会长成两种样子，事后没人分得清哪一行是哪一次。
 * 其它 `assetType` 一律 400 `not_a_media_asset`。
 *
 * ## 二、五个错误码是五件不同的事，一个都不许合并
 *
 * | 码 | 事实 | 谁该去修 |
 * | --- | --- | --- |
 * | 400 `not_a_media_asset` | 调用方要的不是媒体 | 前端 |
 * | 503 `nas_root_unset` | 本进程没挂 NAS（`MDE_NAS_ROOT` 空） | 运维 |
 * | 404 `asset_not_archived` | `archived_assets` 里没有这三段 | 归档流水线 |
 * | 404 `media_gone` | 记录在，盘上那份没了 | 去 NAS 查谁删的 |
 * | 403 `path_outside_root` | 库里那条 `nas_path` 落在根目录外 | **当事故查** |
 *
 * 把前两个 404 合成一个的下场：管理员分不清「这场会议压根没录像」和「录像被人从
 * NAS 上删了」——后者是数据事故，前者不是。
 *
 * ## 三、路径防穿越
 *
 * `archived_assets.nas_path` 是**库里的值**，不是用户输入。但「不是用户输入」不等于
 * 「可以无条件信任」：库被写坏、某处路径拼错、或者将来有谁给归档路径加了一段可配置的
 * 前缀，都会让这一行变成一次**任意文件读取**——而这条端点带管理员会话，读到的东西
 * 会原样发出去。
 *
 * 做法是 `resolve` 之后断言落在 `resolve(nasRoot)` 之内，**比较时带上路径分隔符**：
 * 纯 `startsWith` 会让 `/nas-evil/secret.mp4` 因为前缀匹配 `/nas` 而通过。根目录
 * 本身也不算（它是目录，不是可播放的文件）。拒绝时 `console.warn` 留一行——库里
 * 出现这种记录本身就是个待查的事故，静默 403 会让它永远没人发现。
 *
 * 响应体里**不写文件系统路径**：这条端点的拒绝理由要说得清，但内部目录布局不是
 * 理由的一部分，写进去就是一次免费的目录侦察。路径只进服务端日志。
 *
 * ## 四、Range 不是优化，是能不能播的分水岭
 *
 * 浏览器的 `<video>` 靠 Range 拖进度条；**Safari 在没有 `Accept-Ranges` 时会整个
 * 拒播**——不是「不能拖」，是一帧都不放。所以这里三个头必须互相对得上：
 * `Content-Range` / `Content-Length` / 真正发出去的字节数。对不上的表现不是报错，
 * 而是画面卡住或没有声音，正是这条端点要修的那个故障本身。
 *
 * 多段 Range（`bytes=0-99,200-299`）不支持：**按无 Range 处理返回 200 全量**，
 * 比返回一个只含第一段却宣称自己是 206 的假响应好——后者会让播放器拿到一段
 * 对不上号的数据，然后以一种查不出原因的方式坏掉。认不出的单位（`items=0-9`）
 * 按 RFC 7233 忽略，同样回 200。
 *
 * ## 五、审计：一次播放记一行，不是一次拖动记几十行
 *
 * 复用 content 那一套（`view_content` / `view_restricted_content`、`decision` 恒为
 * `allow`、`detail` 记下当时的判定理由原话），理由见 `content.ts` 文件头第三条。
 *
 * **但不许每个 Range 请求都记一行**：一次拖动进度条会打出几十个请求，几十行审计
 * 等于没有审计——真正要查的那一行会被同一场会议的噪声埋掉。裁定是**只在「这一次
 * 播放的起点」记**：`Range` 头缺失，或它的起始字节是 0。
 *
 * 这条裁定有一个已知的残余风险，写在这里免得下一个人以为它是无懈可击的：如果某个
 * 播放器**从不**发起始为 0 的请求（只发后缀 Range 去取文件尾的 moov），这次播放就
 * 不会留痕。今天的浏览器 `<video>` 一律先发 `bytes=0-` 取头部元数据，所以这条路
 * 走得到；哪天不走了，改法是按 (管理员, 资产) 做时间窗去重，而不是退回「每发必记」。
 *
 * 416 不记：一个字节都没发出去，就没有「查看」可留痕。
 *
 * 审计**不 try/catch**：写不进去就不发文件，与 `content.ts` 的 `recordView` 同一条
 * ——没有对价就不能给内容（spec §2）。
 */

import { resolve, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import { AUDIT_ACTION } from '../../../audit/actions'
import { ASSET_LABEL } from '../../../domain/asset-labels'
import { isVisible } from '../../../policy/access'
import { wasOverridden, type OverriddenDecision } from '../../../policy/override'
import type { AllowEffect, StackRule } from '../../../policy/stacks'
import { buildAuditDetail, type AuditEntry } from '../../../store/audit'
import { parseConsoleMeetingId } from '../../../store/console-meetings'
import type { MeetingKey } from '../../../store/grants'
import { explainMeetingAccess } from '../../../worker/visibility'
import { requireAdminAuth } from '../../middleware'
import { json } from '../../respond'
import type { RouteCtx } from '../../router'

// ===========================================================================
// 依赖
// ===========================================================================

/**
 * 这条端点要的全部外部世界：NAS 挂载点。
 *
 * 收成一个具名接口而不是往 `AppDeps` 上挂一个裸字符串，是跟 `StorageDeps` /
 * `JobsDeps` 同一个先例：将来这条端点要加别的（比如一个只读的 sendfile 抽象、
 * 或者一个按会议限速的闸门），加在这里，`AppDeps` 上仍然只有一行。
 *
 * **值必须与 `StorageDeps.nasRoot` 是同一个 `MDE_NAS_ROOT`**（`src/index.ts` 里
 * 读一次、给两个字段，与 `jobsStore` 一个实例给两处是同一条约定）：各读各的
 * 环境变量，归档存储页会说「NAS 可达、23GB 已用」而这条端点同时报「没挂 NAS」，
 * 两句话都出自本进程，谁也说不清该信哪一句。
 *
 * `null` 表示**没配**，不是「用默认值」：那时端点返回 503 并说清是挂载/配置问题
 * （见文件头第二条那张表）。静默 404 会让人以为是文件不见了，把一个五分钟能修的
 * 环境变量伪装成一次数据事故。
 */
export interface MediaDeps {
  nasRoot: string | null
}

// ===========================================================================
// 只服务媒体类
// ===========================================================================

/**
 * 认得的 `assetType`。**这两个字符串同时是契约的 `AssetKey` 与网关的 `asset_type`**
 * ——八类资产里只有 video / audio 两名相同（见引擎 `ASSET_KEY_TO_GATEWAY_TYPE`
 * 的注释），所以这里不必像 content 端点那样认两套词汇。
 *
 * 用集合白名单而不是 `!isTextAssetType(t)`：后者对**认不出**的 asset_type 也返回
 * true（引擎那边的默认值是「按二进制处理」，对不整读哈希是安全的默认，对
 * 「要不要把这个文件发出去」不是）。将来网关接入新的二进制资产类型时，这里应该
 * 先 400，由人决定它该不该走这条路，而不是自动放行。
 */
const MEDIA_ASSET_TYPES = new Set(['video', 'audio'])

/**
 * `file_type` → `Content-Type`。
 *
 * 判据是**库里那一列 `file_type`**，不是文件名后缀：后缀是归档时按同一列拼出来的，
 * 拿它反推等于绕一圈问同一个来源，而中间那一圈（`baseNameOf` 的字符串切割）会在
 * 无后缀文件上悄悄给出空串。
 *
 * 认不出的一律 `application/octet-stream`——**不猜**。猜错的表现是浏览器按错误的
 * 容器去解，画面全黑但没有任何报错，比「浏览器说我不认识这个类型」难查得多。
 */
const CONTENT_TYPE: Record<string, string> = {
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'video/webm',
}

const OCTET_STREAM = 'application/octet-stream'

// ===========================================================================
// 采集权限判定
// ===========================================================================

/** 与 `console/src/api/types.ts` 的 `WhyKind` 逐字一致，理由同 content.ts */
type WhyKind = 'rule' | 'hand' | 'fail' | 'expired' | 'wait' | 'na' | 'deny'
interface Why {
  by: WhyKind
  text: string
}

interface Access {
  allow: 'allow' | 'deny'
  /** **采集规则不准许，这次是管理员豁免看的**（spec §2）。决定记哪个审计动作 */
  restricted: boolean
  why: Why
  /** 决定这次判定的规则 id，落进审计的 `matched_rule` 列。兜底 deny 时为 null */
  ruleId: number | null
}

/**
 * 候选采集程序 + 判定，**逐字抄自 `handlers/console/content.ts` 的
 * `candidatePrograms` / `resolveAccess`**（那两个函数没有导出，而 content.ts 不在
 * 本任务的落点里，不许改）。
 *
 * ⚠️ **现在有三份了**（`meetings.ts` / `content.ts` / 本文件），**改一处就要改三处**。
 * 分叉的表现是同一场会议在会议记录页显示「准许采集」、在内容预览页挂着琥珀警示条、
 * 而播放这一次记进审计的却是第三种说法——管理员没有任何办法判断哪一边是对的。
 *
 * 三份是一份太多。该做的是把它提成 `handlers/console/access.ts` 由三处共用（与
 * `domain/asset-labels.ts` 从两份拷贝收拢成一份是同一件事），但那要改
 * content.ts / meetings.ts 两个不属于本任务的文件，留给下一轮。
 */
function candidatePrograms(allowRules: readonly StackRule[]): string[] {
  const out: string[] = []
  for (const r of allowRules) {
    const v = r.subjectValue ?? ''
    if (r.subjectType === 'program' && v !== '' && !out.includes(v)) out.push(v)
  }
  // 一条规则都没有时也要跑一轮：人工改写优先于所有规则（spec §5.4），
  // 一条把 deny 翻成 allow 的改写不需要任何规则存在就能生效
  return out.length > 0 ? out : ['']
}

async function resolveAccess(ctx: RouteCtx, key: MeetingKey, now: number): Promise<Access> {
  const vis = ctx.deps.meetingVisibility
  const allowRules = await vis.policy.listEnabledStackRules('allow')

  let example: { programId: string; decision: OverriddenDecision<AllowEffect> } | null = null
  for (const programId of candidatePrograms(allowRules)) {
    const entry = await explainMeetingAccess(vis, {
      programId,
      meetingId: key.meetingId,
      subMeetingId: key.subMeetingId,
      now,
    })
    if (entry.decision === null) continue
    if (isVisible(entry.decision)) {
      return {
        allow: 'allow',
        restricted: false,
        why: {
          by: wasOverridden(entry.decision) ? 'hand' : 'rule',
          text: withProgram(programId, entry.decision.reason),
        },
        ruleId: entry.decision.ruleId,
      }
    }
    example ??= { programId, decision: entry.decision }
  }

  if (example === null) {
    // 判不出来就落到拒绝一侧，**并且说出是判不出来**——不是静默放行，也不是编一个判定
    return {
      allow: 'deny',
      restricted: true,
      why: {
        by: 'na',
        text:
          '这场会议在 meetings 表里查不到元数据（标题、主持人、时间），采集权限规则求值所需的' +
          '事实取不到，无从判定，按拒绝处理。这多半是数据完整性问题，不是某条规则做出的决定。',
      },
      ruleId: null,
    }
  }

  const d = example.decision
  const by: WhyKind = wasOverridden(d)
    ? 'hand'
    : // `deny` 只配「有一条规则明确拒绝」用：兜底（source='default'）不是明确拒绝
      d.source === 'rule' && d.effect === 'deny'
      ? 'deny'
      : 'rule'
  return {
    allow: 'deny',
    restricted: true,
    why: { by, text: withProgram(example.programId, d.reason) },
    ruleId: d.ruleId,
  }
}

/** 程序 id 为空串（一条 allow 规则都没有）时不挂——`采集程序「」` 读起来像个 bug */
function withProgram(programId: string, reason: string): string {
  return programId === '' ? reason : `采集程序「${programId}」：${reason}`
}

// ===========================================================================
// 留痕
// ===========================================================================

interface AssetTriple {
  assetType: string
  remoteId: string
  fileType: string
}

/**
 * 写一行播放记录。**不 try/catch**：见文件头第五条。
 *
 * `assetType` 那一列留 null、把三段自然键写进 `detail`——与 content 端点逐字同一个
 * 处理，不是偷懒。`audit_log` 的 `asset_id` 列已经被周期性会议的场次占了
 * （`sub:${subMeetingId}`，见 `handlers/console/storage.ts` 的同一约定），此时再往
 * `asset_type` 里填一个真的资产类型，读的人会看到一对
 * `asset_type=video / asset_id=sub:xxx`——一个看起来像资产引用、实际上不是的组合。
 * 两个页面读同一张审计表，口径必须只有一个。
 */
async function recordPlay(
  ctx: RouteCtx,
  input: { adminId: string; key: MeetingKey; access: Access; asset: AssetTriple },
): Promise<void> {
  const { assetType, remoteId, fileType } = input.asset
  const label = ASSET_LABEL[assetType as 'video' | 'audio'] ?? assetType
  const target = `media:${assetType}/${remoteId}/${fileType}`
  const entry: AuditEntry = {
    occurredAt: ctx.deps.now(),
    actorType: 'admin',
    actorId: input.adminId,
    action: input.access.restricted ? AUDIT_ACTION.viewRestrictedContent : AUDIT_ACTION.viewContent,
    meetingId: input.key.meetingId,
    assetId: input.key.subMeetingId === '' ? null : `sub:${input.key.subMeetingId}`,
    assetType: null,
    // 这次**查看**是被准许的（管理员豁免），所以恒为 allow。被规则禁掉的是
    // 「采集」，不是这次查看——记成 deny 等于宣称一次没发生过的拒绝
    decision: 'allow',
    matchedRuleId: input.access.ruleId,
    clientKind: 'console',
    detail: buildAuditDetail({
      text: `播放${label} ${target}`,
      data: {
        target,
        asset: input.asset,
        restricted: input.access.restricted,
        allow: input.access.allow,
        // 当时的判定理由原话。事后要问的是「他看的那一刻，这场会议为什么是禁止
        // 采集的」，而 matched_rule 答不出这个（兜底 deny 时它本来就是 null）
        why: input.access.why,
      },
    }),
  }
  await ctx.deps.auditStore.record(entry)
}

// ===========================================================================
// 路径防穿越
// ===========================================================================

/**
 * `target` 是否**严格落在** `root` 之内。
 *
 * 三条都不是可有可无的：
 * 1. 两边都先 `resolve`——`..` / 符号链接式的相对段在字符串比较前必须先被折掉。
 * 2. 前缀比较**带分隔符**：`/nas-evil` 与 `/nas` 只差一个字符，纯 `startsWith`
 *    会放它进来。
 * 3. `target === root` 判 false：根目录是目录不是文件，让它通过只会在下一步
 *    换成一个说不清来源的读目录错误。
 *
 * 与 `src/worker/archive.ts` 的 `isUnder` 是同一条判据（那边判「归档资产是不是在
 * 本会议目录内」），只是这里多做一次 `resolve`：那边比较的两个值都是同一次运算
 * 拼出来的，这里有一个来自库。
 */
function isInsideRoot(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  if (t === r) return false
  return t.startsWith(r.endsWith(sep) ? r : r + sep)
}

// ===========================================================================
// Range
// ===========================================================================

/**
 * 一次请求要发的字节区间。
 *
 * - `full`：无 Range、多段 Range、认不出的单位——三种都返回 200 全量（见文件头第四条）
 * - `partial`：`[start, end]` **闭区间**，与 `Content-Range` 的语义一致
 * - `unsatisfiable`：416，此时**一个字节都不发**，也不留痕
 */
type RangeSpec =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }

/** `bytes=0-1023` / `bytes=1024-` / `bytes=-500`（后缀，取最后 500 字节） */
const BYTE_RANGE = /^(\d*)-(\d*)$/

function parseRange(header: string | null, size: number): RangeSpec {
  if (header === null || header.trim() === '') return { kind: 'full' }

  const eq = header.indexOf('=')
  // RFC 7233：认不出的 range unit **必须忽略**（当作没有这个头），不是报错。
  // 报 416 会让一个用了别的单位的中间件把整个播放打死
  if (eq < 0 || header.slice(0, eq).trim().toLowerCase() !== 'bytes') return { kind: 'full' }

  const spec = header.slice(eq + 1).trim()
  // 多段不支持。返回 200 全量比返回一个只含第一段却自称 206 的假响应好
  if (spec.includes(',')) return { kind: 'full' }

  const m = BYTE_RANGE.exec(spec)
  if (m === null) return { kind: 'unsatisfiable' }

  const head = m[1]!
  const tail = m[2]!
  // `bytes=-` 两头都空：既不是区间也不是后缀，说不出要什么
  if (head === '' && tail === '') return { kind: 'unsatisfiable' }

  if (head === '') {
    // 后缀式：取最后 N 字节。mp4 的 moov 在文件尾时播放器真的会这么发，
    // 不支持它的表现是这类文件一秒都播不了
    const n = Number(tail)
    if (!Number.isSafeInteger(n) || n <= 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', start: Math.max(0, size - n), end: size - 1 }
  }

  const start = Number(head)
  // 起点落在文件之外就是 416：钳到末尾会给出一段调用方没要过的数据
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' }

  // 终点超界**钳到末尾**（RFC 7233 明文允许），不是 416：`bytes=0-99999` 是
  // 播放器要「从这里到能给多少给多少」的常规写法
  const rawEnd = tail === '' ? size - 1 : Number(tail)
  const end = Number.isSafeInteger(rawEnd) ? Math.min(rawEnd, size - 1) : size - 1
  if (end < start) return { kind: 'unsatisfiable' }
  return { kind: 'partial', start, end }
}

// ===========================================================================
// GET /api/v1/admin/meetings/:meetingId/media/:assetType/:remoteId/:fileType
// ===========================================================================

export async function getMedia(req: Request, ctx: RouteCtx): Promise<Response> {
  const now = ctx.deps.now()
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, now)
  // 只读角色**不降级**：看内容是它该有的权限（spec §2 / A8 白名单），
  // 这里走 requireAdminAuth 而不是 requireAdminWrite，与 content 两条端点一致
  if (!auth.ok) return auth.response

  const assetType = ctx.params.assetType ?? ''
  const remoteId = ctx.params.remoteId ?? ''
  const fileType = ctx.params.fileType ?? ''

  // 参数与配置两道校验排在**认证之后、查库之前**——排在认证前面等于向未登录者
  // 反馈参数对不对；排在查库后面则是为一个注定失败的请求先花几次往返
  // （与 content.ts 的 `prepare(validate)` 同一个位置、同一个理由）
  if (!MEDIA_ASSET_TYPES.has(assetType)) {
    return json(400, {
      error: 'not_a_media_asset',
      message:
        `这条端点只服务录像（video）与音频（audio），收到「${assetType}」。` +
        `纪要与转写正文走 GET /api/v1/admin/meetings/:meetingId/content——` +
        `从这里放出去等于开第二条读正文的路，两条路的审计口径会分叉。`,
    })
  }

  // 先判参数再判配置：参数错是调用方的事、说得出该怎么改；根目录没配是本机的事。
  // 两个都错时先说前者，因为它更具体
  const nasRoot = ctx.deps.media.nasRoot
  if (nasRoot === null || nasRoot === '') {
    return json(503, {
      error: 'nas_root_unset',
      message:
        '本进程没有挂载 NAS（MDE_NAS_ROOT 未配置），读不到已归档的录像与音频。' +
        '这不是「这场会议没有录像」——请检查网关进程的挂载与环境变量。',
    })
  }

  const key = parseConsoleMeetingId(ctx.params.meetingId ?? '')
  const row = await ctx.deps.consoleMeetings.get(key.meetingId, key.subMeetingId, now)
  if (row === null) return json(404, { error: 'meeting_not_found' })

  const [access, archived] = await Promise.all([
    resolveAccess(ctx, key, now),
    ctx.deps.archivesStore.listArchivedAssetsForMeeting(key.meetingId, key.subMeetingId),
  ])

  // 三段**精确**匹配。这里不做任何「差不多就是它」的回退：同一场会议可以有多段
  // 录像（多个 remote_id），退而求其次匹配另一段的表现是播放器放出了另一段会议的
  // 画面，而界面上一切正常
  const hit = archived.find(
    (a) => a.assetType === assetType && a.remoteId === remoteId && a.fileType === fileType,
  )
  if (hit === undefined) {
    return json(404, {
      error: 'asset_not_archived',
      message:
        `这场会议的 archived_assets 里没有 (${assetType}, ${remoteId}, ${fileType}) 这一段。` +
        `它可能还没归档到 NAS（见会议详情的归档阶段），也可能平台压根没生成这一类。`,
    })
  }

  // 相对路径按根目录解，绝对路径 resolve 会原样保留——库里两种写法都兜得住，
  // 而防穿越判据对两种写法是同一条
  const abs = resolve(nasRoot, hit.nasPath)
  if (!isInsideRoot(nasRoot, abs)) {
    // 库里出现这种记录本身是个待查的事故，静默 403 会让它永远没人发现。
    // 路径只进服务端日志，**不进响应体**（见文件头第三条）
    console.warn(
      `[media] 拒绝越界读取：archived_assets 里 (${key.meetingId}/${key.subMeetingId}/` +
        `${assetType}/${remoteId}/${fileType}) 的 nas_path 解析为 ${abs}，不在 ` +
        `MDE_NAS_ROOT（${resolve(nasRoot)}）之内。这条记录需要人工核对。`,
    )
    return json(403, {
      error: 'path_outside_root',
      message:
        '这一段资产在归档记录里的路径不在本进程的 NAS 根目录之内，已拒绝读取。' +
        '这不是权限问题，是一条需要人工核对的归档记录——详情见网关日志。',
    })
  }

  // 先 stat 再决定发什么：Range 的三个头全都要真实大小，而
  // 「记录在、盘上那份没了」必须与「压根没归档过」分成两个码
  let size: number
  try {
    const st = await stat(abs)
    // 目录 / 设备文件也落这里：它们同样「不是一个可播放的文件」，
    // 与其新造第六个错误码，不如归到 media_gone 并在日志里说清是哪一种
    if (!st.isFile()) {
      console.warn(`[media] ${abs} 存在但不是普通文件（归档记录写坏了？），按 media_gone 处理`)
      return mediaGone()
    }
    size = st.size
  } catch {
    return mediaGone()
  }

  const range = parseRange(req.headers.get('range'), size)
  if (range.kind === 'unsatisfiable') {
    // 一个字节都没发出去，就没有「查看」可留痕
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
    })
  }

  const start = range.kind === 'full' ? 0 : range.start
  const end = range.kind === 'full' ? size - 1 : range.end

  // 留痕在**发字节之前**，且**只在这一次播放的起点**记（见文件头第五条）。
  // 写不进去就整个请求失败——没有对价就不能给内容
  if (start === 0) {
    await recordPlay(ctx, { adminId: auth.identity.adminId, key, access, asset: { assetType, remoteId, fileType } })
  }

  const headers = new Headers({
    'content-type': CONTENT_TYPE[fileType.toLowerCase()] ?? OCTET_STREAM,
    // 缺了它 Safari 不是「不能拖进度条」而是**整个拒播**
    'accept-ranges': 'bytes',
    'content-length': String(end - start + 1),
    // 播放而不是下载
    'content-disposition': 'inline',
    // 会议录像不该在任何一层留下副本：这条端点带管理员会话，缓存下来的那一份不带
    'cache-control': 'private, no-store',
  })
  if (range.kind === 'partial') headers.set('content-range', `bytes ${start}-${end}/${size}`)

  // `Bun.file().slice()` 出来的是一个惰性的 Blob，**不把文件读进内存**——
  // 录像可以有几个 GB，整读一次就是一次 OOM。end 是闭区间，slice 的第二参是开区间
  return new Response(Bun.file(abs).slice(start, end + 1), {
    status: range.kind === 'partial' ? 206 : 200,
    headers,
  })
}

function mediaGone(): Response {
  return json(404, {
    error: 'media_gone',
    // 路径不进响应体（文件头第三条）
    message:
      '这一段资产在归档记录里有，但 NAS 上那份文件此刻读不到（被删了？挂载掉了？）。' +
      '这不是「这场会议没有录像」——归档记录还在，请去 NAS 上核对。',
  })
}
