import type { ContentIndex } from '@/api/admin/content'
import { assetLabel, availabilityLabel } from '@/api/admin/content'
import type { Resource } from '@/lib/useResource'
import { daysLeft, fmtBytes, fmtDay } from '@/lib/format'
import { Pill } from '@/ui/Pill'
import { WHY_LABEL } from './text'
import styles from './Preview.module.css'

/**
 * 右下角：**「这场会议的资产与去向」**（spec §4.4 逐字）。
 *
 * > 右下角是「这场会议的资产与去向」，**不是 AI 问答框**：八类资产的格式与体积、
 * > 采集判定（及是哪条规则判的）、已授权给谁、本地还剩几天、NAS 路径
 *
 * 这一块回答的是「这场会议里的东西现在在哪、谁取得走」——腾讯会议那张页面是给
 * 参会者读的，这一页是给管数据的人看的，左边一样，右边不一样。
 *
 * 每一行的 `availability` 都带着自己的理由：六个取值里**只有 `missing` 是
 * 「这场会议确实缺这一类」**，其余五种都是可修复的缺口。把它们显示成「没有」,
 * 就是把一个可修复的缺口伪装成一件既成事实。
 */

export interface AssetPanelProps {
  index: ContentIndex
  /** 「已授权给谁」单独一条窄读，失败时要说取失败，不能显示成"没有授权" */
  grants: Resource<string[]>
  onRetryGrants: () => void
}

export function AssetPanel({ index, grants, onRetryGrants }: AssetPanelProps) {
  const { assets, access, local, media } = index
  const total = assets.length + media.assets.length

  return (
    <section className={styles.side} aria-label="这场会议的资产与去向">
      <h3 className={styles.sideHead}>
        这场会议的资产与去向
        <span className={styles.spacer} />
        <Pill>{total} 项</Pill>
      </h3>

      {assets.length === 0 && (
        <p className={styles.notice}>
          库里没有这场会议的任何一段文本资产记录——既没有正文行，也没有归档记录或
          本地文件。这不等于平台没生成，也可能是拉取还没轮到它。
        </p>
      )}

      <ul className={styles.assetList}>
        {assets.map((a) => (
          <li key={`${a.assetType}/${a.remoteId}/${a.fileType}`} className={styles.asset}>
            <div className={styles.assetRow}>
              <span className={styles.assetName}>{assetLabel(a.assetKey, a.assetType)}</span>
              <span className={styles.mono}>{a.fileType}</span>
              <span className={styles.mono}>{fmtBytes(a.bytes)}</span>
              <span
                className={styles.assetState}
                data-ok={a.availability === 'parsed' ? 'true' : undefined}
                data-missing={a.availability === 'missing' ? 'true' : undefined}
              >
                {availabilityLabel(a.availability)}
              </span>
            </div>
            {a.chars !== null && <p className={styles.assetMeta}>正文 {a.chars} 字</p>}
            {a.reason !== null && <p className={styles.reason}>{a.reason}</p>}
            {a.nasPath !== null && <code className={styles.path}>{a.nasPath}</code>}
          </li>
        ))}

        {media.assets.map((a) => (
          <li key={`media/${a.assetType}/${a.remoteId}/${a.fileType}`} className={styles.asset}>
            <div className={styles.assetRow}>
              <span className={styles.assetName}>{assetLabel(a.assetKey, a.assetType)}</span>
              <span className={styles.mono}>{a.fileType}</span>
              <span className={styles.mono}>{fmtBytes(null)}</span>
              <span className={styles.assetState}>不入库，只给去向</span>
            </div>
            <p className={styles.assetMeta}>
              录像与音频不进正文库，本接口也不下发它们的体积；去向（NAS 路径）在上面的
              播放位置区里。
            </p>
          </li>
        ))}
      </ul>

      <dl className={styles.kv}>
        <dt>采集判定</dt>
        <dd>
          <b data-allow={access.allow}>{access.allow === 'allow' ? '准许采集' : '禁止采集'}</b>
          {' · '}
          {WHY_LABEL[access.why.by] ?? access.why.by} · {access.why.text}
        </dd>

        <dt>已授权给</dt>
        <dd>
          {grants.state === 'loading' && '读取中……'}
          {grants.state === 'error' && (
            <>
              <span className={styles.errInline}>取失败：{grants.error.message}</span>
              <button type="button" className={styles.retry} onClick={onRetryGrants}>
                重试
              </button>
            </>
          )}
          {grants.state === 'ready' &&
            (grants.data.length === 0 ? '还没有授权给任何程序' : grants.data.join('、'))}
        </dd>

        <dt>本地保留</dt>
        <dd>
          {local.expiresAt === null
            ? '还没有归档到 NAS，保留窗口还没开始计时'
            : local.filesGone
              ? `本地文件已在 ${local.purgedAt === null ? '到期时' : fmtDay(local.purgedAt)}清理，只能去 NAS 取`
              : `本地文件还在，还剩 ${daysLeft(local.expiresAt)} 天`}
          <p className={styles.reason}>{local.text}</p>
        </dd>

        <dt>NAS 路径</dt>
        <dd>
          {local.nasDir === null ? (
            '还没有归档到 NAS，没有路径'
          ) : (
            <code className={styles.path}>{local.nasDir}</code>
          )}
        </dd>
      </dl>
    </section>
  )
}

/**
 * 右下角**不是 AI 问答框**（spec §1.4 数据出境闸门 · §10 YAGNI）。
 *
 * 原型在这个位置为「向这场会议提问」留了空，并且**刻意没有实现**，理由写在
 * 界面上：那是一条新的出境路径，真要接就当一个采集程序来管——走接入向导拿凭据、
 * 受规则和授权约束、每次问答记一条审计。
 *
 * 这里连那个禁用的输入框都不画：一个点不动的输入框仍然在暗示"这个功能马上就有"，
 * 而这条路径要不要开是一个尚未做出的决定，不是一个尚未完成的工期（同 G-g
 * 对「新建定时任务」按钮的处置）。
 */
export function AskNote() {
  return (
    <section className={styles.ask} aria-label="向这场会议提问（刻意不做）">
      <h3 className={styles.askHead}>向这场会议提问 —— 刻意不做</h3>
      <p>
        问答要把会议内容送到模型那边，那是一条<b>新的出境路径</b>，不能从这个页面悄悄
        开出去。真要接，就<b>当一个采集程序来管</b>：走接入向导拿凭据、受规则和授权约束、
        每次问答记一条审计。
      </p>
      <p>
        在那之前这里不放输入框——一个点不动的输入框只会让人以为它快好了，而这是一个
        还没做的决定，不是一个还没写完的功能。
      </p>
    </section>
  )
}

export default AssetPanel
