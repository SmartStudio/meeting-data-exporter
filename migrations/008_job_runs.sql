-- 控制台阶段 4 · T11（A4）：定时任务的运行记录与失败项，外加给 audit_log 补一列 detail。
--
-- 计划：docs/superpowers/plans/2026-08-26-console-stage4-api-and-scheduler.md §3 T11
-- 规格：docs/console/spec.md §4.8「定时任务」
--
-- ## 这次建两张表、加一列
--
--   job_runs      每一次任务运行的一行。§4.8 那条 sparkline 读它，"失败的那次是红的"
--                 靠 status 分色
--   job_failures  §4.8「失败项 · 需要处理」那张表。**失败项不静默丢弃**是硬要求
--   audit_log.detail  新增一列 TEXT，见下面第三节
--
-- ## 一、job_runs：为什么排队态也是它的一行
--
-- 手动触发端点（POST /api/v1/admin/jobs/:name/run）在**网关进程**里，而调度器在
-- **worker 进程**里（spec §4.8 的四个任务各跑一份是灾难，网关是多实例的）。
-- 于是网关不能自己跑任务，它只能留下一条"有人要求跑一次"的记录，由 worker 侧的
-- 调度器在下一个 tick 认领。这条记录就是 job_runs 里 status='queued' 的一行——
-- 不另开一张 job_requests 表，是因为它随后会**原地**变成 running / succeeded，
-- 那正是同一次运行的生命周期，拆两张表只会让"这次手动触发到底跑了没有"要 join 才答得出。
--
-- status 的取值与各自的含义（都是**事实**，不是"还没轮到"）：
--   queued       网关记下了手动触发请求，调度器还没认领
--   running      已开跑，还没结束。**进程崩在这里的行会一直是 running**，见第二节
--   succeeded    跑完了，summary 里是这一轮的数字
--   failed       任务体自己抛了（不是"轮内有几件事失败"，那种走 succeeded + summary）
--   interrupted  调度器启动时发现的上一次残留 running 行——进程中途断过
--   skipped      到点了，但上一轮还没跑完，本轮不起（重叠保护，验收判据 2）
--
-- ## 二、"进程重启后不补跑错过的，但要看得出中间断了"（验收判据 3）
--
-- 不补跑是**结构保证**，不是一段代码：调度靠"当前时间落在哪个时间片"判到没到点
-- （见 src/store/jobs.ts 的 slotOf），进程启动时把每个任务的"上一次触发的时间片"
-- 初始化成**此刻这一片**，于是错过的那些片永远不会被翻出来重放。
--
-- 看得出断过则靠这张表：崩溃时那一行 running 没人写 finished_at，调度器下次启动
-- 会把它改成 interrupted 并填上发现时刻。所以时间轴上会留下
-- "…succeeded, succeeded, interrupted, （一段空白）, succeeded…"——空白就是停机窗口。
--
-- **这条清理只对本进程负责的任务做，且假定同一时刻只有一个调度器实例。**
-- 多开一个调度器的话，后启动的那个会把前一个正在跑的 running 行误标成 interrupted
-- （数据错，任务不会被中止）。这与"调度器只能有一份"是同一条部署约束的两面。
--
-- ## 三、job_failures：一行一个"对象"，重复失败是累加不是新增
--
-- 唯一键 (job_name, target)：同一个对象在同一个任务上反复失败，是**同一个失败项**
-- 重试了 N 次，不是 N 个失败项。§4.8 要显示的"2 / 5"就是这一行的 attempts /
-- max_attempts。每轮插一条新行的话，一场归档不上的会议会在几天内把这张表刷成几百行，
-- 而"需要处理"的其实自始至终是同一件事。
--
-- target 是那个对象的**规范化键**（会议是 meeting_id + sub_meeting_id，程序是
-- service_accounts.id，整轮性的失败是任务自己的名字）。meeting_id / sub_meeting_id
-- 另外单列两列，是为了让详情抽屉能按会议反查——target 是给唯一键用的，不是给查询用的。
--
-- **max_attempts 是"该找人了"的阈值，不是"到此为止"的阈值。** 归档没有重试上限：
-- listMeetingsNeedingArchive 只要还看得到未归档的完成资产就会把这场会议再捞回来，
-- 结构上会一直重试下去。真给它一个停止阈值才是错的——放弃归档意味着这场会议的
-- 录制在上游到期后彻底没有了（spec §1.2），而放弃之后它连"失败项"都不再是。
-- 取 5 与引擎下载执行体的 MAX_ATTEMPTS 同值（packages/engine/src/executor/index.ts），
-- 好让界面上两处"N / 5"是同一个口径。
--
-- resolved_at：失败项**恢复了也不删行**。删掉等于把"这件事曾经卡了三天"从历史里抹掉，
-- 而那恰恰是运维复盘要看的。"失败项 · 需要处理"那张表按 resolved_at IS NULL 过滤。
--
-- ## 四、audit_log 新增 detail TEXT——它是给谁的
--
-- 两个已完成的任务各自独立撞上了同一堵墙：audit_log 里能装自由文本的最宽一列是
-- asset_id VARCHAR(255)，而实际被当成自由文本用的是 asset_type VARCHAR(64)：
--
--   T6（规则 API）  记不下一条完整规则，只能记"变了的字段"并截断留一个省略号
--   T9（审计 API）  记不下拒绝原因，多数记录只能对外报 reason: null
--
-- 本迁移**只把这一列加出来，不改任何现有写入方**。把 T6 / T9 改成用新列是后续任务的事
-- ——那要同时动写侧与读侧的形状，混进本任务只会让一次调度器的改动附带一次审计语义的改动。
--
-- 为什么是 TEXT 而不是 VARCHAR(N)：这一列装的是"一条规则的全文" / "一句拒绝原因"，
-- 前者的长度由管理员写的规则决定，挑任何一个 N 都是在赌。TEXT 存在行外，NULL 的行
-- （现存的全部记录）一个字节都不多占。
--
-- 为什么可空：现存记录没有这一列的值，NULL 表示"这条记录写下时还没有 detail"，
-- 与空串（"写了，但内容为空"）是两回事。
--
-- ## 五、迁移本身的两条硬约束（src/store/db.ts 的 runMigrations）
--
-- 1. 它按分号**朴素切分**语句，所以除语句结束符之外本文件不许出现分号，注释里尤其不行
-- 2. 它**每次启动都重跑**。CREATE TABLE 带 IF NOT EXISTS 就够
--    ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，必须走 information_schema 守卫
--    （写法沿用 004 与 006，动态语句只能靠 PREPARE 实现，
--    而会话变量与预处理语句都是会话级的——runMigrations 把整个迁移跑在同一条连接上）

CREATE TABLE IF NOT EXISTS job_runs (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  -- 任务名。取值见 src/store/jobs.ts 的 JOB_CATALOG，与 spec §4.8 的四个任务一一对应
  job_name     VARCHAR(32)  NOT NULL,
  -- schedule = 到点自动跑，manual = 管理员在界面上按的。列名不叫 trigger:
  -- 那是 MySQL 的保留字，每次引用都要反引号
  trigger_kind VARCHAR(16)  NOT NULL DEFAULT 'schedule',
  -- 手动触发的管理员（admin_accounts.id）。schedule 的行为 NULL
  requested_by VARCHAR(128) NULL,
  -- queued / running / succeeded / failed / interrupted / skipped，含义见表头第一节
  status       VARCHAR(16)  NOT NULL,
  -- 开跑时刻。queued 的行还没开跑，为 NULL——与"开跑了但没跑完"（started_at 非空、
  -- finished_at 为空）必须分得开，否则界面上"排队中"和"正在跑"长得一样
  started_at   BIGINT       NULL,
  finished_at  BIGINT       NULL,
  -- 这一轮的数字。四个任务各有各的形状（归档轮是 newlyArchived/failed/…，
  -- 清单重算是逐程序的 fetchable/blocked），所以是 JSON 不是几个定死的列。
  -- E-e 裁定的"清单重算写摘要不写缓存"，写的就是这一列
  summary      JSON         NULL,
  -- 任务体自己抛出时的错误话。status='failed' 时非空
  error        TEXT         NULL,
  created_at   BIGINT       NOT NULL,
  PRIMARY KEY (id),
  -- sparkline 与"最近一次运行"都是"按任务取最近 N 行"，这条索引正是为它建的。
  -- 第二段用 id 而不是 started_at：queued 的行 started_at 为 NULL，
  -- 按它排序会把排队中的那一行排到时间轴之外
  KEY idx_job_runs_name (job_name, id DESC),
  -- 调度器每个 tick 都要问"有没有人要求手动跑一次"。没有这条索引，
  -- 那次查询在一张只增不减的表上是全表扫，而它每 30 秒跑一次
  KEY idx_job_runs_queued (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='定时任务的每一次运行。spec 4.8 的 sparkline 读它';

CREATE TABLE IF NOT EXISTS job_failures (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  job_name        VARCHAR(32)  NOT NULL,
  -- 失败对象的规范化键，见表头第三节。191 是为了让 (job_name, target) 这条唯一键
  -- 在 utf8mb4 下稳稳落在 InnoDB 的索引字节上限之内
  target          VARCHAR(191) NOT NULL,
  -- 人读的对象名（会议标题、程序名）。§4.8 那张表第一列显示它,
  -- 只有 target 的话运维看到的是一串 ID
  target_label    VARCHAR(255) NOT NULL DEFAULT '',
  -- 会议维度的失败项才有值。target 是给唯一键的，这两列是给"按会议反查"的
  meeting_id      VARCHAR(64)  NULL,
  sub_meeting_id  VARCHAR(64)  NOT NULL DEFAULT '',
  -- 失败原因原文。归档失败的原因里常带着 NAS 路径与底层 errno，截断了就查不下去
  reason          TEXT         NOT NULL,
  -- 一句"影响"，spec §4.8 明写要有。归档那句是「未归档，到期会永久丢失」
  -- （spec §1.2：没有归档成功的会议，本地保留期一到就彻底没有了）
  impact          VARCHAR(255) NOT NULL,
  attempts        INT          NOT NULL DEFAULT 1,
  -- 该找人了的阈值，不是到此为止的阈值。理由见表头第三节
  max_attempts    INT          NOT NULL DEFAULT 5,
  first_failed_at BIGINT       NOT NULL,
  last_failed_at  BIGINT       NOT NULL,
  -- 非空 = 后来自己好了。行不删，理由见表头第三节
  resolved_at     BIGINT       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_job_failure (job_name, target),
  -- "失败项 · 需要处理"那张表的查询就是这一条：未恢复的，最近失败的排前面
  KEY idx_job_failure_open (resolved_at, last_failed_at DESC),
  KEY idx_job_failure_meeting (meeting_id, sub_meeting_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='spec 4.8 的失败项 需要处理。失败项不静默丢弃';

SET @mig008_has_detail := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'audit_log'
     AND COLUMN_NAME = 'detail'
);

SET @mig008_sql := IF(@mig008_has_detail = 0,
  'ALTER TABLE audit_log ADD COLUMN detail TEXT NULL',
  'DO 0');

PREPARE mig008 FROM @mig008_sql;
EXECUTE mig008;
DEALLOCATE PREPARE mig008;
