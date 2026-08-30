/**
 * A6 · 内容读取 API（阶段 4 · T10）。spec.md §4.4「内容预览」。
 *
 * ```
 * GET /api/v1/admin/meetings/:meetingId/content            纪要 / 转写正文（按 asset_type）
 * GET /api/v1/admin/meetings/:meetingId/content/chapters   时间轴
 * ```
 *
 * 写侧是 T4（`src/store/contents.ts` + `migrations/007_asset_contents.sql`），本文件
 * 一个字都不改它，只读。
 *
 * ## 一、五段主键：按四段查会漏掉第二段
 *
 * `asset_contents` 的主键是 `(meeting_id, sub_meeting_id, asset_type, remote_id, file_type)`
 * ——**五段**。同一场会议的同一类文本资产可以有多段（引擎的 `assetKeyToFilename`
 * 为此留了 `transcript_2.txt` 的序号消歧，见 `FILENAME_HAS_REMOTE_ID`），多段之间
 * 正是靠 `remote_id` 区分的。
 *
 * 所以本文件读正文时**按三段查**（会议两段 + `asset_type`），把命中的全部段一起返回,
 * `remote_id` 一律不参与筛选。少想这一层的表现是：预览页显示的是最后归档的那一段,
 * 界面上没有任何痕迹说明还有另一段——而那正是 007 表头点名要防的那种静默丢失。
 *
 * ## 二、「未解析」不许显示成「这场会议没有纪要」
 *
 * T4 的裁定是**只有 txt 入库**，docx / pdf 明确记一行 `unsupported_format`。这两件事
 * 在界面上必须分得开，因为处理方式完全不同：前者去 NAS 拿原文件就能看，后者要去查
 * 归档流水线为什么没拉到。所以 `selected.state` 有三个取值（`ok` / `unparsed` /
 * `absent`），资产索引的 `availability` 有六个——**每一个都对应一件不同的事实**：
 *
 * | availability | 事实 | 谁写的 |
 * | --- | --- | --- |
 * | `parsed` | 正文在库里 | `asset_contents.status` |
 * | `unsupported_format` | 不是 txt，或不是合法 UTF-8 | 同上 |
 * | `too_large` | 超过 MEDIUMTEXT 的 16MB 上限 | 同上 |
 * | `not_ingested` | 已归档到 NAS，但正文还没入库（回填没跑到） | 本文件按两表差集算 |
 * | `not_archived` | 本地下载完成了，还没归档——正文入库发生在归档时 | 同上 |
 * | `missing` | **确认取不到**（`skipped` / `dead`） | `meeting_assets.status` |
 *
 * 只有最后一行才是「这场会议确实缺这一类」。把上面五种里的任何一种显示成它，
 * 就是把一个可修复的缺口伪装成一件既成事实。
 *
 * ## 三、留痕是「管理员仍然能看」的对价，不是可选项
 *
 * spec §2：「管理员查看会议内容会留痕。尤其是被规则禁止采集的会议——管理员仍然能看
 * （他要判断这条规则拦对了没有），但顶部挂琥珀警示条，且这次查看进审计日志。」
 *
 * 于是两个端点都写一行 `audit_log`，动作分两种：
 *
 * - `view_content`：采集规则准许这场会议
 * - `view_restricted_content`：**采集规则不准许**，这次是管理员豁免看的
 *
 * **分两个动作，而不是一个动作加一个 `matched_rule`**：兜底 deny（一条规则都没匹配）
 * 没有规则 id 可记，那时两种查看在审计流里会长得一模一样，而「哪些被禁采集的会议
 * 被管理员看过」恰恰是这条留痕唯一要回答的问题。分成两个动作之后，A5 的审计页
 * 用现成的 `?action=` 就筛得出来（`store/audit.ts` 的 `AuditQuery.actions`）。
 *
 * 这一行**不 try/catch**：审计写不进去就没有对价，此时返回正文等于绕过 spec §2。
 * 让它抛出去、由 `router.ts` 的 `internalError` 变成 500，是这里唯一诚实的选择。
 *
 * 明细走 `audit_log.detail`（阶段 4 · T15），除了「看了什么」还记下**当时的判定
 * 理由原话**。事后复盘要问的是「他看的那一刻，这场会议为什么是禁止采集的」，
 * 而 `matched_rule` 答不出这个——兜底 deny 时它本来就是 null。
 *
 * ## 四、录像不代理（T10 验收 3）
 *
 * `?type=video` / `?type=audio` 直接 400。录像与音频既不入 `asset_contents`
 * （007 表头：它们不是文本，单个可以有几个 GB），本接口也不去读文件、不做流转发——
 * 网关多实例、录像几个 GB，代理一份就是把网关变成 CDN。响应里的 `media` 块只给
 * **去向**：NAS 路径、本地路径、以及签直链的那个既有端点。
 *
 * ## 五、时间轴章节没有来源，所以不编（同 E-c 那条口径）
 *
 * 腾讯会议那张页面上的「章节 + 摘要」在本系统里**一次都没被拉取过**：
 * `src/tencent/records.ts` 里没有任何一个取章节的调用点，库里也没有任何一列装它。
 * 所以 `chapters` 恒为空数组、`source` 报 `'none'`，并说清为什么——这与 A2 对
 * `why.fetch` 的处理（计划 §0 E-c）是同一条裁定：**不宣称一次没发生过的判定/没拉过
 * 的数据**。
 *
 * 时间轴仍然有东西可渲染：转写正文里的时间戳。它们是真实数据，所以照样解析出来,
 * 但字段叫 `cues`（转写分段）而不是 `chapters`，并在 `text` 里写明两者的区别。
 * 认不出格式时返回前几行原文（`sample`），好过一个说不出为什么的空时间轴。
 */

import type { RowDataPacket } from 'mysql2'
import {
  ALL_ASSET_KEYS,
  ASSET_KEY_TO_GATEWAY_TYPE,
  GATEWAY_TYPE_TO_ASSET_KEY,
  isTextAssetType,
  type AssetKey,
} from '@yaowu/mde-engine'
import { isVisible } from '../../../policy/access'
import { wasOverridden, type OverriddenDecision } from '../../../policy/override'
import type { AllowEffect, StackRule } from '../../../policy/stacks'
import { buildAuditDetail, type AuditEntry } from '../../../store/audit'
import { ASSET_LABEL } from '../../../domain/asset-labels'
import { AUDIT_ACTION } from '../../../audit/actions'
import { parseConsoleMeetingId, type ConsoleMeetingRow } from '../../../store/console-meetings'
import type { MeetingArchiveRecord } from '../../../store/archives'
import type { AssetContentKey, AssetContentStatus } from '../../../store/contents'
import type { Pool } from '../../../store/db'
import type { MeetingKey } from '../../../store/grants'
import { expiresAt } from '../../../worker/retention'
import { explainMeetingAccess } from '../../../worker/visibility'
import { requireAdminAuth } from '../../middleware'
import { json } from '../../respond'
import type { RouteCtx } from '../../router'

// ===========================================================================
// asset_contents 的读侧
// ===========================================================================

/**
 * 索引里的一行——**不带正文**。
 *
 * 与 `AssetContentRecord`（T4 的写侧形状）差两处：没有 `content`，多一个 `chars`。
 * 两处都是为了同一件事：一页预览可能要列七八段文本资产，把每一段的正文都读出来
 * 只为了显示「这份纪要多长」，等于为一个数字搬十几 MB。`chars` 由 SQL 侧的
 * `CHAR_LENGTH` 算，**字符数不是字节数**——中文按字节算会把「5 个字」显示成 15。
 */
export interface ContentIndexRow extends AssetContentKey {
  status: AssetContentStatus
  /** NAS 副本的字节数 */
  bytes: number
  /** 未解析的原因，一句人话；parsed 时 null */
  reason: string | null
  contentHash: string | null
  /** unix 秒 */
  parsedAt: number
  /** 正文字符数；未解析时 null */
  chars: number | null
}

export interface ContentSegmentRow extends ContentIndexRow {
  /** 正文，`status !== 'parsed'` 时恒为 null */
  content: string | null
}

/**
 * 内容预览要的两条查询。**故意收窄成两个方法**，不是一个通用的 contents store——
 * 与 `handlers/console/audit.ts` 的 `AuditMeetingLookup` 同一个理由：
 * `src/store/contents.ts`（T4）是写侧的落点，本任务不改它，而它的 `get` 要五段全键、
 * 答不了「这场会议这一类有几段」。
 */
export interface ContentLookup {
  /** 一场会议的全部文本资产行，**不带正文**，按自然键升序 */
  listForMeeting(meetingId: string, subMeetingId: string): Promise<ContentIndexRow[]>
  /**
   * 一场会议里某一类文本资产的**全部段**，带正文。
   *
   * ⚠️ `remoteId` 不是参数，这是有意的：多段之间正是靠它区分，拿它当筛选条件就等于
   * 每次只取一段（见文件头第一条）。`fileType` 可选，对应界面上的 `txt / docx / pdf`
   * 格式开关。
   */
  listSegments(
    meetingId: string,
    subMeetingId: string,
    assetType: string,
    fileType?: string,
  ): Promise<ContentSegmentRow[]>
}

interface ContentSqlRow extends RowDataPacket {
  meeting_id: string
  sub_meeting_id: string
  asset_type: string
  remote_id: string
  file_type: string
  status: AssetContentStatus
  bytes: number
  reason: string | null
  content_hash: string | null
  parsed_at: number
  chars: number | null
}

interface SegmentSqlRow extends ContentSqlRow {
  content: string | null
}

/** SELECT 列表里除正文之外的全部列。两条查询共用一份，免得索引与正文两条路给出不同的字段 */
const INDEX_COLUMNS = `meeting_id, sub_meeting_id, asset_type, remote_id, file_type,
        status, bytes, reason, content_hash, parsed_at,
        CHAR_LENGTH(content) AS chars`

function mapIndexRow(r: ContentSqlRow): ContentIndexRow {
  return {
    meetingId: r.meeting_id,
    subMeetingId: r.sub_meeting_id,
    assetType: r.asset_type,
    remoteId: r.remote_id,
    fileType: r.file_type,
    status: r.status,
    // BIGINT 显式 Number 化，理由同 store/contents.ts：字符串 "1234" 会让
    // 「大于 1MB 就折叠」这类判断悄悄按字典序比
    bytes: Number(r.bytes),
    reason: r.reason,
    contentHash: r.content_hash,
    parsedAt: Number(r.parsed_at),
    chars: r.chars === null ? null : Number(r.chars),
  }
}

export function createContentLookup(pool: Pool): ContentLookup {
  return {
    async listForMeeting(meetingId, subMeetingId) {
      const [rows] = await pool.execute<ContentSqlRow[]>(
        `SELECT ${INDEX_COLUMNS}
           FROM asset_contents
          WHERE meeting_id = ? AND sub_meeting_id = ?
          ORDER BY asset_type, remote_id, file_type`,
        [meetingId, subMeetingId],
      )
      return rows.map(mapIndexRow)
    },

    async listSegments(meetingId, subMeetingId, assetType, fileType) {
      // 三段键 + 可选的 file_type。**主键前缀**（meeting_id, sub_meeting_id, asset_type）
      // 正好是这条 WHERE，所以它走主键的最左前缀，不是全表扫。
      const [rows] = await pool.execute<SegmentSqlRow[]>(
        `SELECT ${INDEX_COLUMNS}, content
           FROM asset_contents
          WHERE meeting_id = ? AND sub_meeting_id = ? AND asset_type = ?
                ${fileType === undefined ? '' : 'AND file_type = ?'}
          ORDER BY remote_id, file_type`,
        fileType === undefined
          ? [meetingId, subMeetingId, assetType]
          : [meetingId, subMeetingId, assetType, fileType],
      )
      return rows.map((r) => ({ ...mapIndexRow(r), content: r.content }))
    },
  }
}

// ===========================================================================
// 对外形状
// ===========================================================================

/** 与契约 `console/src/api/types.ts` 的 `WhyKind` 逐字一致。重新声明而不是 import
 *  的理由同 `handlers/console/meetings.ts`：`console/` 是独立的 npm 工程，跨不过去 */
type WhyKind = 'rule' | 'hand' | 'fail' | 'expired' | 'wait' | 'na' | 'deny'
interface Why {
  by: WhyKind
  text: string
}

/** 六个取值各对应一件不同的事实，含义见文件头第二条那张表 */
export type ContentAvailability =
  | AssetContentStatus
  | 'not_ingested'
  | 'not_archived'
  | 'missing'

interface ContentAsset {
  /** 网关的 `asset_type` 原值（库里存的就是它） */
  assetType: string
  /** 契约的 `AssetKey`。认不出的 `asset_type` 给 null，**不硬塞进八个键里的某一个** */
  assetKey: AssetKey | null
  remoteId: string
  fileType: string
  availability: ContentAvailability
  bytes: number | null
  chars: number | null
  reason: string | null
  contentHash: string | null
  parsedAt: number | null
  nasPath: string | null
}

interface ContentSegment extends ContentAsset {
  /** 这一类里的第 n 段（1 起）。对应引擎的 `transcript_2.txt` 那个序号 */
  ordinal: number
  content: string | null
}

// 八类资产的中文名从 `src/domain/asset-labels.ts` 来（阶段 5 · A9 收拢的唯一一份）

function labelOf(assetType: string): string {
  const key = GATEWAY_TYPE_TO_ASSET_KEY[assetType]
  return key === undefined ? assetType : ASSET_LABEL[key]
}

/** unix 秒读成一句人话，只为进理由文案。UTC 就是审计里的口径——与
 *  `worker/visibility.ts` / `handlers/console/meetings.ts` 的 `stamp` 同源 */
function stamp(sec: number): string {
  return `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`
}

/** 三段自然键（会议维度已经确定），用 NUL 分隔——理由同 `archiveStateKey`：
 *  用可打印字符分隔会让 `("a:b","")` 与 `("a","b")` 撞成同一个键 */
function assetKeyOf(assetType: string, remoteId: string, fileType: string): string {
  return `${assetType} ${remoteId} ${fileType}`
}

// ===========================================================================
// 采集权限判定
// ===========================================================================

/**
 * 候选采集程序：启用的 allow 规则上出现过的 `subject_value`。
 *
 * **与 `handlers/console/meetings.ts` 的 `candidatePrograms` 是同一条裁定**（含
 * 「一条规则都没有时用 `['']` 再跑一轮」这一条）——那一轮不是多余的：人工改写优先于
 * 所有规则（spec §5.4），一条把 deny 翻成 allow 的改写不需要任何规则存在就能生效。
 *
 * 这里重写一份而不是 import，是因为 T10 的落点里明确写了「不要碰其他 handler」，
 * 而那个函数没有导出。**两处必须同时改**：分叉的表现是同一场会议在会议记录页显示
 * 「准许采集」、在内容预览页却挂着琥珀警示条，而管理员没有任何办法判断哪一边是对的。
 */
function candidatePrograms(allowRules: readonly StackRule[]): string[] {
  const out: string[] = []
  for (const r of allowRules) {
    const v = r.subjectValue ?? ''
    if (r.subjectType === 'program' && v !== '' && !out.includes(v)) out.push(v)
  }
  return out.length > 0 ? out : ['']
}

interface Access {
  allow: 'allow' | 'deny'
  /** 琥珀警示条的开关：**采集规则不准许，这次是管理员豁免看的**（spec §2） */
  restricted: boolean
  why: Why
  banner: string | null
  /** 决定这次判定的规则 id，落进审计的 `matched_rule` 列。兜底 deny 时为 null */
  ruleId: number | null
}

/**
 * 「这场会议被采集规则禁止采集了没有」。
 *
 * 走 `explainMeetingAccess`——**与采集清单重算（`computeProgramInventory`）是同一段
 * 判定代码、同一批原料**。自己在这里再判一遍的下场是：控制台说「准许采集」而网关取的
 * 时候被拒，两处各判一遍谁都查不出是哪一边错了。
 *
 * 「至少有一个采集程序会被判 allow」就算准许——与 A2 的 `summarizeAllow` 同一条裁定。
 */
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
        banner: null,
        ruleId: entry.decision.ruleId,
      }
    }
    example ??= { programId, decision: entry.decision }
  }

  if (example === null) {
    // 判不出来就落到拒绝一侧，**并且说出是判不出来**——不是静默放行，也不是编一个判定。
    // 与 A2 的同一条分支逐字同源。这种会议照样挂琥珀条：它是「规则没准许」的一种。
    return {
      allow: 'deny',
      restricted: true,
      why: {
        by: 'na',
        text:
          '这场会议在 meetings 表里查不到元数据（标题、主持人、时间），采集权限规则求值所需的' +
          '事实取不到，无从判定，按拒绝处理。这多半是数据完整性问题，不是某条规则做出的决定。',
      },
      banner: RESTRICTED_BANNER,
      ruleId: null,
    }
  }

  const d = example.decision
  const by: WhyKind = wasOverridden(d)
    ? 'hand'
    : // `deny` 只配「有一条规则明确拒绝」用：兜底（source='default'）不是明确拒绝，
      // 报 deny 会让管理员去找那条根本不存在的规则
      d.source === 'rule' && d.effect === 'deny'
      ? 'deny'
      : 'rule'
  return {
    allow: 'deny',
    restricted: true,
    why: { by, text: withProgram(example.programId, d.reason) },
    banner: RESTRICTED_BANNER,
    ruleId: d.ruleId,
  }
}

/** 程序 id 为空串（一条 allow 规则都没有）时不挂——`采集程序「」` 读起来像个 bug */
function withProgram(programId: string, reason: string): string {
  return programId === '' ? reason : `采集程序「${programId}」：${reason}`
}

const RESTRICTED_BANNER =
  '这场会议按当前的采集权限规则是**禁止采集**的。管理员仍然能看——他要判断这条规则拦对了没有' +
  '（spec §2）——但这次查看已经记进操作审计（动作 view_restricted_content）。' +
  '留痕就是「管理员仍然能看」这条豁免的对价，不是可选项。'

// ===========================================================================
// 留痕
// ===========================================================================

// 这里曾有一个 clipDetail（与 storage.ts / jobs.ts 三份同源）：自由文本被裁到
// 64 字符塞进 audit_log.asset_type。migrations/008 的 detail TEXT 之后不再需要它，
// 明细走 buildAuditDetail，上限与超限留痕收在 src/store/audit.ts 一处。

/**
 * 写一行查看记录。**不 try/catch**：见文件头第三条——审计写不进去就没有对价，
 * 此时把正文发出去等于绕过 spec §2。
 */
async function recordView(
  ctx: RouteCtx,
  input: { adminId: string; key: MeetingKey; access: Access; detail: string },
): Promise<string> {
  const action = input.access.restricted ? AUDIT_ACTION.viewRestrictedContent : AUDIT_ACTION.viewContent
  const entry: AuditEntry = {
    occurredAt: ctx.deps.now(),
    actorType: 'admin',
    actorId: input.adminId,
    action,
    meetingId: input.key.meetingId,
    // audit_log 没有 sub_meeting_id 列，周期性会议的场次落 asset_id——
    // 与 `handlers/console/storage.ts` 的管理员写操作同一个约定
    assetId: input.key.subMeetingId === '' ? null : `sub:${input.key.subMeetingId}`,
    // 「这次看了什么」不是资产类型（它可能是 index / chapters 这种非资产的视图），
    // 从前塞在这一列是因为 detail 列还不存在。现在留空
    assetType: null,
    // 这次**查看**是被准许的（管理员豁免），所以恒为 allow。记成 deny 等于宣称
    // 一次没发生过的拒绝——被规则禁掉的是「采集」，不是这次查看
    decision: 'allow',
    matchedRuleId: input.access.ruleId,
    clientKind: 'console',
    // 受限查看这一族的对价是「留痕」（spec §2），所以留痕要留得住话：
    // 除了看了什么，把**当时的判定理由原话**一并记下——事后复盘要问的是
    // 「他看的那一刻，这场会议为什么是禁止采集的」，而 matched_rule 答不出这个
    detail: buildAuditDetail({
      text: `查看 ${input.detail}`,
      data: {
        target: input.detail,
        restricted: input.access.restricted,
        allow: input.access.allow,
        why: input.access.why,
      },
    }),
  }
  await ctx.deps.auditStore.record(entry)
  return action
}

// ===========================================================================
// 资产索引：四个来源合成一张表
// ===========================================================================

interface AssetSources {
  contents: readonly ContentIndexRow[]
  archived: readonly {
    assetType: string
    remoteId: string
    fileType: string
    nasPath: string
    archivedAt: number
  }[]
  completed: readonly { assetType: string; remoteId: string; fileType: string }[]
  missing: readonly {
    assetType: string
    remoteId: string
    fileType: string
    status: 'skipped' | 'dead'
    lastError: string | null
  }[]
}

/**
 * 合成资产索引。四个来源按**可信度**排队，先到的赢：
 * `asset_contents`（正文的事实）→ `archived_assets`（NAS 上有副本）→
 * `meeting_assets` 的 completed（本地有文件）→ `meeting_assets` 的终态缺失。
 *
 * 这个顺序不是随手排的：一份已经入库的正文即便对应的本地文件早被清理，
 * 它的 `availability` 也必须是 `parsed`——那正是 E-f 选入库方案要保住的东西。
 */
function buildAssetIndex(src: AssetSources): ContentAsset[] {
  const out: ContentAsset[] = []
  const seen = new Set<string>()
  const nasPathOf = new Map(
    src.archived.map((a) => [assetKeyOf(a.assetType, a.remoteId, a.fileType), a.nasPath]),
  )

  const push = (a: ContentAsset): void => {
    const k = assetKeyOf(a.assetType, a.remoteId, a.fileType)
    if (seen.has(k)) return
    seen.add(k)
    out.push(a)
  }

  for (const c of src.contents) {
    push({
      assetType: c.assetType,
      assetKey: GATEWAY_TYPE_TO_ASSET_KEY[c.assetType] ?? null,
      remoteId: c.remoteId,
      fileType: c.fileType,
      availability: c.status,
      bytes: c.bytes,
      chars: c.chars,
      reason: c.reason,
      contentHash: c.contentHash,
      parsedAt: c.parsedAt,
      nasPath: nasPathOf.get(assetKeyOf(c.assetType, c.remoteId, c.fileType)) ?? null,
    })
  }

  for (const a of src.archived) {
    // 录像与音频不入 asset_contents（007 表头），它们由 media 块交代去向，
    // 不该出现在「纪要正文」这张索引里
    if (!isTextAssetType(a.assetType)) continue
    push({
      assetType: a.assetType,
      assetKey: GATEWAY_TYPE_TO_ASSET_KEY[a.assetType] ?? null,
      remoteId: a.remoteId,
      fileType: a.fileType,
      availability: 'not_ingested',
      bytes: null,
      chars: null,
      reason:
        `已归档到 NAS（${stamp(a.archivedAt)}），但 asset_contents 里还没有这一段的正文——` +
        `多半是这场会议归档在正文入库上线之前，跑一次回填脚本 scripts/backfill-contents.ts 就有了。` +
        `文件本身在 ${a.nasPath}，现在就能取。`,
      contentHash: null,
      parsedAt: null,
      nasPath: a.nasPath,
    })
  }

  for (const c of src.completed) {
    if (!isTextAssetType(c.assetType)) continue
    push({
      assetType: c.assetType,
      assetKey: GATEWAY_TYPE_TO_ASSET_KEY[c.assetType] ?? null,
      remoteId: c.remoteId,
      fileType: c.fileType,
      availability: 'not_archived',
      bytes: null,
      chars: null,
      reason:
        '本地已下载完成，但还没归档到 NAS——正文入库发生在归档那一刻（见 src/worker/archive.ts），' +
        '所以这一段还读不到正文。等下一轮归档任务（每小时整点）跑过就有了。',
      contentHash: null,
      parsedAt: null,
      nasPath: null,
    })
  }

  for (const m of src.missing) {
    if (!isTextAssetType(m.assetType)) continue
    push({
      assetType: m.assetType,
      assetKey: GATEWAY_TYPE_TO_ASSET_KEY[m.assetType] ?? null,
      remoteId: m.remoteId,
      fileType: m.fileType,
      availability: 'missing',
      bytes: null,
      chars: null,
      // **这一档才是「这场会议确实缺这一类」**，上面三档都不是
      reason:
        `确认取不到：这一段在 meeting_assets 里是终态 ${m.status}` +
        `（${m.status === 'dead' ? '重试用尽' : '明确放弃'}）` +
        `${m.lastError === null ? '' : `，最后一次的错是「${m.lastError}」`}。` +
        `NAS 上也没有副本，去 NAS 取会扑空。`,
      contentHash: null,
      parsedAt: null,
      nasPath: null,
    })
  }

  // 顺序按 ALL_ASSET_KEYS：界面上八类资产的次序因此是稳定的，不跟着优化器走。
  // 认不出的 asset_type 排在最后（网关将来接新纪要引擎时会出现），不丢掉
  const rank = (a: ContentAsset): number => {
    const k = a.assetKey
    return k === null ? ALL_ASSET_KEYS.length : ALL_ASSET_KEYS.indexOf(k)
  }
  return out.sort(
    (x, y) =>
      rank(x) - rank(y) ||
      x.assetType.localeCompare(y.assetType) ||
      x.remoteId.localeCompare(y.remoteId) ||
      x.fileType.localeCompare(y.fileType),
  )
}

// ===========================================================================
// 参数
// ===========================================================================

interface ResolvedType {
  gatewayType: string
  assetKey: AssetKey
}

/**
 * `?type=` 认两套词汇：契约的 `AssetKey`（`transcript`）与网关的 `asset_type`
 * （`meeting_summary`）。两者只有 transcript / ai_transcript 两项不同名，而这种
 * **部分重合**恰好是引擎那份注释记着的一次真实故障（M3.5，dev-plan §5 C7）——
 * 前端拿哪一套过来都能用，是这里唯一不会再踩一次的做法。
 *
 * 原型 HTML 里那套短名（`summary` / `aitr` / `digest`）一律不认，回 400。
 */
function resolveAssetType(raw: string): ResolvedType | null {
  if (Object.hasOwn(ASSET_KEY_TO_GATEWAY_TYPE, raw)) {
    const key = raw as AssetKey
    return { gatewayType: ASSET_KEY_TO_GATEWAY_TYPE[key], assetKey: key }
  }
  const key = GATEWAY_TYPE_TO_ASSET_KEY[raw]
  return key === undefined ? null : { gatewayType: raw, assetKey: key }
}

// ===========================================================================
// 本地文件与 NAS
// ===========================================================================

interface LocalState {
  archived: boolean
  filesGone: boolean
  archivedAt: number | null
  purgedAt: number | null
  expiresAt: number | null
  nasDir: string | null
  text: string
}

/**
 * 「本地文件还在不在」——判据是 `local_purged_at IS NULL`，**不是** `expiresAt >= now`。
 * 与 `worker/visibility.ts` 的 `checkRetention` 同一条口径（D-u）：窗口过了但清理被
 * 暂停的会议文件还在，此刻真取得到。
 */
function localState(rec: MeetingArchiveRecord | null): LocalState {
  if (rec === null) {
    return {
      archived: false,
      filesGone: false,
      archivedAt: null,
      purgedAt: null,
      expiresAt: null,
      nasDir: null,
      text:
        '这场会议还没有归档到 NAS，保留窗口也就还没开始计时。纪要正文入库发生在归档那一刻，' +
        '所以此刻库里读到的正文可能不全——本地文件在不在，看会议详情里的拉取/归档两个阶段。',
    }
  }
  const due = expiresAt(rec)
  if (rec.localPurgedAt === null) {
    return {
      archived: true,
      filesGone: false,
      archivedAt: rec.archivedAt,
      purgedAt: null,
      expiresAt: due,
      nasDir: rec.nasDir,
      text:
        `本地文件还在，保留期到 ${stamp(due)}。NAS 上的副本在 ${rec.nasDir}。` +
        `到期后只删本地文件，数据库记录（含这里读到的纪要正文）永久保留（spec §4.9）。`,
    }
  }
  return {
    archived: true,
    filesGone: true,
    archivedAt: rec.archivedAt,
    purgedAt: rec.localPurgedAt,
    expiresAt: due,
    nasDir: rec.nasDir,
    // §4.10 的原话（「本地已到期，请去 NAS 取」）与 visibility.ts 那条 blocker 同源
    text:
      `本地文件已于 ${stamp(rec.localPurgedAt)} 到期清理（保留期到 ${stamp(due)}）,` +
      `NAS 上的副本在 ${rec.nasDir}。**本页读到的纪要正文不受影响**——它在归档时就已经` +
      `入库，数据库记录永久保留（spec §4.9），这正是内容入库而不是预览时现读文件的理由。` +
      `录像与音频不入库，本地既然已清理，就只能按上面这个路径去 NAS 取。`,
  }
}

// ===========================================================================
// media：录像与音频只给去向
// ===========================================================================

interface MediaAsset {
  assetType: string
  assetKey: AssetKey | null
  remoteId: string
  fileType: string
  nasPath: string | null
  localPath: string | null
  archivedAt: number | null
  /** 本地那份还在不在。已清理时只剩 NAS 一条路 */
  localGone: boolean
}

function buildMedia(src: AssetSources, local: LocalState): {
  proxied: false
  text: string
  assets: MediaAsset[]
} {
  const assets: MediaAsset[] = []
  const seen = new Set<string>()
  for (const a of src.archived) {
    if (isTextAssetType(a.assetType)) continue
    const k = assetKeyOf(a.assetType, a.remoteId, a.fileType)
    if (seen.has(k)) continue
    seen.add(k)
    assets.push({
      assetType: a.assetType,
      assetKey: GATEWAY_TYPE_TO_ASSET_KEY[a.assetType] ?? null,
      remoteId: a.remoteId,
      fileType: a.fileType,
      nasPath: a.nasPath,
      localPath: null,
      archivedAt: a.archivedAt,
      localGone: local.filesGone,
    })
  }
  for (const c of src.completed) {
    if (isTextAssetType(c.assetType)) continue
    const k = assetKeyOf(c.assetType, c.remoteId, c.fileType)
    if (seen.has(k)) continue
    seen.add(k)
    assets.push({
      assetType: c.assetType,
      assetKey: GATEWAY_TYPE_TO_ASSET_KEY[c.assetType] ?? null,
      remoteId: c.remoteId,
      fileType: c.fileType,
      nasPath: null,
      localPath: null,
      archivedAt: null,
      localGone: local.filesGone,
    })
  }
  return {
    // `proxied` 说的是**这条端点**（`GET .../content`）下不下发媒体字节，答案仍然
    // 是不。2026-08-30 新开的 `GET .../media/...` 是另一条端点、另一套 Range 语义,
    // 它不改变这一条的事实——把这个字段翻成 true 会让「内容索引里带着录像的字节」
    // 成为一句谎话。控制台判断能不能播用的是资产自己的 `nasPath` + 容器类型
    // （见 console 的 `pickPlayableMedia`），不读这个字段。
    proxied: false,
    text:
      '录像与音频**不进正文库**（`asset_contents` 是文本表），也**不由本条端点下发字节**：' +
      '单个可以有几个 GB，塞进内容索引的 JSON 里没有意义。' +
      '控制台里的播放走另一条端点 `GET .../media/:assetType/:remoteId/:fileType`——' +
      '它读的是**已经归档到 NAS 的那份文件**，带 Range，所以能拖动；起播记一行审计。' +
      (local.filesGone
        ? `本地文件已到期清理，平台直链也早就失效，能播的只剩 NAS 上那一份${local.nasDir === null ? '' : `（${local.nasDir}）`}。`
        : ''),
    assets,
  }
}

// ===========================================================================
// 转写分段（时间轴）
// ===========================================================================

export interface TranscriptCue {
  /** 相对会议开始的秒数 */
  at: number
  /** 结束秒数；只有 SRT/WebVTT 那种带箭头的格式给得出，其余为 null */
  endAt: number | null
  /**
   * 发言人。**启发式**：时间戳之后 32 字符内出现的第一个全角/半角冒号之前那一段。
   * 认错了最多是把半句话当成人名，不会影响 `at`——而 `at` 才是「点一下跳转」要用的。
   */
  speaker: string | null
  text: string
}

export type TranscriptFormat = 'srt' | 'bracket' | 'speaker' | 'none'

/** `(时):分:秒[.毫秒]`。小时段可省（腾讯的短会转写常写成 `03:21`） */
const TS = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?`
const CUE_ARROW = new RegExp(`^\\s*${TS}\\s*-->\\s*${TS}`)
const CUE_LEAD = new RegExp(`^\\s*[\\[(]?${TS}[\\])]?[\\s　]*`)
/**
 * 腾讯会议实际导出的那一种：**发言人在前、时间戳在括号里**——`曾慧(00:00:21): 正文`。
 *
 * 上面两条都要求时间戳**在行首**，而平台给的不是。2026-08-28 的真实故障：库里
 * 95 份转写正文全部判成 `none`、零分段，时间轴 tab 空、进度条没有标记、没有字幕。
 *
 * 人名段落用 `[^()（）\[\]]` 而不是 `.`：人名里不会有括号，而用 `.{1,32}?` 会让
 * 正文里任何一处「……(1:23)……」都能凑出一次匹配，把一整段正文切成两半。
 * 结尾的冒号是可选的——`曾慧(00:00:21) 正文` 这种没有冒号的写法同样认。
 */
const CUE_SPEAKER_LEAD = new RegExp(`^\\s*([^()（）\\[\\]:：]{1,32})[(（]${TS}[)）][：:]?[\\s　]*`)

/** SRT 的序号行。它不是正文，续行时要停在这儿——否则「2」会被并进上一段的文本 */
const INDEX_LINE = /^\d{1,6}$/
/** 发言人切分。非贪婪 + 32 字符上限：正文里的冒号很常见，切太狠会把半句话当人名 */
const SPEAKER = /^(.{1,32}?)[：:][\s　]*(.+)$/

function toSec(h: string | undefined, m: string, s: string): number {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s)
}

function splitSpeaker(rest: string): { speaker: string | null; text: string } {
  const m = SPEAKER.exec(rest)
  if (m === null) return { speaker: null, text: rest }
  return { speaker: m[1]!.trim(), text: m[2]!.trim() }
}

/**
 * 从转写正文里认出时间戳分段。
 *
 * **认不出就报 `none`，不硬凑一个 0:00 起的整段**：一个假装成功的时间轴会让管理员
 * 以为这场会议的转写没有时间信息，而真相可能是平台换了导出格式。调用方拿到 `none`
 * 时会把前几行原文一起下发，好让人当场看出是什么格式。
 */
export function parseTranscriptCues(raw: string): { format: TranscriptFormat; cues: TranscriptCue[] } {
  const lines = raw.split(/\r?\n/)
  if (lines.some((l) => CUE_ARROW.test(l))) return { format: 'srt', cues: parseSrt(lines) }
  // bracket 先于 speaker 判：`[01:05] 张三：正文` 的行首是括号，人名段落要求至少
  // 一个非括号字符，所以它进不了 speaker——但把顺序倒过来就说不清了，别倒。
  if (lines.some((l) => CUE_LEAD.test(l))) return { format: 'bracket', cues: parseBracket(lines) }
  if (lines.some((l) => CUE_SPEAKER_LEAD.test(l))) {
    return { format: 'speaker', cues: parseSpeakerLead(lines) }
  }
  return { format: 'none', cues: [] }
}

function parseSrt(lines: readonly string[]): TranscriptCue[] {
  const cues: TranscriptCue[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = CUE_ARROW.exec(lines[i]!)
    if (m === null) continue
    const texts: string[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const t = lines[j]!.trim()
      if (t === '' || INDEX_LINE.test(t) || CUE_ARROW.test(lines[j]!)) break
      texts.push(t)
    }
    const { speaker, text } = splitSpeaker(texts.join('\n'))
    cues.push({
      at: toSec(m[1], m[2]!, m[3]!),
      endAt: toSec(m[5], m[6]!, m[7]!),
      speaker,
      text,
    })
    i = j - 1
  }
  return cues
}

function parseBracket(lines: readonly string[]): TranscriptCue[] {
  const cues: TranscriptCue[] = []
  for (const line of lines) {
    const m = CUE_LEAD.exec(line)
    if (m === null) {
      // 没有时间戳的行是上一段的续行。丢掉它等于把长发言截成第一句
      const prev = cues[cues.length - 1]
      const t = line.trim()
      if (prev !== undefined && t !== '') prev.text = prev.text === '' ? t : `${prev.text}\n${t}`
      continue
    }
    const { speaker, text } = splitSpeaker(line.slice(m[0].length).trim())
    cues.push({ at: toSec(m[1], m[2]!, m[3]!), endAt: null, speaker, text })
  }
  return cues
}

/**
 * `发言人(时间戳): 正文`。续行的处理与 `parseBracket` 完全一致——没有时间戳的行
 * 并进上一段，丢掉它等于把一段长发言截成第一句。
 *
 * 发言人**不走 `splitSpeaker`**：这里的人名是正则第 1 组捕出来的，已经确定；
 * 再让 `splitSpeaker` 去正文里找冒号，会把「他说：我不同意」的「他说」当成第二个
 * 人名，覆盖掉真的那个。
 */
function parseSpeakerLead(lines: readonly string[]): TranscriptCue[] {
  const cues: TranscriptCue[] = []
  for (const line of lines) {
    const m = CUE_SPEAKER_LEAD.exec(line)
    if (m === null) {
      const prev = cues[cues.length - 1]
      const t = line.trim()
      if (prev !== undefined && t !== '') prev.text = prev.text === '' ? t : `${prev.text}\n${t}`
      continue
    }
    const speaker = m[1]!.trim()
    cues.push({
      at: toSec(m[2], m[3]!, m[4]!),
      endAt: null,
      speaker: speaker === '' ? null : speaker,
      text: line.slice(m[0].length).trim(),
    })
  }
  return cues
}

/** 一次最多下发多少段。转写动辄上千段，整份塞进 JSON 会让抽屉一开就卡住 */
const CUES_DEFAULT_LIMIT = 500
const CUES_MAX_LIMIT = 5000

// ===========================================================================
// 公共前置：两个端点都要的那一段
// ===========================================================================

interface Prepared {
  key: MeetingKey
  row: ConsoleMeetingRow
  access: Access
  local: LocalState
  sources: AssetSources
  now: number
  adminId: string
}

type PrepareResult = { ok: true; prepared: Prepared } | { ok: false; response: Response }

/**
 * 认证 + 会议 + 判定 + 归档事实，两个端点共用。
 *
 * `validate` 在**认证之后、查库之前**跑：参数校验不能排在认证前面（那等于向未登录者
 * 反馈参数对不对），也不该排在五条查询后面（一个 `?type=video` 不值得先花五次往返
 * 再被拒）。中间这个位置是唯一两头都对的。
 */
async function prepare(
  req: Request,
  ctx: RouteCtx,
  validate?: () => Response | null,
): Promise<PrepareResult> {
  const now = ctx.deps.now()
  const auth = await requireAdminAuth(req, ctx.deps.adminAuth, now)
  if (!auth.ok) return { ok: false, response: auth.response }

  const bad = validate?.() ?? null
  if (bad !== null) return { ok: false, response: bad }

  // 路径段与 `ConsoleMeetingRow.id` 是一对：`consoleMeetingId` 编、这个解。
  // 只用 meeting_id 的话周期性会议的各场次会撞成同一行（见 A2 的同一处注释）
  const key = parseConsoleMeetingId(ctx.params.meetingId ?? '')
  const row = await ctx.deps.consoleMeetings.get(key.meetingId, key.subMeetingId, now)
  if (row === null) return { ok: false, response: json(404, { error: 'meeting_not_found' }) }

  const ar = ctx.deps.archivesStore
  const [access, archive, archived, completed, missing] = await Promise.all([
    resolveAccess(ctx, key, now),
    ar.findMeetingArchive(key.meetingId, key.subMeetingId),
    ar.listArchivedAssetsForMeeting(key.meetingId, key.subMeetingId),
    ar.listCompletedAssets(key.meetingId, key.subMeetingId),
    ar.listMissingAssets(key.meetingId, key.subMeetingId),
  ])

  return {
    ok: true,
    prepared: {
      key,
      row,
      access,
      local: localState(archive),
      sources: { contents: [], archived, completed, missing },
      now,
      adminId: auth.identity.adminId,
    },
  }
}

/** 会议那一小块。契约的 `Meeting` 是给会议记录页的，这里只要标识与抬头要用的几列 */
function meetingBlock(row: ConsoleMeetingRow): Record<string, unknown> {
  return {
    id: row.id,
    meetingId: row.meetingId,
    subMeetingId: row.subMeetingId,
    title: row.title,
    code: row.code,
    startAt: row.startAt,
    durationSec: row.durationSec,
    host: row.host,
    // 身份映射查出来的姓名，查不到是 null。**必须跟着 host 一起下发**：少了它，
    // 预览页只能把 host 那串 32 位 userid 原样摆上去，而那正是会议记录页刚修掉的
    // 问题。两个页面读同一个 assembleRow，抬头这里漏一个字段就等于漏一页。
    hostName: row.hostName,
    // 「标题是空的」与「元数据没拉回来」在界面上长得一模一样，这一列是唯一的区分
    missing: row.missing,
  }
}

function accessBlock(access: Access, action: string): Record<string, unknown> {
  return {
    allow: access.allow,
    restricted: access.restricted,
    why: access.why,
    banner: access.banner,
    audit: { logged: true, action },
  }
}

// ===========================================================================
// GET /api/v1/admin/meetings/:meetingId/content
// ===========================================================================

export async function getContent(req: Request, ctx: RouteCtx): Promise<Response> {
  const url = new URL(req.url)
  const rawType = url.searchParams.get('type')
  const format = url.searchParams.get('format')

  // `?type=` 的解析是纯函数，先算；**要不要因此拒绝**交给 prepare 在认证之后、
  // 查库之前判（见那个函数的注释）。录像那一条尤其不能晚——它就是验收 3
  // 那句「不代理内容」。
  const type = rawType === null || rawType === '' ? null : resolveAssetType(rawType)
  const p = await prepare(req, ctx, () => {
    if (rawType === null || rawType === '') return null
    if (type === null) {
      return json(400, {
        error: 'invalid_asset_type',
        detail:
          `认不出资产类型「${rawType}」。合法取值是契约的 AssetKey（${ALL_ASSET_KEYS.join(' / ')}）` +
          `或网关的 asset_type（${ALL_ASSET_KEYS.map((k) => ASSET_KEY_TO_GATEWAY_TYPE[k]).join(' / ')}）。` +
          `原型 HTML 里那套短名（summary / aitr / digest）不是合法取值。`,
      })
    }
    if (!isTextAssetType(type.gatewayType)) {
      return json(400, {
        error: 'binary_asset_not_proxied',
        detail:
          `${labelOf(type.gatewayType)}不入 asset_contents，本接口也不代理它的内容：` +
          `它不是文本，单个可以有几个 GB。直链仍由 POST /api/v1/assets/:assetId/download-url 签发，` +
          `本地已清理的会议按响应里 media.assets[].nasPath 去 NAS 取。`,
      })
    }
    return null
  })
  if (!p.ok) return p.response
  const { key, row, access, local, adminId } = p.prepared

  const contents = await ctx.deps.contents.listForMeeting(key.meetingId, key.subMeetingId)
  const sources: AssetSources = { ...p.prepared.sources, contents }
  const assets = buildAssetIndex(sources)

  const selected =
    type === null
      ? null
      : await buildSelected(ctx, key, type, format === null || format === '' ? undefined : format, assets)

  // 留痕在**响应拼好之后、返回之前**：写失败就整个请求失败（见文件头第三条）
  const action = await recordView(ctx, {
    adminId,
    key,
    access,
    detail: `content:${type === null ? 'index' : type.assetKey}`,
  })

  return json(200, {
    meeting: meetingBlock(row),
    access: accessBlock(access, action),
    local,
    assets,
    selected,
    media: buildMedia(sources, local),
  })
}

async function buildSelected(
  ctx: RouteCtx,
  key: MeetingKey,
  type: ResolvedType,
  fileType: string | undefined,
  index: readonly ContentAsset[],
): Promise<Record<string, unknown>> {
  // 按三段查，remote_id 一律不参与筛选——多段一段都不能漏（文件头第一条）
  const rows = await ctx.deps.contents.listSegments(
    key.meetingId,
    key.subMeetingId,
    type.gatewayType,
    fileType,
  )
  const segments: ContentSegment[] = rows.map((r, i) => ({
    assetType: r.assetType,
    assetKey: GATEWAY_TYPE_TO_ASSET_KEY[r.assetType] ?? null,
    remoteId: r.remoteId,
    fileType: r.fileType,
    availability: r.status,
    bytes: r.bytes,
    chars: r.chars,
    reason: r.reason,
    contentHash: r.contentHash,
    parsedAt: r.parsedAt,
    nasPath: index.find(
      (a) => a.assetType === r.assetType && a.remoteId === r.remoteId && a.fileType === r.fileType,
    )?.nasPath ?? null,
    ordinal: i + 1,
    content: r.content,
  }))

  const label = ASSET_LABEL[type.assetKey]
  const parsed = segments.filter((s) => s.availability === 'parsed')
  if (parsed.length > 0) {
    return {
      type: type.gatewayType,
      assetKey: type.assetKey,
      state: 'ok',
      segments,
      text:
        `${label}共 ${segments.length} 段，其中 ${parsed.length} 段有正文。` +
        (segments.length > parsed.length
          ? '另有几段未解析，原因见每段的 reason——它们不是缺失，文件在 NAS 上。'
          : ''),
    }
  }

  if (segments.length > 0) {
    return {
      type: type.gatewayType,
      assetKey: type.assetKey,
      state: 'unparsed',
      segments,
      text:
        `${label}在库里有 ${segments.length} 段记录，但一段正文都解析不出来，逐段的理由见 reason。` +
        `「未解析」与「这场会议缺这一类纪要」是两件事：文件在 NAS 上，只是本版本只解析 txt` +
        `（docx / pdf 要单独的解析器，不在控制台阶段 4 的范围内）。`,
    }
  }

  // asset_contents 里一行都没有。索引里可能还有别的来源认得它——那三档同样不是「缺失」
  const others = index.filter((a) => a.assetType === type.gatewayType)
  const pending = others.filter((a) => a.availability === 'not_ingested' || a.availability === 'not_archived')
  if (pending.length > 0) {
    return {
      type: type.gatewayType,
      assetKey: type.assetKey,
      state: 'unparsed',
      segments: [],
      text:
        `${label}确实存在（${pending.length} 段），只是正文还不在库里：${pending[0]!.reason}` +
        `这不等于这场会议缺这一类纪要。`,
    }
  }
  const dead = others.filter((a) => a.availability === 'missing')
  return {
    type: type.gatewayType,
    assetKey: type.assetKey,
    state: 'absent',
    segments: [],
    text:
      dead.length > 0
        ? `这场会议没有${label}：${dead[0]!.reason}`
        : `这场会议在库里没有任何一段${label}的记录——既没有正文行，也没有归档记录或本地文件。` +
          `要么平台压根没生成这一类，要么拉取阶段还没轮到它（见会议详情的拉取阶段）。`,
  }
}

// ===========================================================================
// GET /api/v1/admin/meetings/:meetingId/content/chapters
// ===========================================================================

/** 时间轴优先读完整转写，其次 AI 转写。两者都是 `isTextAssetType`，都在库里 */
const TRANSCRIPT_PREFERENCE: readonly AssetKey[] = ['transcript', 'ai_transcript']

const CHAPTERS_TEXT =
  '腾讯会议那张页面上的「章节 + 摘要」在本系统里没有来源：src/tencent/records.ts 里没有任何一个' +
  '取章节的调用点，库里也没有任何一列装它。所以这里的 chapters 恒为空数组，不编一份' +
  '看起来像模像样的章节——与 A2 对 why.fetch 的处理（计划 §0 E-c）是同一条裁定。' +
  '下面的 cues 是**转写分段**，不是章节：它们的时间戳来自转写正文本身，是真实数据，' +
  '足够支撑 spec §4.4 的「点一下跳转」。'

export async function getChapters(req: Request, ctx: RouteCtx): Promise<Response> {
  const url = new URL(req.url)
  const rawLimit = url.searchParams.get('limit')

  const limit = rawLimit === null || rawLimit === '' ? CUES_DEFAULT_LIMIT : Number(rawLimit)
  const p = await prepare(req, ctx, () => {
    // 超限不静默钳制：客户端以为自己要到了 20000 段、实际只拿到 5000 段，
    // 后半截转写在时间轴上凭空消失，而界面上一切正常
    if (!Number.isInteger(limit) || limit < 1 || limit > CUES_MAX_LIMIT) {
      return json(400, {
        error: 'invalid_limit',
        detail: `limit 必须是 1..${CUES_MAX_LIMIT} 的整数，收到「${rawLimit}」`,
      })
    }
    return null
  })
  if (!p.ok) return p.response
  const { key, row, access, adminId } = p.prepared

  // 逐个候选类型找第一段有正文的转写。最多两次查询（transcript / ai_transcript）,
  // 不是把整场会议的正文都读出来
  let picked: { row: ContentSegmentRow; assetKey: AssetKey } | null = null
  for (const assetKey of TRANSCRIPT_PREFERENCE) {
    const segs = await ctx.deps.contents.listSegments(
      key.meetingId,
      key.subMeetingId,
      ASSET_KEY_TO_GATEWAY_TYPE[assetKey],
    )
    const hit = segs.find((s) => s.status === 'parsed' && s.content !== null)
    if (hit !== undefined) {
      picked = { row: hit, assetKey }
      break
    }
  }

  const parsed = picked === null ? { format: 'none' as TranscriptFormat, cues: [] } : parseTranscriptCues(picked.row.content ?? '')
  const cues = parsed.cues.slice(0, limit)
  // 认不出格式时给前几行原文：一个说得出「我看到的是这样的内容」的空时间轴，
  // 比一个说不出为什么的空时间轴强得多
  const sample =
    picked !== null && parsed.format === 'none'
      ? (picked.row.content ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').slice(0, 3)
      : null

  const action = await recordView(ctx, { adminId, key, access, detail: 'content:chapters' })

  return json(200, {
    meeting: meetingBlock(row),
    access: accessBlock(access, action),
    chapters: [],
    source: 'none',
    text: CHAPTERS_TEXT,
    cues,
    cuesFrom:
      picked === null
        ? null
        : {
            assetType: picked.row.assetType,
            assetKey: picked.assetKey,
            remoteId: picked.row.remoteId,
            fileType: picked.row.fileType,
            format: parsed.format,
            total: parsed.cues.length,
            returned: cues.length,
            truncated: parsed.cues.length > cues.length,
          },
    sample,
  })
}
