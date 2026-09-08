import type { ContentAsset, ContentIndex } from '@/api/admin/content'
import { assetLabel, availabilityLabel } from '@/api/admin/content'
import type { Resource } from '@/lib/useResource'
import { daysLeft, fmtBytes, fmtDateTime, fmtDay } from '@/lib/format'
import { Pill } from '@/ui/Pill'
import { Emphasis, WHY_LABEL } from './text'
import styles from './AssetPanel.module.css'

/**
 * 右下角：**「这场会议的资产与去向」**（spec §4.4 逐字）。
 *
 * > 右下角是「这场会议的资产与去向」，**不是 AI 问答框**：六类资产的格式与体积、
 * > 采集判定（及是哪条规则判的）、已授权给谁、本地还剩几天、NAS 路径
 *
 * 这一块回答的是「这场会议里的东西现在在哪、谁取得走」——腾讯会议那张页面是给
 * 参会者读的，这一页是给管数据的人看的，左边一样，右边不一样。
 *
 * ## 版面：先给答案，再给明细
 *
 * 事实清单（采集判定 / 已授权给 / 本地保留 / NAS 路径）在**最上面**——它是人
 * 打开这一页最先要的那几行答案，把它压在一张长资产列表下面等于藏起来。
 *
 * ## 资产按类合并，理由去重
 *
 * 上一版一条资产画一张卡片，同一类的 docx / pdf / txt 各占一张，而后端的 `reason`
 * 是**按类**写的：三张卡片上一字不差地重复同一段话，路径还在散文里和 `<code>` 里
 * 各出现一次——同一句话在屏幕上出现六遍，人就不读了。
 *
 * 所以这里按 `assetKey ?? assetType` 合并成一行一组，`reason` **去重后逐条列**
 * （只要有一条不同就分别列出并标明是哪个 `fileType` 的），路径**只在明细里出现
 * 一次**。reason 本身一个字都不改：那是后端逐条写好的理由。
 *
 * ## 状态列不许压成一个
 *
 * 每一行的 `availability` 都带着自己的理由：六个取值里**只有 `missing` 是
 * 「这场会议确实缺这一类」**，其余五种都是可修复的缺口。所以组内取值不一致时
 * 必须把各态**分别数出来**（「2 已归档，正文未入库 · 1 未解析（格式不支持）」），
 * 合并成一个词就是把一个可修复的缺口伪装成一件既成事实。
 */

export interface AssetPanelProps {
  index: ContentIndex
  /** 「已授权给谁」单独一条窄读，失败时要说取失败，不能显示成"没有授权" */
  grants: Resource<string[]>
  onRetryGrants: () => void
}

/* ── 分组 ─────────────────────────────────────────────────────────── */

interface Group<T> {
  /** `assetKey ?? assetType`。认不出的新引擎按 `assetType` 自成一组，不折进「其他」 */
  key: string
  label: string
  items: T[]
}

/**
 * 按 `assetKey ?? assetType` 合并。**保持后端下发的顺序**——索引的顺序是后端
 * 排好的，这里重排一次就是在前端另立一套优先级。
 */
function groupByKind<T extends { assetKey: string | null; assetType: string }>(
  list: readonly T[],
): Array<Group<T>> {
  const out: Array<Group<T>> = []
  for (const a of list) {
    const key = a.assetKey ?? a.assetType
    const hit = out.find((g) => g.key === key)
    if (hit === undefined) out.push({ key, label: assetLabel(a.assetKey, a.assetType), items: [a] })
    else hit.items.push(a)
  }
  return out
}

/** 组内各 `availability` 各有几条。首次出现的顺序即显示顺序。 */
function countStates(items: readonly ContentAsset[]): Array<{ availability: string; n: number }> {
  const out: Array<{ availability: string; n: number }> = []
  for (const a of items) {
    const hit = out.find((s) => s.availability === a.availability)
    if (hit === undefined) out.push({ availability: a.availability, n: 1 })
    else hit.n += 1
  }
  return out
}

/**
 * 组内的 `reason` 去重：一模一样的三条只留一条，同时记下它是哪几个 `fileType` 的。
 * 文本本身**原样保留**，不截断、不改写。
 */
function dedupeReasons(items: readonly ContentAsset[]): Array<{ text: string; types: string[] }> {
  const out: Array<{ text: string; types: string[] }> = []
  for (const a of items) {
    if (a.reason === null) continue
    const hit = out.find((r) => r.text === a.reason)
    if (hit === undefined) out.push({ text: a.reason, types: [a.fileType] })
    else hit.types.push(a.fileType)
  }
  return out
}

function assetId(a: { assetType: string; remoteId: string; fileType: string }): string {
  return `${a.assetType}/${a.remoteId}/${a.fileType}`
}

/* ── 组件 ─────────────────────────────────────────────────────────── */

export function AssetPanel({ index, grants, onRetryGrants }: AssetPanelProps) {
  const { assets, access, local, media } = index
  const total = assets.length + media.assets.length
  const groups = groupByKind(assets)
  const mediaGroups = groupByKind(media.assets)

  return (
    <section className={styles.side} aria-label="这场会议的资产与去向">
      <h3 className={styles.sideHead}>
        这场会议的资产与去向
        <span className={styles.spacer} />
        <Pill>{total} 项</Pill>
      </h3>

      {/* 事实清单在最上面：这是人打开这一页最先要的答案 */}
      <dl className={styles.kv}>
        <dt>采集判定</dt>
        <dd>
          <b className={styles.verdict} data-allow={access.allow}>
            {access.allow === 'allow' ? '准许采集' : '禁止采集'}
          </b>
          {/* 判定必须可追溯到是哪条规则判的——这一条一个字都不许简化 */}
          <span className={styles.why}>
            {WHY_LABEL[access.why.by] ?? access.why.by} · <Emphasis text={access.why.text} />
          </span>
        </dd>

        <dt>已授权给</dt>
        <dd>
          {grants.state === 'loading' && '读取中……'}
          {/* 取失败**不能**显示成「还没有授权给任何程序」：后者是一个我们没有依据的结论 */}
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
          {/* 天数不切成独立元素：它是一句话里的数，不是一列要对齐的数字
              （tabular-nums 挂在 .kv dd 上就够）。切开会把这一句拆成三个文本节点。

              精确到期时刻（`2026-09-27 02:22:10 UTC`）挂 `title`，不上屏。它和主持人
              那串 userid、审计动作名同一个处置：**机器精度的东西给需要它的人留个入口,
              不占人人都要读的那一行**。上一版它印在下面那段说明里，而那一行的结论
              「还剩 27 天」才是人真正要的数——两个数并排，反而要多读一遍才知道该看哪个。 */}
          <span title={local.expiresAt === null ? undefined : `保留期到 ${fmtDateTime(local.expiresAt)}`}>
            {local.expiresAt === null
              ? '还没有归档到 NAS，保留窗口还没开始计时'
              : local.filesGone
                ? `本地文件已在 ${local.purgedAt === null ? '到期时' : fmtDay(local.purgedAt)}清理，只能去 NAS 取`
                : `本地文件还在，还剩 ${daysLeft(local.expiresAt)} 天`}
          </span>
          {/* 后端文案。它是补充说明，视觉上比上面那句结论弱一档 */}
          {local.text !== '' && (
            <span className={styles.soft}>
              <Emphasis text={local.text} />
            </span>
          )}
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

      {assets.length === 0 && (
        <p className={styles.notice}>
          库里没有这场会议的任何一段文本资产记录——不等于平台没生成，也可能是拉取还没轮到它。
        </p>
      )}

      {/* 不画表头行：每个 <details> 是一个独立的 grid，表头的列宽撑不到下面各行，
          列名会停在一个对不上任何一列的位置。summary 本身自解释（格式 + 状态）。 */}
      <div className={styles.rows}>
        {groups.map((g) => {
          const states = countStates(g.items)
          const reasons = dedupeReasons(g.items)
          const mixed = states.length > 1
          // 一条理由覆盖不到全组（有的 fileType 根本没给理由）时也要标明是哪个的
          const labelled = reasons.length > 1 || (reasons[0]?.types.length ?? 0) < g.items.length

          return (
            <details key={g.key} className={styles.group}>
              {/* 单态的组一行排完；组内状态不一致时状态另起一行占满宽度——三个态
                  挤进同一行的右半边会换行成三段，和左边的格式列连成一串读不开。 */}
              <summary className={styles.summary} data-mixed={mixed ? 'true' : undefined}>
                <span className={styles.name}>{g.label}</span>
                <span className={styles.types}>
                  {g.items.map((a) => (
                    <span key={assetId(a)} className={styles.type}>
                      {a.fileType}
                    </span>
                  ))}
                </span>
                <span className={styles.states}>
                  {states.map((s) => (
                    <span
                      key={s.availability}
                      className={styles.state}
                      data-ok={s.availability === 'parsed' ? 'true' : undefined}
                      data-missing={s.availability === 'missing' ? 'true' : undefined}
                    >
                      {mixed && <span className={styles.count}>{s.n} </span>}
                      {availabilityLabel(s.availability)}
                    </span>
                  ))}
                </span>
                <span className={styles.mark} aria-hidden="true">
                  ▸
                </span>
              </summary>

              <div className={styles.detail}>
                {reasons.length > 0 && (
                  <ul className={styles.reasons}>
                    {reasons.map((r) => (
                      <li key={r.text} className={styles.reason}>
                        {labelled && <span className={styles.reasonWho}>{r.types.join(' / ')}：</span>}
                        <Emphasis text={r.text} />
                      </li>
                    ))}
                  </ul>
                )}

                <ul className={styles.items}>
                  {g.items.map((a) => (
                    <li key={assetId(a)} className={styles.item}>
                      <span className={styles.itemType}>{a.fileType}</span>
                      {/* 组内状态不一致时，逐条说清是哪个格式处在哪一态 */}
                      {mixed && (
                        <span
                          className={styles.itemState}
                          data-ok={a.availability === 'parsed' ? 'true' : undefined}
                          data-missing={a.availability === 'missing' ? 'true' : undefined}
                        >
                          {availabilityLabel(a.availability)}
                        </span>
                      )}
                      <span className={styles.num}>{fmtBytes(a.bytes)}</span>
                      {a.chars !== null && <span className={styles.num}>正文 {a.chars} 字</span>}
                      {a.nasPath !== null && <code className={styles.path}>{a.nasPath}</code>}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )
        })}

        {mediaGroups.map((g) => (
          <details key={`media/${g.key}`} className={styles.group}>
            <summary className={styles.summary}>
              <span className={styles.name}>{g.label}</span>
              <span className={styles.types}>
                {g.items.map((a) => (
                  <span key={assetId(a)} className={styles.type}>
                    {a.fileType}
                  </span>
                ))}
              </span>
              <span className={styles.states}>
                <span className={styles.state} data-ok="true">
                  不入库，只给去向
                </span>
              </span>
              <span className={styles.mark} aria-hidden="true">
                ▸
              </span>
            </summary>

            <div className={styles.detail}>
              <ul className={styles.items}>
                {g.items.map((a) => (
                  <li key={assetId(a)} className={styles.item}>
                    <span className={styles.itemType}>{a.fileType}</span>
                    {a.nasPath === null ? (
                      <span className={styles.itemNote}>
                        {a.localGone
                          ? '本地文件已到期清理，NAS 上也没有这一段的副本'
                          : '还没归档到 NAS，暂时没有可取的路径'}
                      </span>
                    ) : (
                      <code className={styles.path}>{a.nasPath}</code>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        ))}
      </div>

      {/* `media.text` 是**整个 media 块**的口径，不是某一组的，所以只在这里出现一次。
          它现在通常是**空串**：上一版那四句「为什么这条 API 不下发媒体字节」占了整个
          面板底部，而屏幕上早有更短的版本——录像那一组行尾的「不入库，只给去向」、
          每个 mp4 自己的 NAS 路径、以及左边那个正在播的播放器。
          空串就什么都不画：一个空的 `<p>` 仍然吃掉一行外边距。 */}
      {media.assets.length > 0 && media.text !== '' && (
        <p className={styles.mediaNote}>
          <Emphasis text={media.text} />
        </p>
      )}
    </section>
  )
}

export default AssetPanel
