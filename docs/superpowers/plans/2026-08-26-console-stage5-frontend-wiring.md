# 阶段 5 · 前端接线（F2–F7）

**规格**：`docs/console/spec.md`（§4 逐页说明、§7 系统状态、§8 三态、§9 键盘、§11 缺口）
**排期表**：`docs/console/dev-plan.md` §3 阶段 5
**上一阶段**：`docs/superpowers/plans/2026-08-26-console-stage4-api-and-scheduler.md`（33 条 admin API 已全部落地）

开工前先读三份侦察产出（在 scratchpad，不进仓库）：

| 文件 | 内容 |
| --- | --- |
| `<SCRATCH>/api-contracts.md` | 33 条 admin API 的请求/响应契约，逐字段 |
| `<SCRATCH>/spec-pages.md` | spec 逐页要求的要点清单，含原型文件路径 |
| `<SCRATCH>/console-infra.md` | 前端已有的基元、hook、令牌、测试约定 |

`<SCRATCH>` = `/private/tmp/claude-501/-Users-zouyanjian-other-try-yaowu-meeting-data-exporter/7305115e-1780-4236-99b6-ad57bd306eba/scratchpad`

这三份**刻意不进仓库**：它们是从源头（`src/http/handlers/console/`、`tests/http/`、
`docs/console/spec.md`、`console/src/`）抽出来的施工参考，进了仓库就会与代码漂移，
变成第二份真相。路径失效之后从源头重新生成即可，**权威始终是源头而不是它们**。
下面每一处引用都同时给了源头位置，照着源头核对一遍再动手。

---

## 0. 开工前的裁定

阶段 4 的经验是：没有在开工前定下来的事，会在十七个并行分支里各自定一遍，
然后在合并时打架。以下八条在派活之前定死。

### G-a 先修地基，再并行接页

阶段 4 的十七个任务全都往 `src/http/router.ts` / `src/index.ts` 追加，最后花在
手工合并上的力气不比写代码少，还两次被合并吃掉花括号。

阶段 5 的前端有同样形状的汇聚点，而且更多：`console/src/app/routes.tsx`（七条路由）、
`console/src/api/`（客户端层）、`console/src/app/SystemStatus.tsx`（全局系统状态）。
七个页面任务并行去改这三处，冲突是必然而不是可能。

**裁定：阶段 5 开头有一个不可并行的地基任务（F0），一次性把所有汇聚点改到位。**
此后每个页面任务只碰 `pages/<自己>/` 与 `api/admin/<自己那个域>.ts`，两两不相交。

代价是第一步串行。这个代价小于合并七个分支。

### G-b 新类型跟着它唯一的消费者走，不进 `types.ts`

`api/types.ts` 是第二个汇聚点：七页各自要 Rule / Program / StorageInfo / AuditEntry /
JobRun / Content 六组新类型，都往里塞就是六路冲突。

而这六组类型**各自只有一个消费者**——`Rule` 只有自动规则页用，`JobRun` 只有定时
任务页用。跟着消费者走，`api/types.ts` 这一轮根本不用动，冲突点自然消失。

**裁定：新类型定义在各自的 `api/admin/<域>.ts` 里并从那里导出。**
只有真正跨页共享的才进 `types.ts`——而跨页共享的（`Meeting` / `Why` / `Triage` /
`AssetKey`）F1 已经建好了。

### G-c 写操作不做乐观更新，删掉前端那份状态推导

`pages/Meetings/write.ts` 的 `applyWrite` 是 mock 时代的产物：它在前端推导
「改了 `fetch` 就要连带改 `why` / `hand` / `keep`」。文件头的注释自己写着这个形状
**已经栽过四次**。

接真 API 之后，这套推导在后端也有一份（而且带测试）。留着两份就是两份真相，
而它们不一致的地方恰好是判定边界——最需要准确的地方。

**裁定：写操作 = 发请求 + 重取，不做乐观更新。** `applyWrite` 及其伴生的推导
（`grantCellKind` / `allowWhyKind` 里属于"推导下一个状态"的部分）删掉；纯展示映射
（阶段名、理由分类的**呈现**）留下。

代价是每次操作要等一个往返。补偿是操作期间的 pending 态必须做出来——点了没反应
是比慢一点更糟的体验。管理操作不是高频输入，这个取舍站得住。

### G-d 五态系统状态：三态从真实请求来，两态各有出处

F1 的 `SystemStateProvider` 是一个全局下拉框，手动切 ok/loading/load-failed/empty/
nas-down/tencent-down 六个值，`mockApi(state)` 照着分支返回假数据。接真 API 后：

| 状态 | 真实来源 |
| --- | --- |
| `loading` / `load-failed` | `useResource` 的三态，本来就是真的 |
| `empty` | 真实的空结果（`total === 0`） |
| `nas-down` | `GET /api/v1/admin/storage` 的 `nas.reachable`（`false` 时仍返回 200——不可达本身是要展示的内容，不是错误） |
| `tencent-down` | **没有专门端点**——从 `GET /api/v1/admin/jobs` 里 `name === 'fetch_recordings'`（"拉取新录制"）那一项的 `recentRuns` 推：连续失败即视为腾讯会议不可达 |

`tencent-down` 这条是推断而非直报，**必须在界面上说清它是推断**（"最近 N 轮拉取
连续失败"），不能显示成一句肯定的"腾讯会议不可达"——那是在替一个我们没有的探测
下结论。

手动切换的下拉框保留，但收进 `?proto=1` 开关下（与顶栏原型脚手架同一处置，
见 `94209ec`）：它是演示与截图工具，不是运行时功能。

### G-e 采集程序的停用与轮换：数据层已经在了，只缺端点

`service_accounts`（001）已经有 `enabled TINYINT` 和 `secret_hash` 两列。
spec §11 缺口 4「轮换凭据 / 停用程序」因此不是新建模型，是补两个 handler。

### G-f 只读角色需要一次迁移——`admin_accounts` 没有角色列

`admin_accounts`（003）只有 id / username / password_hash / created_at。
少了列，后端就无法拒绝一个只读账号发来的写请求，而**前端藏起来的按钮不是权限**。

所以 spec §11 缺口 1 不是"前端加个判断"，是「迁移加列 + 每个写 handler 加判断 +
前端按角色降级」三件事。

### G-g「新建定时任务」不做，删掉那个按钮

原型自己已经回答了这个问题。`gate-console.html:3934`：

> 新建任务还没做——四个内置任务已经覆盖整条链路，先不急着开放自定义。

`JOB_CATALOG`（`src/store/jobs.ts`）是代码里的四个常量、不是一张表；要支持自定义
任务，得先回答"执行体从哪来"——那是一个新子系统，不是一个表单。

**裁定：spec §11 缺口 3 的处置是删掉「新建任务」按钮，并在 spec §10（明确不做）
里记一行。** 留着一个点了弹"还没做"的按钮，比没有这个按钮更差。

### G-h F7 的五个缺口有三个卡在后端，先补后端

| §11 缺口 | 后端现状 | 归属 |
| --- | --- | --- |
| 1 只读角色 | 无角色列（G-f） | A8 → F7 |
| 2 移动端卡片化降级 | 不需要后端 | F7 |
| 3 新建定时任务 | 不做（G-g） | 删按钮 |
| 4 轮换凭据 / 停用程序 | 列已在，缺端点（G-e） | A8 → F7 |
| 5 账号设置 / 修改密码 | 无端点 | A8 → F7 |

把"前端做一半、后端没有对应端点"的任务发出去，得到的一定是一个假按钮。
**A8 排在 F7 前面。**

---

## 1. 全局约束

这几条对**每一个**任务都成立，实施者收到的 brief 里会原样带上：

1. **TDD**。先写测试再写实现。前端测试用 vitest + testing-library，
   跑法是 `cd console && npm run test`（**不是 `bun test`**——根目录的 bunfig.toml
   把 `console/**` 排除在外，用错 runner 会得到几十条无意义的失败）。
2. **不许静默放行**。任何"拿不准"的分支都要落到安全的一侧**并把理由显示出来**。
   前端这一侧的形态是：拿不到判定理由时显示"理由缺失"而不是留空，
   拿不到状态时显示"未知"而不是默认成"正常"。
3. **判定理由必须可回溯**。界面上每一个状态圆点旁边都要能点开它的理由，
   理由的文本一律来自后端下发的 `why`，前端不自己编。
4. **格式化一律走 `lib/format.ts`**。组件里不许出现 `toFixed` / `padStart` /
   手写的日期拼接。缺什么函数就往那里加，并补它的单测。
5. **令牌一律走 `styles/tokens.css`**。组件的 CSS Module 里不许出现字面色值、
   不许出现魔法间距。缺什么令牌就往那里加。
6. **深色模式与无障碍是门槛不是加分**。每个新页面都要过 `npm run a11y`，
   且在明/暗两套主题下都检查过对比度。
7. **响应形状以 `<SCRATCH>/api-contracts.md` 为准**。字段名写错一个字母就是一个 bug，
   而 TypeScript 帮不上忙——`res.json()` 回来是 `any`。**每个域的 api 文件都要有
   一层运行时校验**（至少校验必填字段存在），失败时抛出带端点名的错误。
8. **不许改动 `src/`（后端）**。阶段 5 的任务除 A8 外全部只碰 `console/`。
   发现后端缺口时**记进任务报告，不要顺手改后端**——那会与其他分支冲突，
   且绕过后端的测试门槛。

---

## 2. 任务表

```
F0 地基（串行，一人做完再派其余）
   │
   ├──→ F2  会议记录页接真 API + 详情抽屉      大
   ├──→ F3  自动规则页 + 规则编辑器            大
   ├──→ F4  采集授权页 + 接入向导              中
   ├──→ F5a 定时任务页                         中
   ├──→ F5b 归档存储页                         中
   ├──→ F5c 操作审计页                         中
   └──→ F6  内容预览页                         大
              │
              ▼
   A8 后端补三个缺口（只读角色迁移 · 程序停用/轮换 · 修改密码）
              │
              ▼
   F7 前端补缺口（只读降级 · 移动端卡片化 · 三处新表单 · 删「新建任务」）
```

| 任务 | 独占的文件 | 用到的 API | 规模 |
| --- | --- | --- | --- |
| **F0** | `api/client.ts`（新）· `api/admin/grants.ts`（新，两页共用）· `app/routes.tsx` · `app/SystemStatus.tsx` · 六个页面目录的空壳 · `api/mock/` 的处置 | — | 中 |
| **F2** | `pages/Meetings/**` · `api/admin/meetings.ts`（新） | A2 三条 + override 两条 + extend + history | 大 |
| **F3** | `pages/Rules/**` · `api/admin/rules.ts`（新） | rules 六条 | 大 |
| **F4** | `pages/Consumers/**` · `api/admin/programs.ts`（新） | programs 三条 | 中 |
| **F5a** | `pages/Jobs/**` · `api/admin/jobs.ts`（新） | jobs 两条 | 中 |
| **F5b** | `pages/Storage/**` · `api/admin/storage.ts`（新） | storage 四条 | 中 |
| **F5c** | `pages/Audit/**` · `api/admin/audit.ts`（新） | audit 一条 | 中 |
| **F6** | `pages/Preview/**` · `api/admin/content.ts`（新） | content 两条 | 大 |
| **A8** | `src/**`（后端）· 一份新迁移 | — | 中 |
| **F7** | 跨页，**串行做**，见 §12 | A8 的新端点 | 中 |

**七个页面任务两两不相交**，可以全部并行派出去。
F0 的产物是它们共同的地基，必须先合进主干。

---

## 3. F0 · 地基（串行，必须先合进主干）

这一任务本身不点亮任何页面。它的全部价值是让后面七个任务互不相干。

### 3.1 `api/client.ts` —— 统一的请求层

现在只有 `api/admin.ts` 一个文件在直接 `fetch`（三条会话端点），它的
`call()` 私有函数就是这一层的雏形。把它抽出来，给全部 33 条端点共用：

```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    message: string,
    readonly body?: unknown,
  ) { super(message) }
}

/** 会话过期。调用方（页面）不处理它，由一个全局的 401 出口统一跳登录 */
export class UnauthorizedError extends ApiError {}

export async function apiGet<T>(path: string, query?: Record<string, unknown>): Promise<T>
export async function apiSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>
```

必须做到的几件事：

- `credentials: 'include'`，与 `api/admin.ts` 现有的写法一致（httpOnly cookie 的必要条件）
- **401 统一抛 `UnauthorizedError`**，不在各页面各写一遍跳转。
  由 `AppShell` 或一个 error boundary 捕获它并 `<Navigate to="/login">`。
  **注意**：`fetchAdminIdentity()` 是唯一一个「401 是预期结果」的调用，
  它必须继续返回 `null` 而不是抛——不要把它改成走 `apiGet`，或者给它一个显式的
  「401 不抛」开关。这条弄错的表现是登录页自己把自己重定向到登录页，死循环。
- query 参数的序列化：`undefined` 的键不出现在 URL 里（不是出现成 `?x=undefined`）
- 非 2xx 时把响应体读出来放进 `ApiError.body`——后端的 400 是带原因的，
  吞掉它等于让每个错误都长得一样

**`api/admin.ts` 保持原样不动**。它的文件头注释说明了为什么会话 API 刻意不走
mock 层，那个理由现在依然成立；把它并进 client.ts 是另一件事，不在这一轮。

### 3.2 `api/admin/grants.ts` —— 两页共用，所以归地基

七个域文件里只有这一个有两个消费者：F2 的详情抽屉要在里面授权/撤销/人工改写，
F4 的采集授权页也要用同一组端点。放在地基里建好，两边都 import，不会各写一份。

覆盖六条：`listPrograms` / `createProgram` / `programInventory` /
`grantMeeting` / `revokeGrant` / `putOverride` / `revokeOverride`。

**周期性会议的场次 id 一律从查询串 `?sub=` 传**（后端路由上只有 `:meetingId`，
两个 DELETE 又没有请求体，所以只有这一种写法）。把这条封在函数签名里：
调用方传 `{ meetingId, subMeetingId }`，由这个文件负责拼 `?sub=`，
不要让七个调用点各自去记这个约定。

### 3.3 `app/routes.tsx` —— 七条路由一次性改完

六个 `Placeholder` 全部换成真实页面组件。同时在
`pages/{Rules,Consumers,Jobs,Storage,Audit,Preview}/` 各建一个最小空壳：

```tsx
// pages/Rules/index.tsx
export default function RulesPage() {
  return <PageShell title="自动规则">{/* F3 */}</PageShell>
}
```

空壳要**能过 a11y 与主题回归**（有 `<h1>`、有正确的 landmark），这样后面七个任务
谁先合进来都不会把门槛测试打红。`_Placeholder.tsx` 在六个空壳都建好之后删掉。

### 3.4 `app/SystemStatus.tsx` —— 拆成两件事

现在这个文件里住着两样不相干的东西：**系统健康状态**（`SystemStateProvider`，
全局）和**会议数据**（`useMeetings()`）。后者只有会议记录页在用，住在这里
纯属历史原因，而它会让 F0 和 F2 抢同一个文件。

- `useMeetings()` **搬到 `pages/Meetings/useMeetings.ts`**（这一步照搬实现，
  仍然吃 mock；换真 API 是 F2 的事）。搬之前先 grep 确认除 `pages/Meetings/`
  之外没有别的消费者。
- `SystemStatus.tsx` 只留 `SystemStateProvider` / `useSystemState` / 状态条渲染。
- 按 **G-d** 接真实来源：`nas-down` 从 `GET /api/v1/admin/storage` 读，
  `tencent-down` 从 `GET /api/v1/admin/jobs` 里「拉取新录制」的最近运行推。
  **推断出来的那条要在界面上说清是推断**——文案是"最近 N 轮拉取连续失败"，
  不是"腾讯会议不可达"。
- 手动切状态的下拉框收进 `?proto=1`（与顶栏原型脚手架同一处置）。

### 3.5 `api/mock/` 的处置：留着，但只服务 `?proto=1`

不删。它是无后端时开发与截图的唯一手段，而 spec §7/§8 的五种形态本来就要能
一键复现。但**默认路径一步都不许碰它**——"看起来能跑，其实是假数据"是这一轮
最需要防的事故。

做法：mock 的入口只在 `?proto=1` 下被 import，且原型模式在界面上有可见标记
（顶栏的原型脚手架已经有位置）。

### 3.6 F0 的验收

- `cd console && npm run test` 全绿，`npm run typecheck` 干净，`npm run a11y` 过
- 七条路由都能打开，六个空壳页显示各自的标题
- 会议记录页**行为完全不变**（还是 mock，F0 不动它的数据来源）
- 系统状态条在真实后端不可达时显示"加载失败"而不是假装正常

---

## 4. F2 · 会议记录页接真 API + 详情抽屉

**独占**：`console/src/pages/Meetings/**` · `console/src/api/admin/meetings.ts`（新）
**规格**：spec §4.2（主页面，F1 已做）· **§4.3（详情抽屉，本任务的主体）** · §9 键盘
**要点清单**：`<SCRATCH>/spec-pages.md` 第 1 节

F1 的 T6 已经把会议记录页**本身**做完了（分诊条、表格、批量操作、键盘操作），
跑在 mock 上。这个任务是两件事：换成真数据、把详情抽屉做出来。

### 4.1 换数据源时会撞上的三处形态差异

mock 与真 API 不是一一对应的，照着换会撞上这三处。**先想清楚再动手**：

1. **分页**。`mockApi.listMeetings()` 一次返回全部；真的 `GET /api/v1/admin/meetings`
   带分页与总数。表格因此要么分页要么增量加载，而分诊条的五个计数**不能**用
   当前页的行去算——它有自己的端点 `GET /api/v1/admin/meetings/triage`，
   拿当页数据现算会得到一个随翻页变化的"总数"。
2. **"今天"**。`MOCK_NOW` 把今天钉在 2026-08-23，`index.tsx` 里
   `useMemo(() => new Date(MOCK_NOW * 1000), [])` 那行的注释已经写明要换成
   `new Date()`。换掉之后所有相对时间（"7 天内到期"）才是真的。
3. **筛选与排序**。mock 时代是前端在内存里筛；真 API 的筛选参数在服务端。
   哪些筛选项服务端支持、哪些不支持，照 `<SCRATCH>/api-contracts.md` 办；
   **不支持的筛选项不要在前端偷偷补一个内存版本**——那样翻到第二页筛选就失效，
   而且用户看不出来。真支持不了就把那个筛选项去掉，并在任务报告里记为后端缺口。

### 4.2 删掉 `write.ts` 的状态推导（G-c）

按 G-c：写操作 = 发请求 + 重取，不做乐观更新。

- `applyWrite` 及其"推导下一个状态"的部分删掉
- **纯展示映射留下**：阶段名（`STAGE_NAME`）、理由归类的**呈现**规则
- 每个写操作要有 pending 态（按钮禁用 + 指示），失败要有可见的错误出口，
  不许静默失败
- `KEEP_DAYS = 30` 这个常量：延长多少天现在由后端决定并下发，
  前端不要再拿它算 `expiresAt`

删的时候读一遍 `write.ts` 的文件头注释——它记着这个形状栽过的四次，
每一条都是在说"改了状态却不改与之绑定的理由"。换成真 API 之后这个风险
转移到后端（那边有测试），但**前端仍然不许自己拼 `why`**：
界面上显示的理由一律来自后端下发的 `why`。

### 4.3 详情抽屉（spec §4.3）

这是本任务的主体。照 `<SCRATCH>/spec-pages.md` 第 1 节实现，其中这几条是硬要求：

- **四段对应产品模型四阶段**，每段带自己的判定理由
- 理由的呈现按来源分色（rule 中性 / hand 琥珀 / fail 红 / expired·wait·na 是
  生命周期原因，优先级高于权限原因）——这套映射 F1 已有，复用不要重写
- **人工改写**的入口在抽屉里，改写后该阶段标记为 `hand`
- **「撤销归档」的语义**在要点清单里有一条 2026-08-25 的定案，**逐字实现**
- 抽屉用 `src/ui/` 已有的浮层基座，焦点管理与 Esc 不要重新发明
- 历史记录来自 `GET /api/v1/admin/meetings/:meetingId/history`

### 4.4 测试

- 分诊条的计数走自己的端点，翻页不变（这是一条回归测试，写死）
- 每个写操作：pending → 成功后重取 → 界面更新；以及失败时的错误出口
- 抽屉的键盘可达性（Tab 循环、Esc 关闭、打开时焦点进入、关闭后焦点归还）
- 后端返回缺字段时不白屏——运行时校验抛出带端点名的错误，页面显示错误态

---

## 5. F3 · 自动规则页 + 规则编辑器

**独占**：`console/src/pages/Rules/**` · `console/src/api/admin/rules.ts`（新）
**规格**：spec §4.6（规则页）· §4.7（编辑器）· **§5 规则引擎语义（逐字实现，不能凭直觉）**
**要点清单**：`<SCRATCH>/spec-pages.md` 第 2 节

这一页最容易出的错是**前端自己实现一遍求值语义**然后与后端说法不一致。

- **三栈（fetch / archive / allow）各自独立求值**，优先级降序、同优先级按 id 升序、
  首个命中即停、**不合并**。这套语义前端只用于**呈现**（"这条规则排第几、会不会被
  上面那条挡住"），**判定结果一律来自后端**。
- 影响预览走 `POST /api/v1/admin/rules/preview`，**不要在前端算**。
  spec §5.5 定义了预览的计算范围，前端算一遍就是第二份真相。
- `GET /api/v1/admin/rules/:id/matches` 是"这条规则现在命中哪些会议"。
- 条件构建器要覆盖 §5.3 的全部字段与运算符。**字段与运算符的清单以后端为准**——
  前端硬编码一份清单，后端加了新运算符前端就不知道；照契约文档办，
  如果后端没有下发清单的端点，记为缺口。
- **G-b 的类型放这里**：`Rule` / `RuleCondition` / `PreviewResult` 定义并导出自
  `api/admin/rules.ts`，不进 `api/types.ts`。

危险点：**空标题这类"事实缺失"与"事实为空"必须分得开**。阶段 4 的 T13 修的就是
这个洞——把 NULL 标题折成空串，会让 `title 含 X → deny` 落到宽松的一侧。
规则编辑器在展示"这条规则会命中什么"时不能重新引入这个折叠。

---

## 6. F4 · 采集授权页 + 接入向导

**独占**：`console/src/pages/Consumers/**` · `console/src/api/admin/programs.ts`（新）
**共用**：`api/admin/grants.ts`（F0 已建）
**规格**：spec §4.5 · §6.4
**要点清单**：`<SCRATCH>/spec-pages.md` 第 4 节

- **`Consumer.scope` 这一轮要删掉**。`api/types.ts` 里它的注释已经写明理由：
  真实的 `GET /api/v1/admin/programs` 不下发这个字段，mock 里那个配置串
  （'AI 纪要 + 完整转写'）伪装成了一次实际结果。
  **正确来源是 `GET /api/v1/admin/programs/:id/inventory` 的 `assetTypes`**，
  逐程序一个请求。删 `scope` 时连 mock 里的一并删。
- 那句"这个程序实际能取到什么"的话是**这一页的全部价值**，spec 里明说它
  **是三个「与」求交之后的实际结果，不是配置值**。要点清单第 4 节有逐字要求。
- 接入向导四步，照要点清单。
- **停用程序 / 轮换凭据这一轮不做**（G-e / G-h：端点还没有，A8 之后由 F7 补）。
  不要放一个点了没反应的按钮——现在就不放。

---

## 7. F5a · 定时任务页

**独占**：`console/src/pages/Jobs/**` · `console/src/api/admin/jobs.ts`（新）
**规格**：spec §4.8
**要点清单**：`<SCRATCH>/spec-pages.md` 第 5 节

- 四个任务格子 + 每个一条 sparkline（失败那次是红的），数据来自
  `GET /api/v1/admin/jobs`
- **失败项不会静默丢弃**：下方的「失败项 · 需要处理」表要显示影响
  （"未归档，到期会永久丢失"）与已重试次数（`2 / 5`）。这是 spec 写死的。
- 手动触发走 `POST /api/v1/admin/jobs/:name/run`
- **「新建任务」按钮不做（G-g）**。原型里那个按钮点了弹"还没做"，
  这一轮的处置是**删掉它**，并在 `docs/console/spec.md` §10（明确不做）加一行、
  §11 缺口 3 标注为「已裁定不做，见 §10」。
- 这一页同时是 `tencent-down` 的来源（G-d）：「拉取新录制」连续失败即视为
  腾讯会议不可达。**这个推断的措辞在两处必须一致**——本页与系统状态条。

---

## 8. F5b · 归档存储页

**独占**：`console/src/pages/Storage/**` · `console/src/api/admin/storage.ts`（新）
**规格**：spec §4.9
**要点清单**：`<SCRATCH>/spec-pages.md` 第 6 节

> **依赖 A8**：`nas.failedMeetings` 现在恒为 `null`（handler 还没接上
> `job_failures`，见 §11.3）。**这一轮先照 `failedMeetingsNote` 显示"暂不可得"，
> 不要编一个数，也不要拿"归档中"顶替。** A8 合进来之后这一格自然点亮。

- 两块：NAS 归档（挂载点/协议/连通状态/最近检测/容量三分/归档三态计数）与
  本地保留窗口（保留期内/其中已授权/7 天内到期/本地占用）
- 三个动作：改默认保留天数 · 导出可采集清单 · 立即清理已到期文件。
  **「立即清理」是不可逆操作**，要二次确认，且确认框里要说清删的是什么、
  留下的是什么。
- **页面底部那段话必须留着**（spec 逐字给出）：到期只删本地文件，
  数据库记录永久保留。它是产品模型的复述，不是装饰。
- 这一页是 `nas-down` 的来源（G-d）。

---

## 9. F5c · 操作审计页

**独占**：`console/src/pages/Audit/**` · `console/src/api/admin/audit.ts`（新）
**规格**：spec §4.10
**要点清单**：`<SCRATCH>/spec-pages.md` 第 7 节

- 数据来自 `GET /api/v1/admin/audit`，筛选维度照契约文档
- **时间是 unix 秒不是毫秒**。阶段 4 有两个独立的实施者都在这一列上栽过
  （`audit_log.occurred_at` 的注释一度写成毫秒）。格式化走 `lib/format.ts`。
- `audit_log.detail` 是阶段 4 新加的 TEXT 列（008），里面是这次操作的细节。
  它可能为 NULL（这条列加进来之前的历史记录），**为 NULL 时显示"无细节"
  而不是空白**——空白让人以为是渲染坏了。

---

## 10. F6 · 内容预览页

**独占**：`console/src/pages/Preview/**` · `console/src/api/admin/content.ts`（新）
**规格**：spec §4.4 · §2（只读留痕）
**要点清单**：`<SCRATCH>/spec-pages.md` 第 3 节

- 三个 tab（纪要 / 时间轴 / 转写文字）+ 贯穿三者的播放器联动区，
  以及右下角的「这场会议的资产与去向」——**它不是 AI 问答框**，
  要点清单第 3 节专门写了这一条。
- **章节数据这一轮拿不到**：阶段 4 的 T16 裁定 `GET .../content/chapters` 恒返回
  空 `chapters` + `source: 'none'`，同时从转写的时间戳给出 `cues`。
  所以时间轴 tab 的形态是「按转写时间戳切分」而不是「按章节」，
  **界面上要说清这一点**，不要拿 cues 冒充章节。
- **管理员查看会议内容会留痕**（spec §2），两条端点后端都已经在记。
  前端不需要额外做什么，但**不要为了"省一次请求"把内容缓存起来复用**——
  那会让留痕少一条，而留痕的价值恰恰在于完整。
- 打开时的初始状态有明确写死的规则，见要点清单。

---

## 11. A8 · 后端补三个缺口（F7 的前置）

**独占**：`src/**` · 一份新迁移 `009_admin_roles.sql`
**规格**：spec §2（角色与权限）· §11 缺口 1 / 4 / 5

这是阶段 5 里唯一改后端的任务。**它必须在 F7 之前合进主干**——否则 F7 只能造假按钮。

### 11.1 只读角色（缺口 1）

`admin_accounts` 现在只有 id / username / password_hash / created_at。

- 迁移加一列 `role VARCHAR(16) NOT NULL DEFAULT 'admin'`，取值 `admin` / `readonly`。
  **迁移的两条硬约束照旧**：`.sql` 里任何地方（注释也算）不许出现分号，
  DDL 每次启动都会重跑，所以 `ALTER TABLE` 要走 `information_schema` 判断 +
  `PREPARE`/`EXECUTE` 的守卫写法（照 `008_job_runs.sql` 加 `detail` 列那段抄）。
  默认值 `'admin'` 是**必须的**：已有账号不能因为加了一列就全变成只读。
- `requireAdminAuth` 把角色带进上下文
- **每一个写 handler 拒绝 readonly**，返回 403 并说明原因。
  "写 handler"的清单要一条条数过——`GET` 之外的全部 admin 端点，
  加上 `GET .../content` 这两条（它们会写审计，但读内容本身是只读角色该有的权限，
  **这两条允许 readonly**，留痕照记）。
- `GET /api/v1/admin/auth/me` 下发 `role`，前端照它降级
- **测试**：每个写端点各有一条"只读账号被 403 挡住"的用例。少一条就是一个洞。

### 11.2 停用程序 / 轮换凭据（缺口 4）

`service_accounts` 已经有 `enabled` 与 `secret_hash`，所以是补端点不是建模型。

- `PATCH /api/v1/admin/programs/:id` —— 改 `enabled`
- `POST /api/v1/admin/programs/:id/rotate-secret` —— 生成新 secret

**轮换的安全要求写死在这里**：新 secret 只在这一次响应里返回明文，库里只存 hash；
响应里要说明"这是唯一一次能看到它的机会"。**不许**提供任何"再看一次"的端点——
那等于把 hash 存储的意义抵消掉。

停用一个程序之后，它已有的授权怎么办？**裁定：授权保留，但 `AccessGate` 因
`enabled = 0` 一律拒绝。** 理由：停用是一个可逆动作，连带删授权会让"停用再启用"
变成一次不可逆的数据丢失。

两条都进 `audit_log`。

### 11.3 归档失败数接上 `job_failures`（阶段 5 侦察时发现）

`GET /api/v1/admin/storage` 现在返回 `nas.failedMeetings: null` 配一句
`failedMeetingsNote: "归档失败项尚未落库…"`。这句话在阶段 4 之前是对的，
但 **T-A4 已经把 `job_failures` 建起来并让 `src/worker/archive.ts` 往里落行了**，
数据现在有了，只是这个 handler 还在照旧报 null。

- `failedMeetings` 从 `job_failures` 里 `job_name = 'archive_nas'` 的未解决行数取
- `failedMeetingsNote` 随之删掉——它现在描述的是一个已经不成立的状态，
  留着比没有更糟
- spec §4.9 的「已归档 / 归档中 / 归档失败」三态因此才是完整的

### 11.4 修改密码（缺口 5）

`POST /api/v1/admin/auth/password`，请求体 `{ currentPassword, newPassword }`。

- **必须校验 `currentPassword`**——只凭会话 cookie 就能改密码，等于一次 XSS
  就能永久接管账号
- 改密码后**吊销该账号的其它会话**（`admin_sessions` 里同 `admin_id` 的行），
  当前这一条留着，否则用户改完密码立刻被踢出去
- 密码强度门槛与建号那条路径共用同一份校验（`90036a2` 已经把两条路径统一过一次，
  不要在这里第三次各写一份）
- 进 `audit_log`，**detail 里不许出现密码本身或它的任何片段**

---

## 12. F7 · 前端补缺口（串行，A8 之后）

**跨页**，所以放在最后一个人做，不并行。
**规格**：spec §11

四件事（缺口 3 已按 G-g 裁定为不做，由 F5a 删按钮）：

1. **只读角色降级**。`auth/me` 下发的 `role` 为 `readonly` 时，
   所有写入口隐藏或禁用。**要点：禁用比隐藏好**——隐藏会让只读用户以为
   这个功能不存在，禁用 + 一句"只读账号不能改"说明了真实情况。
   用户菜单里那句"数据管理员 · 可改规则与授权"要随角色变。
   **前端的降级不是权限**，权限在 A8 的 403；这一层只是别让人白点。
2. **移动端卡片化降级**。表格现在 `min-width: 1020px`，窄屏只能横向滚动。
   375px 下换成卡片。spec 里那张 `screens/20-移动端-375px.webp` 是现状不是目标。
   分诊条、导航条一并处理。
3. **轮换凭据 / 停用程序**的两个动作加到采集授权卡片上（用 A8 的新端点）。
   轮换后的新 secret 用一次性展示的形态——可复制、明说只显示这一次。
4. **账号设置 / 修改密码**，用户菜单里的入口（用 A8 的新端点）。

5. **停用的程序在采集授权页上要显示成停用**，并且**它的采集清单要停止报"N 场可取"**。
   A8 发现 `worker/visibility.ts` 的清单重算**不看 `enabled`**：
   `GET /programs/:id/inventory` 会对一个已停用的程序照常算出「N 场可取」，
   而网关那一侧现在会拒。这正是 spec §1.3 要防的漂移方向——
   **控制台说准许、程序去取的时候被拒**。

   A8 没改它，因为 `visibility.ts` 同时被调度器的清单重算任务读，动它会牵到那一侧。
   **F7 先在前端把停用的卡片标出来并把清单数字换成"已停用"**；
   根治（让 `visibility.ts` 也看 `enabled`）留给后续，记在这里免得忘。

---

## 13. 编排与验收

### 13.1 派活顺序

```
第一波（串行）  F0 地基 —— 合进主干后才派下一波
第二波（并行）  F2 · F3 · F4 · F5a · F5b · F5c · F6   七个工作树，两两不相交
第三波（串行）  A8 后端补口
第四波（串行）  F7 前端补缺口
```

第二波的七个任务**每个一个独立 git worktree**。派活的 brief 里必须带上：
**禁用 `git stash -u` 与 `git reset --hard`**——共享工作树时它们卷走过别人的
未跟踪文件。

新工作树的引导：前端任务要 `cd console && npm install`（`node_modules` 不在 git 里，
新树是空的，不装就连 `npm run test` 都跑不起来）。**A8 是唯一的后端任务**，
它另外还要 `cp` 一份 `.env.test`（gitignored，新工作树里没有）——
`tests/helpers/testdb.ts` 的 `withTestDb()` 靠里面的 `TEST_DATABASE_URL` 建库。

### 13.2 每个任务的完成门槛

- `cd console && npm run test` 全绿
- `npm run typecheck` 干净
- `npm run a11y` 过
- 明/暗两套主题都看过，对比度达标
- 375px 宽度下不横向滚动（F7 之前允许表格滚动，其余不许）
- 任务报告写进 scratchpad，**不进主干**（这个仓库没有 `task-*-report.md` 的历史）

### 13.3 阶段 5 的整体验收

- 七个页面全部跑在真实 API 上，`api/mock/` 只在 `?proto=1` 下被 import
- 断开后端时每一页都显示明确的错误态，没有白屏、没有假装正常
- 只读账号登录后，每一个写入口都是禁用的，且点不动的原因写在界面上
- spec §11 的五个缺口：四个做完，第三个（新建定时任务）在 §10 里记着为什么不做

### 13.4 阶段 5 之外仍然欠着的

- **§4.5 AI 纪要延迟探测**——M3.5 四条机制里唯一没跑过真实验证的，
  要一场刚结束、纪要还没生成的会议才触发得了
- **F9 · 前端接 A9 的两条新契约**（唯一还没派的任务）。A9 把审计的 28 个动作
  标签与规则的条件字段清单收回了后端，但 `console/` 仍在读自己那四份镜像——
  **在接线之前这一轮实际上多了一个会变的源头，漂移窗口比之前更宽**。
  它会碰 `pages/Rules/` 与 `pages/Audit/`，而 F7 正在给所有页面加只读降级，
  两者会撞，所以排在 F7 之后。

- **spec §5.3 与实现的落差：`host` 说是"人员选择器"，三份实现都是自由填 userid**。
  A9 核对三份字段清单时翻出来的，**唯一一处此前没被记在案的**。
  要么把 spec 改成自由填，要么真做一个选择器——它需要一个"按名字搜人"的端点，
  而那要接企微通讯录。**先记在这里，不要默默让 spec 和实现各说各的。**

- **运算符的中文名 / 单位 / placeholder 后端没有这份数据**，所以 F9 接线之后
  前端仍然要自己造一小份。这是一份比原来小得多的镜像，但仍是镜像。
  另外 `dept` 的"为什么不可用"两处是两句话，后端那句会让人以为等一等就有了。

- **内容预览的播放器播不了录像**（F6 报的）。唯一能签直链的端点走采集程序 JWT，
  管理员会话签不出来，响应里也没有它要的 assetId。现在的处置是如实说明 +
  NAS 去向 + 一条走时的位置游标（三处联动挂在游标上）。真要能播，
  **需要补一条管理员维度的直链签发端点**。

- **`worker/visibility.ts` 的清单重算不看 `enabled`**。停用的程序在采集授权页
  照常算出「N 场可取」，网关那侧却会拒——spec §1.3 要防的漂移方向。
  F7 先在前端挡住（显示「已停用」而不是一个会骗人的数字），
  **根治要动 `visibility.ts`，而它同时被调度器的清单重算任务读**。

- **A8 上线前要跑一句核对**。A8 给 `AccessGate` 补上了 `enabled` 判断——
  在此之前「停用程序」这个动作**根本没生效**：`enabled` 只在拿凭据换访问令牌时
  检查过，而访问令牌是 JWT，签出去之后到自然过期为止服务端不再查库。
  补上之后有一个有意的副作用：**一条 allow 规则不再足以放行，程序本身得存在且启用着**。

  所以上线前先跑：

  ```sql
  SELECT DISTINCT r.subject_value
    FROM policy_rules r
    LEFT JOIN service_accounts s ON s.id = r.subject_value
   WHERE r.kind = 'allow' AND r.subject_type = 'program' AND s.id IS NULL
  ```

  有结果就说明生产库里存在「规则里有、`service_accounts` 里没有」的程序
  （手工插过规则，或者 seed 与建号脚本用过不同的 id）。这些程序会在上线之后
  **从「取得到」变成「取不到」**，理由显示成「程序已停用或已不存在」。
  先建号或改规则，再上线。

- **A7 上线后建第一条拉取规则**——部署本身不需要动作（走兼容兜底），
  但建下第一条的那一刻兜底翻面，第一条应当是无条件"全拉"，
  确认日志 `mode=governed` 且 `fetched` 数与原先的 `meetings` 数吻合之后再逐步收紧
