# 阶段 6 · 上线：把六个阶段的交付装到机器上

- 日期：2026-08-27
- 前置：[`docs/console/dev-plan.md` §7](../../console/dev-plan.md)（为什么下一步是部署，三条实测判据）
  与 [§8 欠账清单](../../console/dev-plan.md)（D-1 … D-8）
- 覆盖率现状：[`specs/2026-07-20-user-stories.md` §9.4](../specs/2026-07-20-user-stories.md)
  33 条故事 ✅26 · ◐4 · ⬜1 · ⏸1 · —1，**但全部 `✅` 只到「代码成立」为止**（§9.7）

---

## 0. 一句话

**功能全写完了，一行没上线。** 阶段 6 不写新功能，只做一件事：让阶段 2–5 的交付
在真实机器上真的跑起来，然后拿真实运行的证据把 §9.7 那张「只由替身证明」的表清空。

---

## 1. 开工前要拍板的三件事

这三件都不是技术难点，是**方向选择**——选错了后面全部返工，所以放在最前面。

### R6-a 部署形态：容器，还是把现状正规化？

**现状是两套说法打架：**

| | 说的 | 实际 |
| --- | --- | --- |
| `docs/deploy.md:369-400` | ECS + 自建 Docker + RDS，`docker build` / `docker push` / `docker run` 全套 | — |
| 生产实测（2026-08-26） | — | `/home/ubuntu/mde/app` 目录 + bun 直跑，无容器 |

而且有一条硬推论：**这套 `Dockerfile` 很可能一次都没成功构建过。** deps 阶段只
`COPY package.json bun.lock` 就跑 `bun install --frozen-lockfile`，而
`workspaces: ["client", "packages/*"]` 的成员一个都不在场——那条 workspace 链接
无从建立，构建期就会坏。

**我的推荐是走容器**，理由三条：
1. `deploy.md` 已经按容器写了一整套，改 `Dockerfile` 的 COPY 清单比重写文档便宜；
2. 网关 / worker / scheduler 三个进程可以共用一个镜像、只换 `CMD`，不会出现「网关更新了、worker 还是旧代码」这种版本漂移；
3. **这次漏掉 `packages/` 正是「手工同步目录」的典型故障**——容器把「哪些文件要带上」变成一份可审查的清单，而 rsync 不会。

**如果你选 bun 直跑**：那 `deploy.md` 那一整章要重写成实际流程，并且需要一份
显式的同步清单（至少 `src` · `packages` · `console/dist` · `migrations` · `scripts` ·
`package.json` · `bun.lock`），否则同样的漏法会再发生一次。

### R6-b 控制台前端怎么送到浏览器

`src/index.ts` 与 `src/http/router.ts` 里没有任何静态文件服务的痕迹，
`console/vite.config.ts:20` 却写着「生产部署是反向代理把前端静态文件与网关挂在同一个源下
（docs/deploy.md §1）」——**而 `deploy.md` 里没有这一节**。等于说：这个决定从来没被真正做过。

两个选项：

| | 做法 | 代价 |
| --- | --- | --- |
| **(a) 网关 serve**（推荐） | 构建期把 `console/dist` 拷进镜像，网关加一条静态文件路由 + SPA fallback | 要动 `src/http/router.ts`，多一条路由；好处是同源、无 CORS、只有一个进程要管、`Cookie` 的 `SameSite` 不用放宽 |
| (b) 反向代理 | Nginx/Caddy 一个 server 块挂两个 location | 不动代码；但多一个要配、要证书、要和网关保持同源的组件，而且**这份配置目前不存在也没人写过** |

选 (a) 的话有一处要小心：**API 路由必须优先于 SPA fallback**，否则一个拼错的
`/api/v1/admin/xxx` 会返回 `index.html` 而不是 404，前端的 `validate.ts` 会报出一个
指向错方向的解析错误。

### R6-c 上线顺序：先归档链路，还是先控制台？

**推荐分两次上线，归档链路在前。**

理由是风险不对称：控制台是只读为主 + 少量管理写操作，出问题影响一个人；
归档 worker 会**删本地文件**（到期清理），出问题影响的是数据本身。
让归档链路先在生产上跑一段、有真实的 `job_runs` / `job_failures` 数据之后再上控制台，
控制台第一次被打开时就有东西可看，也才验得出「定时任务页显示的是不是真的」。

**但有一个前提**：到期清理在**审计写侧补齐之前**不能开（见 S7）。

---

## 2. 任务拆解

### S1 · 让 `packages/` 进得去（阻塞全部）

**问题**：`src/` 下 19 个文件 import `@yaowu/mde-engine`，其中值导入（不会被类型擦除）
至少有 `src/policy/access.ts:32` · `stacks.ts:55` · `archive-dir.ts:42` ·
`store/console-meetings.ts:1` · `handlers/console/meetings.ts:74` · `rules.ts:87` ·
`src/worker/*` 全部。而 `Dockerfile` 的 COPY 清单里没有 `packages/`。

**做完的判据**（不是「改完了」，是能核对的）：
- [ ] 在一台**干净机器**上从零构建，然后 `docker run` 起网关，`/healthz` 返回 200
- [ ] 同一个镜像 `CMD` 换成 worker 与 scheduler，两个进程都能起到「等待任务」的状态
- [ ] 构建产物里 `node_modules/@yaowu/mde-engine` 真的存在且指向有内容的目录

**注意**：`bun install --frozen-lockfile` 在 deps 阶段跑，所以 `packages/` 必须在
**那一阶段**就 COPY 进去，只在 release 阶段补是不够的。

### S2 · 控制台前端进得去（依赖 R6-b）

- [ ] 构建 `console/dist` 并进入产物
- [ ] 浏览器打开根路径能看到登录页（**这将是这 8 个页面第一次被真实环境打开**）
- [ ] 深链接直接访问（如 `/audit`）不 404
- [ ] 一个不存在的 `/api/v1/admin/xxx` 返回 **404 JSON**，不是 `index.html`

### S3 · worker 与 scheduler 的进程编排

**这两个是独立进程**（`bun run worker` / `bun run scheduler`），不是网关的一部分。
`docs/deploy.md` 目前**一个字都没提它们**。

- [ ] 两个进程有各自的启动方式、日志去向、崩溃重启策略
- [ ] `MDE_ARCHIVE_ROOT`（**必填**，启动时校验可用）与 `MDE_NAS_ROOT` 已配
- [ ] scheduler 起来后能看到 `job_runs` 表里出现第一行
- [ ] **确认只起一份 scheduler**——它没有多实例互斥，两份会各跑各的时间片

### S4 · 迁移 004–009 上生产

生产 `migrations/` 只有 `001`，而库里的表到 003（说明 002/003 是手工或早期跑的）。

- [ ] 004–009 六份的源文件进入产物
- [ ] 确认它们都满足 `runMigrations` 的两条硬约束：**分号只能作语句分隔**（naive split，
      注释里也不能有分号）、DDL 必须 `IF NOT EXISTS` 或用 `information_schema` +
      `PREPARE`/`EXECUTE` 守卫（每次启动都重跑）
- [ ] 起服务后 `job_runs` / `job_failures` / `meeting_asset_probes` / `admin_accounts.role`
      等表与列真的出现

### S5 · 环境变量与 `.env` 清理

- [ ] **企微三项清空**（现在填的是非空占位符，导致 `config.wecom !== null`，
      `WECOM_ROUTES` 那道 501 守卫一次也不触发，`POST /device/code` 照发一个
      永远走不完的 `device_code`——正是 `f4adb3c` 要消灭的形态）。清空后
      preflight 第 5 项判 **skip** 而不是 fail
- [ ] `MDE_ARCHIVE_ROOT` / `MDE_NAS_ROOT` 已配且指向真实可写目录
- [ ] `bun run preflight` 全绿（第 5 项 skip 是正常的）

### S6 · `deploy.md` 补齐（依赖 R6-a / R6-b 的结论）

现在这份文档只讲网关一个进程，且描述的部署方式与实际不符。要补：
控制台前端 · worker · scheduler · 三个进程的关系 · 新增的环境变量 · 迁移怎么上。

### S7 · 审计的两个洞（**上线到期清理之前必须补**）

来自欠账 §8.3 第 7 条：

1. **管理员登录/登出不写审计**——`src/http/handlers/console/auth.ts` 的 `login()`
   成功失败都不落行（同文件其余账号动作都落）
2. **调度器执行的到期清理不写审计**——`src/worker/scheduler.ts` 里 `audit` 出现 **0 次**

第 2 条是硬阻塞：**到期清理是全系统唯一不可逆的动作**。人工在界面上点的那次有记录、
定时跑的没有——这比全都没有更容易误导（看审计流的人会以为文件是被人删的）。
**在这一条补上之前，不要打开到期清理。**

### S8 · 上线动作（一次性，有先后）

- [ ] **A8 的核对 SQL**（部署前跑）：
      ```sql
      SELECT DISTINCT r.subject_value FROM policy_rules r
      LEFT JOIN service_accounts s ON s.id = r.subject_value
      WHERE r.kind = 'allow' AND r.subject_type = 'program' AND s.id IS NULL
      ```
      有结果就意味着有程序会从「可达」翻成「不可达」
- [ ] **A7 的第一条拉取规则**：先建一条**无条件全拉**，确认日志里 `mode=governed`
      且 `fetched` 与此前数量相当，再逐步收紧。回滚方式是在规则页停用全部拉取规则，
      **不需要重新部署**

### S9 · 用真实运行的证据清空 §9.7 那张表

这是阶段 6 真正的验收，不是附加项：

- [ ] 归档链路在生产跑通一轮（`job_runs` 有成功行、NAS 上有 sidecar）
- [ ] 控制台 8 个页面在真实数据下各打开一次
- [ ] **M3.5 §4.5 AI 纪要延迟探测**——五条机制里唯一没验过的，需要一场
      **刚结束、纪要还没生成**的会议。上线之后这个条件会自然出现，不必特意开会
- [ ] 回填 `specs/2026-07-20-user-stories.md` §9.7

---

## 3. 顺序

```
R6-a R6-b R6-c 拍板
      │
      ▼
     S1 ────────────────────► 阻塞一切，先做
      │
      ├──► S2（前端进产物）      ┐
      ├──► S3（两个进程编排）     ├─ 可并行
      ├──► S4（迁移）            │
      └──► S5（环境变量）        ┘
                │
                ▼
               S7（审计两个洞）  ← 到期清理的硬前置
                │
                ▼
               S6（deploy.md 按实际重写）
                │
                ▼
          上线（按 R6-c：归档链路 → 控制台）
                │
                ▼
               S8（核对 SQL → 第一条拉取规则）
                │
                ▼
               S9（真实证据回填）
```

---

## 4. 不在本阶段的

明确划出去，免得阶段 6 变成一个什么都往里装的筐：

- **账号管理界面**（US-3.5 的 `◐`）——`console/src` 对 `/admin/accounts` 三条端点
  的调用数是 0，而且 `spec.md` 的页面清单里从来就没有这一页。上线靠
  `admin-bootstrap` 建第一个账号、加人打 API 是可行的，不阻塞。**归阶段 7**
- **US-2.5 撤销归档**（唯一的 `⬜`）——语义已拍板、界面已标注留白，不阻塞上线
- **US-1.3 的告警**（本轮新降级的那条）——STS 续期本身正常工作，缺的是失败时的
  主动通知。上线后有真实故障样本了再设计告警渠道更合适
- **D-3 换 NAS 根目录的迁移脚本**——只在真的要换挂载点时才需要
- **欠账 §8.3 的 2 / 3 / 4 / 5 / 6 / 8**（跨栈契约测试、host 人员选择器、运算符中文名、
  预览播放器、`visibility.ts` 不看 `enabled`、时间范围筛选）——都是功能债，归阶段 7

---

## 5. 这个阶段最容易犯的错

**把「部署成功」当成「验证通过」。** 阶段 6 的产出不是「服务起来了」，
是 §9.7 那张表被真实运行的证据清空。这个仓库已经三次为「替身比真实依赖宽容」
付过代价（设备登录 26 测试全绿却在真实 MySQL 下不可用 · `openDb` 42 测试全绿却在
真实文件路径下必崩 · `asset_type` 词汇表推断错误伪装成「视频没产出」）。
**服务起来只是让真实证据有机会产生，不是证据本身。**
