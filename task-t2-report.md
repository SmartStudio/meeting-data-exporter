# T2 · 规则写侧（A3 的数据底座）—— 完成报告

- 日期：2026-08-26
- 计划：`docs/superpowers/plans/2026-08-26-console-stage4-api-and-scheduler.md` §3 T2（裁定 E-g）
- 落点：`src/store/policy.ts` · `tests/store/policy.test.ts`（只碰了这两个文件）
- 状态：**DONE**

## 一、交付内容

`PolicyStore` 在原有两个判定路径读法之外，追加了管理侧的六个方法：

| 方法 | 说明 |
| --- | --- |
| `listAllRules(kind?)` | **含 disabled**，按判定顺序排列，每条带 `issues` |
| `getRule(id)` | 单条，不存在返回 `null` |
| `createRule(draft & { now })` | 校验不过**拒绝 promise**，一行都不落库 |
| `updateRule(id, patch)` | **合并到当前行之后整体校验**；不存在返回 `null` |
| `setEnabled(id, enabled, now)` | **不做内容校验**（理由见下） |
| `deleteRule(id)` | 返回**被删规则的完整内容**（不是布尔） |

新增导出：`RuleDraft` · `RulePatch` · `AdminRule` · `PolicyRuleInvalid`。

`AdminRule` = 引擎要的 `StackRule` + `createdBy` / `createdAt` / `updatedAt` + `issues`
（`describeStackRuleIssues` 的原样结果）。**没有另起一套 store 私有的规则形状**——
文件头注释里那条「每一次映射都是一次可能悄悄改变判定的机会」对写侧同样成立。

判定路径的两个读法（`listEnabledRules` / `listEnabledStackRules`）与它们的 SQL
**一个字都没改**，管理侧的三列（`created_by` / `created_at` / `updated_at`）
只有管理侧的查询多读。

## 二、两条最要紧的验收判据

### 1. 校验失败是 reject，不是同步 throw

`createRule` / `updateRule` / `setEnabled` 全部声明为 `async`，校验在函数体内做，
所以失败一律是被拒绝的 promise。测试里钉的是这件事**本身**，不只是「会失败」：

```ts
expect(() => { p = store.createRule(draft({ conds: [] })) }).not.toThrow()
await expect(p!).rejects.toThrow(PolicyRuleInvalid)
```

调用那一步不许抛——抛了就说明校验发生在 promise 之外，调用方的 `.catch()` 会被绕过
（阶段 3 的 `putOverride` 踩过，见 `grants.ts` 里那条注释）。

### 2. `conds` 为空数组拒绝写入

空 conds 在 `evaluateRule` 里是「匹配一切」，一条空条件的 allow 规则就是放行全库的
兜底规则。写侧连同**非数组 conds** 一起拒。这与 `policy.ts` 里 `CONDS_UNPARSABLE`
那段注释是同一件事的两面，我在那段注释里补了一句指向写侧的交叉引用：
读侧堵的是已经躺在库里的坏数据，写侧堵的是新的，两道都要。

三栈一视同仁：fetch 的空 conds 是「全拉」，archive 的是「全归档到同一个目录」，
都不比 allow 无辜。

## 三、写侧拒什么、只报什么（这次唯一需要自行裁定的一条线）

计划只点名了 `kind` / `join_op` / `conds` / `effect` 四项，其余得自己定。
用的判据是**两类事故各自的方向**，写在 `validateDraft` 的头部注释里：

**拒绝**（写不进去）：

- a. **判定会比管理员的本意更宽**：空 conds、非数组 conds。
- b. **存进去的东西和管理员填的不是一回事**：`effect` 是脏数据（读侧会替它落到本栈
  安全侧）、资产类型名不认识（读侧会把那一类丢掉，界面上看起来像是授权过了）、
  `note` 超列宽（MySQL 非严格模式静默截断，而 note 会原样进判定理由）、
  `priority` 不是整数或超 INT 范围（数据库会取整/截断，判定顺序跟着变）、
  `kind` / `join_op` 填错、allow 栈缺采集程序主体、fetch/archive 栈带主体。
- c. 条件里的**拼写错误**（未知字段、不支持的运算符、值类型不对）。
  这一条是我加的，理由：这三种没有任何正当用途，而它们造出来的死规则在 allow 栈里
  可能让一条本该拦住的 deny 落空、由低优先级的 allow 接手；写侧是唯一一次
  「管理员就站在这里、能当场改」的机会。

**只报不拒**（照写，问题进 `AdminRule.issues`）——「这条规则没用」那一类：

- `dept` 条件当前没有数据源（企微通讯录未接入）。这是系统能力缺口，规则本身没写错，
  管理员可以先配着等通讯录接上。拦掉等于让他配不成。
- 准许采集却没列出任何合法资产类型。它落在**安全侧**（一类都取不到），
  不是「比本意更宽」，而读侧本来就要显示它（验收 3）。

### 怎么做到「不另写一套判断」

- `effect` → `normalizeEffect(kind, …)`，`asset_types` → `normalizeAssetTypes`，
  静态问题 → `describeStackRuleIssues`，全部是 `stacks.ts` 已有的。
- 条件层的拼写检查**没有照着 `CONDITION_FIELDS` 再判一遍**：值层的阻断性检查
  （`blockingValueIssue`）是 `conds.ts` 的模块私有函数，复制一份就是第二套判断。
  改用**探针**：`evaluateCond(cond, PROBE_FACTS, 0)`，因为 `evaluateCond` 在碰
  facts 之前就把形状 / 字段 / 运算符 / 值查完了，`malformed` / `unknown_field` /
  `unknown_op` / `bad_value` 这四种 reason 与会议数据无关，是纯静态结论。
  `no_data_source` / `not_matched` 不在阻断集里，dept 因此写得进去。

## 四、另外几处需要说明的裁定

1. **`setEnabled` / `deleteRule` 故意不校验规则内容。** 一条 conds 坏掉的规则照样要
   停得掉、删得掉——出事时「把这条规则关掉」是唯一能立刻止血的动作，若它也要先过校验，
   恰恰是最该关掉的那条规则会变成关不掉的。有测试钉住。
2. **`deleteRule` 返回被删规则的完整内容，不是布尔。** `policy_rules` 没有软删除的列
   （本任务不加迁移），删完这条规则在库里就不存在了，「它当时长什么样」只能由调用方
   记进 `audit_log`。不把内容带出来，那条审计就无从记起。
3. **`updateRule` 是合并后整体校验**，且在事务里 `SELECT … FOR UPDATE`。
   - 合并后校验：规则的合法性有跨字段的部分（allow 栈必须有主体、fetch 栈必须没有），
     只看 patch 会让「把 allow 改成 fetch、主体忘了清」溜过去。有测试钉住。
   - `FOR UPDATE`：没有它，两个管理员各读一份各写一份，后写的那次会带着过期快照
     覆盖回去，先写的改动就此消失——而这里改的是数据出境的闸门。
   - `created_at` / `created_by` 不在 `SET` 里：那两列记的是「谁什么时候建的」。
4. **`setEnabled` 不看 `affectedRows`，改为重读一次。** MySQL 默认只数「真的改了的行」，
   一次「本来就是这个状态」的重复点击会被报成「规则不存在」。
5. **列宽按码点数检查**（`[...s].length`，不是 `.length`），与 MySQL 的 VARCHAR(n) 一致。
6. `inTransaction` 与 `grants.ts` 里那个同名函数重复了十行。两个 store 各自独立，
   等第三个也要用时再提到 `db.ts`，现在提取只是多一层间接（且本任务不许碰 `db.ts`）。

## 五、验证

```
bun test tests/store/ tests/policy/     312 pass · 0 fail
bun run typecheck                       干净
bun test（全量）                         856 pass · 0 fail · 75 files
```

`tests/store/policy.test.ts` 新增 22 个用例（全文件 34 个）。TDD：先写的测试因
`PolicyRuleInvalid` 未导出整体失败，实现后转绿。另做过一次**变异验证**——
把空 conds 那一支临时改成恒假，3 个用例当场失败（不是空转），改回后复绿。

## 六、给下游（T6 · A3 规则 API）的交接

- **审计不在 store 这一层。** store 拿不到操作者身份，`audit.ts` 也不在本任务的可改
  范围内。计划 §1 约束 6 与 E-g 的「改规则必须记审计」由 T6 的 handler 落，
  `deleteRule` 返回完整内容就是为它准备的（`rule_create` / `rule_update` /
  `rule_delete` / `rule_toggle` 四个 action）。
- `PolicyRuleInvalid.issues` 是逐条中文描述，校验**不短路**（一次把能说的都说完），
  可直接下发给规则编辑器逐条标红 → 400。
- `updateRule` / `setEnabled` / `deleteRule` 返回 `null` = 规则不存在 → 404。
  与「校验不过」（reject）是两条不同的路径，别合并。
- `AdminRule.issues` 直接就是 §4.7 规则页要显示的「这条规则不会命中任何会议」。

## 七、与计划矛盾之处

**无。** 计划 §3 T2 的三条验收判据逐条落地，`policy_rules`（004）的列确实够用，
没有新迁移。唯一需要自行裁定的是「写侧拒什么、只报什么」那条线（计划只点名了四项），
裁定与理由见第三节，已逐条写进 `validateDraft` 的头部注释。
