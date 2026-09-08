import { useState } from 'react'
import {
  rotateProgramSecret,
  setProgramAutoGrant,
  setProgramEnabled,
  type RotatedSecret,
  type ServiceProgram,
} from '@/api/admin/grants'
import { assetLabel, autoGrantErrorText, ASSET_KEYS } from '@/api/admin/programs'
import { readonlyTitle, useReadonly } from '@/app/session'
import { ApiError } from '@/api/client'
import { Button } from '@/ui/Button'
import { Sheet } from '@/ui/Sheet'
import { SecretRow } from './SecretRow'
import styles from './Consumers.module.css'

/**
 * 卡片上的三个动作：**停用 / 启用**、**轮换凭据**（spec §11 缺口 4，端点由 A8 补）
 * 与 **自动授权开关**（方案 2）。
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
 *
 * ## 自动授权：一个开关，但要先把三件事说清
 *
 * 开着之后有一个后台任务替人往 `meeting_grants` 里写行。判定逻辑一个字没改
 *（清单、网关闸门、审计、撤销全部照旧），但**授权的来源多了一个不是人的**，
 * 所以确认面板里逐条写着三条规矩，一条一句：
 *
 * 1. 什么时候跑——每轮拉取 / 归档结束时接着跑一次，另有每 5 分钟兜底；
 * 2. **人工撤销过的会议不会被补回来**——人的决定压过这个开关；
 * 3. **关掉开关不收回已有授权**——可逆的动作不该带不可逆的后果。
 *
 * 第 3 条同时是关闭面板的正文：一个人按下"关闭"时最可能以为自己在做的事，
 * 恰恰是它不做的那件事。收回要去会议记录页批量收回，那句话得跟着一起说。
 *
 * 资产范围默认「不限制」（以规则判定为准）。切到「只授权这几类」却一类都没勾
 * 时确认按钮禁用——`[]` 后端回 400，让人点下去再看错误，等于把一条已知的规矩
 * 留给服务端去说。
 */

type Busy = 'toggle' | 'rotate' | 'auto' | null
type Confirm = 'toggle' | 'rotate' | 'auto' | null
/** 资产范围两档：不限制（以规则判定为准） / 只授权勾中的这几类。 */
type Scope = 'all' | 'pick'

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
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [rotated, setRotated] = useState<RotatedSecret | null>(null)
  const [ack, setAck] = useState(false)
  const [leaveWarn, setLeaveWarn] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>('all')
  const [picked, setPicked] = useState<string[]>([])

  const nextEnabled = !program.enabled
  const nextAutoGrant = !program.autoGrant
  /** 切到「只授权这几类」却一类都没勾：`[]` 后端回 400，这里先拦住 */
  const scopeEmpty = scope === 'pick' && picked.length === 0

  /** 打开开启面板时按这一行现在的取值起头，不带上一次的勾选。 */
  function openAutoConfirm(): void {
    const current = program.autoGrantAssetTypes
    setScope(current !== null && current.length > 0 ? 'pick' : 'all')
    setPicked(current ?? [])
    setConfirm('auto')
  }

  function togglePicked(key: string): void {
    setPicked((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

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

  async function doAutoGrant(): Promise<void> {
    setConfirm(null)
    setBusy('auto')
    setError(null)
    try {
      await setProgramAutoGrant(program.id, {
        autoGrant: nextAutoGrant,
        // 关掉的时候把现有范围原样带回去：这一下要做的事是"别再自动授权了"，
        // 顺手把范围也清掉是一个没人要求过的副作用。
        autoGrantAssetTypes: nextAutoGrant
          ? scope === 'all'
            ? null
            : picked
          : program.autoGrantAssetTypes,
      })
      onChanged()
    } catch (e) {
      // 这一条端点有自己的错误码（`invalid_auto_grant_asset_types`，可能带
      // `issues` 逐条点名），翻成人话；没见过的仍然退回 client 那句。
      setError(autoGrantErrorText(e))
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
        <Button
          size="sm"
          variant="quiet"
          onClick={openAutoConfirm}
          disabled={busy !== null || readonly}
          title={roTitle}
        >
          {busy === 'auto' ? '提交中…' : program.autoGrant ? '关闭自动授权' : '开启自动授权'}
        </Button>
      </div>

      {error !== null && (
        <p className={styles.actionError} role="alert" data-testid={`action-error-${program.id}`}>
          {error}
        </p>
      )}

      {/* ── 二次确认（三个动作共用一个面板，内容按 confirm 分支）─────── */}

      <Sheet size="sm"
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirmTitle(confirm, program)}
      >
        {confirm === 'auto' ? (
          program.autoGrant ? (
            <div className={styles.confirmBody} data-testid="confirm-auto-off">
              <p className={styles.confirmLead}>关掉之后新会议不再自动授权。</p>
              <p className={styles.confirmNote}>
                <b>已经授权的会议一条都不收回</b>——要收回去会议记录页批量收回。
              </p>
            </div>
          ) : (
            <div className={styles.confirmBody} data-testid="confirm-auto-on">
              <p className={styles.confirmLead}>
                开了之后，每轮「拉取新录制」有资产下载完成、或每轮「归档到 NAS」有新归档时紧接着跑一次，另有每 5 分钟一次的兜底。
              </p>
              <p className={styles.confirmLead}>
                <b>你手动撤销过的会议不会被自动补回来</b>——人的决定压过这个开关。
              </p>
              <p className={styles.confirmLead}>
                <b>关掉开关不收回已经授权的会议</b>——要收回去会议记录页批量收回。
              </p>
              <p className={styles.confirmNote}>只授权规则已判准许、且文件还在本地的会议。</p>
              <ScopePicker
                programId={program.id}
                scope={scope}
                picked={picked}
                onScope={setScope}
                onToggle={togglePicked}
                empty={scopeEmpty}
              />
            </div>
          )
        ) : confirm === 'rotate' ? (
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
          {confirm === 'auto' ? (
            <Button
              variant={program.autoGrant ? 'warn' : 'primary'}
              onClick={() => void doAutoGrant()}
              disabled={!program.autoGrant && scopeEmpty}
            >
              {program.autoGrant ? '确认关闭' : '确认开启'}
            </Button>
          ) : confirm === 'rotate' ? (
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

function confirmTitle(confirm: Confirm, program: ServiceProgram): string {
  if (confirm === 'rotate') return `轮换「${program.name}」的凭据`
  if (confirm === 'auto') return program.autoGrant ? '关闭自动授权？' : '让规则替它授权？'
  return program.enabled ? `停用「${program.name}」` : `启用「${program.name}」`
}

/**
 * 自动授权的资产范围。
 *
 * 默认那一档是**不限制**，不是"六类全勾"：两者在库里不是同一个取值
 *（`null` vs 六个键的白名单），而且含义不同——不限制的意思是"以规则判定为准"，
 * 后端加第七类资产时它自动跟着变，一份写死六项的白名单不会。
 *
 * 资产名走 `assetLabel`，键走 `ASSET_KEYS`（由 `ASSET_LABEL` 派生），
 * 这一屏不留第二份资产清单。
 */
function ScopePicker({
  programId,
  scope,
  picked,
  onScope,
  onToggle,
  empty,
}: {
  /** 单选组的 name 按程序分开：同名的两组单选在同一个文档里会被浏览器当成一组 */
  programId: string
  scope: Scope
  picked: readonly string[]
  onScope: (s: Scope) => void
  onToggle: (key: string) => void
  empty: boolean
}) {
  const group = `auto-grant-scope-${programId}`
  return (
    <div className={styles.scope} data-testid="auto-grant-scope">
      <label className={styles.scopeOpt}>
        <input
          type="radio"
          className={styles.ackBox}
          name={group}
          checked={scope === 'all'}
          onChange={() => onScope('all')}
        />
        <span>不限制（以规则判定为准）</span>
      </label>
      <label className={styles.scopeOpt}>
        <input
          type="radio"
          className={styles.ackBox}
          name={group}
          checked={scope === 'pick'}
          onChange={() => onScope('pick')}
        />
        <span>只授权这几类</span>
      </label>
      {scope === 'pick' && (
        <div className={styles.scopeAssets}>
          {ASSET_KEYS.map((key) => (
            <label key={key} className={styles.scopeOpt}>
              <input
                type="checkbox"
                className={styles.ackBox}
                checked={picked.includes(key)}
                onChange={() => onToggle(key)}
              />
              <span>{assetLabel(key)}</span>
            </label>
          ))}
        </div>
      )}
      {empty && (
        <p className={styles.confirmNote} data-testid="auto-grant-scope-empty">
          至少勾一类，或改回不限制。
        </p>
      )}
    </div>
  )
}
