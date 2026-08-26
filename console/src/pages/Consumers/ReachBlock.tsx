import { programInventory, type ProgramInventory } from '@/api/admin/grants'
import {
  inventoryErrorText,
  reachLine,
  remedyHint,
  tallyBlockers,
  type ProgramStanding,
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

/**
 * 「这个程序实际能取到什么」——spec §4.5 说卡片正中间这句话是**这一页的全部价值**。
 *
 * 三件事在这里必须同时成立，少一件这块就变成了装饰：
 *
 * 1. **数字与资产串只能来自 inventory**。它是 授权 ∩ 保留期 ∩ 规则 求交之后的
 *    实际结果，不是配置值。`Consumer.scope` 那个配置串已经连同 mock 一起删掉了。
 * 2. **拉不到清单时说"清单暂不可得"，绝不退化成空清单**。空清单是一个结论
 *    （"它现在一场都取不走"），而拉不到是我们没有结论——把后者显示成前者，
 *    等于替一次没做成的查询下结论。
 * 3. **程序被停用 / 凭据过期时不许说"现在可取走"**。清单端点算的是授权、保留期
 *    与规则三者，**不看 `enabled` 与 `expiresAt`**（`src/worker/visibility.ts`
 *    的 `computeProgramInventory`），所以一个停用的程序照样会有一份非空清单——
 *    那是"如果它还能登录"的结果，直说成"现在可取走"就是在撒谎。
 */
export function ReachBlock({
  programId,
  standing,
  res,
}: {
  programId: string
  standing: ProgramStanding
  res: InventoryRes
}) {
  if (res.state === 'loading') {
    // 加载态刻意用另一个 testid：`reach-<id>` 只标"已经有结论"的那几种渲染，
    // 否则测试里 findByTestId 会抓到还在转的那一帧，断言的是空话。
    return (
      <div className={styles.reach} data-kind="loading" data-testid={`reach-${programId}-loading`}>
        <p className={styles.reachLead}>正在求交：有授权 ∩ 在保留期内 ∩ 规则允许采集…</p>
        <Skeleton width="72%" />
      </div>
    )
  }

  if (res.state === 'error') {
    return (
      <div className={styles.reach} data-kind="unavailable" data-testid={`reach-${programId}`}>
        <p className={styles.reachLead}>清单暂不可得</p>
        <p className={styles.reachReason}>{inventoryErrorText(res.error)}</p>
        <p className={styles.reachNote}>
          这不是「一场都取不走」——那是一个结论；现在只是没查到，别按结论用。
        </p>
        <Button size="sm" onClick={res.retry}>
          重新读取清单
        </Button>
      </div>
    )
  }

  const inv = res.data
  const line = reachLine(inv)

  /* 停用的程序：**这一格显示「已停用」，不显示那个数**。
   *
   * 清单端点算的是 授权 ∩ 保留期 ∩ 规则，**不看 `enabled`**，所以一个停用的
   * 程序照样会有一份非空清单。A8 之后网关那一侧已经会拒（判定挪进了
   * `AccessGate`），于是这个数在界面上就成了 spec §1.3 点名要防的那种漂移：
   * **控制台说准许、程序去取的时候被拒**。
   *
   * 所以数字换成状态本身，那份"如果它还能登录会是什么样"的清单降到下面一行——
   * 它仍然有用（决定要不要恢复启用时看的就是它），但它不再冒充「现在可取走」。
   * 根治是让重算也看 `enabled`，那会牵到调度器那一侧，留给后续。 */
  if (standing === 'disabled') {
    return (
      <div className={styles.reach} data-kind="disabled" data-testid={`reach-${programId}`}>
        <p className={styles.reachLine}>
          <b className={styles.reachNum}>已停用</b>
          <span className={styles.reachStopped}>现在 0 场会议对它开放</span>
        </p>
        <p className={styles.reachCaveat}>
          停用立刻生效：它拿凭据换不到新令牌，手上还没过期的那张也一起失效。已有的授权一条都没删。
        </p>
        <p className={styles.reachNote} data-testid={`reach-${programId}-ifenabled`}>
          {line.kind === 'none'
            ? '恢复启用后它也一场都取不到——清单本身就是空的。'
            : line.kind === 'reachable-no-assets'
              ? `恢复启用后清单里有 ${line.count} 场，但一类资产都没列出来——这两件事自相矛盾，把这句话报给维护者。`
              : `恢复启用后它能取走 ${line.count} 场会议的 ${line.assetsText}。这是「如果它还能登录」的结果，不是现在。`}
        </p>
      </div>
    )
  }

  // 「现在」这个词只有在程序真的能登录时才成立，见文件头第 3 条。
  const verb = standing === 'expired' ? '换发凭据后可取走' : '现在可取走'

  return (
    <div className={styles.reach} data-kind={line.kind} data-testid={`reach-${programId}`}>
      {standing === 'expired' && (
        <p className={styles.reachCaveat}>凭据已过期，现在换不到令牌——下面这份清单是换发凭据后的样子。</p>
      )}

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
          {line.blockedCount === 0 ? (
            <p className={styles.reachNote}>
              还没有任何会议授权给它。到「自动规则」里放行，或在「会议记录」里逐场授权。
            </p>
          ) : (
            <>
              <p className={styles.reachNote}>已授权 {line.blockedCount} 场，但现在一场都取不到：</p>
              <BlockerList items={tallyBlockers(inv.blocked)} />
            </>
          )}
        </>
      )}
    </div>
  )
}

/**
 * 能取到的同时还有取不到的——后者同样要说出来。spec §1.3 要求界面**随时**
 * 答得出「为什么这场会议这个程序取不到」，只报好消息等于答了一半。
 */
export function BlockedAside({ inv }: { inv: ProgramInventory }) {
  if (inv.fetchableCount <= 0 || inv.blockedCount <= 0) return null
  return (
    <div className={styles.aside}>
      <p className={styles.asideLead}>另有 {inv.blockedCount} 场已授权但现在取不到：</p>
      <BlockerList items={tallyBlockers(inv.blocked)} />
    </div>
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
