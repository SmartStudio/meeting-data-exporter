# T7 · A3 授权 API + 采集清单 —— 完成报告

- 日期：2026-08-26
- 上游：`docs/superpowers/plans/2026-08-26-console-stage4-api-and-scheduler.md` §3 T7
- 状态：**DONE_WITH_CONCERNS**（功能与验收判据全部落地；四处与计划/前端契约的矛盾自行裁定，列在 §4）
- 测试：`bun test` 877 pass / 0 fail（77 个文件）；`bun run typecheck` 干净

---

## 1. 交付的东西

### 新文件

| 文件 | 内容 |
| --- | --- |
| `src/store/programs.ts` | `ProgramsStore`：`service_accounts` 的控制台读写侧。**读侧类型里没有 `secret_hash`**；`create` 撞 id 返回 false，绝不 UPSERT |
| `src/http/handlers/console/grants.ts` | 七个端点 |
| `tests/store/programs.test.ts` | 8 个用例 |
| `tests/http/console-grants.test.ts` | 37 个用例（35 个假依赖直调 handler + 2 个走真实路由派发与真实库） |

### 端点

```
GET    /api/v1/admin/programs                                采集程序列表
POST   /api/v1/admin/programs                                接入新程序（四步向导的落点）
GET    /api/v1/admin/programs/:id/inventory                  §4.5 那句蓝底的话
POST   /api/v1/admin/meetings/:meetingId/grants              授权给某程序
DELETE /api/v1/admin/meetings/:meetingId/grants/:programId   撤销授权
PUT    /api/v1/admin/meetings/:meetingId/override            写人工改写
DELETE /api/v1/admin/meetings/:meetingId/override/:kind      撤销人工改写
```

全部走 `requireAdminAuth`。周期性会议的场次 id 一律从查询串 `?sub=` 取——路由上只有
`:meetingId`，而两个 DELETE 没有请求体，能承载第二段主键的地方只剩查询串。若 POST/PUT
改从请求体取，同一个键就有了两种写法，前端迟早在某一个端点上漏掉它，而漏掉的后果是
**静默地操作了主场次而不是管理员选中的那一场**。

### 追加型改动（未重排、未改动任何现有行）

- `src/http/router.ts`：6 行 import + 6 个 `AppDeps` 字段 + 7 行路由
- `src/index.ts`：4 行 import + `programsStore` + 临时 `getMeetings` + 6 行装配

### 计划外但必须做的改动

| 文件 | 为什么 |
| --- | --- |
| `src/auth/service.ts` | 补 `generateServiceSecret` / `hashServiceSecret`（见 §4.1） |
| `scripts/seed-dev.ts` | 改用上面两个，否则「同一套」只是口号 |
| `tests/http/testApp.ts` | `AppDeps` 加了字段，不补它 `typecheck` 不过；顺带导出 `consoleMeetingLookup` |
| `tests/e2e/flow.test.ts` | 同上（它自己拼一份 `AppDeps`），复用 testApp 导出的那份 lookup |

`tests/http/testApp.ts` 里我把 `createGrantsStore(pool)` 从内联参数提成了 `grantsStore`
局部变量（`accessGate` 与新字段共用同一个实例）——**这一处动了既有行**，一行，
且行为不变。`tests/e2e/flow.test.ts` 同样一行。

---

## 2. 四条验收判据逐条

### 判据 1 · inventory 走 `computeProgramInventory`，现算；7 天阈值判在这一层

响应给出 §4.5 那句话的三个部分：

```jsonc
{
  "programId": "kb-indexer",
  "now": 1780272000,
  "fetchableCount": 4,          // 「现在可取走 4 场会议」
  "assetTypes": ["transcript", "ai_minutes"],  // 「……的 AI 纪要 + 完整转写」
  "expiringSoonCount": 1,       // 「其中 1 场 7 天内到期」
  "expiringSoonDays": 7,        // 阈值随响应下发，前端不再抄一份 7
  "blockedCount": 2,
  "fetchable": [...], "blocked": [...]   // 每一项带 blockers（code / gate / reason / remedy）
}
```

阈值判在 handler 而不是 `visibility.ts`，因为那个文件的文件头写明「这一层给事实，
不给阈值」——阈值写死在 worker 里的话，界面上想换个天数就得改 worker。

两个容易写错的边界都有用例钉住：

- **`expiresAt === null`（还没归档过）不算快到期。** 保留窗口还没开始计时，
  没有到期时刻可言。把 null 当 0 算会让每一场刚拉下来还没归档的会议都顶着琥珀标记。
- **窗口已过但清理被暂停的会议算快到期。** 判据用 `expiresAt <= now + 7d`
  而不是区间——它比「7 天内到期」更紧急，下一轮清理恢复就没了；用区间会把差值为负的
  那些漏在外面。

另外：**程序不存在返回 404，不返回一份「0 场」的空清单。** 空清单与「接进来了但还没
授权任何会议」在界面上长得一模一样，管理员会以为授权没生效、回授权页反复点，
而真正的问题是 id 拼错了。

### 判据 2 · 接入新程序：明文凭据只出现一次

- 明文只在 `POST /programs` 的 201 响应里出现一次，不落盘、不入库、**不进审计**
  （有一条用例专门断言审计里不含那串明文）。
- 库里只存 argon2id 哈希，与 `scripts/seed-dev.ts` 现在**共用同一个函数**。
- 有一条用例把生成的明文与截获的哈希喂给真实的 `createServiceAuth().authenticate()`
  验一遍：「明文只出现一次」如果配上一份验不过的哈希，就是发了一把打不开门的钥匙，
  而这件事要等对接方第一次调用失败才会被发现。
- **重名返回 409，不覆盖。** `seed-dev.ts` 用的是
  `ON DUPLICATE KEY UPDATE secret_hash = VALUES(secret_hash)`，那对一个「重跑即轮换」的
  开发脚本是对的；控制台这条路上是错的——它会把一个**正在跑的**采集程序的凭据悄悄换掉，
  对接方开始 401，而管理员看到的是「接入成功，这是你的新凭据」。轮换该是另一个动作、
  另一条审计。

### 判据 3 · 写改写时 `kind` 不在 handler 里转换或推断

`kind` 与 `effect` **原样递给 store**。handler 只校验「是不是一个非空字符串」——
那是本层own 的事（请求体反序列化出来的可能是数字、对象、`undefined`），值本身交给
`assertOverrideKind` 与 `migrations/006` 的 CHECK。有两条用例发 `kind: 'ALLOW'` /
`effect: 'AlLoW'` 并断言 store 收到的一字不差。

### 判据 4 · 每一次授权 / 撤销 / 改写 / 接入新程序都记审计

`actor_type = 'admin'`、`actor_id = adminId`（不是 username——用户名可以改，
审计要指得住同一个人）、`client_kind = 'console'`。五个 action：
`grant_meeting` / `revoke_grant` / `put_override` / `revoke_override` / `create_program`。

三条刻意的选择：

1. **走 `AuditStore.record` 而不是 `AuditRecorder`。** 那个 recorder 的三个方法都是
   「程序取数据」维度的，而阶段 4 有三个任务（T6/T7/T8）并行往控制台的写侧加东西，
   各自往 recorder 上加一个方法必然互相冲突，且那几个方法除了 action 常量以外一模一样。
2. **撤销一条本来就不存在的授权照样记**（`detail` 里带 `noop`）。管理员点「撤销」这件事
   发生过；不记的话，日后查「谁动了这条授权」会看到一段空白，而当事人记得自己点过。
3. **store 的防线开火时不记审计。** `putOverride` 抛错时审计那行根本执行不到——
   没写成的事不能留一条说写成了的记录。有用例钉住。

---

## 3. E-a ~ E-g 的落点

- **E-a**（`meetings` 是控制台主表）：`src/index.ts` 与 `tests/http/testApp.ts` 里
  `getMeetings` 的注释；那两段读的都是 `meetings`，一个字都没碰 `meeting_cache`。
- **E-e**（清单现算、不开缓存表）：`src/http/handlers/console/grants.ts` 文件头第一节。

其余五条属于别的任务。

---

## 4. 与计划／前端契约矛盾的地方（自行裁定）

### 4.1 判据 2 说「复用 `src/auth/service.ts`」，但那个文件当时没有产出侧

`src/auth/service.ts` 只有 `Bun.password.verify`（校验侧），没有任何可复用的
「生成 + 哈希」。字面执行「复用」做不到，字面执行「不要另写一套」也做不到。

**裁定：在那个文件里补上 `generateServiceSecret` / `hashServiceSecret`，
并把 `scripts/seed-dev.ts` 也改成用它们。** 理由是结构性的——校验凭据的代码就在
下面几行，产出与校验同处一个文件，「两边用的不是同一套哈希」这件事就没有发生的余地。
`Bun.password.verify` 会从哈希串自带的前缀里认算法，所以换成别的算法照样「能用」、
不会有任何报错，直到某天有人想统一强度参数时才发现库里躺着两三种哈希。

### 4.2 `Consumer.scope` 与 spec §4.5 直接冲突（**这一条要请示**）

- 全局约束 5：响应形状以 `console/src/api/types.ts` 为准。那里的
  `Consumer = { id, name, scope: string }`，mock 里 `scope` 是 `'AI 纪要 + 完整转写'`。
- spec §4.5：那句话「**是三个「与」求交之后的实际结果，不是配置值**」。

`scope` 在 mock 里正是一个配置值。**裁定：`GET /programs` 不下发 `scope`**，
只给账号事实（id / name / tmUserId / enabled / expiresAt / createdAt）；那句话的资产部分
由 `GET /programs/:id/inventory` 的 `assetTypes` 给出，它是求交之后的实际结果。

理由与 E-c 是同一件事的另一面：编一个看起来像结论、实际没经过判定的值，
**比不给更糟**——它把一个未经求交的配置串伪装成一次实际结果。

**代价**：采集授权页（F 侧还没写）要按 `programs` + 逐程序 `inventory` 两个请求拼卡片，
不能一个请求拿完。1–3 个采集程序的规模可以接受。若要改成一个请求拿完，
正确的做法是让 `GET /programs` 也跑一遍 `computeProgramInventory` 并带上摘要，
**而不是**回头去下发一个配置值。前端那份 `Consumer` 需要相应修订。

### 4.3 非法 `kind` 在 HTTP 上是 500，不是 400

判据 3（handler 不判 kind）与完成判据（每个端点要有「参数非法 400」）在这一点上打架。

**裁定：500。** 要返回 400 就得在 handler 里复制一份合法 kind 集合，那就是第三份
「合法值清单」（store 一份、库的 CHECK 一份），三份早晚会分叉——而 D-u 说得很清楚，
kind 是改写行上唯一没有安全侧可落的字段。控制台只会发三个合法值，收到别的说明有
第三方客户端或前端 bug，500 加一条服务端错误日志正是这种情况该有的响亮失败。

「参数非法 400」这条判据由 handler 真正own 的字段覆盖：缺 `kind` / `effect` / `reason` /
`assetTypes` 都是 400。

### 4.4 `audit_log` 没有给管理员写操作留位置

那张表的列是为「程序取数据」设计的：`meeting_id(64)` / `asset_id(255)` /
`asset_type(64)` / `decision` / `matched_rule` / `client_kind`。管理员写操作要记的
「对哪个程序、哪一场次、什么范围」没有对应的列。

**裁定（不新建迁移——`migrations/007` 是 T4 的，`008` 是 T11 的）：**

- `meeting_id` = meetingId（≤64，不拼场次，拼了会溢出列宽）
- `asset_id` = `目标@场次`（主场次不写 `@`）。目标 = programId / kind / 新程序 id
- `asset_type` = 一句话明细，**超过 64 字符截断并加省略号**

截断审计字段通常不可接受，这里可以接受，因为**范围的权威副本不在审计里**：
`meeting_grants` 的行永不被 UPDATE（范围一变就是撤旧插新），当时授权了哪几类那张表
永久说得清。有一条用例钉住「全八类资产时明细不超过 64 字符」。

**建议**：T9（A5 审计 API）落地时，若发现 §4.10 的流水读不出足够信息，
该加一列 `detail TEXT` 而不是继续在这三列里塞。

### 4.5 `getMeetings` 的临时实现有一处 T1 必须正面裁定的东西

T1 未交付，`src/index.ts` 与 `tests/http/testApp.ts` 各有一段临时实现直接查 `meetings` 表。
两处的注释都标了「T1 落地后整段删掉」。其中一处不是将就而是**真问题**：

`meetings` 表的列全部 nullable。临时实现把 `subject IS NULL` 折成空串。
空标题会让 `title has 财务 → allow` 判不匹配（落在安全侧），但也会让
`title has 财务 → deny` 判不匹配（**落在放行侧**）。`visibility.ts` 的文件头明说
「查不到的会议不要造一个空壳顶上」，而一行 `subject` 为 NULL 的记录正是半个空壳。

我没有在临时实现里把这类行丢掉，因为那会让清单报「在 meetings 表里查不到」——
对一行确实存在、只是元数据不全的记录，那句话是假的。**T1 要在
`ConsoleMeetingsStore.getMeetings` 里裁定这件事**，注释里已经点名。

---

## 5. 没做的事

- `GET /programs` 不带清单摘要（见 4.2）。
- 没有「轮换凭据」「停用程序」端点——计划 T7 没列，且轮换该有自己的审计动作，
  不能是建号撞名的副作用。
- 授权时**不校验会议是否存在**：`computeProgramInventory` 已经会把它报成
  `meeting_unknown` 并落到拒绝一侧，理由里写明「授权行指着一场不存在的会议」。
  在 handler 里再挡一道就是第二处真相，且会挡掉「先授权、等 discovery 补上元数据」
  这条本来合法的顺序。
