import { useState } from 'react'
import {
  rotateProgramSecret,
  setProgramEnabled,
  type RotatedSecret,
  type ServiceProgram,
} from '@/api/admin/grants'
import { readonlyTitle, useReadonly } from '@/app/session'
import { ApiError } from '@/api/client'
import { Button } from '@/ui/Button'
import { Sheet } from '@/ui/Sheet'
import { SecretRow } from './SecretRow'
import styles from './Consumers.module.css'

/**
 * 卡片上的两个动作：**停用 / 启用** 与 **轮换凭据**（spec §11 缺口 4，端点由 A8 补）。
 *
 * ## 两件必须在界面上说清的事（A8 报告原话）
 *
 * 1. 停用**不删任何授权**——停用可逆，「停用再启用」不会丢配置。
 * 2. 停用**立刻生效**，包括那个程序手上已经签发、还没过期的访问令牌。
 *    判定在 `AccessGate`，不是只在拿凭据换令牌那一层。
 *
 * ## 轮换的形态：一次性展示
 *
 * 新 secret 只在那一次响应里出现，服务端只存哈希，**没有也不会有「再看一次」
 * 的端点**（那等于把哈希存储的意义抵消掉）。所以这一屏：
 *
 * - 明文 + 一个复制按钮（`SecretRow`，与接入向导第二步同一个组件）；
 * - 后端那句 `secretNote` **原样上屏**，不改写——建号那一步用的是同一句话；
 * - 关闭之前要勾一个「我已经保存好了」。不勾就关会得到一句再问一遍的提醒，
 *   **而不是一声不吭地关掉**——关掉之后这段明文真的就没有了。
 *   提醒之后按钮仍然点得动：这是提醒，不是把人锁在这一屏上。
 */

type Busy = 'toggle' | 'rotate' | null

export function ProgramActions({
  program,
  onChanged,
}: {
  program: ServiceProgram
  /** 写成功之后重取列表。不做乐观更新（裁定 G-c）：卡片上的每一行都是后端说的。 */
  onChanged: () => void
}) {
  const readonly = useReadonly()
  const roTitle = readonlyTitle(readonly)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'toggle' | 'rotate' | null>(null)
  const [rotated, setRotated] = useState<RotatedSecret | null>(null)
  const [ack, setAck] = useState(false)
  const [leaveWarn, setLeaveWarn] = useState<string | null>(null)

  const nextEnabled = !program.enabled

  function fail(e: unknown): void {
    // 端点名与后端错误码都在 message 里；403 时那就是后端写好的那句中文。
    setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))
  }

  async function doToggle(): Promise<void> {
    setConfirm(null)
    setBusy('toggle')
    setError(null)
    try {
      await setProgramEnabled(program.id, nextEnabled)
      onChanged()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  async function doRotate(): Promise<void> {
    setConfirm(null)
    setBusy('rotate')
    setError(null)
    try {
      const res = await rotateProgramSecret(program.id)
      setAck(false)
      setLeaveWarn(null)
      setRotated(res)
      onChanged()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  function closeRotated(): void {
    if (!ack) {
      setLeaveWarn(
        '还没勾「我已经保存好了」。关掉之后这段明文再也拿不到——丢了只能再轮换一次，旧的当场失效。',
      )
      return
    }
    setRotated(null)
    setLeaveWarn(null)
  }

  return (
    <>
      <div className={styles.actions} data-testid={`actions-${program.id}`}>
        <Button
          size="sm"
          variant={program.enabled ? 'warn' : 'default'}
          onClick={() => setConfirm('toggle')}
          disabled={busy !== null || readonly}
          title={roTitle}
        >
          {busy === 'toggle' ? '提交中…' : program.enabled ? '停用' : '启用'}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          onClick={() => setConfirm('rotate')}
          disabled={busy !== null || readonly}
          title={roTitle}
        >
          {busy === 'rotate' ? '轮换中…' : '轮换凭据'}
        </Button>
      </div>

      {error !== null && (
        <p className={styles.actionError} role="alert" data-testid={`action-error-${program.id}`}>
          {error}
        </p>
      )}

      {/* ── 二次确认（两个动作共用一个面板，内容按 confirm 分支）─────── */}

      <Sheet size="sm"
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirmTitle(confirm, program)}
      >
        {confirm === 'rotate' ? (
          <div className={styles.confirmBody} data-testid="confirm-rotate">
            <p className={styles.confirmLead}>
              <b>旧凭据当场失效。</b>对接方的定时任务会在下一次拿凭据换令牌时开始收到 401，
              直到它换上新的那一串。轮换之前先确认那边有人能改配置。
            </p>
            <p className={styles.confirmNote}>
              新的明文<b>只显示这一次</b>。
            </p>
          </div>
        ) : program.enabled ? (
          <div className={styles.confirmBody} data-testid="confirm-disable">
            <p className={styles.confirmLead}>
              停用之后它<b>立刻</b>取不到任何东西——包括它手上已经签发、还没过期的访问令牌
              （判定在网关每一次取数时做，不是只在拿凭据换令牌那一层）。
            </p>
            <p className={styles.confirmNote}>
              <b>已有的授权一条都不会删</b>——停用是可逆的，再点「启用」就回到现在这个样子。
            </p>
          </div>
        ) : (
          <div className={styles.confirmBody} data-testid="confirm-enable">
            <p className={styles.confirmLead}>
              按停用之前的那些授权继续取数——停用期间授权一条都没删。
            </p>
            <p className={styles.confirmNote}>凭据没有变，对接方那边不用改配置。</p>
          </div>
        )}
        <div className={styles.confirmFoot}>
          <Button variant="quiet" onClick={() => setConfirm(null)}>
            取消
          </Button>
          {confirm === 'rotate' ? (
            <Button variant="warn" onClick={() => void doRotate()}>
              确认轮换
            </Button>
          ) : (
            <Button variant={program.enabled ? 'warn' : 'primary'} onClick={() => void doToggle()}>
              {program.enabled ? '确认停用' : '确认启用'}
            </Button>
          )}
        </div>
      </Sheet>

      {/* ── 一次性展示 ───────────────────────────────────────── */}

      <Sheet size="sm" open={rotated !== null} onClose={closeRotated} title={`「${program.name}」的新凭据`}>
        {rotated !== null && (
          <div className={styles.confirmBody} data-testid="rotated-secret">
            <p className={styles.confirmLead} data-testid="rotated-note">
              {rotated.secretNote}
            </p>
            <SecretRow label="CLIENT ID" value={rotated.id} />
            <SecretRow label="新 SECRET" value={rotated.secret} />
            <label className={styles.ack}>
              <input
                type="checkbox"
                className={styles.ackBox}
                checked={ack}
                onChange={(e) => {
                  setAck(e.target.checked)
                  if (e.target.checked) setLeaveWarn(null)
                }}
              />
              <span>我已经把新 Secret 保存好了</span>
            </label>
            {leaveWarn !== null && (
              <p className={styles.confirmWarn} role="alert" data-testid="rotated-leave-warn">
                {leaveWarn}
              </p>
            )}
          </div>
        )}
        <div className={styles.confirmFoot}>
          {/* 不叫「关闭」：Sheet 头部那个 × 的可访问名就是「关闭」，两个同名按钮
              会让读屏和测试都分不清哪个是哪个。两者走的是同一个 closeRotated。 */}
          <Button variant="primary" onClick={closeRotated}>
            关掉这一屏
          </Button>
        </div>
      </Sheet>
    </>
  )
}

function confirmTitle(confirm: 'toggle' | 'rotate' | null, program: ServiceProgram): string {
  if (confirm === 'rotate') return `轮换「${program.name}」的凭据`
  return program.enabled ? `停用「${program.name}」` : `启用「${program.name}」`
}
