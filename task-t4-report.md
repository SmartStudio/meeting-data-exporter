# T4 · 文本类资产正文入库（A6 写侧）—— 完成报告

- 日期：2026-08-26
- 计划：`docs/superpowers/plans/2026-08-26-console-stage4-api-and-scheduler.md` §3 T4
- 状态：**DONE_WITH_CONCERNS**（功能与验收判据全部落地，但生产路径上**还没接线**，见 §4）

---

## 1. 交付物

| 文件 | 新建/修改 | 内容 |
| --- | --- | --- |
| `migrations/007_asset_contents.sql` | 新建 | `asset_contents` 表 + 两条 CHECK |
| `src/store/contents.ts` | 新建 | `ContentsStore`（put / get / listPending）+ `buildAssetContent` |
| `src/worker/archive.ts` | 修改 | 归档成功后的正文入库接线（一处） |
| `scripts/backfill-contents.ts` | 新建 | 手动回填脚本 |
| `tests/store/contents.test.ts` | 新建 | 28 条（store 往返 + CHECK + buildAssetContent + 回填） |
| `tests/worker/archive.test.ts` | 修改 | 追加 T4①–⑧ 八条；用例 1 的 `toEqual` 补一个 `contents` 字段 |

`src/http/` / `src/policy/` / 其它 store 一个字都没碰。

---

## 2. 四条验收判据逐条对照

**① 入库在归档成功之后、按 NAS 副本的哈希对齐。**
接线点在 `archiveMeeting` 的归档循环里，紧跟 `archiveOneAsset` 返回 `archived` 之后，
用的是它带回来的 `nasPath` / `nasHash`（为此把 `archiveOneAsset` 的返回从字符串
换成了 `{status, nasPath, nasHash}`——重新拼一遍路径或再查一次库都是给「两处算法
悄悄分叉」留口子）。`buildAssetContent` **重新读 NAS 上那份副本、重新算 sha256**，
与 `archived_assets.nas_hash` 逐字比对，对不上就不入库。
测试：T4①（`content_hash === nasHash`）、T4⑤（对不上 → 不写行 + warn）。

**② 入库失败不让归档判为失败。**
`ingestAssetContent` **永不抛出**：内部 try/catch，失败只 `console.warn` + 计数。
计数落在 `ArchiveOutcome.contents = {ingested, unparsed, failed}`，与
`ArchiveRoundOutcome.failed` 完全分开。测试 T4④：`put` 抛错时
`result.newlyArchived===1`、`result.failed===0`、`meeting_archives` 照常落库。

**③ `MEDIUMTEXT` 装不下明确拒绝并留痕，不截断。**
`buildAssetContent` 先 `stat` 再决定读不读（一个 100MB 的「txt」整读进内存只是为了
随后判它超限，等于让防御措施自己成为故障源），超限落一行
`status='too_large'` + reason 写清字节数。读到手之后再查一次实际长度（stat 与 read
之间文件可能变了）。上限常量 `MEDIUMTEXT_MAX_BYTES = 16*1024*1024-1`，
可注入小值供测试——另有一条用例钉住默认值不许漂。

**④ 回填脚本只处理没有的行，可重复跑。**
枚举源是 `ContentsStore.listPending`：`archived_assets LEFT JOIN asset_contents`
的差集，再按文本类 `asset_type` 过滤。跑过的行（**含「未解析」那种**）下次不再出现。
测试：三条（只补缺的 / 第二次跑什么都不做 / limit 截断后剩下的留给下一次）。

**坑（docx / pdf）**：只入 `txt`，其余格式**记一行 `status='unsupported_format'` +
reason**，不是静默跳过。这一条写进了 007 的表头注释（连同「为什么值得为没解析出来
的东西占一行」：预览页要能说「这份纪要是 docx，本版本不解析」，而不是「查无此物」
——后者与「这场会议压根没有纪要」在界面上长得一模一样）。

---

## 3. 与计划矛盾之处（自行裁定）

### 3.1 主键：计划写四段，实现是五段 ⚠️ 唯一一处实质矛盾

计划 §3 T4 的表结构是
`(meeting_id, sub_meeting_id, asset_type, file_type)`，注为「与 archived_assets
同键的前四段」。**这句注与代码现实对不上**：`archived_assets` 的主键是五段，
第四段是 `remote_id`，`file_type` 排第五（`migrations/003`）。

照抄会撞键：同一场会议的同一类文本资产**可以有多段**——引擎的
`assetKeyToFilename` 专门为此留了 `transcript_2.txt` 这种序号消歧
（`FILENAME_HAS_REMOTE_ID` 对文本类全为 false），多段之间正是靠 `remote_id` 区分。
少这一段的后果：走 upsert 是**静默覆盖**（预览页显示最后归档的那一段，没有任何
痕迹说明还有另一段），走普通 INSERT 是每轮撞主键报错。

**裁定：五段，与 `archived_assets` 逐列对齐。** 理由写进 007 的表头。
回归用例：`tests/store/contents.test.ts` 的「同一场会议的两段转写按 remote_id
各占一行」、`tests/worker/archive.test.ts` 的 T4⑧。

### 3.2 表比计划多两列：`status` / `reason`

计划的表只有 `content / content_hash / bytes / parsed_at`。但「不许静默跳过：
记一行未解析并说明原因」这条要求没有地方放原因——一行 `content IS NULL` 而没有
其它信息，与「正文是空文件」「还没轮到」都分不开。加 `status`（三取值，有 CHECK
兜底）+ `reason`（一句人话，直接给预览页用）。`content` / `content_hash` 因此
可空，并由第二条 CHECK 保证两种形状不会混："parsed 必有正文、非 parsed 必有理由"。

### 3.3 `ArchiveDeps.contents` 是**可选**的（刻意破例）

仓库的惯例是「忘了接线的后果不是报错而是静默降级 → 就做成必填，让编译器盯着」
（`getMeeting` / `listArchiveRules` 的注释都这么写）。这里破了例：T4 的文件边界
不含 `src/worker/index.ts`（宿主在那里组装 `ArchiveDeps`），做成必填会让仓库
当场编译不过。

破例的代价用另一种方式补上：**没接线时每一个本该入库的资产都会 warn 一句**
（`archive 正文入库未接线（ArchiveDeps.contents 未提供）…`），而不是什么都不发生。
它只在「这一轮真的新归档了一个文本类资产」时触发，所以是一条一次一资产的精确信号，
不是每轮刷屏。测试 T4⑥ 钉住这句话。

### 3.4 `ArchiveRoundOutcome` **没有**加轮级计数

`tests/worker/e2e.test.ts:296,580` 用 `toEqual` **逐字**断言整个 `archived` 对象，
而那个文件在 T4 的可改范围之外，加字段会当场挂掉两条既有测试。加之在正文入库还没
接进 `src/worker/index.ts` 之前，轮级计数只会是一串恒为 0 的数字。

**裁定：轮级计数留给接线的那个任务**（T10 A6 读侧 / T11 A4 调度器，后者本来就要改
`archive.ts`）。当前的留痕靠每一次失败/未解析各自的 warn，不靠轮末汇总。
这条决定写进了 `ArchiveOutcome.contents` 的注释里。

---

## 4. 已知缺口（DONE_WITH_CONCERNS 的原因）

**正文入库在生产路径上还没有真正生效。** `src/worker/index.ts` 组装 `ArchiveDeps`
时没有传 `contents`（那个文件不在 T4 的可改范围内），所以 worker 跑起来仍然只归档、
不入库——每个本该入库的文本资产会 warn 一句提醒。

接线只需要在 `src/worker/index.ts` 的 `archiveDeps` 里加一行
`contents: createContentsStore(pool)`（`pool` 那里已经有，`createArchivesStore(pool)`
就在同一段），并把 `ArchiveDeps.contents` 的 `?` 去掉。**建议由 T10（A6 读侧）
或 T11 一并做掉**，否则 A6 的预览页会一直读到空表，而这个缺口在界面上的表现是
「所有会议都没有纪要正文」——和 E-c 说的那类「引擎交付了、接线漏了」是同一种事故，
只是这次它自己会喊。

其它两点次要的：

- `archived_assets.nas_path` 存的是**绝对路径**，回填脚本直接按它读。NAS 挂载点
  如果换过，回填会整批报「读不到」（有 reason、不写行、挂好后重跑即可），
  但脚本不会自己去 `nasRoot` 重新拼路径——那需要知道旧挂载点，猜不出来。
- 16MB 上限的另一侧是 MySQL 的 `max_allowed_packet`（不少部署仍是 16M 甚至 4M）。
  一份接近上限的正文可能在 `put` 那一步被服务端拒绝，走的是「入库失败」那条路：
  不写行、warn、下次回填重试。这不是本任务能单方面解决的（改的是部署参数），
  `put` 的注释里记了。

---

## 5. 验证

```
bun run typecheck                      # 干净
bun test tests/store/ tests/worker/    # 296 pass / 0 fail（20 个文件）
bun test                               # 868 pass / 0 fail（76 个文件，全量）
```

- 既有归档流水线测试**一条都没挂**（`tests/worker/archive.test.ts` 27→35 条全绿，
  `tests/worker/e2e.test.ts` 未改动、全绿）。
- 迁移幂等性单独实测：对同一个库连跑两次 `runMigrations`（经回填脚本触发），
  第二次无报错；`information_schema` 里 `ck_asset_content_status` /
  `ck_asset_content_shape` 两条约束都在，且 MySQL 真的在执行它们
  （三条「绕开 store 直接 INSERT 被拒」的用例）。
- 007 全文无 ASCII 分号（除唯一的语句终止符），符合 `runMigrations` 的朴素切分约束。
