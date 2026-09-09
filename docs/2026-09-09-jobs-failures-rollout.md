# 2026-09-09 上线：失败项可重试/忽略、404 判永久缺失、横幅可关

规格：`docs/superpowers/specs/2026-09-09-jobs-failures-actions-design.md`

## 0. 前置

- 这一批**不改任何已落盘的文件、不删任何东西**，只加一列、改几条状态流转。不需要停机备份磁盘。
- 库还是要备一份：`mysqldump <db> job_failures meeting_assets > backup-jobs-2026-09-09.sql`。
- **「周期会议按录制记录拆场次」那一批是前置，不是并行项**：它的提交就在这一批下面
  （`bff6004`…`ea2c4ca` 都是本分支 HEAD 的祖先），部署这一批必然把它一起部署。
  它自己有硬顺序约束（拆分脚本必须抢在新代码首轮 `fetch_recordings` 之前），
  那份 runbook 是 `docs/2026-09-09-recurring-split-rollout.md`——**先把它整份走完，
  这里不重复它的任何一步**。本机已经走完并上线，所以本机只需要从第 1 节接着做。
- 本机现在跑着的是：网关 `:3100` + 调度器 + 控制台 vite dev（主工作树，合并后的分支）。
  生产机上控制台是网关自己发的静态目录（`console/dist`，`src/http/static.ts`），
  第 1 节的顺序按生产机写。

## 1. 部署

    git pull && bun install && bun run typecheck

**先把网关起起来，再 build 控制台。** 顺序反了这一页就是白的：新的控制台契约
**要求** `failures[].detail`（`console/src/api/admin/jobs.ts` 用 `r.strOrNull` 读它，
字段缺失就是 `ApiShapeError`），而旧网关不发这个字段。静态文件是**逐请求**从盘上读的
（`Bun.file`），所以网关起完之后再 build，不用为了让新产物生效再重启一次。

    # 1) 先起网关（它启动时跑迁移）
    #    本机是 bun run dev / 生产机按各自的进程管理器重启
    # 2) 再 build 控制台
    cd console && bun run build && cd ..
    # 3) 最后起调度器

迁移 `migrations/014_job_failures_detail.sql` 在网关/调度器启动时自动跑（`src/store/db.ts`
的 `runMigrations`，`src/index.ts` 与 `src/worker/scheduler.ts` 两处都调），
它只做一件事：`job_failures` 加一列 `detail TEXT NULL`。守卫走 information_schema +
PREPARE/EXECUTE，是幂等的，重跑安全。

启动日志里不该有 `mig014` 相关的报错。

## 2. 确认新列到位

    SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_failures' AND COLUMN_NAME = 'detail'

出一行就对了。存量失败项的 `detail` 是 NULL——它们是上一版写的，没有明细，
界面上不画「技术详情」折叠。下一轮拉取跑完之后，仍然 dead 的那些会被重记一遍，
`reason` 换成人话、`detail` 补上原文（`recordFailure` 的 `ON DUPLICATE KEY UPDATE`
里 `reason` 与 `detail` 都是整列覆盖，不是只在插入时写）。

## 3. 看一轮拉取

等一轮（或者在「定时任务」页点「立即运行」）。跑完看失败项表：

- 原因那一列应该已经是「录像：腾讯那边没有这个文件」这种句子，不再是 `ENOENT: …` 一长串
  （五句人话的全集在 `src/worker/failure-text.ts` 的 `describeDownloadError`：
  `腾讯那边没有这个文件` / `腾讯下载服务出错` / `本地写入失败` / `下载不完整` / `下载失败`）
- 同一件事的会议应该归并成一行，「涉及」那一格写着「N 场会议」

## 4. **把存量的 33 条 dead 404 收敛掉**

这一步必须做，它是这一批改动落地的最后一环。

规格 §2.2 定的是：**不写数据迁移**，靠界面上的一次「全部重试」把它们打回队列，
下一轮拉取重新试一次——这一次下载器会在 404 上换一条新链再试，第二次仍 404 就
判永久缺失（`DownloadResult.permanent`），执行器据此 `markSkipped('upstream_missing')`，
资产落成 `skipped/upstream_missing`，失败项自然消失。

操作：

1. 打开控制台「定时任务」页，找到原因是「录像：腾讯那边没有这个文件」的那一组
   （屏幕上写着「33 场会议」这种数字）
2. 点这一组的 **「全部重试」**
3. 等下一轮拉取跑完（每 15 分钟一轮，也可以在拉取那张卡片上点「立即运行」）

一并要知道的两件事：

- 「全部重试」作用的是**这一批下发下来的**组内失败项。表一次最多下发 100 条，
  被截掉的不在其中（表头上方那句「还有 N 条没有列出来」在说这件事）。33 条在一页之内。
- 重试的粒度是**一场会议**（`meeting_id` + `sub_meeting_id`），会把那场会议
  所有 failed/dead 的资产一起打回 `pending` 并把 `attempts` 清零——不只是 404 的那几条。
  这正是想要的：同一场里别的失败资产也该再拿一次完整的五次机会。

跑完之后核对：

    SELECT status, last_error, COUNT(*) FROM meeting_assets
     WHERE last_error IN ('http 404', 'upstream_missing') GROUP BY status, last_error

期望：`skipped / upstream_missing` 一批，`dead / http 404` 归零。
（`markSkipped` 把 `upstream_missing` 写进 `last_error`，所以收敛之后 `http 404`
这个取值在这张表上就不该再有了。）

    SELECT COUNT(*) FROM job_failures WHERE resolved_at IS NULL AND job_name = 'fetch_recordings'

期望：只剩真正需要人处理的那几条。本机实测是 ENOENT（界面上是「本地写入失败」）
那一小撮，成因是平台给了个空正文、`.part` 从未建出来，引擎已修（`bff6004`：空正文落
0 字节文件），在那一组上点一次**「重试」**就该成功。

**如果重试之后它们又变回 dead**，说明下载器那条 404 分支没有生效——去库里看那几条资产：
`status` 应该是 `skipped`、`last_error` 应该是 `upstream_missing`。仍是
`dead / http 404` 就回滚代码（这一批没有不可逆动作），别继续点。

## 5. 顺手验一下另外两件事

- 「归档到 NAS」那张卡片如果是「已经落后」，页顶横幅右上角现在有一个 ×
  （可访问名「关闭这条提醒」）。点掉它，刷新页面不该回来；在那个任务上点一次
  「立即运行」（它会多一行运行记录，落后横幅的身份里带着 `lastRunId`），横幅应该回来。
  **只要那次运行没把「落后」修好**——调度器要是活着并且真把这一轮跑成了，
  卡片翻回「正常」、横幅整条消失，那是另一个（也正确的）结果，不是这一步失败。
- 随便找一条拉取失败项点「忽略」，那一行当场消失；去库里看那场会议的资产应该是
  `skipped / ignored_by_admin`。这一步做完记得在「操作审计」页确认有一条
  「忽略一条失败项」的记录，操作者是你。（重试那个动作的标签是「重试一条失败项」，
  两个都逐条记一行。）

## 6. 回滚

代码回滚即可，`detail` 那一列留着不碍事（旧代码不读它，也不写它）。
第 4 步已经跑过的话，那些资产已经是 `skipped/upstream_missing`——那是一个正确的
终态，回滚之后它们也不会变回 dead，不需要额外处理。

前置那一批（拆场次）的回滚是另一回事，见它自己的 runbook；这一份的回滚**不需要**
连带回滚它。
