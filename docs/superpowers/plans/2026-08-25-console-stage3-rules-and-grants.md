# 控制台阶段 3 实施计划：三栈规则引擎与逐会议授权（R1–R4）

- 日期：2026-08-25
- 阶段：M6 子项目 5 · 阶段 3（[`dev-plan.md` §3](../../console/dev-plan.md)）
- 输入：[`console/spec.md`](../../console/spec.md) §5 求值语义 · §6.3 规则 · §4.6 自动规则 ·
  §4.7 规则编辑器；原型 `docs/console/prototype/gate-console.html` 的 `matchCond` / `evalStack`
  （**可运行的语义参考实现**，行 3400–3432）
- 输出：`src/policy/` 重写 · `migrations/004_console_stage3.sql` ·
  `meeting_grants` / `meeting_overrides` · `src/worker/visibility.ts`
- 前置：见 §1。**其中一件必须先有答案才能写迁移**

---

## 0. 这个阶段为什么排在阶段 4 前面

阶段 4 的 A2（会议查询 API）要在一行里返回**逐阶段判定理由**——「这场会为什么没拉取」
「哪条规则放行了这个程序」。那个理由就是三栈引擎算出来的。跳过阶段 3 直接做 A2，
返回的判定理由只能是假的，前端接上去也是假的。

---

## 1. 开工前的两件事

### 1.1 R0（企微通讯录）：✅ 已定 —— **不做**

spec §5.3 原本要求「不删 `dept` 字段，把接企微通讯录 API 立成前置任务 R0」。
**2026-08-25 核实：企业微信自建应用没有真建**（本地 `.env` 里 WECOM 三项是占位符），
而 M3.5 的部署决策本就是不建自建应用，四条设备流程路由现在返 501。

**决定：R0 不做。** 按 spec §5.3 已经写好的降级路径走：

- `dept` 字段**保留**在规则编辑器里，**禁用**，并写明原因（「需要企业微信通讯录，尚未接入」）
- 引擎里对 `dept` 条件**显式判不匹配**，并且要能与「字段拼错」区分开——
  不是「恰好匹配不上」，是「这个字段当前无数据源」。判定理由里要如实说出来
- 一条规则若**只有** `dept` 条件，它永远不会命中；规则列表要给出可见提示，
  不能让管理员建一条静默失效的规则

### 1.2 C1（priority 排序方向）：✅ 已定 —— **生产库只有 1 行，走最轻的方案**

现有引擎按 priority **升序**取第一条、同优先级 **deny 优先**；spec §5.1 要求 **降序** +
同优先级 **id 升序**。两处都要翻，而**旧数据是按旧语义写的规则**。

**好消息是现有规则集可能是空的。** 代码侧已核实：

- `PolicyStore`（`src/store/policy.ts:14`）只有 `listEnabledRules()` 一个只读方法，**没有任何写规则的入口**
- `src/http/handlers/console/` 下只有 `auth.ts`，没有规则管理端点
- `migrations/003_console_stage2.sql` 全文 87 行，**从没碰过 `policy_rules`**——这张表自
  `001_init.sql` 定义后再没被改过
- 唯一的写入来自 `scripts/seed-dev.ts:67-87`，插的是**一条** `priority=100 · subject_type='user' ·
  resource_expr={} · asset_types=['*'] · effect='allow'` 的全放行规则，且幂等

所以迁移方案取决于生产库里实际有几条规则。查询命令与判读表见
[`docs/m3.5-stage8-9-plan.md` §2](../../m3.5-stage8-9-plan.md)。三种结果对应三种方案：

| 生产库实际 | 迁移方案 | 规模 |
| --- | --- | --- |
| 0 条 / 只有 1 条全放行 | **声明规则集可重建**：清表 + 按新语义重播种 | 小 |
| 多条、priority 互不相同 | 重排 priority + 迁移前后逐条比对判定 | 中 |
| 多条且有 priority 相同 | 同上，且平局语义也在翻（deny 优先 → id 升序），每条翻转都要人工确认 | 大 |

**2026-08-25 实测：`policy_rules` 全表 1 行。** 落在第一行——单条规则不存在排序
问题（降序还是升序，它命中就是它、不命中就走兜底，判定结果完全相同），平局语义
从「deny 优先」换成「id 升序」也无从适用。**C1 的迁移风险归零。**

**但不自动转换那条规则的语义。** 旧规则的主体是人（`subject_type='user'`，
`subject_value` 是腾讯会议 userid），新 allow 栈的主体是采集程序
（`service_accounts.id`）——两者之间没有机械的对应关系，一个人可能对应零个或多个
服务账号，猜哪一个都是在替管理员做他没做过的授权决定。

**T1 的做法**：`migrations/004_console_stage3.sql` 把现有行全量复制进
`policy_rules_legacy`（不丢数据），再按新结构重建空的 `policy_rules`，由管理员按
新语义重新建规则。重建期间没有任何规则 = allow 栈兜底 deny = 谁都取不走，落在安全侧。

---

## 2. 数据模型（本计划裁定）

### 2.1 `policy_rules` 的改造

`migrations/004_console_stage3.sql`（**003 已被阶段 2 占用**）：

| 列 | 动作 | 说明 |
| --- | --- | --- |
| `kind` | **新增** `VARCHAR(8) NOT NULL` | `'fetch'` / `'archive'` / `'allow'`。三栈各自独立求值 |
| `join_op` | **新增** `VARCHAR(3) NOT NULL DEFAULT 'and'` | `'and'` / `'or'`。**一条规则内只有一个连接词**，不支持括号与混用 |
| `conds` | **新增** `JSON NOT NULL` | `[{f, op, v}]`。取代 `resource_expr` |
| `resource_expr` | **删除** | 换表示法，**不做双向转换**——backend-gap §3 已判：双向转换会长期漏语义 |
| `effect` | **扩容** `VARCHAR(8)` → `VARCHAR(255)` | archive 栈的 effect 是**目录模板**，8 字符装不下 |
| `subject_type` | 取值扩展 | 增加 `'program'`。fetch/archive 两栈此列留空 |
| `asset_types` | **保留复用** | allow 栈用它装「准许取走哪几类资产」；fetch 栈用它装「拉哪几类」 |
| `note` | **新增** `VARCHAR(255)` | spec §6.3：说明文字会出现在规则列表**和每场会议的判定理由里** |
| `created_by` | **新增** `VARCHAR(128)` | spec §6.3 的 `author`。对应 `admin_accounts.id` |
| `idx_policy_lookup` | **改** | `(enabled, priority, id)` → `(kind, enabled, priority, id)`：三栈各自取自己那批 |

### 2.2 三栈的 effect 取值域（原型 `gate-console.html:3351-3377` 是事实源）

| 栈 | 主体 | effect 取值 | asset_types | 兜底 |
| --- | --- | --- | --- | --- |
| `fetch` | **无**（系统级） | `'all'` \| `'skip'` | 拉哪几类（`'all'` 时为 `['*']`） | `skip` |
| `archive` | **无**（系统级） | **目录模板**，如 `/nas/meetings-finance/{年}/` | 不用 | `skip` |
| `allow` | **采集程序**（`service_accounts.id`） | `'allow'` \| `'deny'` | 准许取走哪几类 | **`deny`** |

> **allow 栈的兜底是 deny，另两栈是 skip**——第三栈是数据出企业边界的闸门，默认必须是关的
> （spec §4.6）。这不是可以「统一一下」的不一致。

**归档目录模板的占位符**：`{年}` `{月}` `{会议号}` `{标题}`。落地时要与
`src/worker/archive.ts:46` 现有的固定规则 `<year>/<month>/<meetingId>_<subMeetingId>` 对接——
那段代码的注释已经写明它是阶段 2 的临时规则、等 R1 来替换。**替换时注意 `{标题}` 要过
`cleanDirName` 的清洗**（非法字符、字素簇截断），而现有 `archiveMeeting` 签名里拿不到
subject/meetingCode/startTime，这是本阶段要一并解决的接口问题。

### 2.3 新表

```sql
-- 逐会议 × 逐程序授权（spec §1.3 的三个「与」之一）
meeting_grants(meeting_id, sub_meeting_id, program_id, asset_types JSON,
               granted_at, granted_by, revoked_at)

-- 人工改写：单场会议的人工决定，优先于所有规则（spec §5.4）
meeting_overrides(meeting_id, sub_meeting_id, kind, effect, asset_types JSON,
                  note, created_at, created_by)
```

---

## 3. 求值语义（逐字实现，不许凭直觉）

### 3.1 单栈求值（spec §5.1）

```
对某一类规则（fetch / archive / allow）：
  1. 取出该类中 enabled 的全部规则
  2. 按 priority 降序排序，同 priority 按 id 升序
  3. 从上往下找第一条匹配的，用它的 effect，立即停止
  4. 一条都不匹配时用兜底：allow → deny，其余 → skip
```

**第一条命中的说了算**，不合并、不叠加。

### 3.2 单条规则的匹配（spec §5.2）

```
conds 为空        → 匹配一切
join === 'or'     → 任一条件成立即匹配
join === 'and'    → 全部条件成立才匹配（默认）
```

### 3.3 字段与运算符（spec §5.3 + 原型 `matchCond`）

| 字段 | op | 语义 | v 的形态 |
| --- | --- | --- | --- |
| `title` | `has` / `nothas` | 关键词**任一**被标题包含 / 一个都不包含 | 逗号或空白分隔的字符串 |
| `dept` | `in` / `notin` | 主持人部门属于 / 不属于 | 部门名数组 |
| `host` | `is` / `isnot` | 主持人等值 / 不等 | 单个用户 id |
| `dur` | `gt` / `lt` | 会议时长**分钟**大于 / 小于 | 数字 |
| `age` | `within` / `before` | 录制结束在最近 N 天内 / 早于 N 天 | 天数 |
| `arch` | `isarch` / `notarch` | 已写入 NAS / 未归档 | 无值 |

### 3.4 原型与 spec 的三处不一致（本计划的裁定）

实现时**以裁定为准**，不要照抄原型：

| # | 差异 | 裁定 |
| --- | --- | --- |
| **D-a** | 原型 `evalStack` 的 `sort((a,b) => b.pri - a.pri)` **没有 id 平局处理**；spec §5.1 明写同优先级按 id 升序 | **按 spec**。平局必须确定性，且**必须有测试**——不能靠 V8 排序恰好稳定 |
| **D-b** | 原型 `matchCond` 用二元 else 写法（`c.op === 'has' ? hit : !hit`），**未知 op 会静默落进否定分支** | **显式枚举 op，未知 op 一律判不匹配**，与现有 `expr.ts:52`「未知字段一律不匹配」同一条规矩。授权中枢里的静默放行/静默拒绝都是查不出来的错误 |
| **D-c** | spec §6.3 的规则结构里**没有 assets 字段**，但原型的 allow 规则有 `assets:['summary','transcript']` | **spec 的疏漏，按原型补**，用 `asset_types` 列承载。**但必须用 `AssetKey`，不许把原型的短名（`summary`/`aitr`/`digest`）带进代码**——spec §6.2 明令，同一批资产已经有过三套叫法，M3.5 为此吃过一次亏 |

### 3.4.1 T3 落地时新增的两处裁定（2026-08-25，已实现于 `src/policy/stacks.ts`）

这两条 spec 与原型都没回答，T3 实现时裁定，**后续任务继承，不要推翻**：

| # | 问题 | 裁定与理由 |
| --- | --- | --- |
| **D-d** | 命中的规则 `effect` 是脏数据（不在该栈取值域内）时怎么办 | **这条规则说了算，但它说不清楚** → 落到本栈安全侧（fetch/archive → `skip`，allow → `deny`），标 `source: 'rule_invalid'` 并在 `issues` 写明。**不继续往下找**——继续找会让一条写坏的高优先级 deny 被低优先级的 allow 顶掉，正是 §6「不许静默放行」要防的 |
| **D-e** | `asset_types` 是**筛选条件**（决定规则进不进候选集）还是**命中规则的载荷**（决定放行哪几类） | **载荷。** 规则匹配只看 conds 与主体，命中后由 `decisionAllowsAsset()` 作用在判定结果之上。三条依据：① spec §5.1 的匹配只讲 conds 与主体；② 原型 `evalStack`（行 3427-3431）也不按资产过滤，`assets` 挂在 winner 上；③ **筛选式等于合并式语义**——一条高优先级的「只放行转写」会被低优先级的「放行全部」在视频上顶掉，管理员看规则列表以为高优先级那条说了算，实际不是，正是 §5.1 禁止的「不合并、不叠加」 |

> **D-e 要特别注意**：旧 `engine.ts:26-28` 的 `assetMatches` 恰恰是**筛选式**的——那是要被替换掉的旧语义。
> T4 接线时如果发现某个调用点依赖筛选式行为，那是需要显式处理的语义变更，不是可以顺手改回去的细节。
>
> D-e 之下，「命中了 allow 规则但请求的资产不在它的 `asset_types` 里」与「一条规则都没命中走兜底 deny」
> 是**两种不同的拒绝**，判定理由必须能区分——前者要说出是哪条规则放行了这场会议、以及它只放行哪几类。

### 3.5 人工改写必须在引擎之外（spec §5.4）

**单场会议的人工改写优先于所有规则。** 但它**不能混进引擎**：

- 引擎只管规则，改写是引擎结果之上的**覆盖层**
- 混进引擎会让影响预览算不准——spec §5.5 要求把改写过的会议**排除在「会被改变」之外**

### 3.6 影响预览的计算范围（spec §5.5）

只在 `命中(旧规则) ∪ 命中(新规则)` 这个集合上算，**不是全部会议**。
把所有会议都列成「受影响」是虚假的规模感。

> **T5 落地时的澄清：这里的「规则」是被改动的那几条，不是整个规则集。**
> 按「整个旧规则集 ∪ 整个新规则集」读，只要规则集里有一条兜底规则
> （`conds: []` 匹配一切，`seed-dev.ts` 种的就是这样一条），范围立刻等于全部会议——
> 正是本节要防的那件事。原型 `gate-console.html:3570` 的
> `hitsOf(draft) ∪ hitsOf(draftOrig)` 是事实源。
>
> 这样收范围是**安全的**而非近似：新旧两版逐字相同的规则在两次求值里位置与结论都一样，
> 所以一场会议若没被任何**改动过的**规则命中，两次求值经过的「命中的规则」序列完全相同，
> 判定必然相同。`tests/policy/preview.test.ts` 里有一条与「全量逐场重算」对照的用例守着它。

---

## 4. 任务拆解

### R1 · 三栈规则引擎

| # | 任务 | 落点 | 依赖 |
| --- | --- | --- | --- |
| ~~**T1**~~ | ~~数据模型与迁移~~ | `migrations/004_console_stage3.sql` · `src/store/policy.ts` | ✅ **已完成，2026-08-25** |
| ~~**T2**~~ | ~~条件求值器~~ | `src/policy/conds.ts`（新），取代 `expr.ts` | ✅ **已完成** |
| ~~**T3**~~ | ~~三栈引擎~~ | `src/policy/stacks.ts`（新建，未改 `engine.ts`——接线是 T4 的事） | ✅ **已完成** |
| ~~**T4**~~ | ~~接线与旧语义清理~~ | `src/policy/access.ts`（新）· `src/http/handlers/meetings.ts` · `docs/deploy.md` | ✅ **已完成，2026-08-25** |

**T2 必测**：六个字段 × 各自两个 op = 12 条；未知字段判不匹配；未知 op 判不匹配（D-b）；
`conds` 为空匹配一切；and/or 各一条；`dept` 在无数据源时的行为（§1.1）；
`title` 的关键词分隔（逗号、中文逗号、空白都要）。

**T3 必测**：降序取第一条；**同 priority 按 id 升序**（D-a，至少两条同 pri 的规则，
且要断言不是靠排序稳定性）；三栈兜底各不相同（allow→deny，fetch/archive→skip）；
`enabled=0` 的规则不参与；fetch/archive 栈**显式忽略主体**（不是恰好匹配不上——
要能构造一条带 subject 的 fetch 规则并断言它照样按无主体处理）。

**T4 的注意点**：`meetings.ts` 的 `downloadUrl` 注释标明那是**唯一的真正安全边界**，
无论客户端此前是否见过这个 assetId 都要用当前时刻的真实 Meeting 重跑一次判定。
重写时这条不变，且要保住它的测试。

另外 T4 要顺手修两处**文档与代码不符**：
- `docs/deploy.md:304` 写着「数字越小优先级越高」——语义翻转后必须改
- `docs/deploy.md:301-302` 把 `end_time` 列进了支持字段，但 `expr.ts` 从来拒绝它

**T4 落地时新增的三处裁定**（照 §3.4 的体例记在这里，实现以裁定为准）：

| # | 事 | 裁定 |
| --- | --- | --- |
| **D-i** | `ActorIdentity` 没有采集程序 id：旧引擎按 `tmUserId` 匹配主体，新 allow 栈按 `service_accounts.id` | **`ActorIdentity` 加 `programId: string \| null`**，由 `serviceAuth.authenticate` 填 `account.id`，随 access token 载荷往返。**不拿 `tmUserId` 顶替**——一个人可能对应零个或多个服务账号，顶替恰好撞上某个 id 时就是静默放行。旧令牌（载荷里没有这个字段）还原成 `null`，落在拒绝一侧 |
| **D-j** | 企微用户（`programId === null`）走到 allow 栈判什么 | **在读规则之前显式拒绝**，理由写「不是采集程序，采集权限规则的主体是采集程序」。让它落进 `checkSubject` 的「主体匹配不上」分支也是 deny，但理由会变成「没有任何规则匹配」——管理员据此会去**再建一条永远不生效的规则**。判定理由是产品功能（§4.2/§4.3），说错比不说贵 |
| **D-k** | `arch` 条件在网关侧的数据源 | **查 `meeting_archives`，不填 `false`**。列会议时用一次批量查询（`ArchivesStore.listArchivedMeetingKeys`）问清整批，不逐场往返。随手填 `false` 会让一条 `arch notarch → allow` 的规则把已归档的会议也放行，正是 §6「不许静默放行」要防的 |

**D-e 在三个调用点的落地**（旧 `assetMatches` 是筛选式，新语义是载荷式）：

| 调用点 | 旧写法 | 新写法 |
| --- | --- | --- |
| `isMeetingVisible` | 遍历八类资产，有一类判 allow 就可见 | 整场判一次：`effect === 'allow'` **且**放行的资产类型非空。**不能简写成只看 `effect`**——一条 allow 但 `asset_types` 里没有任何合法资产键的规则，判定是 allow 而实际一类都取不到，此时列出会议只会泄露标题与主持人 |
| `filterAssetsByPolicy` | 每个资产各跑一次判定 | 整场判一次，再 `decisionAllowsAsset` 逐类问。逐资产重跑不但白跑，还会掩盖「是哪条规则放行了这场会议」 |
| `downloadUrl` | 单资产判定 | 同上；**「唯一的真正安全边界」这条性质一个字没变**。两种拒绝在审计与理由里分得开：「命中 allow 但不放行这一类」与「一条规则都没命中走兜底」 |

**`end_time` / `dur` 现在可以真的支持了**：`d191f5b`（2026-08-21）已从
`record_files[].record_end_time` 聚合出真实结束时间，M3.5 联调确认字段存在（C6 已闭合）。
`expr.ts:6-10` 那段「故意不提供 end_time」的注释连同
`tests/policy/expr.test.ts` 里对应的回归测试，都要在 T2 里一并更新——**但要保留那段注释
记录的教训**（"如果把 end_time 映射到镜像值，管理员写出的规则会静默按开始时间比对"），
改写成「曾经如此，`d191f5b` 之后有了真实数据源」。

### R2 · 影响预览

| # | 任务 | 落点 |
| --- | --- | --- |
| **T5** | 影响预览纯函数 | `src/policy/preview.ts`，**不落库** |

**必测**：计算范围是 `命中(旧) ∪ 命中(新)`，不是全集（构造一个「有 100 场会议但只有 3 场
在两个规则集的命中并集里」的场景，断言返回 3 而不是 100）；**人工改写过的会议被排除在
「会被改变」之外**（§3.5）。

**T5 落地时新增的三处裁定**（照 §3.4 的体例记在这里，实现以裁定为准）：

| # | 事 | 裁定 |
| --- | --- | --- |
| **D-f** | 计划只列了「判定变了」一种变化，但 allow 规则从 `['*']` 改成 `['transcript']` 时 effect 还是 `allow` | **`assets` 单列一类变化，与 effect 变化一同进「会被改变」**。只比 effect 的话，预览会对着一次真实的收紧说「0 场会改变」——§4.7 最不该出现的那种谎 |
| **D-g** | 「判定没变但决定它的规则变了」算不算受影响 | **单列 `deciderOnly`，不混进「会被改变」**。判定理由会出现在详情抽屉与会议行里，换了规则说了算那句话就变了，管理员该知道；但它不该制造与真正变更同等的警觉——混进去会让每次调优先级都报出一堆「受影响」，几次之后这个数字就没人看了 |
| **D-h** | 规则的「改动指纹」比哪些字段 | **`note` 不参与**。它不改变判定，只影响判定理由的措辞；算进去的话，改个错别字就会让全库会议进入范围、报出一堆「换了理由」。其余字段（含 `priority` / `enabled`）拿不准一律算改过——范围宁可宽一点，也不能漏掉真会变的会议 |

### R3 · 逐会议授权与人工改写

| # | 任务 | 落点 | 依赖 |
| --- | --- | --- | --- |
| **T6** | `meeting_grants` / `meeting_overrides` 表与 store | `migrations/004` · `src/store/grants.ts` | T1 |
| **T7** | 人工改写覆盖层 | `src/policy/override.ts`，在引擎**之外** | T3 · T6 |

**T7 必测**：改写优先于任何规则（包括 priority 最高的那条）；改写只对该场会议生效；
撤销改写后回落到规则判定。

### R4 · 采集清单重算

| # | 任务 | 落点 | 依赖 |
| --- | --- | --- | --- |
| **T8** | 采集清单重算（定时任务四） | `src/worker/visibility.ts` | T3 · T7 |

spec §1.3：外部程序真能取到 = **三个「与」**（规则放行 **且** 已授权 **且** 本地未过期）。
T8 算的就是这个交集，供 spec §4.5「现在可取走 N 场会议」那句话使用——
**它是求交之后的实际结果，不是配置值**。

**必测**：三个条件各缺一个时会议都不出现在清单里；本地已过期但 NAS 有副本的会议
**不在**可取清单里（要给出「本地已到期，请去 NAS 取」这个理由，spec §4.10）。

### 阶段 2 遗留的接线（本阶段一并做）

`src/worker/archive.ts:28-45` 的注释记着：归档目录现在是固定规则，
**「等 R1/R4 落地后这里要接一个真正的规则求值」**。T3 完成后把 archive 栈接上去，
并解决 §2.2 提到的「`archiveMeeting` 拿不到 subject/meetingCode/startTime」的接口问题。

同样，`src/worker/archive.ts` 里「NAS 断连时授权撤下」留的调用点占位，
依赖 `meeting_grants`（T6），本阶段补上。

---

## 5. 会变红的现有测试（预期之内，不是回归）

换语义必然让这些红，**改它们是任务的一部分，不是「修复」**：

| 文件 | 用例 | 为什么红 |
| --- | --- | --- |
| `tests/policy/engine.test.ts` | `低 priority 值优先` | 方向翻转 |
| `tests/policy/engine.test.ts` | `同优先级下 deny 优先于 allow` | 平局语义换成 id 升序 |
| `tests/store/policy.test.ts` | `按 priority 升序返回` | SQL 的 `ORDER BY` 也要翻 |
| `tests/policy/expr.test.ts` | `end_time 不是合法字段…` | C6 已闭合，`end_time` 现在有真实数据源 |
| `tests/policy/expr.test.ts` | 其余 12 条 | `expr.ts` 整体被 `conds.ts` 取代 |

**其余测试一条都不该红。** 尤其 `tests/http/meetings.test.ts` 与 `tests/e2e/flow.test.ts`
里那些通过 `insertPolicyRule()` 造规则的端到端用例——它们验证的是「策略确实拦得住」这件事，
换语义后**行为应当等价**（用新表示法写等价规则）。若这些红了，说明改动溢出了预期范围。

> **T4 落地时的实况（2026-08-25）**：上表四行全部按预期红了，
> `tests/policy/{engine,expr}.test.ts` 两个文件连同 `src/policy/{engine,expr}.ts` 一并删除
> （`expr.ts` 头部那段 `end_time` 的教训确认已活在 `conds.ts` 的文件头与
> `tests/policy/conds.test.ts` 的两条用例里，另在 `domain/types.ts` 的 `endTime` 注释里补了一处）。
>
> 端到端用例确实等价，但**主体换了**：这些用例原先用企微用户身份（`wecom_user`）
> 造 `subject_type='user'` 的规则，换语义后主体是采集程序，所以身份改成服务账号、
> 规则改成 `subject_type='program'`，断言一条没动。`tests/e2e/flow.test.ts` 里取数据的
> 四条用例因此从设备登录改为服务账号登录，并**新增一条**专门盯住
> 「设备授权登录仍然走得通，但企微用户一场会议都取不到」——设备登录链路的覆盖没有丢。

---

## 6. 全局约束

- **TDD**：先写测试看它红，再写实现。授权中枢没有「先实现再补测试」的余地
- **不许静默放行**：任何「判断不出来」的路径都必须落到拒绝一侧，并留下可查的理由。
  现有 `expr.ts` 反复强调这一条（未知字段、`not_in` 非数组、`gte/lte` 遇 NaN），新引擎继承
- **判定理由必须可回溯**：每次判定要能说出「是哪条规则（id + note）决定的」。
  spec §4.2/§4.3 的分诊条与详情抽屉、A2 的会议查询 API 全靠它
- **迁移不得静默改变判定**：见 §1.2。这是本阶段的最高风险项
- **验证**：每个任务完成跑 `bun run typecheck` + `bun test`，
  基线 591 pass / 0 fail（阶段 3 会让基线上升；T1+T4 完成后为 718 pass）；
  前端 `cd console && npx vitest run` 保持 133 pass

---

## 7. 规模与并行

```
T1 数据模型 ─→ T2 条件求值器 ─→ T3 三栈引擎 ─┬─→ T4 接线与清理
                                              ├─→ T5 影响预览
                                              └─→ T7 改写覆盖层 ─→ T8 清单重算
T1 ─────────────────────────→ T6 授权表与 store ──┘
```

- **T2 / T6 可并行**（不同文件，都只依赖 T1）
- **T4 / T5 可并行**（都依赖 T3，落点不重叠）
- **T3 是关键路径上的大头**，语义逐字实现，不适合拆开并行
- T1 卡在 §1.2 的查询结果上，**其余任务的准备工作可以先做**
