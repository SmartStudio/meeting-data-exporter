# YAO-DATA 会议数据管理 · 控制台

管理员用的 Web 控制台。腾讯会议的录制与纪要从这里被拉下来、归档进 NAS，
在本地保留一个窗口期，期间按规则和授权被外部程序取走。

- 状态：**已上线**。2026-09-20 部署到生产（阿里云 ECS + Docker Compose + RDS）。
  六个阶段的后端与前端 F1-F9 都在生产运行。
- 规模：`src/http/router.ts` 的 `ROUTES` 是 54 条（其中 `/api/v1/admin/*` 41 条），
  `migrations/` 16 份，前端 8 个页面（Audit · Consumers · Jobs · Login · Meetings ·
  Preview · Rules · Storage）全部接真实 API。
- 部署形态：镜像在 `node:22-alpine` 阶段跑 `npm run build` 构出 `console/dist`，
  拷进运行镜像，网关按 `MDE_CONSOLE_DIST` 把它挂在根路径。控制台不是独立服务。
- 所属：yaowu-ai / meeting-data-exporter，子项目 5。
- 路线图 M5「子项目 4 桌面应用」已决定无限期推迟，理由见
  [`backend-gap.md` §6](backend-gap.md#6-与路线图的关系已决策)。

---

## 这个目录里有什么

| 文件 | 是什么 | 谁看 |
| --- | --- | --- |
| [`spec.md`](spec.md) | 功能说明书。逐页的行为、规则引擎语义、数据模型、状态机。**本目录唯一的现状来源** | 写后端和前端的人 |
| [`design-system.md`](design-system.md) | 设计系统。令牌、排版、颜色语义、状态规范、无障碍基线 | 写前端的人 |
| [`backend-gap.md`](backend-gap.md) | 2026-08-23 的立项快照：原型要求 vs 当时的网关能力，逐条带落点。G1-G10 十条已于 2026-08-27 全部闭合，它记的是「当初缺什么、各自落在哪个阶段」 | 查历史的人 |
| [`dev-plan.md`](dev-plan.md) | 2026-08-23 的研发计划快照：阶段拆解、并行编排、CLI 整合方案、开工前的七处冲突 | 查历史的人 |
| `prototype/gate-console.html` | 可运行的单文件原型，所有交互都是真的 | 所有人 |
| `prototype/tokens.css` | 设计令牌的历史快照。权威在 `console/src/styles/tokens.css` | 写前端的人 |
| `screens/*.webp` | 22 张原型图，含全部异常态 | 所有人 |

## 怎么跑前端

```bash
cd console && npm ci && npm run dev
# 默认端口 5273。/api 转发到 http://localhost:3000，换端口设 MDE_GATEWAY_ORIGIN
# 直接访问        → 接真后端，需要网关跑在本地
# 访问时带 ?proto=1 → 走 api/mock/ 那份假后端，不需要后端
```

`node_modules` 不在 git 里，新工作树不 `npm ci` 连 `npm run test` 都跑不起来。
`?proto=1` 答全部读端点，断网或没有后端时也能把八个页面走一遍，顶栏还会多出一个
「系统状态」下拉用来调出异常态。

其余 npm 脚本（`console/package.json`）：`build`（先 `tsc --noEmit` 再 `vite build`）、
`preview`、`test`（vitest，不能用 `bun test` 跑）、`typecheck`、`a11y`、`vqa`。

## 怎么看原型

原型是形态的权威，行为规格仍以它为准。

```bash
open docs/console/prototype/gate-console.html
```

直接双击也行，没有构建步骤和外部依赖。Google Fonts 是唯一的外部请求，断网时会退回
系统字体，布局不受影响。

进去之后：

- 登录页随便点「登录」就进，不校验
- 顶栏有一个 `状态：正常` 下拉，能把平时看不到的形态调出来：加载中、加载失败、
  一场会议都没有、NAS 断连、腾讯会议不可达。这五个形态是规格的一部分
- 会议列表里点标题进内容预览（走时条 + 纪要 + 时间轴 + 转写）
- 快捷键：`j`/`k` 上下移动、`空格` 选中、`回车` 打开详情、`1`/`2`/`3` 拉取/归档/授权、
  `e` 延长保留、`p` 预览内容、`/` 搜索

## 读文档的顺序

1. `spec.md` §1 产品模型。这套系统的四个阶段和三个「与」条件是所有界面的骨架，
   不读这一节后面看不懂
2. `spec.md` §5 规则引擎语义，最需要逐字实现的一节
3. `spec.md` §11 已知缺口，当前还没做的事都登记在那张表里
4. `backend-gap.md` 与 `dev-plan.md` 是历史快照，查「当初为什么这么排」时看
5. 逐条用户故事的实现覆盖率明细见
   [用户故事 §9.4](../superpowers/specs/2026-07-20-user-stories.md)。只有那一处有明细，
   本目录的文档一律引用它，不各抄一份

## 重要前提

原型里的所有数字都是编的（会议数、容量、耗时、命中数）。原型证明的是形态与信息结构，
不是任何真实统计。顶栏那个 `原型 · 全部数字为示例` 的标记就是干这个用的。
