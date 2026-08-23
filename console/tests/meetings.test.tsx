import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { SystemState } from '../src/api/types'
import { MEETINGS } from '../src/api/mock/meetings'
import { SystemStateProvider } from '../src/app/SystemStatus'
import MeetingsPage from '../src/pages/Meetings'
import { MeetingTable } from '../src/pages/Meetings/MeetingTable'
import { emptyKind } from '../src/pages/Meetings/MeetingTable'
import { grantCellKind } from '../src/pages/Meetings/MeetingRow'
import { TRIAGE_DEFS } from '../src/pages/Meetings/TriageBar'
import { isTypingTarget, resolveMeetingKey } from '../src/lib/keys'

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
    expect(screen.getByTestId('meetings-status')).toHaveTextContent('正在读取')

    // 工具条同样保留（禁用态），否则数据到了整页还是要往下跳一次
    expect(screen.getByRole('searchbox', { name: '搜索会议' })).toBeDisabled()
  })

  test('归档失败的行是红的，且分诊条第一格计数与之相符', async () => {
    renderPage()
    await ready()

    // 「红」在 jsdom 里读不出来（不解析 var()），所以断言两件能真实反映的事：
    // 1) 这一格声明的是 fail 语义档，2) CSS 把 fail 档接到了 --fail 上。
    expect(screen.getByTestId('triage-archfail')).toHaveAttribute('data-tone', 'fail')
    const triageCss = css('src/pages/Meetings/TriageBar.module.css')
    expect(triageCss).toMatch(/\[data-tone='fail'\]\s*\.count\s*\{\s*color:\s*var\(--fail\)/)

    // 计数与表格里真的处在归档失败状态的行数一致
    const failed = screen.getAllByRole('button', { name: /归档到 NAS：失败/ })
    expect(failed).toHaveLength(1)
    expect(screen.getByTestId('triage-count-archfail')).toHaveTextContent('1')
    expect(failed[0]!.closest('tr')).toHaveAttribute('data-id', 'm3')

    // 归档失败 ⇒ 保留期根本没开始计时，这句必须说出来，不能画一根空进度条
    expect(screen.getByTestId('keep-m3')).toHaveTextContent('归档失败，未开始计时')
  })
})

describe('会议记录页 · 三态与三种空态', () => {
  test('加载失败给出错误详情与重试，不是「暂无数据」', async () => {
    renderPage('load-failed')

    // 先等错误态真的落地：加载态的分页器也挂着同一个 testid，
    // findBy 会抓到那一个然后对着它断言，测出来的是"还在读取"。
    await waitFor(() => expect(screen.getByTestId('meetings-status')).toHaveTextContent('读不到会议列表'))
    const box = screen.getByTestId('meetings-status')
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
    const empty1 = await screen.findByTestId('meetings-status')
    expect(empty1).toHaveTextContent('没有符合条件的会议')
    const clear = within(empty1).getByRole('button', { name: '清除筛选' })
    await user.click(clear)
    expect(rowIds()).toHaveLength(9)
    filtered.unmount()

    // ② 系统里一场都没有 → 去看拉取规则
    const none = renderPage('empty')
    await waitFor(() =>
      expect(screen.getByTestId('meetings-status')).toHaveTextContent('还没有拉取过任何会议'),
    )
    const empty2 = screen.getByTestId('meetings-status')
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
        selectAllMatching={false}
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
    const empty3 = screen.getByTestId('meetings-status')
    expect(empty3).toHaveTextContent('近 7 天内没有会议记录')
    await user.click(within(empty3).getByRole('button', { name: '改为全部时间' }))
    expect(onClearRange).toHaveBeenCalled()
  })

  test('三种空态的成因判定：粗的那层先答，不然给出的出口解决不了问题', () => {
    // 系统里一场都没有的时候，给"清除筛选"是没用的
    expect(emptyKind({ totalAll: 0, totalInRange: 0, totalMatching: 0, rangeDays: 90 })).toBe('none-at-all')
    // 有数据、但都落在时间范围之外 → 出口是换范围，不是清筛选
    expect(emptyKind({ totalAll: 9, totalInRange: 0, totalMatching: 0, rangeDays: 7 })).toBe('out-of-range')
    // 范围里有，是筛选把它筛没的
    expect(emptyKind({ totalAll: 9, totalInRange: 9, totalMatching: 0, rangeDays: 90 })).toBe('filtered-out')
    // "全部时间"下不存在"这段时间没有"
    expect(emptyKind({ totalAll: 9, totalInRange: 0, totalMatching: 0, rangeDays: 0 })).toBe('filtered-out')
    // 有结果就不是空态
    expect(emptyKind({ totalAll: 9, totalInRange: 9, totalMatching: 1, rangeDays: 90 })).toBeNull()
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
    expect(hint).toHaveTextContent('已选中本页 5 场')
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
    expect(screen.getByTestId('meetings-status')).toHaveTextContent('没有符合条件的会议')

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
    const now = new Date(2026, 7, 23, 15, 0)
    const counts = Object.fromEntries(
      TRIAGE_DEFS.map((d) => [d.id, MEETINGS.filter((m) => d.test(m, now)).length]),
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
