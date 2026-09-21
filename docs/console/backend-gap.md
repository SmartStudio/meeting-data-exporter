# 控制台 vs 现有后端：差距分析

- 日期：2026-08-23
- 本文是 2026-08-23 的规划快照。六个阶段已全部完成，系统于 2026-09-20 上线，现状见 [`spec.md`](spec.md)。
- 用途：排开发计划的输入。逐条给出「原型要求什么 / 现在有什么 / 缺什么 / 落点」
- 前置阅读：[`spec.md`](spec.md) §1 产品模型
- 本文是立项时的快照，「现状」列停在 2026-08-23，这个定位不变。
  它回答的是「当初缺什么、各自落在哪个阶段」，不回答现状。
- G1-G10 十条已于 2026-08-27 全部闭合（§2 的进度列已刷新）。缺口的当前状态以
  [`dev-plan.md` §3](dev-plan.md) 为准；十条都闭合之后剩下的是欠账，不是缺口，
  见 [`dev-plan.md` §8](dev-plan.md)

---

## 0. 一句话结论

现有网关做的是「管理员按需导出」：`mde` CLI 问网关要清单、拿下载链接、把文件
拉到本地。控制台要的是「系统持续归档 + 到期清理 + 外部程序按授权取用」。

两者的存储生命周期模型完全不同。现有链路里文件拉下来就结束了；控制台的模型
里，文件拉下来只是第一步，后面还有归档、保留窗口、到期清理三段，而这三段在立项时
一行代码都没有。

> 2026-08-25 补记：这三段的后端逻辑已在阶段 2 落地（2026-08-24）。写于当时的判断是，
> 能力已经有了，缺的是入口：没有控制台 API（A2-A6）也没有界面（F2-F7），所以管理员
> 当时看不到、也点不了这三段中的任何一段。

> 2026-08-27 补记：写于 2026-08-27 时的判断是，上面那条「缺入口」已整体不成立，
> 换成了「缺部署」。
>
> 08-25 之后阶段 3/4/5 连着做完（08-25～08-27）：`src/http/router.ts` 的 `ROUTES`
> 当时是 51 条（`/api/v1/admin/*` 37 条），前端 8 个页面
> （Audit · Consumers · Jobs · Login · Meetings · Preview · Rules · Storage）全部接真实
> API，9 份迁移，后端 1404 测试全绿。入口在代码里已经建齐。
>
> 写于 2026-08-27 时的判断接着说：入口还没有被安装到任何机器上，而且仓库里不存在
> 让它被安装的路径。
>
> 1. `Dockerfile` 只 `COPY src scripts migrations package.json`。`packages/` 不在镜像里，
>    而 `src/` 有 19 个文件 import `@yaowu/mde-engine`，其中包括 `src/worker/*`，
>    也包括网关自己走的 `src/policy/access.ts:32`（`import { GATEWAY_TYPE_TO_ASSET_KEY }`，
>    是值导入，不是类型导入）与 `src/http/handlers/console/{meetings,rules}.ts`。
>    也就是说按当时的 `Dockerfile` 构出来的镜像里，网关自己也 import 不动。
>    deps 阶段只 `COPY package.json bun.lock` 后跑 `bun install --frozen-lockfile`，
>    而 `workspaces: ["client", "packages/*"]` 的成员一个都不在，`@yaowu/mde-engine`
>    这条 workspace 链接根本无从建立。
> 2. `Dockerfile` 也不 COPY `console/`，网关不 serve 任何静态文件
>    （`src/http/router.ts` / `src/index.ts` 里没有 static / `Bun.file` 的痕迹），
>    `docs/deploy.md` 里没有一句控制台部署。控制台前端在当时从没被任何人打开过。
>
> 配套事实（2026-08-26 实测）：生产 `/home/ubuntu/mde/app` 只有网关，无 `packages/`、
> 无 worker 进程、无 crontab，`migrations/` 只有 001 而库里的表到 003，所以
> `job_runs` / `job_failures` / `meeting_asset_probes` 这几张表在当时的生产上根本不存在。
>
> 逐条的下一步见 [`dev-plan.md` §7](dev-plan.md)。
>
> 以上两条判断在 2026-09-20 上线后都已作废：路由表现在是 54 条，其中
> `/api/v1/admin/*` 41 条，迁移 16 份，控制台前端由网关托管。现状见 [`spec.md`](spec.md)。

---

## 1. 现有网关有什么

14 个端点（`src/http/router.ts`）。这是 2026-08-23 的数，2026-08-27 复核时是 51 条
（`ROUTES` 数组，其中 `/api/v1/admin/*` 37 条；按 `compile(` grep 会数出 52，
多出来的那一行是 `function compile` 的定义本身）。下面这份留作立项时的对照：

```
POST /api/v1/auth/device/code        设备授权（企微扫码）
POST /api/v1/auth/device/token
GET  /auth/wecom/callback
GET  /device
POST /api/v1/auth/refresh
POST /api/v1/auth/service-token      服务账号换 token
POST /api/v1/auth/logout
GET  /api/v1/meetings                列会议
GET  /api/v1/meetings/:id
GET  /api/v1/meetings/:id/assets     列资产
POST /api/v1/assets/:assetId/download-url   换下载直链
GET  /webhook/tencent-meeting        STS 回调（GET 校验 / POST 推送）
POST /webhook/tencent-meeting
GET  /healthz
```

可复用的模块：

| 模块 | 现状 | 对控制台的价值 |
| --- | --- | --- |
| `tencent/` 签名 + 限流 + 分页 | 完整 | 直接复用，拉取任务的底座 |
| `sts/manager` STS 生命周期 | 完整（含看门狗） | 直接复用，AI 纪要的前置 |
| `catalog/` 资产清单 | 完整 | 直接复用 |
| `policy/engine` 策略引擎 | 单栈、表达式式 | 要改，见 §3 |
| `audit/recorder` | 写侧完整 | 要补读侧 |
| `auth/service` 服务账号 | argon2id、明文只出现一次 | 直接复用，采集程序凭据 |
| `store/meetings` 会议缓存 | 机会性 upsert | 要扩，见 §4 |
| `client/` 下载引擎 | 断点续传、幂等、SQLite 队列 | 可复用为归档任务的执行器 |

---

## 2. 缺口总表

按「不做就没法开工」排序。

「现状」列是 2026-08-23 的快照，「进度」列在 2026-08-27 刷新过一次。

| # | 缺口 | 现状（立项时） | 规模 | 进度（2026-08-27 复核） |
| --- | --- | --- | --- | --- |
| G1 | 归档到 NAS 的流水线 | 无。`storage` 是接口，NAS 适配器属 M4 未做 | 大 | ✅ 阶段 2 P1+P2（代码成立；生产从没跑过，见 §0 的 08-27 补记） |
| G2 | 保留窗口与到期清理 | 完全没有 | 中 | ✅ 阶段 2 P3（同上） |
| G3 | 三栈规则引擎 | 有单栈策略引擎，语义不同 | 中 | ✅ 阶段 3 R1（2026-08-25，`policy/{conds,stacks,access}.ts`；旧 `engine.ts`/`expr.ts` 已删） |
| G4 | 逐会议 × 逐程序授权 | 无。现在是策略模板匹配，没有 per-meeting grant | 中 | ✅ 阶段 3 R3（2026-08-26，`migrations/005` + `store/grants.ts` + `policy/override.ts`） |
| G5 | 定时任务调度器 | 只有 STS 续期的 `setInterval` | 中 | ✅ 阶段 4 A4（2026-08-26，`migrations/008` + `worker/scheduler.ts`；生产无 crontab、无 worker 进程） |
| G6 | 控制台 API + 管理员会话 | 无任何管理端点；无管理员 Web 会话 | 大 | ✅ A1 + A2-A6 + A8/A9 全做完。`ROUTES` 51 条，其中 `/api/v1/admin/*` 37 条 |
| G7 | 会议列表的查询能力 | `listMeetings` 直通腾讯，无分页/筛选/统计 | 中 | ✅ 阶段 4 A2（`store/console-meetings.ts` + `handlers/console/meetings.ts`）。唯一没做的是时间范围筛选，见 [`dev-plan.md` §8](dev-plan.md) |
| G8 | 审计读侧 | 只写不读 | 小 | ✅ 阶段 4 A5。读侧齐了，写侧还有两个洞（管理员登录/登出、调度器的到期清理都不落行），见 [`dev-plan.md` §8](dev-plan.md) |
| G9 | 内容读取（纪要正文 / 转写 / 章节） | 网关只给下载链接，不返回内容 | 中 | ✅ 阶段 4 A6（`migrations/007` + `store/contents.ts`）。章节恒空（`source: 'none'`，无数据源，如实报缺） |
| G10 | NAS 连通与容量探测 | 无 | 小 | ✅ 阶段 2 P4 |

十条全部闭合。上一次复核（2026-08-25）时这一列还有六条 ⬜ 和一条 🟡，
阶段 3/4/5 在 08-25～08-27 三天里连着做完，整列因此翻面。

但闭合的判据一律是「代码成立 + 测试绿」，不含「真实环境验证过」。本文档全程按
这个口径写：G1/G2/G5 三条标注的「生产从没跑过」是 2026-08-26 上机实测的
结论（生产只有网关）。逐条用户故事的覆盖率明细见
[用户故事 §9.4](../superpowers/specs/2026-07-20-user-stories.md)，本文不重复。

---

## 3. G3 · 规则引擎要怎么改

现有 `policy_rules` 表（`migrations/001_init.sql`）已经有一半：

```sql
priority      INT           -- ✅ 有优先级
subject_type  VARCHAR(16)   -- 主体（谁）
subject_value VARCHAR(128)
resource_expr JSON          -- ⚠️ 表达式，控制台要的是结构化条件
asset_types   JSON          -- ✅
effect        VARCHAR(8)    -- ✅
enabled       TINYINT(1)    -- ✅
```

要补的：

| 要补 | 说明 |
| --- | --- |
| `kind` 列 | 三类规则（`fetch` / `archive` / `allow`）现在挤在一张表里没有区分。三栈各自独立求值，兜底还不一样（`allow` 兜底 deny，其余 skip） |
| 结构化条件 | `resource_expr` 是表达式；控制台的条件构建器产出 `{ join, conds: [{f, op, v}] }`。要么换表示法，要么在两者之间做双向转换，后者会长期漏语义，建议换 |
| `note` / `author` / `created_at` | 规则说明会出现在每场会议的判定理由里，是产品的一部分，不是备注 |
| 影响预览 | 需要一个「拿一份候选规则集，对会议全集重算」的纯函数入口，且不落库 |

求值语义必须逐字实现（见 [`spec.md` §5](spec.md#5-规则引擎语义)）：
优先级降序、第一条命中的说了算、不合并不叠加、人工改写优先于所有规则。

---

## 4. G7 · 会议列表

现在 `GET /api/v1/meetings` 是直通腾讯的（`tencent/records.ts` 按时间窗分页拉）。
控制台需要的是本地库里的查询：

- 分诊条的五个计数（归档失败 / 7 天内到期 / 待授权 / 处理中 / 仅存 NAS）
- 按标题 / 会议号 / 主持人搜索
- 按保留期内、已授权、有人工改写筛选
- 分页
- 每行要带四个维度的状态 + 判定理由 + 授权列表 + 保留窗口

`store/meetings` 现在只是个机会性缓存（列会议时顺手 upsert 一份供策略引擎用），
字段远不够。这张表要扩成控制台的主表。

---

## 5. G6 · 认证要分清三条线

现有两条，控制台要加第三条：

| 线 | 谁 | 现状 |
| --- | --- | --- |
| 设备授权（企微扫码） | 真人用 CLI / 桌面端 | ✅ 已实现（当前部署下四条设备流程路由返 501，`f4adb3c`） |
| 服务账号 | 采集程序 | ✅ 已实现（argon2id，明文只出现一次） |
| 管理员 Web 会话 | 控制台 | ~~❌ 无~~ → ✅ 已实现（A1，2026-08-24）：`admin_accounts` / `admin_sessions` + `src/auth/admin.ts`；2026-08-26 的 A8 又加了 `role` 列（`migrations/009`）与只读角色 |

控制台的登录页是账号密码 + 「记住此设备 30 天」，这和企微扫码不是一回事。

> 已定（2026-08-23）：独立账号体系，账号密码，明确不做企微登录。
>
> M2 的「企微账号、无独立体系、无 SSO」说的是谁能导出数据的身份映射，
> 不覆盖谁能进运维面板。控制台是 1 到 3 个人用的运维面板，且它要在
> NAS 断连、企微不可达这类故障时可用，登录不能依赖另一个可能同时挂掉的系统。
>
> 落点：`admin_accounts` 表 + `src/auth/admin.ts`，argon2id 与会话签发复用
> `auth/service.ts` / `auth/tokens.ts`。原型登录页不用改。

---

## 6. 与路线图的关系（已决策）

路线图（`docs/history/roadmap.md`）里：

```
M4  子项目 3   存储扩展（阿里云 OSS / NAS）   ← ✅ 已收敛为只做 NAS，随本项目阶段 2 交付（2026-08-24）
M5  子项目 4   桌面应用（Bun 内嵌 · Mac/Win 安装包）
               定位已定：管理员工具，服务几人到几十人   ← ⏸ 无限期推迟（2026-08-23）
```

控制台和 M5 桌面应用服务同一批人、干同一件事。

> 已定（2026-08-23）：M5 无限期推迟，但不取消。
>
> 桌面端的独占价值是「文件落在管理员自己的机器上」，而这件事 `mde` CLI 已经能做，
> 且更适合脚本化与定时。控制台补上「服务器持续归档」之后，两个场景都有了承接者，
> 桌面端夹在中间。将来真要做，也是 C 方案（内嵌 webview 复用控制台前端），
> 成本低一个数量级，所以更该等控制台前端做完。

原先的三个选项，留作记录：

| 选项 | 含义 |
| --- | --- |
| A. 控制台取代桌面应用 | M5 取消，子项目 5 接手 |
| B. 两个都做 | 桌面端管本机导出，控制台管服务端归档与授权 |
| C. 桌面端变成控制台的壳 | 内嵌 webview，复用同一套前端 ← 将来若做，走这个 |

另外，G1（归档到 NAS）与 M4（存储扩展）是同一件事的两面：M4 要做 NAS 适配器，
控制台要的归档流水线正好架在它上面。这两块应该合并规划，不要各做一遍。

---

## 7. 建议的开工顺序

> 2026-08-27：下面这五步全部走完了（第 2 步 2026-08-24 · 第 3 步 08-25～08-26 ·
> 第 4/5 步 08-26），前端也在 08-27 接完。这张图现在是执行记录，不是待办。
> 当前的下一步是部署，它不在这张图里，因为立项时没人想到「功能全做完、
> 镜像里却没有 `packages/` 和 `console/`」这种形态。见 [`dev-plan.md` §7](dev-plan.md)。

前提：M3.5 真实环境联调先过（那是投产门槛，与本文档无关但排在前面）。

```
第 0 步  §5 / §6 两个决策  ✅ 已定（2026-08-23）
            ↓
第 2 步  G1 + M4    归档流水线 + NAS 适配器（合并做）
         G2         保留窗口与到期清理（紧跟 G1，因为它依赖归档成功时间）
            ↓
第 3 步  G3         三栈规则引擎（含影响预览的纯函数入口）
         G4         逐会议 × 逐程序授权
            ↓
第 4 步  G6 + G7    控制台 API + 会议查询   ← 前端可以从这里开始接
         G5         定时任务调度器
            ↓
第 5 步  G8 G9 G10  审计读侧 / 内容读取 / NAS 探测
```

G2 必须紧跟 G1：保留窗口是「自归档成功日起算」的，没有归档就没有起算点。
反过来，只做 G1 不做 G2，系统会无限占满本地磁盘。

前端不用等到第 4 步才动工。原型已经是可运行的完整前端，可以先按 `tokens.css`
搭工程骨架、把原型的组件拆出来，等 G6 的 API 一到就接。

---

## 8. 本文之后

本文只回答「缺什么」。怎么排、谁先谁后、`mde` CLI 怎么并进来，见
[`dev-plan.md`](dev-plan.md)：其中 §1 是已拍板的三个决定（含本文 §5、§6），
§2 是 CLI 的三层整合方案，§5 列出了七处规格与现有实现互相矛盾的地方。
