-- job_failures 加一列 detail：原始技术信息（错误原文、资产 id、路径），
-- 从此 reason 那一列只放人话。
--
-- 规格：docs/superpowers/specs/2026-09-09-jobs-failures-actions-design.md 第 2.4 节
-- 写侧：src/worker/failure-text.ts 的 deadAssetsDetail，经 scheduler 的 recordDeadAssets
-- 读侧：GET /api/v1/admin/jobs 的 failures[].detail，控制台失败项表的「技术详情」
--
-- ## 为什么非得分成两列
--
-- 失败项表按「任务 + 原因 + 影响」归并（console/src/pages/Jobs/view.ts 的
-- groupFailures），判据是三段文字**逐字相同**。原始报错里带着 remote_id 与
-- 本地路径，每一条都不一样——把它留在 reason 里，一轮拉取里 23 场会议的
-- 同一件事就是 23 个组，整页要滚三屏才见底。而那些信息又不能扔：运维判断
-- 「该去查什么」靠的就是它。所以分列，不是二选一。
--
-- 可空是它的语义本身：归档任务那种失败项本来就只有一句人话，没有技术明细。
-- NULL = 没有明细，读侧据此不画「技术详情」那个折叠。
--
-- ## 迁移的两条硬约束（src/store/db.ts 的 runMigrations）
--
-- 1. 按分号朴素切分语句，所以除语句结束符外本文件不许出现分号，注释里尤其不行
-- 2. 每次启动都重跑。ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，
--    必须走 information_schema 守卫 + PREPARE/EXECUTE（写法照抄 011）

SET @mig014_has_detail := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'job_failures'
     AND COLUMN_NAME = 'detail'
);

SET @mig014_sql := IF(@mig014_has_detail = 0,
  'ALTER TABLE job_failures ADD COLUMN detail TEXT NULL',
  'DO 0');

PREPARE mig014a FROM @mig014_sql;
EXECUTE mig014a;
DEALLOCATE PREPARE mig014a;
