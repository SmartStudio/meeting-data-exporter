# 阶段总结：子项目 2 · 核心导出引擎 + 客户端 CLI（M3）

- 阶段：meeting-data-exporter 子项目 2（`mde` 客户端 CLI）
- 起止：2026-07-23 立项 → 2026-07-23 合并 master（`251d8e0`）
- 状态：**已完成并合并**。client 58 tests 全绿，typecheck 干净；合并后仓库全量 337 tests 全绿
- 前置：M1 网关加固完成（网关可投产、对客户端 API 契约已定）

---

## 1. 这个阶段做了什么

交付了 `mde`——一个连接导出网关、把会议资产拉到本地并归档的命令行工具。它把子项目 1 建好的
「受策略管控的资产清单与临时下载地址」变成**真正能落到磁盘上的文件**。

它解决的核心矛盾是：**下载是长时、易断、会失败的过程，而管理员需要的是「跑一条命令，最终一定拿全」。**
答案是**数据库即任务队列**——把「要下什么」写进 SQLite，让断点续传、去重、崩溃自愈、
延迟产出的等待，全都退化成同一套状态机上的操作，而不是四套各自为政的特判逻辑。

## 2. 交付物

| 维度 | 数字 |
| --- | --- |
| 产品代码 | 900 行 TypeScript，22 文件，9 个模块目录 |
| 测试代码 | 957 行，14 文件，**58 tests / 154 断言全绿** |
| 端到端 | spec §16 十条必测全覆盖（假网关 + 真实 HTTP + 真实文件系统 + 真实 SQLite） |
| 文档 | README 155 行 + 设计 spec 396 行 + 实现计划 1733 行 |
| 提交 | 26 个（11 任务 + 5 轮复审修复 + 文档同步） |
| 交付形态 | `bun bin/mde.ts <命令>`，7 个命令 |

技术栈：Bun + TypeScript（strict）+ `bun:sqlite`（WAL）。代码落在仓库子目录 `client/`，
独立 `package.json`/`tsconfig.json`，**网关根目录零改动**。

### 模块结构

```
client/src/
├── domain/     领域类型与纯函数（资产键↔平台字段映射 · 31天窗口切分 ·
│               目录名清洗 · 就绪判定）——零依赖，被所有层复用
├── config/     env + 文件 + CLI flag 三层加载与校验
├── gateway/    网关客户端：服务账号认证 · 401 透明重取 · 会议/资产/下载地址
├── store/      bun:sqlite 四表 + 原子领租约 + 去重 upsert + 探测
├── storage/    存储抽象接口 + LocalStorage 实现（M4 只加实现类）
├── discovery/  选择器 → 取清单 → UPSERT 任务 + 建探测
├── downloader/ 单资产下载：Range 续传 · 416 · 换链 · 校验 · 原子 finalize
├── executor/   有界并发池 + 探测循环
└── cli/        命令分发 + 人读输出 + 顶层装配
```

## 3. 关键设计决策

| 决策 | 理由 |
| --- | --- |
| **数据库即任务队列**（bun:sqlite/WAL 为唯一事实源） | 断点续传、去重、崩溃恢复、延迟等待四件事退化成同一套状态机，而非四套特判 |
| **单语句原子领租约**（`UPDATE … WHERE id=(SELECT … pending OR 租约过期) RETURNING *`） | 一条语句同时完成「选中 + 置 running + attempts+1 + 返回」，并发不双领、崩溃后租约到期自动可重领 |
| **续传信 `.part` 实际大小，不信 DB `bytes_written`** | 崩溃时 DB 记账必然落后于磁盘；以磁盘为准则永远不会从错误偏移续传 |
| **写 `.part` + 校验后原子 `rename`** | 正式文件名的存在即「内容完整」的标志，中断绝不留下看似完整的半截文件 |
| **`asset_type` 存平台字段名**（字段驱动，不硬编码封闭联合） | 腾讯将来新增纪要引擎时，网关 emit 新字段即可，客户端无需改代码 |
| **去重靠 `UNIQUE + ON CONFLICT DO UPDATE`** | 无应用层「查-插」竞态；重复发现天然幂等 |
| **绝对 deadline（`end_time + 每类上限`），非重试次数** | AI 纪要产出可能延迟数小时；按次数会过早放弃，按绝对时间才符合业务语义 |
| **服务账号 + 无状态认证，本地不落任何凭证** | CLI 常跑在 cron 里；凭证只从 env 读、access_token 只在内存，泄漏面最小 |
| **`assetId` 全程当不透明串传递** | 网关已把 `meetingRecordId` 自包含进 assetId；客户端不解析、不重构，天然免疫格式变化 |
| **`storage` 从第一天就是接口** | M4 加 OSS/NAS 只新增实现类，`executor` 一行不改 |

## 4. 执行方式与并行

沿用子项目 1 的 subagent 驱动流程，每任务 fresh 实现 + 独立审查（规格合规 + 代码质量）+
修复复审，最后 opus 全分支终审。**11 个任务编排成 6 个批次**：

```
Batch 0（单独）    T1 脚手架 + domain/types           ← 阻塞全部
Batch 1（并行 5）  T2 domain纯函数 · T3 config · T4 store · T5 storage · T6 gateway
Batch 2（并行 2）  T7 discovery · T8 downloader
Batch 3/4/5（各单独） T9 executor → T10 cli → T11 e2e + README
```

七路并行**零合并冲突**。这不是运气——并行度是在「文件归属表」阶段设计出来的：
九模块按依赖 DAG 分层，四个零依赖的基础模块加一个准基础的 gateway 天然构成 Batch 1 的五路。
`gateway` 的签名刻意用内联结构类型而非 `config` 的 `AppConfig`，因此它不 import 尚不存在的
`config/`——每个 worktree 的依赖只指向 fork 点已固化的东西，不指向兄弟 worktree 里正在写的东西。

## 5. 审查拦下的缺陷

以下缺陷**在单元测试全绿的情况下依然存在**，靠不同层次的审查才暴露：

| 发现层 | 缺陷 | 若漏到生产的后果 |
| --- | --- | --- |
| 逐任务审查 | `parseAssetKeys` 用 `in` 判定合法键（走原型链） | `--assets constructor` 被当合法资产键，下游索引拿到非数值 |
| 逐任务审查 | `markSkippedByKey` 无状态守卫 | 按类跳过时**把已下载完成的段翻回 skipped**，静默丢弃成果 |
| 逐任务审查 | discovery 用 Map 塌缩同类资产 | **多段录制只下最后一段**，其余段无任务、无探测、无记录 |
| 控制器跨任务判断 | executor 自行重构 assetId | 对真实网关**取不到下载地址**（`meeting_id ≠ meetingRecordId`） |
| 实现者真跑冒烟 | `openDb` 不建 dbPath 父目录 | **全新 `--out` 首次运行必崩**——42 个测试全绿却没人能起步 |
| opus 全分支终审 | 多段文本类文件名碰撞 | 同类多文本文件互相覆盖 / 并发 `.part` 损坏 |

后两条尤其典型，它们不是「代码写错」：

- **`openDb`**：单测全用 `:memory:`，永远不碰文件路径，所以 42 个测试在结构上就无法暴露
  「真实路径需要先建父目录」。只有装配任务真跑 CLI 对假网关冒烟才逮到——
  **测试替身比真实依赖宽容**，与子项目 1 的设备登录缺陷同源。
- **文件名碰撞**：是修复「多段塌缩」时**引入的新暴露**——让所有类型按 remote_id 各建任务，
  却没注意文本类文件名是固定的（不含 remoteId）。修好了视频，给文本开了口子。
  单任务审查看不见（只看一个 diff），必须把 domain 命名规则 × discovery 建任务粒度 ×
  executor 建路径**三处合看**才可见。这是全分支终审不可省的直接证据。

全部已修复并复审通过。修正记录见实现计划的「实现期偏离与修正」章节。

## 6. 遗留技术债（终审逐条裁为非阻塞）

| # | 问题 | 影响 |
| --- | --- | --- |
| 1 | ~~`storage.writeMeta` 定义并实现了，但无任何调用~~ **已闭合（含尾巴）** | 已接线：`packages/engine/src/manifest/` 在一轮结束后按会议写出 `meeting.json` / `_manifest.json`，worker 与 mde CLI 两个宿主都调。原先留的尾巴（NAS 副本里没有这两个文件）也已闭合：`src/worker/archive.ts` 的 `writeNasSidecars` 在「整场会议归档完成」那一处判定里**独立生成** NAS 那一份——不是搬运本地那两个文件，因为 NAS 那份要多带归档特有的信息（`nasPath` / `nasHash` / `archivedAt` / `retentionDays` / `nasDir`），而本地那份 30 天后会被到期清理删掉。两份共用 `packages/engine/src/domain/manifest.ts` 的同一套类型（NAS 版是本地版的 `extends`）。US-6.2 随之转 `✅` |
| 2 | `--failed` 标志被 `parseArgs` 解析，但无命令消费 | 死标志；应接入 `status`/`retry` 过滤或移除 |
| 3 | `executor` 未知 `asset_type` 回退 `?? (row.asset_type as any)` 非 fail-safe | 当前不可达（discovery 只写已知字段）；若可达会抛在 try/catch 外，宜改为 `markSkipped('unknown_asset_type')` |
| 4 | `store/db.ts` 无版本化迁移（全 `CREATE TABLE IF NOT EXISTS`） | M3 首版所有库皆新建，暂无影响；跨版本 schema 演进前必须补迁移机制 |
| 5 | 若干测试卫生项 | 死导入 `afterEach`；inline 清理无 `try/finally`（失败路径泄漏 tmp 目录/端口） |

## 7. 未被真实验证的部分（阻塞投产，不阻塞合并）

> **2026-08-25 更新。** 本节原文写于 M3 合并当天。M3.5 已于 2026-08-21～08-22 实际执行，
> 下面按实测结果重写——完整证据清单见 [`docs/roadmap.md`](roadmap.md) 的 M3.5 章。

**已被真实网关验证**（Stage 2–7）：

- `listAssets` 的字段名核实完毕。最大的一处不是「字段名不同」而是**语义误判**：
  `asset_type` 发的是网关自己的领域词汇，不是腾讯平台字段名，且**只有 video/audio 两项不同**
  ——这种部分重合让故障伪装成了「视频资产没产出」（`ae5d7c9`）
- `file_type` 确实提供，但会给出 `docs` 这样的非常规值、也会为空（`e02b0aa`）；
  同一资产存在多种格式，唯一键必须带它（`90ad4ca`）
- webhook 线路格式按腾讯官方契约重写完毕（`cc02f13`），STS 回调重试三次的行为也已处理（`584359d`）
- `preflight --sample-user` **已作废**：M3.5 决定不建企微自建应用、只走服务账号，不经过 userid 映射

**仍未被真实验证**（Stage 8/9，**投产门槛**）：完整闭环 · 幂等（重复跑不重下）· 断点续传
（真实大文件 + 对象存储是否支持 Range）· 崩溃恢复（租约过期重领）· AI 纪要延迟产出的探测。
**这五项是本项目设计里最值钱的机制，至今没有真实环境证据**，而服务端的归档 worker 现在就在
持续跑它们。

接缝已留好：字段映射集中在 `gateway/client.ts` 的一个函数里，真实字段名不同只改那一处；
`assetId` 全程当不透明串传递、不解析格式，天然免疫。**这次联调兑现了这份收益**——九处修复
没有一条需要动 discovery / executor / store。

## 8. 下一步

> **2026-08-25 更新。** 原文写的「下一步是 M3.5」已过时。

1. **M6 阶段 3（规则与授权）** —— 当前下一步，见 [`docs/console/dev-plan.md` §7](console/dev-plan.md)
2. **M3.5 的 Stage 8/9** —— 不属于任何阶段，但仍是投产门槛（见 §7）
3. ~~M4（存储扩展 OSS / NAS）~~ —— 已收敛为只做 NAS 并随 M6 阶段 2 交付（2026-08-24）；
   ~~M5（桌面应用）~~ —— 无限期推迟（2026-08-23，D2）

## 附：文档索引

| 文档 | 位置 |
| --- | --- |
| 客户端设计（spec） | `docs/superpowers/specs/2026-07-23-export-engine-cli-design.md` |
| 用户故事 | `docs/superpowers/specs/2026-07-20-user-stories.md`（P2 部分） |
| 实现计划（11 任务 + 偏离记录） | `docs/superpowers/plans/2026-07-23-export-engine-cli.md` |
| CLI 使用说明 | `client/README.md` |
| 执行台账 | `.superpowers/sdd/progress.md`（git-ignored） |

## 附：本地开发注意

从**仓库根**跑 `bun test` 会同时扫到网关的 `tests/` 与客户端的 `client/tests/`（337 = 279 + 58）。
网关侧的库相关测试需要真实 MySQL，未设 `TEST_DATABASE_URL` 时会有 26 个失败——
这是环境缺失，不是客户端引入的回归。只跑客户端用 `cd client && bun test`。
