-- 给 meeting_overrides.kind 加取值域约束。
--
-- 为什么单开一个迁移而不是改 005：005 已经在开发库里跑过，而 runMigrations 每次
-- 启动都重跑全部文件、CREATE TABLE 又带 IF NOT EXISTS——改 005 的建表语句对已经
-- 存在的表一个字都不会生效，是一次静默跳过的 DDL。004 的表头注释记着同一条教训。
--
-- 为什么需要这条约束（T7 落地时发现，见计划 §3.4 的 D-u）：
-- 改写行的 kind 比 effect 更脏，而且**没有安全侧可落**。
--   * kind 填成另一栈：一条 fetch 改写（effect 'all'）被套到归档栈上时，
--     normalizeEffect('archive', 'all') 认为 'all' 是一段合法的非空目录模板，
--     于是这场会议的录像会被归档进一个叫 all 的目录。求值层拦不住——被复用的那个
--     规范化函数无从知道这一行原本是为哪一栈写的。
--   * kind 填成三栈之外（'fecth'）：没有任何一栈认领它，indexOverrides 只能丢掉，
--     于是管理员明确做出的一个决定变成一次**无声的空操作，界面上没有任何痕迹**。
--     这正是「不许静默放行/静默拒绝」要防的那类错误，只是换了一层。
--
-- 求值层拦不住也报不出来，写入侧就必须拦死：store 的 putOverride 做运行时校验，
-- 数据库这一条管住绕开 store 的直接 SQL。两道都要，因为这是授权中枢。
--
-- 注意 runMigrations 按分号朴素切分语句，本文件任何注释里都不许出现分号。

SET @mig006_has_check := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'meeting_overrides'
     AND CONSTRAINT_NAME = 'ck_override_kind'
);

SET @mig006_sql := IF(@mig006_has_check = 0,
  'ALTER TABLE meeting_overrides ADD CONSTRAINT ck_override_kind CHECK (kind IN (''fetch'', ''archive'', ''allow''))',
  'DO 0');

PREPARE mig006 FROM @mig006_sql;
EXECUTE mig006;
DEALLOCATE PREPARE mig006;
