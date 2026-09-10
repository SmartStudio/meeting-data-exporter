-- 016: 录制类型（record_type）落库，转写记录不再要录像 / 音频 / 章节（2026-09-10）
--
-- 腾讯 /v1/corp/records 的 record_type 文档只写了 0 云录制 / 2 上传 / 4 视频录制 /
-- 5 录音。线上实际还返回 3：**转写记录**——平台把一场开了实时转写的会议另拆一条
-- record，主题由平台加前缀「转写_」，record_size 为 0。它只有逐字稿（meeting_summary）
-- 与纪要（ai_minutes）两类产物：/v1/addresses 照样给出 download_address 的 mp4
-- 链接，但对象存储对它一律 404 NoSuchKey（本机 121 条记录、105 条 video 行无一例外），
-- 音频与章节从未出现过。
--
-- 在此之前代码不认识 record_type，于是每一条转写记录都：建一条 video 任务 → 下载
-- 404 → skipped/upstream_missing，再建 audio / chapters 两条探测空等 6h / 48h 到期，
-- 控制台的「资产」永远显示 4/5。
--
-- 本文件做四件事：
--   1. meetings、meeting_cache 各加 record_type 列（引擎发现层与目录层按它裁剪类型）
--   2. 老行按主题前缀「转写_」回填 3——**只在补列的那一次做**，之后这一列由
--      /v1/corp/records 的原值写入，不再看主题（用户自己起名「转写_…」的普通录制
--      不该被误标）
--   3. 清掉转写记录名下的 video / audio / chapters 资产行（只删 skipped 的，
--      它们全是 upstream_missing）——这些行没有任何文件，只是把会议卡在「差一个」
--   4. 清掉转写记录名下 video / audio / chapters 的探测行（abandoned 与 probing 都删，
--      新代码不再为它们建探测）
--
-- ## 迁移的两条硬约束（src/store/db.ts 的 runMigrations）
--
-- 1. 按分号朴素切分语句，所以除语句结束符外本文件不许出现分号，注释里尤其不行
-- 2. 每次启动都重跑。ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，
--    必须走 information_schema 守卫 + PREPARE/EXECUTE（写法照抄 014）。
--    第 3、4 步的 DELETE 条件天然幂等，新代码不会再产生这样的行，重跑是空操作

SET @mig016_has_meetings := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'meetings'
     AND COLUMN_NAME = 'record_type'
);

SET @mig016_sql := IF(@mig016_has_meetings = 0,
  'ALTER TABLE meetings ADD COLUMN record_type TINYINT NOT NULL DEFAULT 0',
  'DO 0');

PREPARE mig016a FROM @mig016_sql;
EXECUTE mig016a;
DEALLOCATE PREPARE mig016a;

SET @mig016_sql := IF(@mig016_has_meetings = 0,
  'UPDATE meetings SET record_type = 3 WHERE subject LIKE ''转写\\_%''',
  'DO 0');

PREPARE mig016b FROM @mig016_sql;
EXECUTE mig016b;
DEALLOCATE PREPARE mig016b;

SET @mig016_has_cache := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'meeting_cache'
     AND COLUMN_NAME = 'record_type'
);

SET @mig016_sql := IF(@mig016_has_cache = 0,
  'ALTER TABLE meeting_cache ADD COLUMN record_type TINYINT NOT NULL DEFAULT 0',
  'DO 0');

PREPARE mig016c FROM @mig016_sql;
EXECUTE mig016c;
DEALLOCATE PREPARE mig016c;

SET @mig016_sql := IF(@mig016_has_cache = 0,
  'UPDATE meeting_cache SET record_type = 3 WHERE subject LIKE ''转写\\_%''',
  'DO 0');

PREPARE mig016d FROM @mig016_sql;
EXECUTE mig016d;
DEALLOCATE PREPARE mig016d;

DELETE a FROM meeting_assets a
  JOIN meetings m ON m.meeting_id = a.meeting_id AND m.sub_meeting_id = a.sub_meeting_id
 WHERE m.record_type = 3
   AND a.asset_type IN ('video', 'audio', 'chapters')
   AND a.status = 'skipped';

DELETE p FROM meeting_asset_probes p
  JOIN meetings m ON m.meeting_id = p.meeting_id AND m.sub_meeting_id = p.sub_meeting_id
 WHERE m.record_type = 3
   AND p.asset_type IN ('video', 'audio', 'chapters');
