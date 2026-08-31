import { useCallback, useState } from 'react'
import type { OverrideKind, ServiceProgram } from '@/api/admin/grants'
import type { AdminMeeting, AdminWhy } from '@/api/admin/meetings'
import { fetchMeetingHistory, getMeeting } from '@/api/admin/meetings'
import { readonlyTitle, useReadonly } from '@/app/session'
import { daysLeft, fmtBytes, fmtDateTime, fmtDay, fmtDuration } from '@/lib/format'
import { useResource } from '@/lib/useResource'
import { Button } from '@/ui/Button'
import { Pill } from '@/ui/Pill'
import { Skeleton } from '@/ui/Skeleton'
import { StatusDot } from '@/ui/StatusDot'
import {
  dotState,
  extendedText,
  grantCellKind,
  groupHistory,
  historyAtText,
  hostLabel,
  meetingTitle,
  parseWhy,
  programName,
  STAGE_NAME,
  stateLabel,
  type Stage,
  WHY_MISSING_TEXT,
  whyLabel,
  whyTone,
} from './display'
import { wkey } from './writes'
import styles from './MeetingDetail.module.css'

/**
 * 会议详情抽屉（spec.md §4.3）。四段对应产品模型的四个阶段，每段带**判定理由**，
 * 底部是这场会议的操作历史。
 *
 * ## 它自己再取一次单场详情，不复用列表里的那一行
 *
 * 后端的单场端点走 `explainMeetingAccess`，与采集程序真正来取数时是**同一段
 * 判定**；列表端点为了避开 N+1 走的是批量路径。两条路径落到同一段代码上，
 * 但只有单场那条是「程序取的时候会怎么判」的原件。抽屉是管理员回答
 * 「为什么是这个状态」的地方，这里必须用原件——否则会出现最坏的一种不一致：
 * **抽屉说准许，程序取的时候被拒**。
 *
 * 取数期间先用列表那一行顶着（`fallback`），不画一整屏骨架：抽屉是从某一行
 * 点开的，那一行的内容用户刚看过，先显示出来再补细节比先白一下好。
 *
 * ## 「撤销拉取」/「撤销归档」在这一版是什么
 *
 * spec §4.3 给拉取段和归档段各写了一个「撤销」按钮。后端目前**没有**这两条
 * 端点（`git grep` 全仓库无撤销归档路径，用户故事 US-2.5 至今 0 实现）。
 * 能做到的最接近的真实动作是**人工改写**（`PUT /override`，effect=skip）：
 * 它把这一阶段关掉、留下理由与审计，但**不撤销已经发生的那一次归档**。
 * 两者不是一回事，所以这里按它真正的名字叫「人工改写」——放一个名叫「撤销归档」、
 * 实际只是关掉开关的按钮，是这一页最不该犯的那类错误。
 *
 * **缺口登记在 `docs/console/spec.md` §11（第 7 行），不渲染到界面上。**
 * 这一段此前是抽屉里一个虚线框，向管理员解释一个不存在的按钮为什么不存在，
 * 还带着 spec 的定案日期——那是把开发笔记当界面文案。界面回答的是
 * 「我现在要做什么」，缺口的账本是 §11 那张表。
 */

/** 八类资产的中文名。**来源是 spec §6.2 那张表**，与后端 `ASSET_LABEL` 逐字一致。 */
const ASSET_LABEL: Record<string, string> = {
  video: '录像',
  audio: '音频',
  transcript: '完整转写',
  ai_transcript: 'AI 转写',
  ai_minutes: 'AI 纪要',
  ai_topic_minutes: '话题纪要',
  ai_speaker_minutes: '发言人纪要',
  ai_ds_minutes: '会议摘要',
}

export interface MeetingDetailProps {
  /** 列表里的那一行。抽屉自己再取一次详情，取到之前用它顶着 */
  fallback: AdminMeeting
  /** 写操作的重取计数器。它一变，详情与历史一起重来 */
  nonce: number
  programs: readonly ServiceProgram[]
  now: Date
  isPending: (key: string) => boolean
  onExtend: (id: string) => void
  onOpenGrant: (id: string) => void
  onRevoke: (id: string, programId: string) => void
  onOverride: (kind: OverrideKind) => void
  onClearOverride: (kind: OverrideKind) => void
}

export function MeetingDetail(props: MeetingDetailProps) {
  const { fallback, nonce, programs, now, isPending, onExtend, onOpenGrant, onRevoke } = props
  const { onOverride, onClearOverride } = props

  const detail = useResource(() => getMeeting(fallback.id), [fallback.id, nonce])
  const history = useResource(() => fetchMeetingHistory(fallback.id), [fallback.id, nonce])
  const m = detail.state === 'ready' ? detail.data : fallback
  const stale = detail.state !== 'ready'

  return (
    <div className={styles.detail}>
      <p className={styles.meta}>
        {m.missing.includes('code') ? '会议号未取到' : m.code} ·{' '}
        {m.missing.includes('startAt') ? '时间未取到' : fmtDateTime(m.startAt, now)} ·{' '}
        {/* 主持人：查不到姓名时降级成「未知主持人 · 尾号」，
            **不把 userid 原样摆上去**。同一份判定在表格那一列也用着 */}
        {fmtDuration(m.durationSec)} · {hostLabel(m)}
      </p>

      {detail.state === 'error' && (
        <p className={styles.stale} role="alert" data-testid="detail-error">
          读不到这场会议的详情，下面显示的是列表里那一行的内容（可能不是最新的）。
          <br />
          {detail.error.message}{' '}
          <Button variant="quiet" size="sm" onClick={detail.retry}>
            重试
          </Button>
        </p>
      )}
      {detail.state === 'loading' && (
        <p className={styles.stale} data-testid="detail-loading">
          正在读取这场会议的完整详情…
        </p>
      )}

      <StageSection
        m={m}
        stage="fetch"
        stale={stale}
        isPending={isPending}
        onOverride={onOverride}
        onClearOverride={onClearOverride}
      >
        <AssetTable m={m} />
      </StageSection>

      <StageSection
        m={m}
        stage="archive"
        stale={stale}
        isPending={isPending}
        onOverride={onOverride}
        onClearOverride={onClearOverride}
      >
        <ArchiveFacts m={m} now={now} />
      </StageSection>

      <KeepSection m={m} now={now} isPending={isPending} onExtend={onExtend} />

      <GrantSection
        m={m}
        programs={programs}
        isPending={isPending}
        onOpenGrant={onOpenGrant}
        onRevoke={onRevoke}
        onOverride={onOverride}
        onClearOverride={onClearOverride}
      />

      <HistorySection history={history} now={now} />
    </div>
  )
}

/* ── 判定理由 ─────────────────────────────────────────────────── */

/**
 * 一段判定理由。
 *
 * **文本一律来自后端下发的 `why`，前端不自己编**（计划 §1 第 3 条）。
 * 后端没下发时显示「理由缺失」并说清那是读不到、不是没有理由——留空会被读成
 * 「这一段本来就没有理由」。
 *
 * ## 一整段变成三层：标签 / 规则引用 / 其余事实
 *
 * 后端下发的是一整句话。抽屉是管理员点开来看「是哪条规则判的」的地方，而
 * 规则号躺在一段 140 字的话中间——要读完才找得到。`parseWhy` 把它切开
 * （**只切分，不改字**），规则号 + 规则名 + 判成什么单独排一层。
 *
 * 引用后面那句「那是此刻这一次求值……」不进正文：**每一场已归档的会议上它都是
 * 同一句话**，重复到第三场就没人读了。挂在「来自规则」这个标签的 `title` 上，
 * 一个字不删——它是个真实且不直观的陷阱（当前求值 ≠ 当初归档时那一次）。
 */
export function WhyLine({ why }: { why: AdminWhy }) {
  const missing = why.by === ''
  const parts = parseWhy(why.text)
  const aside = missing ? null : parts.aside
  const rule = missing ? null : parts.rule
  const body = missing ? WHY_MISSING_TEXT : parts.text

  return (
    <div className={styles.why} data-tone={whyTone(why.by)} data-by={why.by} data-testid="why-line">
      <p className={styles.whyBy}>
        {/* `title` 是这句注意事项在整个抽屉里唯一的落点。虚线下划线是它的
            可见把手——没有把手的 title 等于没写 */}
        <span className={styles.whyByText} data-aside={aside !== null} title={aside ?? undefined}>
          {whyLabel(why.by)}
        </span>
      </p>

      {rule !== null && (
        <p className={styles.rule} data-testid="why-rule">
          <b className={styles.ruleRef}>{rule.ref}</b>
          <span className={styles.ruleResult}>{rule.result}</span>
          {rule.name !== null && <span className={styles.ruleName}>{rule.name}</span>}
        </p>
      )}

      {body !== '' && <p className={styles.whyText}>{body}</p>}
    </div>
  )
}

function StageSection({
  m,
  stage,
  stale,
  isPending,
  onOverride,
  onClearOverride,
  children,
}: {
  m: AdminMeeting
  stage: Stage
  stale: boolean
  isPending: (key: string) => boolean
  onOverride: (kind: OverrideKind) => void
  onClearOverride: (kind: OverrideKind) => void
  children: React.ReactNode
}) {
  const raw = stage === 'fetch' ? m.fetch : m.archive
  const state = dotState(stage, raw)
  const overridden = m.hand.includes(stage)
  const pending = isPending(wkey(m.id, stage))
  const readonly = useReadonly()
  const roTitle = readonlyTitle(readonly)

  return (
    <section className={styles.section} data-testid={`section-${stage}`} data-stale={stale}>
      <h3 className={styles.head}>
        {state === 'unknown' ? (
          <Pill tone="warn">未知</Pill>
        ) : (
          <StatusDot state={state} label={STAGE_NAME[stage]} overridden={overridden} />
        )}
        {STAGE_NAME[stage]}
        <span className={styles.state} title={state === 'unknown' ? `后端下发的取值是「${raw}」` : undefined}>
          {stateLabel(state)}
        </span>
      </h3>
      <WhyLine why={m.why[stage]} />
      {children}
      <div className={styles.acts}>
        {overridden ? (
          <Button size="sm" disabled={pending || readonly} title={roTitle} onClick={() => onClearOverride(stage)}>
            {pending ? '撤销中…' : '撤销人工改写'}
          </Button>
        ) : (
          <Button size="sm" disabled={pending || readonly} title={roTitle} onClick={() => onOverride(stage)}>
            人工改写这一阶段…
          </Button>
        )}
      </div>
    </section>
  )
}

/* ── 拉取段：八类资产 ─────────────────────────────────────────── */

/** 表头那一句口径。它是**列头的脚注**，不是正文——所以住在 `title` 里。 */
const ASSET_SCOPE_TITLE = '八类资产各自的格式数。不适用的类不出现在这张表里。'

/** 合计体积算不出来时那句区分的全文。正文只留「算不出来 · 不是 0 字节」。 */
const SIZE_UNKNOWN_TITLE = '一个资产都没有声明大小，所以合计体积算不出来。这不等于这场会议占 0 字节。'

/**
 * 八类资产各自的格式数。
 *
 * spec §4.3 还要「各自的体积」——**后端只下发一个合计** `sizeBytes`
 * （`ConsoleMeetingRow.sizeBytes` 是所有已完成资产 `bytes_expected` 之和），
 * 逐类的体积拿不到。所以这里给格式数与合计，并且不去按比例摊一个假的逐类体积。
 * 这条记在任务报告里，**不写在界面上**：后端下发了什么是契约的事，
 * 管理员在这里要做的判断里用不到它。
 */
function AssetTable({ m }: { m: AdminMeeting }) {
  const keys = Object.keys(m.assets)
  if (keys.length === 0) {
    return <p className={styles.text}>这场会议没有任何录制资产。</p>
  }
  return (
    <>
      <table className={styles.assets} data-testid="asset-table">
        <thead>
          <tr>
            <th scope="col" title={ASSET_SCOPE_TITLE}>
              资产
            </th>
            <th scope="col" className={styles.assetNumHead} title={ASSET_SCOPE_TITLE}>
              已拿到 / 应有
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const cell = m.assets[k]!
            const partial = cell.got < cell.total
            return (
              <tr key={k} data-partial={partial}>
                <th scope="row">{ASSET_LABEL[k] ?? k}</th>
                <td className={styles.assetNum} data-partial={partial}>
                  {cell.got}/{cell.total}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">合计体积</th>
            <td>
              {m.sizeBytes === null ? (
                // 「算不出来」与「0 字节」在一个按体积做决策的系统里是两件事，
                // 所以这个区分留在屏幕上；为什么算不出来进 title
                <span data-testid="size-unknown" title={SIZE_UNKNOWN_TITLE}>
                  算不出来 · 不是 0 字节
                </span>
              ) : (
                <span className={styles.assetNum}>{fmtBytes(m.sizeBytes)}</span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
      {m.unknownAssetTypes.length > 0 && (
        <p className={styles.text} data-testid="unknown-assets">
          另有 {m.unknownAssetTypes.length} 类认不出的资产类型（{m.unknownAssetTypes.join('、')}
          ）：已计入上面的数，但不属于契约的八类。
        </p>
      )}
    </>
  )
}

/* ── 归档段：NAS 路径、时间、体积 ─────────────────────────────── */

function ArchiveFacts({ m, now }: { m: AdminMeeting; now: Date }) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    if (m.nasPath === null) return
    const path = m.nasPath
    // clipboard API 在非安全上下文与 jsdom 里都不存在。失败不弹错误——
    // 路径本身就摆在旁边可以手选，这不是一次值得打断人的失败。
    void Promise.resolve()
      .then(() => navigator.clipboard?.writeText(path))
      .then(
        () => setCopied(true),
        () => setCopied(false),
      )
  }, [m.nasPath])

  return (
    <>
      <dl className={styles.facts}>
        <dt>NAS 路径</dt>
        <dd>
          {m.nasPath === null ? (
            <span className={styles.muted}>还没有归档记录，没有路径。</span>
          ) : (
            <span className={styles.pathRow}>
              <code className={styles.path} data-testid="nas-path">
                {m.nasPath}
              </code>
              <Button size="sm" variant="quiet" onClick={copy}>
                {copied ? '已复制' : '复制'}
              </Button>
            </span>
          )}
        </dd>
        <dt>归档时间</dt>
        <dd>
          {m.keep.archivedAt === null ? (
            <span className={styles.muted}>未归档</span>
          ) : (
            fmtDateTime(m.keep.archivedAt, now)
          )}
        </dd>
        <dt>体积</dt>
        <dd>{fmtBytes(m.sizeBytes)}</dd>
      </dl>
      {/* 这里为什么没有「撤销归档」按钮：spec §4.3 脚注（2026-08-25）定的语义是
          「只撤归档记录、NAS 副本保留」，可逆、不需要二次确认；**后端没有这条端点**
          （US-2.5 至今 0 实现）。放一个名字对、动作不对的按钮，在一个"归档记录没了
          就等于丢了"的系统里是最贵的一种误导，所以一个按钮都不放。

          这段话此前是渲染出来的一个虚线框（`data-testid="undo-archive-gap"`）——
          **那是把开发笔记当界面文案**：它向管理员解释一个不存在的按钮为什么不存在，
          还带着 spec 的定案日期。缺口登记在 `docs/console/spec.md` §11 第 7 行，
          那张表才是缺口的账本；这条注释是指路，不是记录（同 §11 抬头那段的规矩）。 */}
    </>
  )
}

/* ── 本地保留段 ───────────────────────────────────────────────── */

function KeepSection({
  m,
  now,
  isPending,
  onExtend,
}: {
  m: AdminMeeting
  now: Date
  isPending: (key: string) => boolean
  onExtend: (id: string) => void
}) {
  const { keep } = m
  const pending = isPending(wkey(m.id, 'extend'))
  const readonly = useReadonly()
  const left = keep.expiresAt === null ? null : daysLeft(keep.expiresAt, now)
  const extended = extendedText(keep)

  return (
    <section className={styles.section} data-testid="section-keep">
      <h3 className={styles.head}>本地保留</h3>

      {keep.expiresAt === null || keep.archivedAt === null ? (
        <p className={styles.text} data-testid="keep-none">
          {/* 归档失败这一支不许压缩掉后果：本地到期就是永久丢失，
              这是这一页唯一一句"不看会出事"的话 */}
          {m.archive === 'failed' ? (
            <>
              归档失败，保留期未开始计时。<b>归档不成功，本地到期后这场会议就永久没有了。</b>
            </>
          ) : (
            '尚未归档，保留期未开始计时。'
          )}
        </p>
      ) : (
        <>
          <p className={styles.bigDays} data-soon={left !== null && left <= 7} data-testid="keep-days">
            {keep.filesGone ? (
              <span className={styles.gone}>本地文件已清理</span>
            ) : (
              <>
                <b>{left}</b> 天
              </>
            )}
          </p>
          <dl className={styles.facts}>
            <dt>归档日</dt>
            <dd>{fmtDay(keep.archivedAt)}</dd>
            <dt>到期日</dt>
            <dd>{fmtDay(keep.expiresAt)}</dd>
            <dt>保留天数</dt>
            <dd>{keep.retentionDays === null ? '—' : `${keep.retentionDays} 天`}</dd>
            {extended !== null && (
              <>
                <dt>人工延长</dt>
                <dd data-testid="extended-text">{extended}</dd>
              </>
            )}
          </dl>
        </>
      )}

      {/* 「从归档成功那一刻起算，不是从会议日」是真的会被搞错的口径，留一行。
          后半句（到期后删本地、只留记录和 NAS 路径）是全站通则，§4.9 归档存储页
          已经写过一次，这一页不再重复——同一句话说两遍，两遍都没人读。 */}
      <p className={styles.note} data-testid="keep-basis">
        保留期从<b>归档成功</b>那一刻起算，不是从会议日。
      </p>

      <div className={styles.acts}>
        <Button
          size="sm"
          disabled={pending || readonly || keep.expiresAt === null || keep.filesGone}
          title={readonlyTitle(readonly)}
          onClick={() => onExtend(m.id)}
        >
          {pending ? '延长中…' : '延长 30 天'}
        </Button>
        {keep.filesGone && <span className={styles.muted}>本地文件已清理，延长不回来。</span>}
      </div>
    </section>
  )
}

/* ── 采集授权段 ───────────────────────────────────────────────── */

function GrantSection({
  m,
  programs,
  isPending,
  onOpenGrant,
  onRevoke,
  onOverride,
  onClearOverride,
}: {
  m: AdminMeeting
  programs: readonly ServiceProgram[]
  isPending: (key: string) => boolean
  onOpenGrant: (id: string) => void
  onRevoke: (id: string, programId: string) => void
  onOverride: (kind: OverrideKind) => void
  onClearOverride: (kind: OverrideKind) => void
}) {
  const cell = grantCellKind(m)
  const overridden = m.hand.includes('allow')
  const pending = isPending(wkey(m.id, 'allow'))
  const readonly = useReadonly()
  const roTitle = readonlyTitle(readonly)

  return (
    <section className={styles.section} data-testid="section-allow">
      <h3 className={styles.head}>
        采集授权
        <span className={styles.state}>
          {cell.kind === 'unknown' ? '未知' : cell.kind === 'denied' ? '禁止' : '准许'}
        </span>
      </h3>

      <WhyLine why={m.why.allow} />

      {m.grants.length === 0 ? (
        <p className={styles.text}>还没有授权给任何采集程序——外部现在取不到。</p>
      ) : (
        <div className={styles.grantRow} data-testid="detail-grants">
          {m.grants.map((id) => (
            <Pill
              key={id}
              tone="brand"
              onRemove={() => onRevoke(m.id, id)}
              removeDisabled={readonly}
              removeTitle={roTitle}
              removeLabel={`收回 ${programName(programs, id)} 对「${meetingTitle(m)}」的授权`}
            >
              {programName(programs, id)}
            </Pill>
          ))}
        </div>
      )}

      <div className={styles.acts}>
        <Button size="sm" onClick={() => onOpenGrant(m.id)} disabled={readonly} title={roTitle}>
          授权给…
        </Button>
        {overridden ? (
          <Button size="sm" disabled={pending || readonly} title={roTitle} onClick={() => onClearOverride('allow')}>
            {pending ? '撤销中…' : '撤销人工改写'}
          </Button>
        ) : (
          <Button size="sm" disabled={pending || readonly} title={roTitle} onClick={() => onOverride('allow')}>
            人工改写采集权限…
          </Button>
        )}
      </div>
      <p className={styles.note}>单场会议的人工改写优先于所有规则。</p>
    </section>
  )
}

/* ── 操作历史 ─────────────────────────────────────────────────── */

function HistorySection({
  history,
  now,
}: {
  history: ReturnType<typeof useResource<Awaited<ReturnType<typeof fetchMeetingHistory>>>>
  now: Date
}) {
  return (
    <section className={styles.section} data-testid="section-history">
      <h3 className={styles.head}>这场会议的操作历史</h3>

      {history.state === 'loading' && (
        <div data-testid="history-loading">
          <Skeleton width="82%" />
          <Skeleton width="64%" />
        </div>
      )}

      {history.state === 'error' && (
        <p className={styles.stale} role="alert" data-testid="history-error">
          读不到操作历史。<b>这不代表没有人取过</b>，只代表这里读不到。
          <br />
          {history.error.message}{' '}
          <Button variant="quiet" size="sm" onClick={history.retry}>
            重试
          </Button>
        </p>
      )}

      {history.state === 'ready' && (
        <>
          {history.data.meeting === null && (
            <p className={styles.text} data-testid="history-no-meta">
              这场会议的元数据在库里查不到了，下面的记录仍然是它的。
            </p>
          )}
          {history.data.rows.length === 0 ? (
            <p className={styles.text}>还没有任何操作记录。</p>
          ) : (
            /* 连续且逐字相同的几行折成一行（`display.groupHistory`）。
               dev 的 StrictMode 让每次取数写两行审计，一屏几十行长得一模一样，
               真正不同的那几条就淹在里面了。

               **折叠不是去重**：`×N` 和时间区间都要上屏。少了 `×N`，
               「一分钟内取了两次」就成了「取了一次」；少了区间，一个时刻会
               掩掉整段跨度——两者都是把审计记录改写掉，比不折叠糟得多。 */
            <ol className={styles.history} data-testid="history-rows">
              {groupHistory(history.data.rows).map((g) => (
                <li
                  key={g.id}
                  className={styles.historyRow}
                  data-deny={g.deny}
                  // 折叠过的行才多出 ×N 那一列；不折叠的行给了这个属性就会
                  // 平白多留一道 gap 的空
                  data-repeat={g.count > 1 ? g.count : undefined}
                >
                  <span className={styles.historyAt} data-testid="history-at">
                    {historyAtText(g, now)}
                  </span>
                  <span className={styles.historyText}>{g.text}</span>
                  {g.count > 1 && (
                    <span
                      className={styles.historyCount}
                      title={`连续 ${g.count} 条一模一样的记录折成了这一行，一条都没有删。`}
                    >
                      ×{g.count}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          {history.data.window.text !== null && (
            <p className={styles.note} data-testid="history-window">
              {history.data.window.text}
            </p>
          )}
          {/* 这一段历史里有哪几种动作后端还没登记中文名（阶段 5 · A9）。
              上面每行的 `text` 里已经带着「（未登记标签）」，但那要一行行读；
              这里汇总一句。**前端不补一份动作名映射表**——补了之后
              「后端漏登记」就被永久掩盖，见 `api/admin/audit.ts`。

              「上面显示的是 audit_log 里的原值」进 `title`：那是在解释另一处 UI
              怎么工作，不是这里要做的判断的依据。 */}
          {history.data.unlabeledActions.length > 0 && (
            <p
              className={styles.note}
              data-testid="history-unlabeled"
              title="这几种动作上面每行显示的是 audit_log 里的原值。"
            >
              {history.data.unlabeledActions.length} 种动作后端还没有登记中文名（
              {history.data.unlabeledActions.map((u) => u.action).join('、')}）
            </p>
          )}
        </>
      )}
    </section>
  )
}
