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
  hostLabel,
  meetingTitle,
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
 * 两者不是一回事，所以这里按它真正的名字叫「人工改写」，并在归档段把
 * 「撤销归档」这条缺口写出来——放一个名叫「撤销归档」、实际只是关掉开关的
 * 按钮，是这一页最不该犯的那类错误。
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
 */
export function WhyLine({ why }: { why: AdminWhy }) {
  const missing = why.by === ''
  return (
    <p className={styles.why} data-tone={whyTone(why.by)} data-by={why.by} data-testid="why-line">
      <b>{whyLabel(why.by)}</b>
      {missing ? WHY_MISSING_TEXT : why.text}
    </p>
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

/**
 * 八类资产各自的格式数。
 *
 * spec §4.3 还要「各自的体积」——**后端只下发一个合计** `sizeBytes`
 * （`ConsoleMeetingRow.sizeBytes` 是所有已完成资产 `bytes_expected` 之和），
 * 逐类的体积拿不到。所以这里给格式数与合计，并且不去按比例摊一个假的逐类体积。
 * 这条记在任务报告里。
 */
function AssetTable({ m }: { m: AdminMeeting }) {
  const keys = Object.keys(m.assets)
  if (keys.length === 0) {
    return <p className={styles.text}>这场会议没有任何录制资产。</p>
  }
  return (
    <>
      <table className={styles.assets} data-testid="asset-table">
        <caption className={styles.caption}>
          八类资产的格式数（已拿到 / 应有）。不适用的类不出现在这张表里。
        </caption>
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
      </table>
      {m.unknownAssetTypes.length > 0 && (
        <p className={styles.text} data-testid="unknown-assets">
          另有 {m.unknownAssetTypes.length} 类认不出的资产类型（{m.unknownAssetTypes.join('、')}）
          ——它们确实占着上面的计数，只是没法归进契约的八类。
        </p>
      )}
      <p className={styles.text}>
        合计体积 {fmtBytes(m.sizeBytes)}
        {m.sizeBytes === null && '（一个资产都没有声明大小，算不出来——不是 0 字节）'}。
        逐类的体积后端没有下发。
      </p>
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
      {/* spec §4.3 脚注定的语义（2026-08-25）：「撤销归档」＝只撤记录、NAS 副本
          保留，是可逆动作，不需要二次确认。**后端没有这条端点**（US-2.5 至今
          0 实现），所以这里没有那个按钮——放一个名字对、动作不对的按钮，
          在一个"归档记录没了就等于丢了"的系统里是最贵的一种误导。 */}
      <p className={styles.gap} data-testid="undo-archive-gap">
        <b>「撤销归档」还没有。</b>
        规格里它的语义是<b>只撤归档记录、NAS 上的副本保留</b>（2026-08-25 定），
        因此是可逆动作、不需要二次确认。但后端目前没有这条端点，控制台不放这个按钮。
        下面那个「人工改写」是另一件事：它把归档阶段关掉，不撤销已经发生的那一次归档。
      </p>
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
          {m.archive === 'failed'
            ? '归档失败，保留期未开始计时。归档不成功，本地到期后这场会议就永久没有了。'
            : '尚未归档，保留期未开始计时。'}
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

      <p className={styles.text}>
        保留期从<b>归档成功</b>那一刻起算，不是从会议日。到期后本地文件删除，只留记录和 NAS 路径。
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
            <ol className={styles.history} data-testid="history-rows">
              {history.data.rows.map((r) => (
                <li key={r.id} className={styles.historyRow} data-deny={r.decision === 'deny'}>
                  <span className={styles.historyAt}>{fmtDateTime(r.at, now)}</span>
                  <span className={styles.historyText}>{r.text}</span>
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
              「后端漏登记」就被永久掩盖，见 `api/admin/audit.ts`。 */}
          {history.data.unlabeledActions.length > 0 && (
            <p className={styles.note} data-testid="history-unlabeled">
              这段历史里有 {history.data.unlabeledActions.length} 种动作后端还没有登记中文名
              （{history.data.unlabeledActions.map((u) => u.action).join('、')}），
              上面显示的是 audit_log 里的原值。
            </p>
          )}
        </>
      )}
    </section>
  )
}
