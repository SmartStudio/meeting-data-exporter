import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { Meeting, SystemState } from '../src/api/types'
import { CONSUMERS } from '../src/api/mock/consumers'
import { MEETINGS, MOCK_NOW } from '../src/api/mock/meetings'
import { applyNasDown } from '../src/api/mock/system'
import { SystemStateProvider } from '../src/app/SystemStatus'
import MeetingsPage from '../src/pages/Meetings'
import { MeetingTable } from '../src/pages/Meetings/MeetingTable'
import { emptyKind } from '../src/pages/Meetings/MeetingTable'
import {
  allowWhyKind,
  applyWrite,
  archiveWhyKind,
  grantCellKind,
  type MeetingWrite,
} from '../src/pages/Meetings/write'
import { TRIAGE_DEFS } from '../src/pages/Meetings/TriageBar'
import { isActivationTarget, isTypingTarget, resolveMeetingKey } from '../src/lib/keys'

/** mock 的"今天"。测试里任何时间基准都从它派生，手抄的话 mock 一改就静默错位。 */
const NOW = new Date(MOCK_NOW * 1000)

/**
 * 只挂会议记录页本体（不套 AppShell）——外壳的行为由 `shell.test.tsx` 负责，
 * 这里要测的是这一页自己的交互。`/preview/:id` 与 `/rules` 给了真实的目标路由，
 * 好断言"点标题真的跳走了"，而不只是"点了一下没报错"。
 */
function renderPage(initialState: SystemState = 'ok') {
  const router = createMemoryRouter(
    [
      { path: '/meetings', element: <MeetingsPage /> },
      { path: '/preview/:id', element: <h1>内容预览占位</h1> },
      { path: '/rules', element: <h1>自动规则占位</h1> },
      { path: '/jobs', element: <h1>定时任务占位</h1> },
    ],
    { initialEntries: ['/meetings'] },
  )
  return render(
    <SystemStateProvider initialState={initialState}>
      <RouterProvider router={router} />
    </SystemStateProvider>,
  )
}

/** 等第一批会议行落地。 */
async function ready() {
  await waitFor(() => expect(screen.getByTestId('row-m1')).toBeInTheDocument())
}

function css(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf-8')
}

/** 注释里允许出现裸数字（说明为什么收成了令牌），声明里不允许。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function rowIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('tbody tr[data-id]')).map(
    (tr) => tr.dataset.id ?? '',
  )
}

describe('会议记录页 · 分诊条', () => {
  test('分诊条五格都在，点某格即筛选', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // 五格顺序就是紧急程度：最紧急的是"到期会永久丢失"。
    const labels = ['归档失败', '7 天内到期', '待授权', '处理中', '仅存 NAS']
    const cards = within(screen.getByTestId('triage-bar')).getAllByRole('button')
    expect(cards).toHaveLength(5)
    labels.forEach((label, i) => expect(cards[i]).toHaveTextContent(label))

    // 计数来自真实 mock 数据，不是写死的
    expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('1')
    expect(rowIds()).toHaveLength(9)

    await user.click(screen.getByTestId('triage-archfail'))

    expect(screen.getByTestId('triage-archfail')).toHaveAttribute('aria-pressed', 'true')
    // 只剩归档失败的那一场（m3 客户沟通 · 华东区）
    expect(rowIds()).toEqual(['m3'])

    // 再点一次取消筛选
    await user.click(screen.getByTestId('triage-archfail'))
    expect(rowIds()).toHaveLength(9)
  })

  test('加载中时分诊条用骨架卡而不是隐藏——隐藏会让布局跳', async () => {
    renderPage('loading')

    const bar = await screen.findByTestId('triage-bar')
    // 关键断言：这一排**在**（占着位置），只是内容换成了骨架
    expect(bar).toBeInTheDocument()
    expect(bar).toHaveAttribute('data-loading', 'true')
    expect(bar.querySelectorAll('[data-skeleton="true"]')).toHaveLength(5)
    // 骨架期间不该冒出可点的筛选按钮（点了会筛一份还不存在的数据）
    expect(within(bar).queryAllByRole('button')).toHaveLength(0)

    // 表格也是骨架行，且分页器说明正在读取——不是一片空白
    expect(document.querySelectorAll('tbody tr[data-skeleton="true"]')).toHaveLength(6)
    expect(screen.getByTestId('meetings-loading')).toHaveTextContent('正在读取')

    // 工具条同样保留（禁用态），否则数据到了整页还是要往下跳一次
    expect(screen.getByRole('searchbox', { name: '搜索会议' })).toBeDisabled()
  })

  test('归档失败的行是红的，且分诊条第一格计数与之相符', async () => {
    renderPage()
    await ready()

    // 「红」在 jsdom 里读不出来（不解析 var()），所以断言两件能真实反映的事：
    // 1) 这一处声明的是 fail 语义档，2) CSS 把 fail 档接到了 --fail 上。

    // **先断言行**：这条测试的名字说的就是"行"。之前它只查了分诊格和
    // TriageBar 的 CSS——需求（表格里那一支的着色）压根没做，测试名字却写着
    // 做了，比没有测试更危险。
    const keep = screen.getByTestId('keep-m3')
    // 归档失败 ⇒ 保留期根本没开始计时，这句必须说出来，不能画一根空进度条
    expect(keep).toHaveTextContent('归档失败，未开始计时')
    expect(keep.querySelector('[data-fail="true"]')).not.toBeNull()
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    expect(rowCss).toMatch(/\.keepNone\[data-fail='true'\]\s*\{\s*color:\s*var\(--fail\)/)

    // 对照组：**没归档**和**归档失败**不能是同一个灰。m4 只是还没归档。
    const notArchived = screen.getByTestId('keep-m4')
    expect(notArchived).toHaveTextContent('未归档')
    expect(notArchived.querySelector('[data-fail="true"]')).toBeNull()

    // 分诊格与表格里真的处在归档失败状态的行数一致
    expect(screen.getByTestId('triage-archfail')).toHaveAttribute('data-tone', 'fail')
    const triageCss = css('src/pages/Meetings/TriageBar.module.css')
    expect(triageCss).toMatch(/\[data-tone='fail'\]\s*\.count\s*\{\s*color:\s*var\(--fail\)/)
    const failed = screen.getAllByRole('button', { name: /归档到 NAS：失败/ })
    expect(failed).toHaveLength(1)
    expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('1')
    expect(failed[0]!.closest('tr')).toHaveAttribute('data-id', 'm3')
  })
})

describe('会议记录页 · 三态与三种空态', () => {
  test('加载失败给出错误详情与重试，不是「暂无数据」', async () => {
    renderPage('load-failed')

    // 加载中 / 加载失败 / 两种空态各有各的 testid——它们的出口完全不同，
    // 共用一个 testid 只会让测试抓到另一个状态然后对着它断言。
    const box = await screen.findByTestId('meetings-error')
    expect(box).toHaveTextContent('读不到会议列表')
    expect(screen.queryByTestId('meetings-loading')).not.toBeInTheDocument()
    // 文件到底还在不在，是看到这一屏的人第一个想知道的事
    expect(box).toHaveTextContent('已经归档到 NAS 的文件不受影响')
    // 真实的错误详情，不是一句"出错了"
    expect(box).toHaveTextContent('503')
    expect(within(box).getByRole('button', { name: '重试' })).toBeInTheDocument()
    // 绝不能退化成空态文案
    expect(box).not.toHaveTextContent('暂无数据')
    expect(box).not.toHaveTextContent('还没有拉取过任何会议')

    // 读不到的时候分诊条必须整个收起来：它算的是 rows 的长度，rows 是空的，
    // 留着就会画出"0 归档失败"——而真相是"不知道有几场"。在一个
    // "归档失败＝一个月后永久丢失"的系统里，这两句话差得很远。
    expect(screen.queryByTestId('triage-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('triage-count-archfail')).not.toBeInTheDocument()
  })

  test('空态分三种，出口各不相同', async () => {
    const user = userEvent.setup()

    // ① 筛选筛没了 → 清除筛选
    const filtered = renderPage()
    await ready()
    await user.type(screen.getByRole('searchbox', { name: '搜索会议' }), '不存在的会议')
    const empty1 = await screen.findByTestId('meetings-empty')
    expect(empty1).toHaveAttribute('data-kind', 'filtered-out')
    expect(empty1).toHaveTextContent('没有符合条件的会议')
    const clear = within(empty1).getByRole('button', { name: '清除筛选' })
    await user.click(clear)
    expect(rowIds()).toHaveLength(9)
    filtered.unmount()

    // ② 系统里一场都没有 → 去看拉取规则
    const none = renderPage('empty')
    const empty2 = await screen.findByTestId('meetings-empty')
    expect(empty2).toHaveTextContent('还没有拉取过任何会议')
    expect(within(empty2).getByRole('button', { name: '去看拉取规则' })).toBeInTheDocument()
    expect(within(empty2).getByRole('button', { name: '去看定时任务' })).toBeInTheDocument()
    // 一场都没有的时候，搜索框和筛选片没有可筛的东西，收起来
    expect(screen.queryByRole('searchbox', { name: '搜索会议' })).not.toBeInTheDocument()
    none.unmount()

    // ③ 这段时间没有 → 换时间范围。
    //    F1 的 mock 里有当天的会议，任何"近 N 天"都筛不空，页面级触发不到这一支；
    //    所以直接把表格组件放到这个状态下渲染，断言它给的是**另一个**出口。
    const onClearRange = vi.fn()
    render(
      <MeetingTable
        rows={[]}
        consumers={[]}
        now={new Date()}
        selected={new Set()}
        cursorId={null}
        onSelect={() => {}}
        onSelectPage={() => {}}
        onSelectAllMatching={() => {}}
        onSelectPageOnly={() => {}}
        allMatchingSelected={false}
        selectedCount={0}
        totalMatching={0}
        page={1}
        pageSize={10}
        onPage={() => {}}
        onPageSize={() => {}}
        loading={false}
        error={null}
        onRetry={() => {}}
        empty="out-of-range"
        rangeDays={7}
        onClearFilters={() => {}}
        onClearRange={onClearRange}
        onGoRules={() => {}}
        onGoJobs={() => {}}
        onOpenTitle={() => {}}
        onOpenDetail={() => {}}
        onToggleStage={() => {}}
        onExtend={() => {}}
        onOpenGrant={() => {}}
        onRevoke={() => {}}
      />,
    )
    const empty3 = screen.getByTestId('meetings-empty')
    expect(empty3).toHaveTextContent('近 7 天内没有符合条件的会议记录')
    await user.click(within(empty3).getByRole('button', { name: '改为全部时间' }))
    expect(onClearRange).toHaveBeenCalled()
  })

  test('三种空态的成因判定：粗的那层先答，不然给出的出口解决不了问题', () => {
    // 系统里一场都没有的时候，给"清除筛选"是没用的
    expect(emptyKind({ totalAll: 0, totalMatchingIgnoringRange: 0, totalMatching: 0, rangeDays: 90 })).toBe('none-at-all')
    // 有数据、但都落在时间范围之外 → 出口是换范围，不是清筛选
    expect(emptyKind({ totalAll: 9, totalMatchingIgnoringRange: 9, totalMatching: 0, rangeDays: 7 })).toBe('out-of-range')
    // **去掉范围就找得到**，同样是范围的锅——哪怕范围内其实有别的会议。
    // 旧判据（"范围内一场都没有"）会把这一支算成"被筛选筛没了"，给出的
    // "清除筛选"点完范围没变，那一场还是找不到。
    expect(emptyKind({ totalAll: 9, totalMatchingIgnoringRange: 1, totalMatching: 0, rangeDays: 7 })).toBe('out-of-range')
    // 去掉范围也找不到，才是筛选把它筛没的
    expect(emptyKind({ totalAll: 9, totalMatchingIgnoringRange: 0, totalMatching: 0, rangeDays: 7 })).toBe('filtered-out')
    // "全部时间"下不存在"这段时间没有"
    expect(emptyKind({ totalAll: 9, totalMatchingIgnoringRange: 9, totalMatching: 0, rangeDays: 0 })).toBe('filtered-out')
    // 有结果就不是空态
    expect(emptyKind({ totalAll: 9, totalMatchingIgnoringRange: 9, totalMatching: 1, rangeDays: 90 })).toBeNull()
  })
})

describe('会议记录页 · 选择与批量', () => {
  test('勾表头只选本页；要选全部得再点一次，且明说总数', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // 把每页压到 5，让"本页"和"全部"真的不是一回事
    await user.selectOptions(screen.getByLabelText('每页条数'), '5')
    expect(rowIds()).toHaveLength(5)

    await user.click(screen.getByRole('checkbox', { name: '全选本页' }))

    // 关键：只选中了本页 5 场，不是全部 9 场
    expect(screen.getByTestId('batch-count')).toHaveTextContent('5')

    const hint = screen.getByTestId('select-all-hint')
    // 说的是**实际选中的场数**，不是"本页有几行"——跨页选过之后再收窄筛选，
    // 这两个数不一样，而底部批量条报的是前者。
    expect(hint).toHaveTextContent('已选中 5 场')
    // 逃生门必须明说总数——扩到全部是第二次、看得见数字的点击
    const expand = within(hint).getByRole('button', { name: '改为选择符合筛选的全部 9 场' })

    await user.click(expand)

    expect(screen.getByTestId('batch-count')).toHaveTextContent('9')
    expect(screen.getByTestId('select-all-hint')).toHaveTextContent('已选中符合当前筛选的全部 9 场')
    expect(screen.getByTestId('batch-bar')).toHaveTextContent('含未显示的页')

    // 还能收回来，只保留本页
    await user.click(screen.getByRole('button', { name: '只保留本页' }))
    expect(screen.getByTestId('batch-count')).toHaveTextContent('5')
  })

  test('本页就是全部时不出逃生门——没有"更多"可扩，那句提示只会制造疑虑', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('checkbox', { name: '全选本页' }))
    expect(screen.getByTestId('batch-count')).toHaveTextContent('9')
    expect(screen.queryByTestId('select-all-hint')).not.toBeInTheDocument()
  })

  test('批量条：选中才浮出，批量延长真的改到了保留期', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const bar = screen.getByTestId('batch-bar')
    expect(bar).toHaveAttribute('data-show', 'false')

    // m1 保留期剩 28 天
    expect(screen.getByTestId('keep-m1')).toHaveTextContent('剩 28 天')

    await user.click(screen.getByRole('checkbox', { name: '选择 产品周会' }))
    expect(bar).toHaveAttribute('data-show', 'true')
    expect(screen.getByTestId('batch-count')).toHaveTextContent('1')

    await user.click(within(bar).getByRole('button', { name: '延长 30 天' }))

    expect(screen.getByTestId('keep-m1')).toHaveTextContent('剩 58 天')
    // 执行完自动清空选择，避免同一批被重复执行
    expect(screen.getByTestId('batch-bar')).toHaveAttribute('data-show', 'false')
  })
})

describe('会议记录页 · 保留期与人工改写', () => {
  test('保留进度条 hover 出现「+30 天」', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const keep = screen.getByTestId('keep-m1')
    // 进度条的可读文本里带着"还剩几天"，读屏用户没有视觉宽度可看
    expect(within(keep).getByRole('progressbar')).toHaveAccessibleName(/还剩 28 天/)

    // 按钮始终在 DOM 里（键盘 `e` 和读屏都要够得到），靠 CSS 在 hover / 光标行时才浮出来。
    // jsdom 不做真实渲染也不跑 :hover，所以这里断言样式规则本身存在——
    // 真实的"平时看不见"留给 T7 的浏览器检查。
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    expect(rowCss).toMatch(/\.extendBtn\s*\{[^}]*opacity:\s*0/)
    expect(rowCss).toMatch(/tr:hover \.extendBtn[^{]*\{\s*opacity:\s*1/)

    const btn = within(keep).getByRole('button', { name: /延长 30 天/ })
    await user.click(btn)

    expect(screen.getByTestId('keep-m1')).toHaveTextContent('剩 58 天')
  })

  test('人工改写过的行有标记', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // m4 董事会闭门会：拉取被人工设为"永不拉取"
    expect(screen.getByRole('button', { name: '拉取：规则不执行 · 人工改写' })).toBeInTheDocument()
    // m1 还没被改写过
    const m1 = screen.getByTestId('row-m1')
    expect(within(m1).getByRole('button', { name: '拉取：已完成' })).toBeInTheDocument()

    // 点一下圆点即改写这个阶段——它是开关，不是纯展示
    await user.click(within(m1).getByRole('button', { name: '拉取：已完成' }))

    expect(within(screen.getByTestId('row-m1')).getByRole('button', { name: '拉取：未执行 · 人工改写' })).toBeInTheDocument()
    // 关掉拉取，后面的阶段跟着失效：授权撤下、保留期清零
    expect(screen.getByTestId('grant-m1')).toHaveTextContent('未归档')
    expect(screen.getByTestId('keep-m1')).toHaveTextContent('未归档')
  })

  test('归档圆点在拉取未完成时不可点——顺序关系是这一栏要传达的第二件事', async () => {
    renderPage()
    await ready()

    const m4 = screen.getByTestId('row-m4')
    expect(within(m4).getByRole('button', { name: /^归档到 NAS：/ })).toBeDisabled()
    const m1 = screen.getByTestId('row-m1')
    expect(within(m1).getByRole('button', { name: /^归档到 NAS：/ })).toBeEnabled()
  })
})

describe('会议记录页 · 授权栏的状态与理由必须自洽', () => {
  test('生命周期原因优先于权限原因——没有规则拒绝的会议不能画成「规则禁止采集」', () => {
    const byId = (id: string) => MEETINGS.find((m) => m.id === id)!

    // m6 招聘面试：确实有一条规则明确拒绝（why.allow.by === 'deny'）
    expect(byId('m6').why.allow.by).toBe('deny')
    expect(grantCellKind(byId('m6')).kind).toBe('denied')

    // m4 董事会闭门会：allow 是 'deny'，但理由是"未拉取"（wait）——
    // 没有任何规则拒绝过它，画成"规则禁止采集"是把状态和理由说拧了。
    expect(byId('m4').allow).toBe('deny')
    expect(byId('m4').why.allow.by).toBe('wait')
    expect(grantCellKind(byId('m4')).kind).toBe('wait')

    // m5 销售晨会：压根没有录制（na）
    expect(grantCellKind(byId('m5')).kind).toBe('na')

    // m8 财务复盘：本地已到期（expired），授权自动失效
    expect(grantCellKind(byId('m8')).kind).toBe('expired')

    // m2 技术评审：准许采集、已归档、还没给任何程序 → 可以授权
    expect(grantCellKind(byId('m2')).kind).toBe('grantable')
  })

  test('deny 是中性的，不是琥珀——一直响的警报等于没有警报', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // m6 招聘面试命中权限规则 #200，是真的被一条规则拒绝了（by === 'deny'）。
    // 但那是规则系统在正确地干活，而且是故意且永久的——琥珀留给"这需要你
    // 看一眼"（有人绕过了规则、保留期快到了）。一个配了隐私规则的组织会有
    // 一整列永久琥珀，真正该被看见的琥珀就淹死在里面。
    const cell = screen.getByTestId('grant-m6')
    expect(cell).toHaveTextContent('规则禁止采集')
    expect(cell.querySelector('[class*="warn"]')).toBeNull()

    // 详情抽屉里那条判定理由同样是中性的
    await user.click(within(screen.getByTestId('row-m6')).getByRole('button', { name: /详情/ }))
    const drawer = await screen.findByRole('dialog', { name: '招聘面试 · 后端 P7' })
    const why = drawer.querySelector('[data-by="deny"]')!
    expect(why).not.toBeNull()
    expect(why).toHaveAttribute('data-tone', 'neutral')

    // 对照组：人工改写**必须**是琥珀——有人绕过了规则系统，那才需要人看一眼。
    // 没有这一半，上面那半会在"所有理由都中性"时照样通过。
    await user.keyboard('{Escape}')
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'closed'))
    await user.click(within(screen.getByTestId('row-m4')).getByRole('button', { name: /详情/ }))
    const m4Drawer = await screen.findByRole('dialog', { name: '董事会闭门会' })
    const handWhy = m4Drawer.querySelector('[data-by="hand"]')!
    expect(handWhy).not.toBeNull()
    expect(handWhy).toHaveAttribute('data-tone', 'warn')
  })

  test('已授权给：pill 可加可删，＋ 授权给… 打开程序选择浮层', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // m2 还没授权给任何程序
    const m2Grant = screen.getByTestId('grant-m2')
    await user.click(within(m2Grant).getByRole('button', { name: '＋ 授权给…' }))

    const sheet = await screen.findByRole('dialog', { name: '授权给采集程序' })
    expect(sheet).toHaveAttribute('data-state', 'open')
    // 逐条核对：这场会议会不会被真的改到
    expect(within(sheet).getByTestId('grant-picker-meetings')).toHaveTextContent('技术评审 · 网关升级')

    await user.click(within(sheet).getByRole('checkbox', { name: /知识库索引器/ }))
    await user.click(within(sheet).getByRole('button', { name: '保存授权' }))

    await waitFor(() => expect(screen.getByTestId('grant-m2')).toHaveTextContent('知识库索引器'))

    // pill 可删
    await user.click(
      within(screen.getByTestId('grant-m2')).getByRole('button', {
        name: /收回 知识库索引器/,
      }),
    )
    expect(screen.getByTestId('grant-m2')).toHaveTextContent('＋ 授权给…')
  })

  test('批量授权逐条列出会被跳过的会议，不给一键全授权', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // 选中一场可授权的（m2）和一场规则禁止的（m6）
    await user.click(screen.getByRole('checkbox', { name: '选择 技术评审 · 网关升级' }))
    await user.click(screen.getByRole('checkbox', { name: '选择 招聘面试 · 后端 P7' }))
    await user.click(within(screen.getByTestId('batch-bar')).getByRole('button', { name: '授权给…' }))

    const sheet = await screen.findByRole('dialog', { name: '批量授权 2 场会议' })
    const list = within(sheet).getByTestId('grant-picker-meetings')
    expect(list).toHaveTextContent('规则禁止，将跳过')
    expect(within(sheet).getByRole('button', { name: '确认授权 1 场' })).toBeInTheDocument()

    await user.click(within(sheet).getByRole('checkbox', { name: /简报机器人/ }))
    await user.click(within(sheet).getByRole('button', { name: '确认授权 1 场' }))

    await waitFor(() => expect(screen.getByTestId('grant-m2')).toHaveTextContent('简报机器人'))
    // 被跳过的那场原样不动
    expect(screen.getByTestId('grant-m6')).toHaveTextContent('规则禁止采集')
  })
})

describe('会议记录页 · 键盘操作', () => {
  test('j/k 上下移动，空格选中，回车打开详情', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    expect(screen.getByTestId('row-m1')).toHaveAttribute('data-cursor', 'true')

    await user.keyboard('j')
    expect(screen.getByTestId('row-m2')).toHaveAttribute('data-cursor', 'true')
    expect(screen.getByTestId('row-m1')).toHaveAttribute('data-cursor', 'false')

    await user.keyboard('j')
    await user.keyboard('k')
    expect(screen.getByTestId('row-m2')).toHaveAttribute('data-cursor', 'true')

    await user.keyboard(' ')
    expect(screen.getByTestId('row-m2')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('batch-count')).toHaveTextContent('1')

    await user.keyboard('{Enter}')
    const drawer = await screen.findByRole('dialog', { name: '技术评审 · 网关升级' })
    expect(drawer).toHaveAttribute('data-state', 'open')
    // 详情里给的是逐阶段的判定理由——这一页存在的理由
    expect(drawer).toHaveTextContent('权限规则允许采集，但还没有授权给任何程序')

    // Esc 关掉。注意抓的是元素本身：抽屉始终挂载，关掉后标题退回兜底的
    // "会议详情"，再按原来的名字去查就查不到了。
    await user.keyboard('{Escape}')
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'closed'))
  })

  test('1/2/3 与 e / p：圆点是开关，e 延长，p 进内容预览', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // 光标停在 m1（产品周会）上。`e` = 延长保留
    await user.keyboard('e')
    expect(screen.getByTestId('keep-m1')).toHaveTextContent('剩 58 天')

    // `3` = 授权
    await user.keyboard('3')
    const sheet = await screen.findByRole('dialog', { name: '授权给采集程序' })
    expect(sheet).toHaveAttribute('data-state', 'open')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(sheet).toHaveAttribute('data-state', 'closed'))

    // `1` = 拉取，圆点即开关
    await user.keyboard('1')
    expect(within(screen.getByTestId('row-m1')).getByRole('button', { name: '拉取：未执行 · 人工改写' })).toBeInTheDocument()
    // 关掉拉取，后面的阶段跟着失效——保留期不会因为"曾经归档过"就留着
    expect(screen.getByTestId('keep-m1')).toHaveTextContent('未归档')
    await user.keyboard('1')
    expect(within(screen.getByTestId('row-m1')).getByRole('button', { name: '拉取：已完成 · 人工改写' })).toBeInTheDocument()
    // 重新拉取不等于重新归档：保留期得等归档成功才重新起算
    expect(screen.getByTestId('keep-m1')).toHaveTextContent('未归档')

    // `p` = 预览内容
    await user.keyboard('p')
    expect(await screen.findByRole('heading', { name: '内容预览占位' })).toBeInTheDocument()
  })

  test('输入框获得焦点时不拦截——在搜索框里打 j 是打字，不是跳行', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // `/` 把焦点送进搜索框
    await user.keyboard('/')
    const search = screen.getByRole('searchbox', { name: '搜索会议' })
    expect(search).toHaveFocus()

    // j / k 落进输入框，成了搜索词——列表被它筛空就是"键真的进了输入框"的证据
    await user.keyboard('jk')
    expect(search).toHaveValue('jk')
    expect(screen.getByTestId('meetings-empty')).toHaveTextContent('没有符合条件的会议')

    // 回车在输入框里同样不该打开详情抽屉
    await user.keyboard('{Enter}')
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull()

    // 清掉搜索词，表格回来，光标还在第一行——中间一步都没跳
    await user.click(screen.getAllByRole('button', { name: '清除筛选' })[0]!)
    expect(screen.getByTestId('row-m1')).toHaveAttribute('data-cursor', 'true')
  })

  test('键位解析是一张能逐条对的表', () => {
    expect(resolveMeetingKey({ key: 'j' })).toEqual({ type: 'move', delta: 1 })
    expect(resolveMeetingKey({ key: 'ArrowUp' })).toEqual({ type: 'move', delta: -1 })
    expect(resolveMeetingKey({ key: ' ' })).toEqual({ type: 'toggle-select' })
    expect(resolveMeetingKey({ key: 'Enter' })).toEqual({ type: 'open-detail' })
    expect(resolveMeetingKey({ key: '2' })).toEqual({ type: 'stage', stage: 'archive' })
    expect(resolveMeetingKey({ key: '3' })).toEqual({ type: 'open-grant' })
    expect(resolveMeetingKey({ key: 'e' })).toEqual({ type: 'extend' })
    expect(resolveMeetingKey({ key: 'p' })).toEqual({ type: 'preview' })
    expect(resolveMeetingKey({ key: '/' })).toEqual({ type: 'focus-search' })
    expect(resolveMeetingKey({ key: 'Escape' })).toEqual({ type: 'close-overlay' })
    // 带修饰键的一概不接管：⌘K 是全局搜索，⌘F 是浏览器查找
    expect(resolveMeetingKey({ key: 'k', metaKey: true })).toBeNull()
    expect(resolveMeetingKey({ key: 'f', ctrlKey: true })).toBeNull()
    expect(resolveMeetingKey({ key: 'x' })).toBeNull()

    // 正在打字时只放行 Esc
    const input = document.createElement('input')
    expect(isTypingTarget(input)).toBe(true)
    expect(resolveMeetingKey({ key: 'j', target: input })).toBeNull()
    expect(resolveMeetingKey({ key: 'Escape', target: input })).toEqual({ type: 'close-overlay' })

    // 焦点在按钮 / 链接上时，Enter 与空格是**它们自己的激活键**，页面不许接管
    const button = document.createElement('button')
    expect(isActivationTarget(button)).toBe(true)
    expect(resolveMeetingKey({ key: 'Enter', target: button })).toBeNull()
    expect(resolveMeetingKey({ key: ' ', target: button })).toBeNull()
    const link = document.createElement('a')
    link.href = '#x'
    expect(resolveMeetingKey({ key: 'Enter', target: link })).toBeNull()
    const fake = document.createElement('span')
    fake.setAttribute('role', 'button')
    expect(resolveMeetingKey({ key: ' ', target: fake })).toBeNull()

    // 但字母/数字键不是任何原生控件的激活键，焦点在按钮上照旧接管——
    // 少了这一半，"什么都不接管"也能让上面几行通过。
    expect(resolveMeetingKey({ key: 'j', target: button })).toEqual({ type: 'move', delta: 1 })
    expect(resolveMeetingKey({ key: '3', target: button })).toEqual({ type: 'open-grant' })
    // 焦点不在控件上时，Enter 仍然是"打开详情"
    const plain = document.createElement('div')
    expect(resolveMeetingKey({ key: 'Enter', target: plain })).toEqual({ type: 'open-detail' })
  })

  test('页面级监听不抢按钮的 Enter / 空格——抢走了整页的按钮就都按不动', async () => {
    renderPage()
    await ready()

    const press = (el: Element, key: string) => {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      act(() => {
        el.dispatchEvent(ev)
      })
      return ev.defaultPrevented
    }

    // 分诊格是个 <button>：Enter / 空格必须留给它自己
    const card = screen.getByTestId('triage-archfail')
    expect(press(card, 'Enter'), 'Enter 被页面抢走了').toBe(false)
    expect(press(card, ' '), '空格被页面抢走了').toBe(false)
    // 对照组：j 照旧接管，否则这条测试恒真
    expect(press(card, 'j')).toBe(true)

    // 表格里的按钮同样（焦点在 A、动作落在 B 是这条 bug 最刺眼的样子）
    const grantAdd = within(screen.getByTestId('grant-m2')).getByRole('button', { name: '＋ 授权给…' })
    expect(press(grantAdd, 'Enter')).toBe(false)
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull()

    // 焦点不在任何控件上时，Enter 仍然打开光标行的详情
    expect(press(document.body, 'Enter')).toBe(true)
  })

  test('加载失败态里，键盘用户按得动「重试」——那是错误态里唯一的出路', async () => {
    renderPage('load-failed')
    const box = await screen.findByTestId('meetings-error')
    const retry = within(box).getByRole('button', { name: '重试' })

    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      retry.dispatchEvent(ev)
    })
    // 页面这时候一行都没有，onKey 会提前 return——但**preventDefault 早就执行了**，
    // 于是浏览器不再激活这颗按钮。这一条是那个 bug 的直接后果。
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('会议记录页 · 系统状态在数据里可见', () => {
  test('nas-down 时保留窗口清零、授权 pill 消失', async () => {
    renderPage('nas-down')
    await ready()

    // spec.md §7.2：归档失败从 1 变 5
    expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('5')

    // 受影响的会议：保留窗口清零（不是"还剩 N 天"），授权撤下（没有任何 pill）
    for (const id of ['m1', 'm2', 'm7', 'm9']) {
      const keep = screen.getByTestId(`keep-${id}`)
      expect(keep).toHaveTextContent('归档失败，未开始计时')
      expect(keep).not.toHaveTextContent('剩')

      const grant = screen.getByTestId(`grant-${id}`)
      expect(grant).toHaveTextContent('未归档')
      expect(within(grant).queryByRole('button', { name: /收回/ })).not.toBeInTheDocument()
    }

    // 保留窗口都没了，"7 天内到期"自然归零——横幅之外的连锁反应
    expect(screen.getByTestId('triage-count-soon')).toHaveTextContent('0')

    // 没被 NAS 影响的会议照旧（m6 已归档、规则禁止采集）
    expect(screen.getByTestId('keep-m6')).toHaveTextContent('剩 29 天')
  })

  test('分诊条五格的判定逐条对得上 mock 数据', () => {
    const counts = Object.fromEntries(
      TRIAGE_DEFS.map((d) => [d.id, MEETINGS.filter((m) => d.test(m, NOW)).length]),
    )
    expect(counts).toEqual({
      archfail: 1, // m3 客户沟通（NAS 写入超时）
      soon: 1, //     m7 全员大会（剩 7 天）
      ungranted: 1, // m2 技术评审（准许采集但没给程序）
      running: 1, //  m3 拉取进行中
      nasonly: 1, //  m8 财务复盘（本地已清理）
    })
  })
})

describe('会议记录页 · 版式', () => {
  test('375px 下页面不横滚（表格自己滚）', async () => {
    renderPage()
    await ready()

    // jsdom 不跑布局，量不出真实溢出。能真实反映的是"溢出被裹在哪一层"：
    // 1) 表格的最小宽度落在 <table> 上，不落在页面容器上
    const tableCss = css('src/pages/Meetings/MeetingTable.module.css')
    expect(tableCss).toMatch(/\.table\s*\{\s*min-width:\s*var\(--meetings-table-w\)/)
    // 组件里不许出现裸像素——1020 只存在于令牌文件里（注释里可以提它，声明里不行）
    expect(stripComments(tableCss)).not.toMatch(/\d+px/)
    expect(css('src/styles/tokens.css')).toMatch(/--meetings-table-w:\s*\d+px/)

    // 2) 横向滚动发生在 ui/Table 自己的 .scroll 容器里
    expect(css('src/ui/Table.module.css')).toMatch(/\.scroll\s*\{\s*overflow-x:\s*auto/)
    // 3) 页面 body 用 clip 兜底（hidden 会让 sticky 失效）
    expect(css('src/styles/base.css')).toMatch(/overflow-x:\s*clip/)

    // 4) 真实 DOM 结构：<table> 的直接祖先就是那个滚动容器
    const table = document.querySelector('table')!
    const scroll = table.parentElement!
    expect(scroll.className).toMatch(/scroll/)

    // 窄屏下分诊条折行而不是横向挤出去
    expect(css('src/pages/Meetings/TriageBar.module.css')).toMatch(/flex-wrap:\s*wrap/)
  })

  test('页面 CSS 里没有裸的 px / hex / rgba（缺值就去 tokens.css 加令牌）', () => {
    const files = [
      'src/pages/Meetings/Meetings.module.css',
      'src/pages/Meetings/TriageBar.module.css',
      'src/pages/Meetings/MeetingTable.module.css',
      'src/pages/Meetings/MeetingRow.module.css',
      'src/pages/Meetings/BatchBar.module.css',
      'src/pages/Meetings/GrantPicker.module.css',
    ]
    for (const f of files) {
      // 注释里可以出现数字（说明取舍），只查声明行
      const decls = stripComments(css(f))
        .split('\n')
        .filter((l) => /:/.test(l))
        .join('\n')
      expect(decls, `${f} 出现了裸像素`).not.toMatch(/:\s*-?\d+(\.\d+)?px/)
      expect(decls, `${f} 出现了裸 hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(decls, `${f} 出现了裸 rgba`).not.toMatch(/rgba?\(/)
    }
  })
})

describe('会议记录页 · 分诊条与表格不许互相矛盾', () => {
  /**
   * **不变量：点任何一个计数格，都必须真能到达它数出来的那些行。**
   *
   * 分诊条的计数算在**全量** `rows` 上——它的产品职责就是"告诉你全系统有什么
   * 需要处理"，把它裁进当前时间窗等于让归档失败（本系统最严重的状态）可以被
   * 一个筛选器悄悄藏起来。既然它报的是全系统，点进去也必须到得了：否则
   * "仅存 NAS 1"配一张空表、出口还是点了也不解决问题的"清除筛选"。
   */
  const EXPECTED: Record<string, string[]> = {
    archfail: ['m3'],
    soon: ['m7'],
    ungranted: ['m2'],
    running: ['m3'],
    nasonly: ['m8'],
  }

  for (const def of TRIAGE_DEFS) {
    test(`点「${def.label}」到得了它数出来的行——哪怕时间范围本来把它们挡在外面`, async () => {
      const user = userEvent.setup()
      renderPage()
      await ready()

      // 先收到"近 7 天"：m7（23 天前）、m8（40 天前）、m9 都被挡在范围外
      await user.click(screen.getByRole('button', { name: /近 90 天/ }))
      await user.click(screen.getByRole('menuitemradio', { name: /近 7 天/ }))
      expect(rowIds()).toEqual(['m1', 'm2', 'm6', 'm3', 'm4', 'm5'])

      // 计数报的仍然是全系统的问题，不是当前时间窗里的
      const expected = EXPECTED[def.id]!
      expect(screen.getByTestId(`triage-count-${def.id}`)).toHaveTextContent(String(expected.length))

      await user.click(screen.getByTestId(`triage-${def.id}`))

      // 到得了：表格里就是它数出来的那些行，一场不多一场不少
      expect(rowIds()).toEqual(expected)
      // 而且时间范围被一并置成了"全部时间"，不是把行藏起来还留着计数
      expect(screen.getByRole('button', { name: /全部时间/ })).toBeInTheDocument()
    })
  }

  test('搜索命中的会议落在时间范围外时，出口是「改为全部时间」而不是点了没用的「清除筛选」', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('button', { name: /近 90 天/ }))
    await user.click(screen.getByRole('menuitemradio', { name: /近 7 天/ }))
    // 财务复盘在 40 天前，被范围挡住了——但范围内明明还有 6 场会议，
    // 旧判据会把这一支算成"被筛选筛没了"。
    await user.type(screen.getByRole('searchbox', { name: '搜索会议' }), '财务复盘')

    const empty = await screen.findByTestId('meetings-empty')
    expect(empty).toHaveAttribute('data-kind', 'out-of-range')
    await user.click(within(empty).getByRole('button', { name: '改为全部时间' }))

    // 出口真的解决了问题：那一场找到了
    expect(rowIds()).toEqual(['m8'])
  })
})

describe('会议记录页 · 跨页选择不许留下两个数字', () => {
  test('跨页全选之后收窄搜索：提示条与批量条说的是同一个数', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.selectOptions(screen.getByLabelText('每页条数'), '5')
    await user.click(screen.getByRole('checkbox', { name: '全选本页' }))
    await user.click(
      within(screen.getByTestId('select-all-hint')).getByRole('button', { name: /全部 9 场/ }),
    )
    expect(screen.getByTestId('batch-count')).toHaveTextContent(/^9$/)

    // 搜索收窄到 7 场（会议号 881-1 开头的那些）
    await user.type(screen.getByRole('searchbox', { name: '搜索会议' }), '881-1')

    // 关键：两处说的是同一个数。之前提示条用 totalMatching 说"全部 7 场"、
    // 底部批量条同时说"9 场已选"——同一屏上两个数字打架。
    expect(screen.getByTestId('batch-count')).toHaveTextContent(/^7$/)
    expect(screen.getByTestId('select-all-hint')).toHaveTextContent('全部 7 场')
  })

  test('筛到只剩 1 行时，批量按钮改的就是那 1 场，不是屏幕上看不见的 9 场', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByRole('checkbox', { name: '全选本页' }))
    expect(screen.getByTestId('batch-count')).toHaveTextContent(/^9$/)

    await user.type(screen.getByRole('searchbox', { name: '搜索会议' }), '全员')
    expect(rowIds()).toEqual(['m7'])
    // 屏幕上只有 1 行，批量条就得说 1。说 9 的话，按下「收回授权」会改掉
    // 9 场里所有有授权的——而这四个批量按钮没有确认面板。
    expect(screen.getByTestId('batch-count')).toHaveTextContent(/^1$/)

    await user.click(within(screen.getByTestId('batch-bar')).getByRole('button', { name: '收回授权' }))
    await user.click(screen.getAllByRole('button', { name: '清除筛选' })[0]!)

    // 那 1 场被改了，看不见的 8 场一个都没被改到
    expect(screen.getByTestId('grant-m7')).toHaveTextContent('＋ 授权给…')
    expect(screen.getByTestId('grant-m1')).toHaveTextContent('知识库索引器')
    expect(screen.getByTestId('grant-m1')).toHaveTextContent('简报机器人')
    expect(screen.getByTestId('grant-m9')).toHaveTextContent('数据仓库同步')
  })

  test('本页只选了一部分时，表头勾选框是半选，不是未选', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const head = screen.getByRole('checkbox', { name: '全选本页' })
    expect(head).not.toBePartiallyChecked()

    await user.click(screen.getByRole('checkbox', { name: '选择 产品周会' }))
    // 未勾的表头在说"这一页一个都没选"，而屏幕上明明有一行是选中的
    expect(head).toBePartiallyChecked()

    await user.click(head)
    expect(head).toBeChecked()
    expect(head).not.toBePartiallyChecked()
  })
})

describe('会议记录页 · 状态与理由的不变量', () => {
  const CTX = { nowSec: MOCK_NOW, consumers: CONSUMERS }

  /** 页面上真实存在的每一种写操作。新增写操作时这张表要跟着长。 */
  const WRITES: MeetingWrite[] = [
    { op: 'stage', stage: 'fetch', next: 'done' },
    { op: 'stage', stage: 'fetch', next: 'off' },
    { op: 'stage', stage: 'archive', next: 'done' },
    { op: 'stage', stage: 'archive', next: 'off' },
    { op: 'grants', next: ['kb-indexer'] },
    { op: 'grants', next: [] },
    { op: 'extend' },
  ]

  /**
   * 「状态与理由不许自相矛盾」——一条不变量，不是一组场景。
   *
   * 这个 bug 类在本计划里已经出现四次（T2 的种子数据、`FetchState` 缺 `'off'`、
   * 批量写操作一处也不更新 `why`、关掉拉取连带改 `archive` 却不记 `hand`），
   * 每次都是"某条写路径只维护它直接改的字段"。逐个场景断言挡不住第五次，
   * 所以这里断言的是不变量本身。
   */
  function contradictions(m: Meeting): string[] {
    const bad: string[] = []
    const say = (t: string) => bad.push(`${m.id}: ${t}`)

    // 人工改写环与理由必须互相印证。少任何一半，抽屉里就会出现
    // "状态说没执行过、理由说已成功写入 NAS 并校验了哈希"。
    for (const stage of ['fetch', 'archive'] as const) {
      if (m.hand.includes(stage) !== (m.why[stage].by === 'hand'))
        say(`${stage}: hand=${m.hand.includes(stage)} 但 why.by=${m.why[stage].by}`)
    }
    // 没有录制 ⇔ 理由是"不适用"
    if ((m.fetch === 'none') !== (m.why.fetch.by === 'na'))
      say(`fetch=${m.fetch} 却说 ${m.why.fetch.by}`)
    if ((m.archive === 'none') !== (m.why.archive.by === 'na'))
      say(`archive=${m.archive} 却说 ${m.why.archive.by}`)
    // 失败 ⇔ 理由是"失败"。绿点「已完成」紧挨一块红框写「归档失败」就是这条漏了。
    if ((m.archive === 'failed') !== (m.why.archive.by === 'fail'))
      say(`archive=${m.archive} 却说 ${m.why.archive.by}`)
    const ak = archiveWhyKind(m)
    // 人工改写优先于所有规则（spec.md §5），是这条唯一的豁免
    if (ak !== null && m.why.archive.by !== ak && m.why.archive.by !== 'hand')
      say(`archive=${m.archive} 的理由应是 ${ak}，实际 ${m.why.archive.by}`)
    // 授权理由完全由状态定死
    const alk = allowWhyKind(m)
    if (m.why.allow.by !== alk && !(m.why.allow.by === 'hand' && m.hand.includes('allow')))
      say(`allow 理由应是 ${alk}，实际 ${m.why.allow.by}`)
    // 判定为 deny 的会议不许落到"可授权"（画成「＋ 授权给…」还真能授权出去）
    if (m.allow === 'deny' && grantCellKind(m).kind === 'grantable') say('allow=deny 却算可授权')
    // 保留期自归档成功起算
    if (m.keep.expiresAt !== null && !m.keep.filesGone && m.archive !== 'done')
      say(`archive=${m.archive} 却有保留期`)
    // 已经不可授权的会议不该还留着授权
    if (m.grants.length > 0 && grantCellKind(m).kind !== 'grantable') say('不可授权却还留着授权')
    return bad
  }

  test('这条不变量真的会红：只改状态、不改理由就会被抓出来', () => {
    const m3 = MEETINGS.find((m) => m.id === 'm3')!
    // 批量"重跑归档"之前干的正是这件事：把 archive 置成 done、keep 重新起算，
    // why 一个字不动。
    const naive: Meeting = {
      ...m3,
      archive: 'done',
      keep: { archivedAt: MOCK_NOW, expiresAt: MOCK_NOW + 86400, extended: 0, filesGone: false },
    }
    expect(contradictions(naive).length).toBeGreaterThan(0)

    // 关掉拉取却只记 fetch 一个人工改写环，也会被抓出来
    const halfHand: Meeting = { ...m3, fetch: 'off', archive: 'off', hand: ['fetch'] }
    expect(contradictions(halfHand).length).toBeGreaterThan(0)
  })

  test('种子数据本身不矛盾（正常态与 NAS 断连态）', () => {
    for (const m of [...MEETINGS, ...applyNasDown(structuredClone(MEETINGS))]) {
      expect(contradictions(m), `种子 ${m.id}`).toEqual([])
    }
  })

  test('任何写操作之后（含两步组合）状态与理由都不矛盾', () => {
    const seeds = [...MEETINGS, ...applyNasDown(structuredClone(MEETINGS))]
    for (const seed of seeds) {
      for (const a of WRITES) {
        const one = applyWrite(seed, a, CTX)
        expect(contradictions(one), `${seed.id} ← ${JSON.stringify(a)}`).toEqual([])
        for (const b of WRITES) {
          const two = applyWrite(one, b, CTX)
          expect(contradictions(two), `${seed.id} ← ${JSON.stringify(a)} → ${JSON.stringify(b)}`).toEqual([])
        }
      }
    }
  })

  test('allow 为 deny 的会议一律不可授权，by 只决定文案', () => {
    const m6 = MEETINGS.find((m) => m.id === 'm6')!
    // 只按 why.allow.by 判会开一个反向的洞：allow 仍是 deny、理由却是
    // rule / hand 的行会落到"可授权"，画成「＋ 授权给…」而且真能授权出去。
    expect(grantCellKind({ ...m6, why: { ...m6.why, allow: { by: 'rule', text: 'x' } } })).toEqual({
      kind: 'denied',
      hand: false,
    })
    const handed: Meeting = {
      ...m6,
      hand: [...m6.hand, 'allow'],
      why: { ...m6.why, allow: { by: 'hand', text: '陈运维 手动设为禁止' } },
    }
    expect(grantCellKind(handed)).toEqual({ kind: 'denied', hand: true })
    // 写操作这一层也拦得住：授权发不出去
    expect(applyWrite(handed, { op: 'grants', next: ['kb-indexer'] }, CTX).grants).toEqual([])

    // 对照组：allow 为 allow 的确实授权得出去，否则上面几行恒真
    const m2 = MEETINGS.find((m) => m.id === 'm2')!
    expect(grantCellKind(m2).kind).toBe('grantable')
    expect(applyWrite(m2, { op: 'grants', next: ['kb-indexer'] }, CTX).grants).toEqual(['kb-indexer'])
  })

  test('批量重跑归档之后，同一行的四处说法一致', async () => {
    const user = userEvent.setup()
    renderPage('nas-down')
    await ready()

    // NAS 断连，m1 归档失败、保留期清零、授权撤下
    expect(screen.getByTestId('keep-m1')).toHaveTextContent('归档失败，未开始计时')
    expect(screen.getByTestId('triage-count-ungranted')).toHaveTextContent('0')

    await user.click(screen.getByRole('checkbox', { name: '选择 产品周会' }))
    await user.click(within(screen.getByTestId('batch-bar')).getByRole('button', { name: '重跑归档' }))

    // ① 本地保留：重新起算　② 已授权给：可以授权了，不是"未归档"
    expect(screen.getByTestId('keep-m1')).toHaveTextContent('剩 30 天')
    expect(screen.getByTestId('grant-m1')).toHaveTextContent('＋ 授权给…')
    // ③ 分诊条把它算进"待授权"，而点「＋ 授权给…」确实打得开（不再被挡回
    //    "需要先归档成功"）
    expect(screen.getByTestId('triage-count-ungranted')).toHaveTextContent('1')
    await user.click(within(screen.getByTestId('grant-m1')).getByRole('button', { name: '＋ 授权给…' }))
    expect(await screen.findByRole('dialog', { name: '授权给采集程序' })).toHaveAttribute('data-state', 'open')
    await user.keyboard('{Escape}')

    // ④ 抽屉里的归档理由：不再是"失败 归档失败：NAS 断连"
    await user.click(within(screen.getByTestId('row-m1')).getByRole('button', { name: /详情/ }))
    const drawer = await screen.findByRole('dialog', { name: '产品周会' })
    expect(drawer.querySelector('[data-by="fail"]')).toBeNull()
    expect(drawer).not.toHaveTextContent('NAS 断连，写入被拒')
    expect(within(drawer).getByRole('img', { name: '归档到 NAS：已完成 · 人工改写' })).toBeInTheDocument()
  })

  test('关掉拉取，归档那一段也跟着换理由——不是状态说没执行、理由说已校验哈希', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // 光标停在 m1，按 `1` 关掉拉取
    await user.keyboard('1')

    const m1 = screen.getByTestId('row-m1')
    // 归档圆点跟着变"未执行"，而且带上人工改写环
    expect(within(m1).getByRole('button', { name: '归档到 NAS：未执行 · 人工改写' })).toBeInTheDocument()

    await user.click(within(m1).getByRole('button', { name: /详情/ }))
    const drawer = await screen.findByRole('dialog', { name: '产品周会' })
    // 抽屉里归档那一段不能还写着"已成功写入 NAS 并校验哈希"
    expect(drawer).not.toHaveTextContent('已成功写入 NAS 并校验哈希')
    expect(drawer).toHaveTextContent('归档随之失效')
  })
})

describe('会议记录页 · 数据到达时不许闪一帧空态', () => {
  test('首屏没有任何一帧画出「还没有拉取过任何会议」', async () => {
    // 用 effect 镜像服务端数据时，数据到达的那次 commit 里 loading 已经是
    // false 而 rows 还是空的——分诊条与工具条整排卸载、表格画出大空态，
    // 下一帧才换回真实数据。测试全 `await waitFor` 抓不到这一帧，所以这里
    // 用 Profiler 在**每一次提交**上取一张快照（onRender 跑在提交阶段，
    // DOM 已经更新完了）。
    const commits: string[] = []
    const onRender: ProfilerOnRenderCallback = () => {
      commits.push(document.body.textContent ?? '')
    }
    const router = createMemoryRouter(
      [
        { path: '/meetings', element: <MeetingsPage /> },
        { path: '/preview/:id', element: <h1>内容预览占位</h1> },
      ],
      { initialEntries: ['/meetings'] },
    )
    render(
      <SystemStateProvider initialState="ok">
        <Profiler id="meetings" onRender={onRender}>
          <RouterProvider router={router} />
        </Profiler>
      </SystemStateProvider>,
    )
    await ready()

    // 至少经历了"加载中 → 有数据"两次提交，否则下面的过滤是空转
    expect(commits.length).toBeGreaterThan(1)
    expect(commits.filter((t) => t.includes('还没有拉取过任何会议'))).toEqual([])
    // 分诊条也不许中途整排消失又长回来——那正是"整页往下跳"
    expect(commits.filter((t) => t.includes('产品周会') && !t.includes('待授权'))).toEqual([])
  })
})

describe('会议记录页 · 语义色只在该出现的地方出现', () => {
  test('资产列的「部分未拿到」是中性的，不是琥珀——琥珀只有两个含义', () => {
    const rowCss = css('src/pages/Meetings/MeetingRow.module.css')
    const partial = /\.assets\[data-state='partial'\]\s*\{([^}]*)\}/.exec(stripComments(rowCss))
    expect(partial, '找不到 partial 这一支的规则').not.toBeNull()
    expect(partial![1]).not.toMatch(/--warn|--fail/)

    // 对照组：琥珀在这个文件里仍然有它唯一合法的用处——保留期快到了
    expect(stripComments(rowCss)).toMatch(/\.keepLeft\[data-soon='true'\]\s*\{[^}]*var\(--warn\)/)
  })
})
