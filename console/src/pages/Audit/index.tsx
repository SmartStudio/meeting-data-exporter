import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { listAudit, type AuditPage } from '@/api/admin/audit'
import { fmtDateTime } from '@/lib/format'
import { useResource } from '@/lib/useResource'
import { Button } from '@/ui/Button'
import { Chip } from '@/ui/Chip'
import { Input } from '@/ui/Input'
import { PageShell } from '@/ui/PageShell'
import { Pill } from '@/ui/Pill'
import { Popover } from '@/ui/Popover'
import { AuditTable } from './AuditTable'
import {
  AUDIT_DEFAULT_UI,
  AUDIT_RANGES,
  emptyKind,
  hasFieldFilters,
  toQuery,
  type AuditUiFilter,
} from './filters'
import styles from './Audit.module.css'

/**
 * 操作审计页（spec.md §4.10）。
 *
 * 一行一次访问，人和程序混在同一条流里。这一页的用处是**出事之后回头查**，
 * 所以筛选比表格本身更重要——而筛选**必须发生在后端**：一次请求只带回一页，
 * 在这一页上再筛一次，得到的是"这 50 条里符合的"，页脚却写着"共 N 条"。
 * 翻到第二页就对不上，而且用户看不出来。
 *
 * ## 版式：一条工具条 + 一行状态 + 一张一行一条的表
 *
 * 常用的筛选（身份、只看被拒绝、时间范围）全在一条工具条上，一眼看完；
 * 少用的精确筛选（操作者 ID、动作代码）收进「精确筛选」面板，应用之后以
 * 可移除的标签回显在工具条上——两个空输入框常驻在页面上，看起来像搜索框，
 * 打半个名字查不到会被读成"这个程序没取过东西"。
 *
 * 更顺手的入口在表格里：展开任何一条记录，都能「只看这个操作者 / 只看这个
 * 动作」——不用抄 ID，也不用知道动作代码怎么拼。
 *
 * ## 时间锚点冻在一次查询里
 *
 * 「近 7 天」要换算成一个具体的 `from`（unix 秒）。如果每次渲染现取
 * `Date.now()`，翻页时下界会跟着往前挪：第 2 页的窗口比第 1 页晚几秒，
 * 夹在中间的记录**从两页之间漏掉**，而屏幕上完全看不出来。
 * 所以锚点存在 state 里，只有「刷新」和切换时间范围时才重新取。
 *
 * ## 原型上有、这里没有的两个控件
 *
 * - **模糊搜索框**（「搜操作者 / 动作 / 会议号」）：后端没有这个参数。
 *   在前端补一个内存版就是上面那个"翻页即失效"的坑，所以删掉，记进任务报告。
 * - **导出表格**：后端没有导出端点。留一个点了弹"还没做"的按钮，比没有更差
 *   （与计划 G-g 删掉「新建定时任务」是同一条道理）。
 */
export default function AuditPage() {
  const [ui, setUi] = useState<AuditUiFilter>(AUDIT_DEFAULT_UI)
  // 输入框先落在草稿里，按「应用」才变成筛选条件——每敲一个字发一次请求，
  // 打完一个程序名就是十几次全表查询。
  const [draftActorId, setDraftActorId] = useState('')
  const [draftAction, setDraftAction] = useState('')
  const [exactOpen, setExactOpen] = useState(false)
  const [anchorSec, setAnchorSec] = useState(() => Math.floor(Date.now() / 1000))
  const actorInputRef = useRef<HTMLInputElement>(null)
  const ids = useId()

  const query = useMemo(() => toQuery(ui, anchorSec), [ui, anchorSec])
  // `useResource` 的依赖要是原始值，把参数序列化成一个键。
  const key = JSON.stringify(query)
  const res = useResource<AuditPage>(() => listAudit(query), [key])

  /**
   * 上一次成功读到的那一页。
   *
   * 重新查询期间**继续显示它**（并在旁边挂一句"正在读取…"），而不是整张表
   * 清空：清空的话每点一个筛选片，表格就整块消失再长回来，页面高度跟着跳，
   * 而管理员正想对照着看"改了这个条件之后少了哪几条"。
   *
   * 渲染期派生，不用 effect 镜像——effect 要等这一帧提交完才跑，那一帧里
   * 新数据已经到了、镜像还是旧的，会先画错一帧。
   */
  const serverPage = res.state === 'ready' ? res.data : null
  const [shown, setShown] = useState<AuditPage | null>(null)
  if (serverPage !== null && serverPage !== shown) setShown(serverPage)

  const loading = res.state === 'loading'
  const error = res.state === 'error' ? res.error : null
  const now = useMemo(() => new Date(anchorSec * 1000), [anchorSec])

  const patch = useCallback((next: Partial<AuditUiFilter>) => {
    // 任何筛选条件一变就回第一页：留在第 5 页的话，换条件之后大概率落在
    // 一个空的 offset 上，界面显示"没有记录"，而真相是"这一页之外有"。
    setUi((prev) => ({ ...prev, page: 1, ...next }))
  }, [])

  const toggleKind = (kind: (typeof AUDIT_DEFAULT_UI.actorKinds)[number]) => {
    const has = ui.actorKinds.includes(kind)
    patch({ actorKinds: has ? ui.actorKinds.filter((k) => k !== kind) : [...ui.actorKinds, kind] })
  }

  const setRange = (rangeId: AuditUiFilter['rangeId']) => {
    // 换范围时重新取锚点：上一次锚点可能是十分钟前打开页面时的，
    // 「近 24 小时」用它算出来的窗口会少掉最近十分钟。
    setAnchorSec(Math.floor(Date.now() / 1000))
    patch({ rangeId })
  }

  const clearFilters = () => {
    setDraftActorId('')
    setDraftAction('')
    setUi(AUDIT_DEFAULT_UI)
  }

  const applyExact = () => {
    patch({ actorId: draftActorId.trim(), action: draftAction.trim() })
    setExactOpen(false)
  }

  const closeExact = () => {
    // 关掉面板时草稿退回已应用的值：打了一半没按「应用」的东西不该留着
    // 下次打开时冒出来，让人以为它已经在生效。
    setDraftActorId(ui.actorId)
    setDraftAction(ui.action)
    setExactOpen(false)
  }

  /** 表格里「只看这个操作者 / 只看这个动作」的入口——草稿与条件一起改。 */
  const filterActor = (id: string) => {
    setDraftActorId(id)
    patch({ actorId: id })
  }
  const filterAction = (action: string) => {
    setDraftAction(action)
    patch({ action })
  }

  const refresh = () => {
    setAnchorSec(Math.floor(Date.now() / 1000))
    res.retry()
  }

  const narrowed = hasFieldFilters(ui) || ui.rangeId !== AUDIT_DEFAULT_UI.rangeId
  const exactCount = (ui.actorId !== '' ? 1 : 0) + (ui.action !== '' ? 1 : 0)

  return (
    <PageShell
      title="操作审计"
      description="谁在什么时候对哪场会议做了什么，是准许还是拒绝，都在这里。"
      actions={
        <Button onClick={refresh} disabled={loading} title="结果的时间上界钉在打开本页的那一刻；新记录按这里才会出现">
          刷新
        </Button>
      }
    >
      <div className={styles.toolbar}>
        <div className={styles.group} role="group" aria-label="操作者身份">
          <Chip active={ui.actorKinds.includes('person')} onClick={() => toggleKind('person')}>
            人的操作
          </Chip>
          <Chip active={ui.actorKinds.includes('prog')} onClick={() => toggleKind('prog')}>
            程序取用
          </Chip>
          <Chip active={ui.actorKinds.includes('sys')} onClick={() => toggleKind('sys')}>
            系统自动
          </Chip>
        </div>

        <Chip active={ui.onlyDenied} onClick={() => patch({ onlyDenied: !ui.onlyDenied })}>
          只看被拒绝
        </Chip>

        <span className={styles.exactWrap}>
          <Button
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={exactOpen}
            onClick={() => (exactOpen ? closeExact() : setExactOpen(true))}
          >
            精确筛选{exactCount > 0 ? ` · ${exactCount}` : ''} ▾
          </Button>
          <Popover
            open={exactOpen}
            onClose={closeExact}
            label="精确筛选"
            placement="bottom-start"
            initialFocusRef={actorInputRef}
            className={styles.exactPanel}
          >
            <form
              className={styles.exactForm}
              onSubmit={(e) => {
                e.preventDefault()
                applyExact()
              }}
            >
              <div className={styles.exactField}>
                <label className={styles.exactLabel} htmlFor={`${ids}-actor`}>
                  操作者 ID
                </label>
                <Input
                  ref={actorInputRef}
                  id={`${ids}-actor`}
                  type="text"
                  value={draftActorId}
                  onChange={(e) => setDraftActorId(e.target.value)}
                  aria-describedby={`${ids}-actor-hint`}
                  autoComplete="off"
                />
                {/* 后端这两个参数都是**精确匹配**，不是 LIKE。说清楚，否则输入框
                    长得像搜索框，打半个名字查不到会被读成"这个程序没取过东西"。 */}
                <span className={styles.exactHint} id={`${ids}-actor-hint`}>
                  完整的账号名或程序 ID，精确匹配，不是模糊搜索。
                </span>
              </div>
              <div className={styles.exactField}>
                <label className={styles.exactLabel} htmlFor={`${ids}-action`}>
                  动作代码
                </label>
                <Input
                  id={`${ids}-action`}
                  type="text"
                  value={draftAction}
                  onChange={(e) => setDraftAction(e.target.value)}
                  aria-describedby={`${ids}-action-hint`}
                  autoComplete="off"
                />
                <span className={styles.exactHint} id={`${ids}-action-hint`}>
                  库里的原值，多个用逗号隔开。不记得代码？展开任一条记录，点「只看这个动作」。
                </span>
              </div>
              <div className={styles.exactActs}>
                <Button type="submit" variant="primary" size="sm">
                  应用
                </Button>
                <Button variant="quiet" size="sm" onClick={closeExact}>
                  取消
                </Button>
              </div>
            </form>
          </Popover>
        </span>

        {/* 已应用的精确条件回显成可移除的标签：面板收起之后，条件不能跟着
            从眼前消失——看不见的筛选条件会让"没有记录"被读成"没发生过"。 */}
        {ui.actorId !== '' && (
          <Pill
            tone="brand"
            onRemove={() => filterActor('')}
            removeLabel={`移除操作者筛选 ${ui.actorId}`}
          >
            操作者 <code className={styles.pillCode}>{ui.actorId}</code>
          </Pill>
        )}
        {ui.action !== '' && (
          <Pill tone="brand" onRemove={() => filterAction('')} removeLabel={`移除动作筛选 ${ui.action}`}>
            动作 <code className={styles.pillCode}>{ui.action}</code>
          </Pill>
        )}

        {narrowed && (
          <Button variant="quiet" size="sm" onClick={clearFilters}>
            清除筛选
          </Button>
        )}

        <span className={styles.spacer} />

        {/* 时间范围是分段单选，五档全摆在面上——它是这一页最常动的条件，
            藏进下拉里每次要点两下，而且看不到还有哪几档可选。 */}
        <div className={styles.ranges} role="radiogroup" aria-label="时间范围">
          {AUDIT_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={r.id === ui.rangeId}
              className={styles.range}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.status}>
        {/* 读失败时不显示时间窗口：那一行描述的是**上一次成功**的查询，
            而屏幕上摆着的是一个错误态——两者放在一起会被读成"这段时间没有记录"。 */}
        {shown !== null && error === null && <WindowLine page={shown} now={now} />}
        {loading && (
          <span className={styles.loading} role="status" data-testid="audit-loading">
            {/* 上一次的结果还留在屏幕上时必须说出来：筛选片已经是新的选择，
                表格还是旧的那一批，不说清楚就是让人按着新条件读旧结果。 */}
            {shown === null ? '正在读取…' : '正在按新条件重新查询，下面还是上一次的结果…'}
          </span>
        )}
      </div>

      {ui.actorKinds.length > 0 && (
        <p className={styles.note} data-testid="audit-unknown-caveat">
          按身份筛选时<b>不会显示「未知身份」的记录</b>——后端只认人 / 程序 / 系统三种。要看全部，请取消身份筛选。
        </p>
      )}

      {shown !== null && error === null && <UnlabeledNote page={shown} />}

      <AuditTable
        page={shown}
        now={now}
        loading={loading && shown === null}
        error={error}
        onRetry={refresh}
        empty={emptyKind(ui)}
        onClearFilters={clearFilters}
        onAllTime={() => setRange('all')}
        onFilterActor={filterActor}
        onFilterAction={filterAction}
        current={ui.page}
        pageSize={ui.pageSize}
        onPage={(p) => setUi((prev) => ({ ...prev, page: p }))}
        onPageSize={(size) => setUi((prev) => ({ ...prev, page: 1, pageSize: size }))}
      />
    </PageShell>
  )
}

/**
 * 「这一页有 N 种动作后端还没登记中文名」。
 *
 * ## 为什么这一句必须在，而不是前端补一份映射表
 *
 * 这一页存在的全部理由是给人读。一个动作没有中文名时，「动作」列里是一行
 * 英文 snake_case——而它读起来与一个真的叫这个名字的动作一模一样。
 * F5c 数出库里有 24 种动作而后端那张表只有 3 行，正是因为没有任何东西会
 * 就此喊一声。
 *
 * **前端不补兜底映射表**（哪怕只补一行）：补了之后界面上一切正常，而
 * 「后端漏登记」这件事被永久掩盖。A9 为防漏登记在后端加了类型收窄与源码
 * 扫描两道门，前端兜底等于把那两道门的价值抵消掉。所以这里做的相反的事——
 * 把后端说的那句话原样搬上屏。
 *
 * 每一项的 `hint` 今天是同一句常量，所以按内容去重后只显示一次；
 * 将来后端按动作给不同的话，这里自然会各显示一句。
 */
function UnlabeledNote({ page }: { page: AuditPage }) {
  const items = page.unlabeledActions
  if (items.length === 0) return null
  const hints = [...new Set(items.map((u) => u.hint))]

  return (
    <div className={styles.note} data-testid="audit-unlabeled-actions">
      <p>
        这一页有 <b>{items.length}</b> 种动作后端还没有登记中文名，「动作」列里显示的是{' '}
        <code>audit_log</code> 的原值：
        {items.map((u, i) => (
          <span key={u.action}>
            {i > 0 && '、'}
            <code>{u.action}</code>（{u.count} 次）
          </span>
        ))}
      </p>
      {/* 后端那句话原样上屏，前端不改写、不缩写 */}
      {hints.map((h) => (
        <p key={h}>{h}</p>
      ))}
    </div>
  )
}

/**
 * 本次结果真正用的时间窗口 + 总数。
 *
 * **回显的是后端算出来的那一段，不是界面上选的那一档。** 两者本该一致；
 * 不一致的时候（比如没传 from、后端兜了一个默认的 7 天窗口），说了实话的
 * 那一个才有用——看不见的默认窗口会让管理员把"它在窗口之外"读成"它没发生过"。
 *
 * 上界钉在锚点上是有代价的（新记录要刷新才出现），所以在这里说出来，
 * 不让人以为这一页是实时的；为什么钉见 filters.ts 的 toQuery。
 */
function WindowLine({ page, now }: { page: AuditPage; now: Date }) {
  const { window: w } = page
  // from=0 是「不限起点」。照直格式化会得到 1970 年，那是一个真实存在但毫无
  // 意义的日期，读起来像是数据坏了。
  const from = w.from <= 0 ? '不限起点' : fmtDateTime(w.from, now)
  const to = w.to === null ? '至今' : fmtDateTime(w.to, now)

  return (
    <p className={styles.window} data-testid="audit-window">
      <span className={styles.windowRange}>
        {from} — {to}
      </span>
      <span className={styles.windowSep} aria-hidden="true">
        ·
      </span>
      <span className={styles.windowRange}>共 {page.total} 条</span>
      {w.isDefault && w.text !== null ? (
        <b className={styles.windowWarn}>{w.text}</b>
      ) : (
        <span className={styles.windowNote}>新记录要按「刷新」才会出现</span>
      )}
    </p>
  )
}
