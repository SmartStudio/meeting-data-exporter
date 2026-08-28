import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { installProtoApi, resetProtoWorld, setProtoSystemState } from '../src/api/mock/install'
import { MEETINGS, MOCK_NOW } from '../src/api/mock/meetings'
import { buildRules, ruleHits } from '../src/api/mock/rules'
import { listMeetings, fetchTriage, getMeeting } from '../src/api/admin/meetings'
import { listPrograms } from '../src/api/admin/grants'

/**
 * 原型模式的假后端（`?proto=1`）。
 *
 * 它是**演示与截图工具**：`scripts/a11y-check.ts` 的十几个场景全都跑在
 * `/meetings` 上，那台静态服务器不挂后端，所以这一层必须答得出会议列表、
 * 分诊计数与采集程序，否则每个无障碍场景看到的都是同一屏"读不到会议列表"。
 *
 * 这里测的是它**答得对**——形状对得上契约、写操作真的改得动、没实现的端点
 * 回一个说得清楚的 501 而不是一个像空数据的 200。真页面的行为在
 * `tests/meetings.test.tsx` 里测，那边用的是自己的 stub，不经过这一层。
 */

let restore: () => void = () => undefined

beforeEach(() => {
  restore = installProtoApi()
  resetProtoWorld()
})

afterEach(() => {
  restore()
  vi.unstubAllGlobals()
})

describe('原型模式的假后端', () => {
  test('会议列表过得了真实域文件的运行时校验 —— 形状与契约一致', async () => {
    const page = await listMeetings({ limit: 50, offset: 0 })
    expect(page.rows.length).toBe(MEETINGS.length)
    expect(page.total).toBe(MEETINGS.length)
    // 契约比 F1 的 Meeting 多七个字段，少一个前端就崩
    const row = page.rows[0]!
    expect(row.meetingId).toBe(row.id)
    expect(row.missing).toEqual([])
    expect(row.unknownAssetTypes).toEqual([])
    expect(typeof row.keep.extendedSource).toBe('string')
    expect(typeof row.keep.extendedDays).toBe('number')
  })

  test('时间平移到今天 —— 演示不该在几天后变成一堆过期会议', async () => {
    const page = await listMeetings({})
    const withWindow = page.rows.filter((r) => r.keep.expiresAt !== null)
    expect(withWindow.length).toBeGreaterThan(0)
    const nowSec = Math.floor(Date.now() / 1000)
    // 种子里那批"保留期还在走"的会议，平移之后到期日必须仍在未来
    expect(Math.max(...withWindow.map((r) => r.keep.expiresAt!))).toBeGreaterThan(nowSec)
  })

  test('分诊五格是全量算的，不随分页变', async () => {
    const t = await fetchTriage()
    const first = await listMeetings({ limit: 1, offset: 0 })
    expect(first.rows).toHaveLength(1)
    const again = await fetchTriage()
    expect(again).toEqual(t)
    expect(t.archiveFailed + t.nasOnly).toBeGreaterThan(0)
  })

  test('服务端筛选真的筛：search / triage / 三态布尔', async () => {
    const all = await listMeetings({})
    const granted = await listMeetings({ hasGrant: true })
    expect(granted.rows.every((r) => r.grants.length > 0)).toBe(true)
    expect(granted.total).toBeLessThan(all.total)

    const failed = await listMeetings({ triage: 'archiveFailed' })
    expect(failed.rows.every((r) => r.archive === 'failed')).toBe(true)

    const hit = await listMeetings({ search: all.rows[0]!.code })
    expect(hit.total).toBe(1)
  })

  test('分页真的切页', async () => {
    const p1 = await listMeetings({ limit: 2, offset: 0 })
    const p2 = await listMeetings({ limit: 2, offset: 2 })
    expect(p1.rows).toHaveLength(2)
    expect(p1.rows[0]!.id).not.toBe(p2.rows[0]!.id)
    expect(p1.total).toBe(p2.total)
  })

  test('单场详情带操作历史；列表端点恒为空历史', async () => {
    const page = await listMeetings({})
    expect(page.rows.every((r) => r.history.length === 0)).toBe(true)
    const one = await getMeeting(page.rows[0]!.id)
    expect(one.history.length).toBeGreaterThan(0)
  })

  test('采集程序列表不下发任何凭据字段', async () => {
    const programs = await listPrograms()
    expect(programs.length).toBeGreaterThan(0)
    for (const p of programs) {
      expect(Object.keys(p)).not.toContain('secret')
    }
  })

  test('nas-down 的数据形态是 spec §7.2 的一部分：保留窗口清零、授权撤下', async () => {
    const before = await listMeetings({})
    const okFailed = before.rows.filter((r) => r.archive === 'failed').length

    setProtoSystemState('nas-down')
    const after = await listMeetings({})
    const broken = after.rows.filter((r) => r.archive === 'failed')
    expect(broken.length).toBeGreaterThan(okFailed)
    for (const m of broken) {
      expect(m.keep.archivedAt).toBeNull() // 没归档成功就不该开始计时
      expect(m.keep.expiresAt).toBeNull()
      expect(m.grants).toEqual([]) // 没归档成功的东西不该对外可见
    }
  })

  test('写操作真的改得动：授权、撤销、人工改写', async () => {
    const page = await listMeetings({ hasGrant: false })
    const target = page.rows[0]!
    const url = `/api/v1/admin/meetings/${encodeURIComponent(target.id)}`

    await fetch(`${url}/grants`, {
      method: 'POST',
      body: JSON.stringify({ programId: 'kb-indexer', assetTypes: null }),
    })
    expect((await getMeeting(target.id)).grants).toContain('kb-indexer')

    await fetch(`${url}/grants/kb-indexer`, { method: 'DELETE' })
    expect((await getMeeting(target.id)).grants).not.toContain('kb-indexer')

    await fetch(`${url}/override`, {
      method: 'PUT',
      body: JSON.stringify({ kind: 'fetch', effect: 'skip', assetTypes: null, reason: '演示' }),
    })
    const after = await getMeeting(target.id)
    expect(after.fetch).toBe('off')
    expect(after.hand).toContain('fetch')
    // 改状态就要一起改理由——状态说"未执行"、理由还写着"已成功拉取"是这一页栽过的那类洞
    expect(after.why.fetch.by).toBe('hand')
    expect(after.why.fetch.text).toContain('演示')
  })

  test('人工改写缺理由时 400，与真后端一致', async () => {
    const page = await listMeetings({})
    const res = await fetch(
      `/api/v1/admin/meetings/${encodeURIComponent(page.rows[0]!.id)}/override`,
      { method: 'PUT', body: JSON.stringify({ kind: 'fetch', effect: 'skip', assetTypes: null }) },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_reason' })
  })

  test('没实现的端点回 501 并说清是原型模式少了一条，不是一个像空数据的 200', async () => {
    // F8 之后 `/rules` 已经答得上了（见 tests/mock-pages.test.ts），所以这里换一条
    // 控制台还没有消费者、这一层也就没实现的端点：签发下载直链。
    const res = await fetch('/api/v1/admin/meetings/m1/download-url', { method: 'POST' })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('proto_not_implemented')
    expect(body.detail).toContain('api/mock/install.ts')
  })

  /**
   * 假后端对「坏 conds」的判法，必须与真实后端逐字一致。
   *
   * 这一层原来把「conds 不是数组」和「conds 是空数组」都当成"无条件 → 命中全部"，
   * 于是 `?proto=1` 下那条种子坏规则（#320）显示「命中全部 9 场」、文案写着
   * "它会命中全部会议"；而 `src/policy/conds.ts` 的 `evaluateRule` 对非数组 conds
   * 判的是 `matched: false`，`describeRuleIssues` 报的是"这条规则不会命中任何会议"
   * ——**方向正好相反**，而且反在数据出境的那道闸门上。
   *
   * 它能反着写还活下来，是因为没有任何一条测试钉住这个口径。补上。
   * 这两条断言里的字符串来自 `src/policy/conds.ts:613` 与 `src/store/policy.ts:333`，
   * 后端改了这句话，这里就该红。
   */
  test('坏 conds 的判法与真实后端一致：非数组命中 0，空数组命中全部', () => {
    const all = MEETINGS.length
    expect(all).toBeGreaterThan(0)

    // conds 不是数组 → 规则读不出来 → 不参与匹配 → 0 场
    // （src/store/policy.ts 的 CONDS_UNPARSABLE：兜底值绝不能是 []，
    //   "那等于让一条坏掉的规则放行全部会议"）
    expect(ruleHits({ conds: { title: '复盘' } }, MEETINGS)).toHaveLength(0)
    expect(ruleHits({ conds: 'nope' }, MEETINGS)).toHaveLength(0)
    expect(ruleHits({ conds: null }, MEETINGS)).toHaveLength(0)

    // conds 是**合法的空数组** → "规则没有条件，匹配全部会议" → 全部
    // （src/policy/conds.ts 的 evaluateRule 对 length === 0 显式判 matched: true）
    expect(ruleHits({ conds: [] }, MEETINGS)).toHaveLength(all)
  })

  test('种子里那条坏规则的文案与后端 describeRuleIssues 说的是同一件事', () => {
    const broken = buildRules(MOCK_NOW).find((r) => r.id === 320)
    expect(broken).toBeDefined()
    // 后端两处原话（src/policy/conds.ts:613、src/store/policy.ts:333）都是这一句
    expect(broken!.issues.join(' ')).toContain('conds 不是数组，这条规则不会命中任何会议')
    // 反向断言：不许再出现原来那句相反的话
    expect(broken!.issues.join(' ')).not.toContain('会命中全部会议')
    expect(broken!.matchCount).toBe(0)
    expect(broken!.matchScanned).toBe(MEETINGS.length)

    // 归档兜底那条是**合法的空数组**，它才是真的命中全部——两者别再混为一谈
    const catchAll = buildRules(MOCK_NOW).find((r) => r.id === 210)
    expect(catchAll!.conds).toEqual([])
    expect(catchAll!.matchCount).toBe(MEETINGS.length)
  })

  /**
   * `GET /rules` 的命中数是**现算**的，不是装载那一刻的快照。
   *
   * 快照版本的后果：`PATCH /rules/:id` 改完条件回到列表页，数字还是改之前的；
   * 而规则编辑器的实时预览（`POST /rules/preview`）走的是真算——同一页上两个数
   * 对不上，正是这一页最不该出现的那种不一致。
   */
  test('改完规则条件，列表里的命中数跟着变；新建的规则也有数字', async () => {
    const read = async (id: number): Promise<{ matchCount?: number; matchScanned?: number }> => {
      const res = await fetch('/api/v1/admin/rules')
      const body = (await res.json()) as { rules: Array<{ id: number; matchCount?: number; matchScanned?: number }> }
      const row = body.rules.find((r) => r.id === id)
      expect(row).toBeDefined()
      return row!
    }

    // #310「标题含『大会』」，种子里只有一场全员大会
    expect((await read(310)).matchCount).toBe(1)

    // 把条件改成「标题含『复盘』」。期望值从种子里数出来，不写死——
    // 种子会议改了这条测试该跟着变，而不是留一个恰好对不上的常量
    const expected = MEETINGS.filter((m) => m.title.includes('复盘')).length
    expect(expected).toBeGreaterThan(1)
    const patched = await fetch('/api/v1/admin/rules/310', {
      method: 'PATCH',
      body: JSON.stringify({ conds: [{ f: 'title', op: 'has', v: '复盘' }], reason: '测试' }),
    })
    expect(patched.status).toBe(200)
    const after = await read(310)
    expect(after.matchCount).toBe(expected)
    expect(after.matchScanned).toBe(MEETINGS.length)

    // 新建的规则不再永远显示"—"
    const created = await fetch('/api/v1/admin/rules', {
      method: 'POST',
      body: JSON.stringify({ kind: 'allow', priority: 10, conds: [], effect: 'deny', reason: '测试' }),
    })
    const { rule } = (await created.json()) as { rule: { id: number } }
    // conds 是合法空数组 → 匹配全部（与 evaluateRule 一致）
    expect((await read(rule.id)).matchCount).toBe(MEETINGS.length)
  })

  test('不打向 admin 的请求原样交给底层 fetch，不被拦下', async () => {
    // 先把拦截器摘掉，换上一个 spy，再装回去——这样拦截器抓到的"真 fetch"是 spy
    restore()
    const spy = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', spy)
    restore = installProtoApi()

    await fetch('/healthz')
    expect(spy).toHaveBeenCalledTimes(1)

    // admin 的请求则一条都不许漏下去
    await fetch('/api/v1/admin/meetings/triage')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
