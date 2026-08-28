import type { ReactNode } from 'react'
import { programInventory, type ProgramInventory } from '@/api/admin/grants'
import {
  inventoryErrorText,
  reachLine,
  remedyHint,
  tallyBlockers,
  type ProgramStanding,
  type ReachLine,
} from '@/api/admin/programs'
import { useResource, type Resource } from '@/lib/useResource'
import { Button } from '@/ui/Button'
import { Skeleton } from '@/ui/Skeleton'
import styles from './Consumers.module.css'

export type InventoryRes = Resource<ProgramInventory> & { retry: () => void }

/** 逐程序一个请求。清单是求交的结果，只能一个程序一个程序地问。 */
export function useInventory(programId: string): InventoryRes {
  return useResource(() => programInventory(programId), [programId])
}

type ReachKind = 'loading' | 'unavailable' | 'disabled' | ReachLine['kind']

function reachKind(standing: ProgramStanding, res: InventoryRes): ReachKind {
  if (res.state === 'loading') return 'loading'
  if (res.state === 'error') return 'unavailable'
  if (standing === 'disabled') return 'disabled'
  return reachLine(res.data).kind
}

/**
 * 「这个程序实际能取到什么」——spec §4.5 说这句话是**这一页的全部价值**。
 *
 * 三件事在这里必须同时成立，少一件这块就变成了装饰：
 *
 * 1. **数字与资产串只能来自 inventory**。它是 授权 ∩ 保留期 ∩ 规则 求交之后的
 *    实际结果，不是配置值。
 * 2. **拉不到清单时说"清单暂不可得"，绝不退化成空清单**。
 * 3. **程序被停用 / 凭据过期时不许说"现在可取走"**（`computeProgramInventory`
 *    不看 `enabled` 与 `expiresAt`，见 `src/worker/visibility.ts`）。
 *
 * 「取不到几场、为什么」这件事**不在**这里说——它是独立的一格
 * （表格里的 `BlockedCell`；接入向导第三步的预览没有取不到的会议可展示，
 * 不需要它）。原来一场都取不到时这一块要么什么都不说，要么把整份挡下清单
 * 塞进同一块蓝底里；拆开之后，"现在能取几场"和"取不到几场为什么"是两件
 * 平级的事，不再是一件事里的主句与从句。
 *
 * 内容本体在 `ReachContent`：这一页的表格（`ReachCell`，外壳是 `<td>`）与
 * 接入向导第三步的预览（`ReachBlock`，外壳是 `<div>`，见 `Wizard.tsx`）
 * 共用同一份分支逻辑，只是外壳标签不同——两处不该各写一份、迟早两边的
 * 文案或判定分叉。
 */
function ReachContent({
  programId,
  standing,
  res,
}: {
  programId: string
  standing: ProgramStanding
  res: InventoryRes
}): ReactNode {
  if (res.state === 'loading') {
    return <Skeleton width="72%" />
  }

  if (res.state === 'error') {
    // 「清单暂不可得」这四个字本身就说了它不是一个结论，字色也是琥珀而不是中性。
    return (
      <>
        <p className={styles.reachLead}>清单暂不可得</p>
        <p className={styles.reachReason}>{inventoryErrorText(res.error)}</p>
        <Button size="sm" onClick={res.retry}>
          重新读取清单
        </Button>
      </>
    )
  }

  const inv = res.data
  const line = reachLine(inv)

  /* 停用的程序：**这一格显示「已停用」，不显示那个数**。
   *
   * 清单端点算的是 授权 ∩ 保留期 ∩ 规则，**不看 `enabled`**，所以一个停用的
   * 程序照样会有一份非空清单。网关那一侧已经会拒（判定在 `AccessGate`），
   * 于是这个数在界面上就成了 spec §1.3 点名要防的那种漂移：
   * **控制台说准许、程序去取的时候被拒**。
   *
   * 所以数字换成状态本身，那份"如果它还能登录会是什么样"的清单降到下面一行。 */
  if (standing === 'disabled') {
    return (
      <>
        <p className={styles.reachLine}>
          <b className={styles.reachNum}>已停用</b>
          <span className={styles.reachStopped}>现在 0 场会议对它开放</span>
        </p>
        {/* 「停用立刻生效 / 授权一条都没删」原来常驻在这里，那是**做决定那一刻**
            要知道的事，二次确认面板逐条写着；停用之后再挂一遍就是把一次性的
            提醒变成了常设的段落，所以这里不重复。 */}
        <p className={styles.reachNote} data-testid={`reach-${programId}-ifenabled`}>
          {line.kind === 'none'
            ? '恢复启用后它也一场都取不到——清单本身就是空的。'
            : line.kind === 'reachable-no-assets'
              ? `恢复启用后清单里有 ${line.count} 场，但一类资产都没列出来——这两件事自相矛盾，把这句话报给维护者。`
              : `恢复启用后能取走 ${line.count} 场会议的 ${line.assetsText}。`}
        </p>
      </>
    )
  }

  // 「现在」这个词只有在程序真的能登录时才成立，见文件头第 3 条。
  const verb = standing === 'expired' ? '换发凭据后可取走' : '现在可取走'

  return (
    <>
      {line.kind === 'reachable' && (
        <>
          <p className={styles.reachLine}>
            {verb} <b className={styles.reachNum}>{line.count}</b> 场会议的 {line.assetsText}
          </p>
          {line.expiringSoon > 0 && (
            <p className={styles.reachSoon}>
              其中 {line.expiringSoon} 场 {line.expiringSoonDays} 天内到期
            </p>
          )}
        </>
      )}

      {line.kind === 'reachable-no-assets' && (
        <p className={styles.reachLine}>
          {verb} <b className={styles.reachNum}>{line.count}</b> 场会议，但清单里一类资产都没列出来——
          这两件事自相矛盾，先别当真，把这句话报给维护者。
        </p>
      )}

      {line.kind === 'none' && (
        <>
          <p className={styles.reachLine}>
            当前 <b className={styles.reachNum}>0</b> 场会议对它开放。
          </p>
          {/* 已授权但取不到时"为什么"由 `BlockedCell` 那一列回答，这里不重复；
              只有从来没授权过（连挡下的都没有）才在这里给出路。 */}
          {line.blockedCount === 0 && (
            <p className={styles.reachNote}>
              还没有任何会议授权给它。到「自动规则」里放行，或在「会议记录」里逐场授权。
            </p>
          )}
        </>
      )}
    </>
  )
}

interface ReachProps {
  programId: string
  standing: ProgramStanding
  res: InventoryRes
}

/** 表格里「现在能取」那一列。data-testid 与改版前同名：`reach-<id>`
 *（加载中是 `reach-<id>-loading`，只标"已经有结论"的那几种渲染，
 *  否则测试里 findByTestId 会抓到还在转的那一帧，断言的是空话）。 */
export function ReachCell({ programId, standing, res }: ReachProps) {
  const kind = reachKind(standing, res)
  const loading = res.state === 'loading'
  return (
    <td
      data-label="现在能取"
      className={styles.reachCell}
      data-kind={kind}
      data-testid={loading ? `reach-${programId}-loading` : `reach-${programId}`}
      aria-busy={loading || undefined}
      aria-label={loading ? '正在读取这个程序的清单' : undefined}
    >
      <ReachContent programId={programId} standing={standing} res={res} />
    </td>
  )
}

/** 接入向导第三步「可取清单」预览用的独立版本——单独一个程序的一次性预览，
 *  不在表格里，所以外壳是块级容器而不是 `<td>`（见 `Wizard.tsx` 的 `AssetsStep`）。 */
export function ReachBlock({ programId, standing, res }: ReachProps) {
  const kind = reachKind(standing, res)
  const loading = res.state === 'loading'
  return (
    <div
      className={styles.reachStandalone}
      data-kind={kind}
      data-testid={loading ? `reach-${programId}-loading` : `reach-${programId}`}
      aria-busy={loading || undefined}
      aria-label={loading ? '正在读取这个程序的清单' : undefined}
    >
      <ReachContent programId={programId} standing={standing} res={res} />
    </div>
  )
}

/**
 * 「取不到几场、为什么」——spec §1.3 要求界面**随时**答得出「为什么这场会议
 * 这个程序取不到」，只报好消息等于答了一半。不管这个程序现在能取几场，
 * 只要有已授权但拿不到的会议，这一格就按原因归并列出来。
 */
export function BlockedCell({ res }: { res: InventoryRes }) {
  if (res.state === 'loading') {
    return (
      <td data-label="取不到" className={styles.blockedCell}>
        <Skeleton width="48%" size="sm" />
      </td>
    )
  }

  if (res.state === 'error') {
    // 清单本身都拉不到，"取不到几场"无从谈起——不编一个假的 0 或者假的破折号
    // 之外的东西，交给"现在能取"那一列去说清单暂不可得。
    return (
      <td data-label="取不到" className={styles.blockedCell}>
        <span className={styles.dash}>—</span>
      </td>
    )
  }

  const inv = res.data
  if (inv.blockedCount <= 0) {
    return (
      <td data-label="取不到" className={styles.blockedCell}>
        <span className={styles.dash}>—</span>
      </td>
    )
  }

  const lead =
    inv.fetchableCount > 0
      ? `另有 ${inv.blockedCount} 场已授权但现在取不到：`
      : `已授权 ${inv.blockedCount} 场，但现在一场都取不到：`

  return (
    <td data-label="取不到" className={styles.blockedCell}>
      <p className={styles.asideLead}>{lead}</p>
      <BlockerList items={tallyBlockers(inv.blocked)} />
    </td>
  )
}

function BlockerList({ items }: { items: ReturnType<typeof tallyBlockers> }) {
  return (
    <ul className={styles.tally}>
      {items.map((t) => {
        const hint = remedyHint(t.remedy)
        return (
          <li key={t.code} className={styles.tallyItem}>
            <span className={styles.tallyLabel}>{t.label}</span>
            <span className={styles.tallyCount}>{t.count} 场</span>
            {/* 理由的文本一律来自后端下发的原话，前端不自己编（计划 §1 第 3 条） */}
            <span className={styles.tallySample}>{t.sample}</span>
            {hint !== null && <span className={styles.tallyHint}>{hint}</span>}
          </li>
        )
      })}
    </ul>
  )
}
