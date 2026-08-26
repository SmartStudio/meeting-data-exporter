import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Drawer } from '@/ui/Drawer'
import { Button } from '@/ui/Button'
import { Input } from '@/ui/Input'
import { ApiError } from '@/api/client'
import { listPrograms, type ServiceProgram } from '@/api/admin/grants'
import {
  createRule,
  deleteRule,
  patchRule,
  previewRules,
  type CandidateRule,
  type PreviewResult,
  type Rule,
  type RuleCondition,
  type RuleInput,
  type StackKind,
} from '@/api/admin/rules'
import { ASSET_ALL, ASSET_KEYS, CONDITION_FIELDS, OP_LABEL, fieldSpec } from './fields'
import { STACK_META } from './order'
import { ImpactPreview } from './ImpactPreview'
import type { EditorState } from './index'
import styles from './RuleEditor.module.css'

/**
 * 规则编辑器（spec §4.7）。
 *
 * 右侧全高面板，**比抽屉宽**，因为条件构建器和影响预览必须同屏——spec 的原话是
 *
 * > 规则的难点从来不是「怎么填」，是「填完之后有多少场会议的状态会变」。
 *
 * 影响预览**钉在底部**（`position: sticky`），不跟正文滚动：滚上去看不见的数字
 * 等于没有。三个数一律来自 `POST /rules/preview`，前端一个都不算（spec §5.5
 * 定义了计算范围，前端另算一遍就是第二份真相）。
 *
 * ## 三条刻意的限制
 *
 * 1. **一条规则内只能全用「且」或全用「或」**。混用而没有括号，读起来通顺，
 *    求值顺序却常常和人的直觉不一样。需要混用就拆成两条规则。
 * 2. **`dept` 可见但禁用**，并写明原因。不隐藏：库里的老规则上真的有这个字段，
 *    隐藏了管理员就看不出那条规则为什么不命中。
 * 3. **删除按钮默认是安静的**，点第一次才变红（二次确认）。
 *
 * ## 编辑器里不改 kind——除非它本来就认不出
 *
 * 后端的 PATCH 允许改 kind，但界面上平时不给这个口子：三栈的 effect 取值域、主体
 * 规矩、资产类型全都因栈而异，改 kind 等于把整张表单换一套语义，那不是改一个字段。
 * 要换栈就在那一栈里新建。
 *
 * **唯一的例外是打开时 kind 就不在三栈里**（库里的一条坏行，`describeStackRuleIssues`
 * 会说它「不会参与任何判定」）。那时不开这个口子就是死路：编辑器打得开却修不了，
 * 而唯一的修法恰恰是改 kind。
 */
export interface RuleEditorProps {
  state: EditorState | null
  /** 用来算新规则的默认优先级（本栈最高 + 100）。 */
  allRules: Rule[]
  onClose: () => void
  onSaved: (text: string) => void
}

export function RuleEditor({ state, allRules, onClose, onSaved }: RuleEditorProps) {
  const kind = state === null ? null : state.mode === 'create' ? state.kind : (state.rule.kind as StackKind)
  const stackName = kind !== null && kind in STACK_META ? STACK_META[kind].name : '规则'
  const title =
    state === null ? '规则编辑器' : `${state.mode === 'create' ? '新建' : '编辑'}${stackName}`

  return (
    <Drawer open={state !== null} onClose={onClose} title={title} className={styles.panel}>
      {state !== null && (
        <EditorBody
          key={state.mode === 'edit' ? `edit-${state.rule.id}` : `create-${state.kind}`}
          state={state}
          allRules={allRules}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Drawer>
  )
}

/* ── 草稿 ───────────────────────────────────────────────────────── */

interface Draft {
  /** 正常情况下等于打开编辑器时那一栈；只有「kind 认不出的规则」才改得动它。 */
  kind: string
  priority: number
  join: 'and' | 'or'
  conds: RuleCondition[]
  subjectValue: string
  assetTypes: string[]
  effect: string
  note: string
}

function defaultEffect(kind: string): string {
  if (kind === 'fetch') return 'all'
  if (kind === 'allow') return 'allow'
  return 'meetings/{年}/{月}/{会议号}-{标题}/'
}

/**
 * 新建时的默认资产类型。
 *
 * `fetch` 默认 `['*']`（全部八类）：把会议的产出全部收进自己的 NAS，
 * 与"数据出企业边界"无关，默认全收是对的。
 *
 * `allow` 默认 **空**：那一栈是数据出境闸门，默认给全部八类等于替管理员做了
 * 一次最宽的授权。空的后果是安全的（后端会报"一类都取不到"，界面也说了），
 * 管理员必须自己勾。
 */
function defaultAssets(kind: string): string[] {
  return kind === 'fetch' ? [ASSET_ALL] : []
}

function draftFromRule(rule: Rule): Draft {
  return {
    kind: rule.kind,
    priority: rule.priority,
    join: rule.join === 'or' ? 'or' : 'and',
    // 写坏的条件项（null）带不进表单——它不是 { f, op, v }，没有可编辑的形状。
    // 丢掉这件事必须说出来，见下面的 droppedConds
    conds: rule.conds.filter((c): c is RuleCondition => c !== null).map((c) => ({ ...c })),
    subjectValue: rule.subjectValue ?? '',
    assetTypes: [...rule.assetTypes],
    effect: rule.effect,
    note: rule.note ?? '',
  }
}

function blankDraft(kind: StackKind, allRules: Rule[]): Draft {
  const top = allRules
    .filter((r) => r.kind === kind && Number.isFinite(r.priority))
    .reduce((max, r) => Math.max(max, r.priority), 0)
  return {
    kind,
    priority: top + 100,
    join: 'and',
    // 空 conds 会被写侧拒绝（"空条件在求值器里是「匹配一切」"），所以开局给一条
    conds: [{ f: 'title', op: 'has', v: '' }],
    subjectValue: '',
    assetTypes: defaultAssets(kind),
    effect: defaultEffect(kind),
    note: '',
  }
}

/* ── 表单主体 ───────────────────────────────────────────────────── */

interface BodyProps {
  state: EditorState
  allRules: Rule[]
  onClose: () => void
  onSaved: (text: string) => void
}

function EditorBody({ state, allRules, onClose, onSaved }: BodyProps) {
  const editingId = state.mode === 'edit' ? state.rule.id : null
  const [draft, setDraft] = useState<Draft>(() =>
    state.mode === 'edit' ? draftFromRule(state.rule) : blankDraft(state.kind, allRules),
  )
  const kind = draft.kind
  /**
   * 打开时 kind 就认不出（库里的一条坏行）。**只有这时才让人改 kind**：
   * 编辑器的整张表单是按栈组织的（effect 取值域、主体规矩、资产类型三栈全不同），
   * 平时开这个口子等于把换栈伪装成改一个字段。
   *
   * 但认不出的时候不开这个口子就是死路：那条规则不参与任何判定，
   * 而唯一的修法恰恰是改 kind——编辑器打得开却修不了，比打不开更糟。
   */
  const initialKindUnknown = !(
    (state.mode === 'create' ? state.kind : state.rule.kind) in STACK_META
  )
  const [issues, setIssues] = useState<string[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)

  const droppedConds =
    state.mode === 'edit' ? state.rule.conds.filter((c) => c === null).length : 0

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
  }, [])

  const positive = isPositiveEffect(kind, draft.effect)
  const stackName = isStackKind(kind) ? STACK_META[kind].name : `kind「${kind}」的规则`

  /* ── 影响预览 ─────────────────────────────────────────────── */

  const candidate = useMemo<CandidateRule>(() => {
    const c: CandidateRule = {
      // 认不出的 kind 也原样发出去：预览要显示的是「管理员真填了什么会发生什么」
      kind: kind as StackKind,
      priority: draft.priority,
      join: draft.join,
      conds: draft.conds,
      subjectType: kind === 'allow' ? 'program' : null,
      subjectValue: kind === 'allow' ? (draft.subjectValue === '' ? null : draft.subjectValue) : null,
      assetTypes: draft.assetTypes,
      effect: draft.effect,
      note: draft.note === '' ? null : draft.note,
      enabled: state.mode === 'edit' ? state.rule.enabled : true,
    }
    if (editingId !== null) c.id = editingId
    return c
  }, [kind, draft, editingId, state])

  // kind 认不出时不带 kind 参数：后端会 400 unknown_stack_kind，
  // 而那条 400 说的是「你问错了」，不是「这条规则有问题」
  const preview = usePreview(candidate, isStackKind(kind) ? kind : null)

  /* ── 写 ───────────────────────────────────────────────────── */

  function toInput(): RuleInput {
    return {
      // 认不出的 kind 照发。后端的校验会拒绝并说清原因，前端不替它猜一个
      kind: kind as StackKind,
      priority: draft.priority,
      join: draft.join,
      conds: draft.conds,
      subjectType: kind === 'allow' ? 'program' : null,
      subjectValue: kind === 'allow' ? (draft.subjectValue === '' ? null : draft.subjectValue) : null,
      assetTypes: draft.assetTypes,
      effect: draft.effect,
      note: draft.note === '' ? null : draft.note,
    }
  }

  async function save() {
    setSaving(true)
    setIssues([])
    setSaveError(null)
    try {
      if (editingId === null) {
        const created = await createRule(toInput())
        onSaved(`新建了${stackName} #${created.id}`)
      } else {
        await patchRule(editingId, toInput())
        onSaved(`保存了${stackName} #${editingId}`)
      }
    } catch (e) {
      applyWriteError(e, setIssues, setSaveError)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (editingId === null) return
    setSaving(true)
    setSaveError(null)
    try {
      await deleteRule(editingId)
      onSaved(`删除了${stackName} #${editingId}`)
    } catch (e) {
      applyWriteError(e, setIssues, setSaveError)
    } finally {
      setSaving(false)
    }
  }

  /* ── 渲染 ─────────────────────────────────────────────────── */

  return (
    <div className={styles.body}>
      <p className={styles.lede}>
        规则的难点从来不是「怎么填」，是<b>填完之后有多少场会议的状态会变</b>。
        下面的影响预览钉在底部，边填边看。
      </p>

      {droppedConds > 0 && (
        <p className={styles.warnBox} role="alert">
          这条规则里有 {droppedConds} 个条件不是 <code>{'{ f, op, v }'}</code> 形式的对象，
          表单装不下它们。<b>现在保存会把它们删掉。</b>
        </p>
      )}

      {initialKindUnknown && (
        <section className={styles.section} aria-label="规则类型">
          <h3 className={styles.sectionTitle}>规则类型</h3>
          <p className={styles.warnBox} role="alert">
            这条规则的 <code>kind</code>（<b>{state.mode === 'edit' ? state.rule.kind : ''}</b>）
            不是三栈之一，引擎不会让它参与任何判定。选一栈把它修回来——
            换栈会同时把动作重置成那一栈的默认值，因为三栈的 effect 取值域完全不同。
          </p>
          <select
            className={styles.select}
            aria-label="规则类型"
            value={isStackKind(kind) ? kind : ''}
            onChange={(e) => {
              const next = e.target.value
              if (!isStackKind(next)) return
              update({ kind: next, effect: defaultEffect(next), assetTypes: defaultAssets(next) })
            }}
          >
            <option value="">请选择</option>
            {(Object.keys(STACK_META) as StackKind[]).map((k) => (
              <option key={k} value={k}>
                {STACK_META[k].name}
              </option>
            ))}
          </select>
        </section>
      )}

      <section className={styles.section} aria-label="条件">
        <h3 className={styles.sectionTitle}>条件</h3>
        <ConditionList draft={draft} update={update} />
        <p className={styles.hint}>
          一条规则内只能全用「且」或全用「或」——这是刻意限制。混用而没有括号，
          读起来通顺，求值顺序却常常和人的直觉不一样；需要混用就拆成两条规则。
        </p>
        <p className={styles.hint}>
          「主持人部门」当前不可选：{CONDITION_FIELDS.dept?.unavailableReason}
        </p>
      </section>

      <section className={styles.section} aria-label="动作">
        <h3 className={styles.sectionTitle}>动作</h3>
        {isStackKind(kind) ? (
          <EffectPicker kind={kind} draft={draft} update={update} />
        ) : (
          <p className={styles.hint}>先在上面选一栈，动作的可选项随栈而定。</p>
        )}
        {positive && isStackKind(kind) && kind !== 'archive' && (
          <AssetPicker kind={kind} draft={draft} update={update} />
        )}
      </section>

      {kind === 'allow' && (
        <section className={styles.section} aria-label="采集程序">
          <h3 className={styles.sectionTitle}>采集程序</h3>
          <ProgramPicker value={draft.subjectValue} onChange={(v) => update({ subjectValue: v })} />
          <p className={styles.hint}>
            采集权限规则的主体是<b>采集程序</b>，不是人。拉取与归档两栈是系统级行为，
            不针对任何主体。
          </p>
        </section>
      )}

      <section className={styles.section} aria-label="说明与优先级">
        <h3 className={styles.sectionTitle}>说明与优先级</h3>
        <label className={styles.field}>
          <span>说明</span>
          <Input
            value={draft.note}
            onChange={(e) => update({ note: e.target.value })}
            placeholder="这条规则是干什么的"
          />
        </label>
        <p className={styles.hint}>
          说明会出现在规则列表<b>和每场会议的判定理由里</b>——事后复盘"那天为什么放行"
          读的就是这句话。
        </p>
        <label className={styles.field}>
          <span>优先级</span>
          <Input
            type="number"
            value={String(draft.priority)}
            onChange={(e) => update({ priority: Number(e.target.value) })}
          />
        </label>
        <p className={styles.hint}>
          数字大的先求值。同优先级按建立先后（id 升序），<b>不按 effect 决定平局</b>。
        </p>
      </section>

      {issues.length > 0 && (
        <div className={styles.issueBox} role="alert">
          <p className={styles.issueTitle}>后端拒绝了这次写入，一行都没落库：</p>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {saveError !== null && (
        <p className={styles.warnBox} role="alert">
          {saveError}
        </p>
      )}

      <div className={styles.actions}>
        <Button variant="primary" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button variant="quiet" onClick={onClose} disabled={saving}>
          取消
        </Button>
        {editingId !== null && (
          // 删除默认是安静的，点第一次才变红（spec §4.7）
          <Button
            variant={deleteArmed ? 'danger' : 'quiet'}
            className={styles.deleteBtn}
            disabled={saving}
            onClick={() => (deleteArmed ? void remove() : setDeleteArmed(true))}
          >
            {deleteArmed ? '确认删除，不可撤销' : '删除这条规则'}
          </Button>
        )}
      </div>

      <ImpactPreview kind={kind} result={preview.result} error={preview.error} pending={preview.pending} />
    </div>
  )
}

/** 400 `rule_invalid` 的逐条原因单独渲染；别的错误当一句话显示。 */
function applyWriteError(
  e: unknown,
  setIssues: (v: string[]) => void,
  setError: (v: string | null) => void,
): void {
  if (e instanceof ApiError && e.status === 400) {
    const body = e.body
    if (body !== null && typeof body === 'object' && Array.isArray((body as { issues?: unknown }).issues)) {
      const list = (body as { issues: unknown[] }).issues.filter((x): x is string => typeof x === 'string')
      if (list.length > 0) {
        setIssues(list)
        return
      }
    }
  }
  setError(e instanceof Error ? e.message : String(e))
}

function isStackKind(v: string): v is StackKind {
  return v === 'fetch' || v === 'archive' || v === 'allow'
}

function isPositiveEffect(kind: string, effect: string): boolean {
  if (kind === 'fetch') return effect === 'all'
  if (kind === 'allow') return effect === 'allow'
  return effect !== 'skip'
}

/* ── 影响预览的取数 ─────────────────────────────────────────────── */

interface PreviewHook {
  result: PreviewResult | null
  error: Error | null
  pending: boolean
}

/**
 * 草稿变了就重算一次影响预览，350ms 防抖。
 *
 * 防抖不是省流量：每敲一个字符就发一次，回来的顺序不保证，屏幕上的三个数会
 * 在几个中间状态之间跳——那比慢一点更让人不敢相信它。
 *
 * 过期响应显式丢弃（每次 effect 自己的 `cancelled`），理由与 `useResource`
 * 里那段注释一样：共享 ref 防不住同一次 flush 里的新旧交替。
 */
function usePreview(candidate: CandidateRule, kind: StackKind | null): PreviewHook {
  const [result, setResult] = useState<PreviewResult | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [pending, setPending] = useState(true)
  const fingerprint = JSON.stringify(candidate)
  const latest = useRef(candidate)
  latest.current = candidate

  useEffect(() => {
    let cancelled = false
    setPending(true)
    const timer = window.setTimeout(() => {
      previewRules(kind === null ? { rule: latest.current } : { rule: latest.current, kind })
        .then((r) => {
          if (cancelled) return
          setResult(r)
          setError(null)
          setPending(false)
        })
        .catch((e: unknown) => {
          if (cancelled) return
          setError(e instanceof Error ? e : new Error(String(e)))
          setPending(false)
        })
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [fingerprint, kind])

  return { result, error, pending }
}

/* ── 条件构建器 ─────────────────────────────────────────────────── */

interface PartProps {
  draft: Draft
  update: (patch: Partial<Draft>) => void
}

function ConditionList({ draft, update }: PartProps) {
  function setCond(i: number, next: RuleCondition) {
    update({ conds: draft.conds.map((c, j) => (j === i ? next : c)) })
  }

  return (
    <>
      <ul className={styles.conds}>
        {draft.conds.map((cond, i) => (
          <li key={i} className={styles.cond}>
            <div className={styles.condJoin}>
              {i === 0 ? (
                <span className={styles.when}>当</span>
              ) : (
                <button
                  type="button"
                  className={styles.joinBtn}
                  aria-label={`连接词：${draft.join === 'or' ? '或' : '且'}，点一下切换（一条规则内只能全用一种）`}
                  onClick={() => update({ join: draft.join === 'or' ? 'and' : 'or' })}
                >
                  {draft.join === 'or' ? '或' : '且'}
                </button>
              )}
            </div>

            <ConditionFields cond={cond} onChange={(next) => setCond(i, next)} />

            <button
              type="button"
              className={styles.condDel}
              aria-label={`删除第 ${i + 1} 个条件`}
              // 一条都不剩会被写侧拒绝（空 conds = 匹配一切），所以最后一条删不掉
              disabled={draft.conds.length === 1}
              title={draft.conds.length === 1 ? '至少要有一个条件：空条件在求值器里是「匹配一切」' : undefined}
              onClick={() => update({ conds: draft.conds.filter((_, j) => j !== i) })}
            >
              <span aria-hidden="true">×</span>
            </button>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="quiet"
        onClick={() => update({ conds: [...draft.conds, { f: 'title', op: 'has', v: '' }] })}
      >
        添加条件
      </Button>
    </>
  )
}

function ConditionFields({
  cond,
  onChange,
}: {
  cond: RuleCondition
  onChange: (next: RuleCondition) => void
}) {
  const spec = fieldSpec(cond.f)
  const ops = spec?.ops ?? [cond.op]

  function changeField(f: string) {
    const next = fieldSpec(f)
    // 换字段就换一套运算符与值形态。留着旧的 op 会造出一条 unknown_op 的死规则
    onChange({ f, op: next?.ops[0] ?? '', v: defaultValueFor(next?.value ?? 'string') })
  }

  return (
    <div className={styles.condFields}>
      <select
        className={styles.select}
        aria-label="条件字段"
        value={cond.f}
        onChange={(e) => changeField(e.target.value)}
      >
        {/* 库里的老规则可能用了一个不在清单里的字段。选项里没有它，
            select 会显示成空——所以显式补一个，标明它不认识 */}
        {spec === null && <option value={cond.f}>未知字段「{cond.f}」</option>}
        {Object.entries(CONDITION_FIELDS).map(([key, s]) => (
          <option key={key} value={key} disabled={!s.available}>
            {s.label}
          </option>
        ))}
      </select>

      <select
        className={styles.select}
        aria-label="条件运算符"
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value })}
      >
        {!ops.includes(cond.op) && <option value={cond.op}>不支持的运算符「{cond.op}」</option>}
        {ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABEL[op] ?? op}
          </option>
        ))}
      </select>

      <ConditionValue spec={spec} cond={cond} onChange={onChange} />
    </div>
  )
}

function defaultValueFor(kind: string): unknown {
  if (kind === 'none') return undefined
  if (kind === 'number') return 0
  if (kind === 'strings') return []
  return ''
}

function ConditionValue({
  spec,
  cond,
  onChange,
}: {
  spec: ReturnType<typeof fieldSpec>
  cond: RuleCondition
  onChange: (next: RuleCondition) => void
}) {
  if (spec === null) {
    return (
      <span className={styles.rawValue}>
        值：<code>{JSON.stringify(cond.v)}</code>
      </span>
    )
  }
  if (spec.value === 'none') return null
  if (spec.value === 'strings') {
    // dept 是唯一用这个形态的字段，而它当前不可选。真选到了（库里的老规则）
    // 也只读——没有数据源，改了也不会命中
    return (
      <span className={styles.rawValue}>
        {Array.isArray(cond.v) ? cond.v.map(String).join('、') : String(cond.v)}
        <em>（这个字段当前没有数据源，改了也不会命中）</em>
      </span>
    )
  }
  if (spec.value === 'number') {
    return (
      <span className={styles.numberValue}>
        <Input
          type="number"
          aria-label="条件值"
          value={typeof cond.v === 'number' ? String(cond.v) : ''}
          onChange={(e) => onChange({ ...cond, v: Number(e.target.value) })}
        />
        <span className={styles.unit}>{spec.unit}</span>
      </span>
    )
  }
  return (
    <Input
      aria-label="条件值"
      placeholder={spec.placeholder}
      value={typeof cond.v === 'string' ? cond.v : ''}
      onChange={(e) => onChange({ ...cond, v: e.target.value })}
    />
  )
}

/* ── 动作 ───────────────────────────────────────────────────────── */

const EFFECT_OPTIONS: Record<string, ReadonlyArray<{ value: string; label: string; sub: string }>> = {
  fetch: [
    { value: 'all', label: '拉取', sub: '把这场会议的资产拉回本系统。具体拉哪几类由下面的资产类型决定' },
    { value: 'skip', label: '不拉取', sub: '本系统不持有副本。腾讯会议侧的保留期一到，这场会议就没有了' },
  ],
  allow: [
    { value: 'allow', label: '准许采集', sub: '仍需在会议列表里授权给具体程序才真的能取走。两者是「与」的关系' },
    { value: 'deny', label: '禁止采集', sub: '照常拉取、照常归档进 NAS，但任何外部程序都取不到' },
  ],
}

function EffectPicker({ kind, draft, update }: PartProps & { kind: StackKind }) {
  if (kind === 'archive') {
    return (
      <>
        <label className={styles.field}>
          <span>目标目录</span>
          <Input value={draft.effect} onChange={(e) => update({ effect: e.target.value })} />
        </label>
        <p className={styles.hint}>
          填 <code>skip</code> 表示不归档。改目录<b>不会</b>搬迁已经归档过的文件——
          历史文件留在原路径，只有之后新归档的会写到新目录。
        </p>
      </>
    )
  }
  const options = EFFECT_OPTIONS[kind] ?? []
  return (
    <fieldset className={styles.effects}>
      <legend className={styles.srOnly}>动作</legend>
      {options.map((o) => (
        <label key={o.value} className={styles.effectOpt} data-on={draft.effect === o.value}>
          <input
            type="radio"
            name="rule-effect"
            value={o.value}
            checked={draft.effect === o.value}
            onChange={() => update({ effect: o.value })}
          />
          <span>
            <b>{o.label}</b>
            <small>{o.sub}</small>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function AssetPicker({ kind, draft, update }: PartProps & { kind: StackKind }) {
  const all = draft.assetTypes.includes(ASSET_ALL)
  function toggle(key: string) {
    const has = draft.assetTypes.includes(key)
    update({
      assetTypes: has ? draft.assetTypes.filter((k) => k !== key) : [...draft.assetTypes, key],
    })
  }

  return (
    <div className={styles.assets}>
      <p className={styles.sectionSub}>资产类型</p>
      <label className={styles.assetOpt}>
        <input
          type="checkbox"
          checked={all}
          onChange={() => update({ assetTypes: all ? [] : [ASSET_ALL] })}
        />
        <span>
          全部八类<small>*</small>
        </span>
      </label>
      {!all &&
        ASSET_KEYS.map((a) => (
          <label key={a.key} className={styles.assetOpt}>
            <input
              type="checkbox"
              checked={draft.assetTypes.includes(a.key)}
              onChange={() => toggle(a.key)}
            />
            <span>
              {a.label}
              <small>{a.key}</small>
            </span>
          </label>
        ))}
      {draft.assetTypes.length === 0 && (
        <p className={styles.warnLine}>
          一类都没勾。这条规则{kind === 'allow' ? '准许采集，但实际上一类都取不到' : '要拉取，但实际上一类都不会拉'}。
        </p>
      )}
    </div>
  )
}

/* ── 采集程序 ───────────────────────────────────────────────────── */

function ProgramPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [programs, setPrograms] = useState<ServiceProgram[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    listPrograms()
      .then((list) => {
        if (!cancelled) setPrograms(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  if (error !== null) {
    return (
      <div role="alert" className={styles.warnBox}>
        <p>采集程序列表读取失败：{error}</p>
        {/* 读不到列表不等于不能配规则——subject_value 就是 service_accounts.id，
            手填一样有效。但要说清这是在手填，别让人以为已经校验过 */}
        <label className={styles.field}>
          <span>采集程序 id（手填，不校验）</span>
          <Input value={value} onChange={(e) => onChange(e.target.value)} />
        </label>
        <Button size="sm" onClick={() => setNonce((n) => n + 1)}>
          重试
        </Button>
      </div>
    )
  }

  return (
    <select
      className={styles.select}
      aria-label="采集程序"
      value={value}
      disabled={programs === null}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{programs === null ? '载入中…' : '请选择采集程序'}</option>
      {(programs ?? []).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}（{p.id}）{p.enabled ? '' : ' · 已停用'}
        </option>
      ))}
    </select>
  )
}
