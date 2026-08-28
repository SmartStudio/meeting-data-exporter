-- meeting_cache 补一条按会议号的索引（2026-08-27 的 P0 修复）。
--
-- ## 为什么现在需要它
--
-- 001 建这张表时它只有一个读法：download-url 端点凭 meeting_record_id 反查
-- （主键，够用），外加一条 idx_meeting_cache_meeting_id。
--
-- P0 修复之后它多了一个读法：**精确查询的第一级**。`/v1/corp/records` 是全公司
-- 唯一的会议列表来源，而它没有 meeting_id / meeting_code 参数，所以「按会议号
-- 点名查一场会议」变成先读本表、未命中再去枚举整个时间窗（每页 20 条、10次/min）。
-- 按 meeting_code 的那一路没有索引就是全表扫——而这张表只增不删，会一直长。
--
-- ## 为什么带上 start_time
--
-- 查询形如 WHERE meeting_code = ? AND start_time >= ? AND start_time <= ?
-- （见 src/store/meetings.ts 的 listByMeetingCode）。复合索引让时间那一段也走索引，
-- 而不是回表之后再逐行比。
--
-- 按 meeting_id 的那一路沿用 001 建的 idx_meeting_cache_meeting_id：meeting_id
-- 本身就足够选择性，不为它再堆一条冗余索引。
--
-- ## 迁移本身的两条硬约束（src/store/db.ts 的 runMigrations）
--
-- 1. 它按分号**朴素切分**语句，所以除语句结束符之外本文件不许出现分号，注释里尤其不行
-- 2. 它**每次启动都重跑**。MySQL 的 CREATE INDEX / ALTER TABLE ADD KEY 没有
--    IF NOT EXISTS，必须走 information_schema 守卫 + PREPARE/EXECUTE
--    （写法照抄 008 加 detail 那段与 009 加 role 那段）。
--    会话变量与预处理语句都是会话级的——runMigrations 把整个迁移跑在同一条连接上

SET @mig010_has_code_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'meeting_cache'
     AND INDEX_NAME = 'idx_meeting_cache_meeting_code'
);

SET @mig010_sql := IF(@mig010_has_code_idx = 0,
  'ALTER TABLE meeting_cache ADD KEY idx_meeting_cache_meeting_code (meeting_code, start_time)',
  'DO 0');

PREPARE mig010 FROM @mig010_sql;
EXECUTE mig010;
DEALLOCATE PREPARE mig010;
