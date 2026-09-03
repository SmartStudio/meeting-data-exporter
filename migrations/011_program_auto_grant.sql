-- 程序级自动授权（方案 2）：给 service_accounts 加两列。
--
-- 规格：docs/console/spec.md §4.5「自动授权」· §4.8 任务五
--
-- ## 这两列是什么
--
--   auto_grant             这个采集程序开没开自动授权。1 = 后台任务「自动授权」
--                          会把规则放行、文件还在本地、尚无生效授权、且从未被人工
--                          撤销过的会议**真的写进 meeting_grants**
--   auto_grant_asset_types 自动写出去的那些授权行的资产范围。**三态里只有两态合法**：
--                            NULL     不额外限制，以采集权限规则的判定为准
--                            非空数组 白名单，取值是八类资产键
--                          空数组不允许存进来——「什么都不授权的自动授权」没有意义，
--                          它写出来的每一行授权都是一条一类资产都取不到的空授权，
--                          而那些行随后还会挡住这场会议将来被正确地自动授权
--                          （已有生效授权就跳过）。写侧 400 挡回去，见
--                          src/http/handlers/console/grants.ts 的 patchProgram
--
-- ## 为什么是程序级开关，不是规则级
--
-- 采集权限规则回答的是「这场会议**准不准**被这个程序取走」，是判定；授权回答的是
-- 「这场会议**给没给**这个程序」，是决定。方案 2 要自动化的是后者，判定一个字都不改
-- ——清单、网关闸门、待授权分诊、审计、撤销全部原样能用，只是多了一个「系统代为授权」
-- 的来源。把开关挂到规则上会把这两件事焊死：一条规则同时既是判定又是决定，
-- 此后任何一次改规则都顺带改变了「哪些会议已经授权出去了」，而授权是要留痕的动作。
--
-- 挂在程序上还让「先停下」这件事有一个准确的开关：程序 enabled = 0 时整个程序跳过
-- （停用 = 先别取，不该在停用期间替它堆授权），而关掉 auto_grant **不收回**已有授权
-- ——可逆动作不该带不可逆后果，要收回请去会议记录页批量收回。
--
-- ## 迁移本身的两条硬约束（src/store/db.ts 的 runMigrations）
--
-- 1. 它按分号**朴素切分**语句，所以除语句结束符之外本文件不许出现分号，注释里尤其不行
-- 2. 它**每次启动都重跑**。ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，
--    必须走 information_schema 守卫 + PREPARE/EXECUTE（写法照抄 009）。
--    两列**各自**守一次：只守第一列的话，一个「上次跑到一半只加成了 auto_grant」的库
--    会在下次启动时因为第一列已存在而整段跳过，第二列永远补不上
--
-- 默认值 0 是必须的：这张表里已经有采集程序，而自动授权是一个**会往授权表里写行**的
-- 开关。加一列默认打开，等于迁移跑完的那一刻替每一个既有程序做了一批没人点过的授权。

SET @mig011_has_auto_grant := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'service_accounts'
     AND COLUMN_NAME = 'auto_grant'
);

SET @mig011_sql := IF(@mig011_has_auto_grant = 0,
  'ALTER TABLE service_accounts ADD COLUMN auto_grant TINYINT(1) NOT NULL DEFAULT 0',
  'DO 0');

PREPARE mig011a FROM @mig011_sql;
EXECUTE mig011a;
DEALLOCATE PREPARE mig011a;

SET @mig011_has_types := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'service_accounts'
     AND COLUMN_NAME = 'auto_grant_asset_types'
);

-- 可空是这一列的语义本身（NULL = 不额外限制），不是「暂时没值」。
-- JSON 而不是 VARCHAR：与 meeting_grants.asset_types / policy_rules.asset_types 同一种列，
-- 三处存的是同一批资产键，用同一种列读写才不会各写一套解析
SET @mig011_sql := IF(@mig011_has_types = 0,
  'ALTER TABLE service_accounts ADD COLUMN auto_grant_asset_types JSON NULL',
  'DO 0');

PREPARE mig011b FROM @mig011_sql;
EXECUTE mig011b;
DEALLOCATE PREPARE mig011b;
