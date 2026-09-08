/**
 * 操作审计（`GET /api/v1/admin/audit`）。
 *
 * ## 时间是 unix 秒，且相对**真实的现在**
 *
 * 别的种子都活在 `MOCK_NOW` 那个固定的"今天"里，装载时整体平移。审计这一份
 * 直接按真实现在往回数：这一页默认只看最近 7 天，而且时间窗口是页面自己算好
 * 发上来的（`?from=&to=`）。种子如果活在种子时间里，平移量哪怕差一秒，
 * 默认那一屏就可能一条都没有——而空表和"这段时间真的没人操作过"在屏幕上
 * 长得一模一样。
 *
 * ## 形态分支在这里，不在别处
 *
 * 这一页最难看清的几种记录，恰恰是最需要被门槛扫到的：**结果存疑**（库里既不是
 * allow 也不是 deny 的脏值）、**认不出的操作者**、**不针对某一场会议的动作**、
 * **补不齐标题的对象**、**没有明细的老记录**（`detail` 是阶段 4 才加的列）。
 * 它们各自是一种不同的呈现（琥珀 / 问号徽标 / 灰底说明），种子里各留了一条。
 */

interface RowSpec {
  id: number
  /** 多久以前（秒） */
  agoSec: number
  actor: { kind: string; type: string; id: string }
  action: string
  actionLabel: string | null
  object: {
    id: string
    idKind: string
    meetingId: string | null
    title: string | null
    code: string | null
  } | null
  asset: { id: string; type: string | null } | null
  detail: string | null
  result: { decision: string; kind: string; reason: string | null }
  matchedRuleId: number | null
  clientKind: string | null
}

const MIN = 60
const HOUR = 3600
const DAY = 86_400

const PROG = (id: string) => ({ kind: 'prog', type: 'service_account', id })
const PERSON = (id: string) => ({ kind: 'person', type: 'admin', id })
const SYS = { kind: 'sys', type: 'scheduler', id: 'worker-1' }

const ALLOW = { decision: 'allow', kind: 'allow', reason: null }
const deny = (reason: string): RowSpec['result'] => ({ decision: 'deny', kind: 'deny', reason })

function meeting(id: string, title: string, code: string): RowSpec['object'] {
  return { id, idKind: 'meeting', meetingId: id, title, code }
}

/**
 * 十四条记录。每一条都指得回种子会议世界里真实存在的一场（`api/mock/meetings.ts`），
 * 规则 id 也对得上 `api/mock/rules.ts`——审计说"命中规则 #350"，规则页上就该有 #350。
 */
const ROWS: RowSpec[] = [
  {
    id: 9014,
    agoSec: 3 * MIN,
    actor: PROG('kb-indexer'),
    action: 'fetch_asset',
    actionLabel: '取用资产',
    object: meeting('m1', '产品周会', '881-123-40'),
    asset: { id: 'as-9911', type: 'ai_minutes' },
    detail: '知识库索引器取走了 AI 纪要（txt）。\n{"bytes":18342,"format":"txt","hash":"sha256:9f21…"}',
    result: ALLOW,
    matchedRuleId: 300,
    clientKind: 'api',
  },
  {
    id: 9013,
    agoSec: 42 * MIN,
    actor: PROG('dw-sync'),
    action: 'fetch_asset',
    actionLabel: '取用资产',
    object: meeting('m8', '财务复盘 · 7 月', '881-108-71'),
    asset: { id: 'as-8802', type: 'video' },
    detail: '本地文件已在到期清理中删除，拒绝取用。\n{"expiredAt":1755000000}',
    result: deny('保留期已结束，本地文件已清理。NAS 副本不对外提供。'),
    matchedRuleId: null,
    clientKind: 'api',
  },
  {
    id: 9012,
    agoSec: 2 * HOUR,
    actor: PERSON('陈运维'),
    action: 'extend_retention',
    actionLabel: '延长保留期',
    object: meeting('m9', '上季度经营复盘', '881-077-14'),
    asset: null,
    detail: '延长 30 天。理由：数据仓库同步还没跑完。\n{"addedDays":30,"extendedDays":60}',
    result: ALLOW,
    matchedRuleId: null,
    clientKind: 'console',
  },
  {
    id: 9011,
    agoSec: 3 * HOUR + 20 * MIN,
    actor: SYS,
    action: 'archive_meeting',
    actionLabel: '归档到 NAS',
    object: meeting('m3', '客户沟通 · 华东区', '881-140-88'),
    asset: null,
    detail: 'NAS 写入失败：目标目录不可写（errno 30, EROFS）。\n{"attempt":5,"maxAttempts":5}',
    result: deny('NAS 写入失败：目标目录不可写（errno 30, EROFS）。'),
    matchedRuleId: null,
    clientKind: null,
  },
  {
    /* 这一条把这一页最难看清的几种形态凑在一起：认不出的操作者、认不出的动作、
       归一化不到会议维度的对象、补不齐的标题、既不是 allow 也不是 deny 的结果、
       以及 `detail` 这一列出现之前的老记录。 */
    id: 9010,
    agoSec: 5 * HOUR,
    actor: { kind: 'unknown', type: 'legacy_agent', id: 'agent-7' },
    action: 'issue_download_url',
    actionLabel: null,
    object: { id: 'rec-55f1', idKind: 'meeting_record', meetingId: null, title: null, code: null },
    asset: { id: 'as-55f1-1', type: null },
    detail: null,
    result: { decision: 'ok', kind: 'unknown', reason: null },
    matchedRuleId: null,
    clientKind: null,
  },
  {
    id: 9009,
    agoSec: 8 * HOUR,
    actor: PERSON('陈运维'),
    action: 'grant_meeting',
    actionLabel: '授权采集',
    object: meeting('m7', '全员大会 · Q3 复盘', '881-099-22'),
    asset: null,
    detail: '授权给「简报机器人」。\n{"programId":"daily-digest","assetTypes":null}',
    result: ALLOW,
    matchedRuleId: 310,
    clientKind: 'console',
  },
  {
    id: 9008,
    agoSec: 11 * HOUR,
    actor: PERSON('陈运维'),
    action: 'update_setting',
    actionLabel: '改配置',
    // 不针对某一场会议：这类动作的对象整个是 null，不许拿一个会议 id 顶上
    object: null,
    asset: null,
    detail: 'default_retention_days：30 → 30（没有实际变化）。\n{"before":30,"after":30}',
    result: ALLOW,
    matchedRuleId: null,
    clientKind: 'console',
  },
  {
    id: 9007,
    agoSec: 26 * HOUR,
    actor: PROG('daily-digest'),
    action: 'fetch_asset',
    actionLabel: '取用资产',
    object: meeting('m7', '全员大会 · Q3 复盘', '881-099-22'),
    asset: { id: 'as-7701', type: 'transcript' },
    detail: '简报机器人取走了完整转写（txt）。\n{"bytes":40218,"format":"txt"}',
    result: ALLOW,
    matchedRuleId: 310,
    clientKind: 'api',
  },
  {
    id: 9006,
    agoSec: 30 * HOUR,
    actor: PERSON('陈运维'),
    action: 'set_override',
    actionLabel: '人工改写',
    object: meeting('m4', '董事会闭门会', '881-100-01'),
    asset: null,
    detail:
      '拉取阶段设为「永不拉取」。理由：董事会决议，录制不出腾讯会议侧。\n{"kind":"fetch","effect":"skip"}',
    result: ALLOW,
    matchedRuleId: null,
    clientKind: 'console',
  },
  {
    id: 9005,
    agoSec: 2 * DAY,
    actor: PROG('kb-indexer'),
    action: 'fetch_asset',
    actionLabel: '取用资产',
    object: meeting('m6', '招聘面试 · 后端 P7', '881-161-19'),
    asset: { id: 'as-6601', type: 'ai_minutes' },
    detail: '命中禁止采集的规则，拒绝。\n{"ruleId":350}',
    result: deny('权限规则 #350「标题含「面试」「薪酬」「绩效」→ 禁止采集」。'),
    matchedRuleId: 350,
    clientKind: 'api',
  },
  {
    id: 9004,
    agoSec: 3 * DAY,
    actor: PERSON('陈运维'),
    action: 'view_restricted_content',
    actionLabel: '查看受限内容',
    object: meeting('m6', '招聘面试 · 后端 P7', '881-161-19'),
    asset: { id: 'as-6601', type: 'ai_minutes' },
    detail: '管理员豁免查看了 AI 纪要。这次查看本身就是这条记录的由来。',
    result: { decision: 'allow', kind: 'allow', reason: '管理员豁免：规则禁止采集，但控制台可看，看了留痕。' },
    matchedRuleId: 350,
    clientKind: 'console',
  },
  {
    id: 9003,
    agoSec: 4 * DAY,
    actor: SYS,
    action: 'cleanup_expired',
    actionLabel: '到期清理',
    object: meeting('m8', '财务复盘 · 7 月', '881-108-71'),
    asset: null,
    detail: '本地文件已删除，记录与 NAS 副本保留。\n{"purged":19,"bytes":19818086}',
    result: ALLOW,
    matchedRuleId: null,
    clientKind: null,
  },
  {
    id: 9002,
    agoSec: 5 * DAY,
    actor: PROG('dw-sync'),
    action: 'fetch_asset',
    actionLabel: '取用资产',
    object: meeting('m9', '上季度经营复盘', '881-077-14'),
    asset: { id: 'as-9901', type: 'ai_transcript' },
    detail: '数据仓库同步取走了逐字稿（智能优化版）（txt）。\n{"bytes":6120,"format":"txt"}',
    result: ALLOW,
    matchedRuleId: 320,
    clientKind: 'api',
  },
  {
    id: 9001,
    agoSec: 6 * DAY,
    actor: SYS,
    action: 'archive_meeting',
    actionLabel: '归档到 NAS',
    object: meeting('m6', '招聘面试 · 后端 P7', '881-161-19'),
    asset: null,
    detail: '归档成功，19 个文件，15.3 MB，哈希校验通过。\n{"dir":"meetings-hr/2026/08/"}',
    result: ALLOW,
    matchedRuleId: 205,
    clientKind: null,
  },
]

export interface AuditQuery {
  from?: number
  to?: number
  actorId?: string
  actorKind?: string[]
  action?: string[]
  decision?: string
  limit: number
  offset: number
}

/** 后端的默认窗口。页面自己会带 `from`，所以这条只在不带的时候兜底。 */
const DEFAULT_DAYS = 7

export function buildAudit(q: AuditQuery, nowSec: number): Record<string, unknown> {
  const from = q.from ?? nowSec - DEFAULT_DAYS * DAY
  const rows = ROWS.map((r) => ({ ...r, at: nowSec - r.agoSec })).filter((r) => {
    if (r.at < from) return false
    if (q.to !== undefined && r.at >= q.to) return false
    if (q.actorId !== undefined && r.actor.id !== q.actorId) return false
    if (q.actorKind !== undefined && !q.actorKind.includes(r.actor.kind)) return false
    if (q.action !== undefined && !q.action.includes(r.action)) return false
    if (q.decision !== undefined && r.result.decision !== q.decision) return false
    return true
  })

  const isDefault = q.from === undefined
  const shown = rows.slice(q.offset, q.offset + q.limit)
  return {
    // occurred_at DESC：种子本来就是倒序写的，这里原样保留，不折叠不去重
    rows: shown.map(({ agoSec: _ago, ...row }) => row),
    total: rows.length,
    limit: q.limit,
    offset: q.offset,
    window: {
      from,
      to: q.to ?? null,
      isDefault,
      days: Math.max(1, Math.round(((q.to ?? nowSec) - from) / DAY)),
      text: isDefault
        ? '没有指定时间范围，这里显示的是最近 7 天。更早的操作在窗口之外，不是没有发生过。'
        : null,
    },
    // **这一页里**有哪几种动作后端没有登记中文名（阶段 5 · A9）。种子里那条
    // `actionLabel: null` 的记录就是为了让这句提示在演示与 a11y 门槛里真的出现
    unlabeledActions: unlabeledOf(shown),
  }
}

/** 按首次出现顺序汇总，带出现次数。全部登记过时是空数组，不是 null。 */
function unlabeledOf(rows: ReadonlyArray<{ action: string; actionLabel: string | null }>) {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (r.actionLabel !== null) continue
    counts.set(r.action, (counts.get(r.action) ?? 0) + 1)
  }
  return [...counts].map(([action, count]) => ({
    action,
    count,
    hint:
      '这个动作在后端没有登记中文标签（src/audit/actions.ts 的 AUDIT_ACTION_LABELS 里没有这一行），' +
      '界面上显示的是 audit_log 里的原值。',
  }))
}
