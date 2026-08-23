-- 服务端归档 worker 的队列表。
--
-- 与 001 的 meeting_cache 的关系：meeting_cache 是网关列会议时顺手写的机会性缓存，
-- 只服务策略引擎，字段不全、没有生命周期。本文件的 meetings 是控制台的主表，
-- 承载拉取/归档/保留/授权四个阶段的状态。阶段 4（A2）把控制台的查询接到这张表上之后
-- meeting_cache 退役，届时另写迁移删除，本次不动它。
--
-- 注意 runMigrations 按分号朴素切分语句，本文件任何注释里都不许出现分号。

CREATE TABLE IF NOT EXISTS meetings (
  meeting_id     VARCHAR(64)   NOT NULL,
  sub_meeting_id VARCHAR(64)   NOT NULL DEFAULT '',
  meeting_code   VARCHAR(64)   NULL,
  subject        VARCHAR(512)  NULL,
  host_userid    VARCHAR(128)  NULL,
  start_time     BIGINT        NULL,
  end_time       BIGINT        NULL,
  created_at     BIGINT        NOT NULL,
  updated_at     BIGINT        NOT NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id),
  KEY idx_meetings_start (start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_assets (
  id               BIGINT        NOT NULL AUTO_INCREMENT,
  meeting_id       VARCHAR(64)   NOT NULL,
  sub_meeting_id   VARCHAR(64)   NOT NULL DEFAULT '',
  asset_type       VARCHAR(64)   NOT NULL,
  remote_id        VARCHAR(128)  NOT NULL,
  asset_id         VARCHAR(255)  NULL,
  status           VARCHAR(16)   NOT NULL DEFAULT 'pending',
  storage_target   VARCHAR(16)   NOT NULL DEFAULT 'local',
  target_path      VARCHAR(1024) NULL,
  -- file_type 参与唯一键，故 NOT NULL DEFAULT 空串：同一份录制的多种导出格式
  -- 共享 record_file_id，只有格式能区分它们。可空列进唯一键等于没有约束。
  file_type        VARCHAR(32)   NOT NULL DEFAULT '',
  bytes_expected   BIGINT        NULL,
  bytes_written    BIGINT        NOT NULL DEFAULT 0,
  content_hash     VARCHAR(64)   NULL,
  attempts         INT           NOT NULL DEFAULT 0,
  lease_expires_at BIGINT        NULL,
  last_error       TEXT          NULL,
  completed_at     BIGINT        NULL,
  created_at       BIGINT        NOT NULL,
  updated_at       BIGINT        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_asset (meeting_id, sub_meeting_id, asset_type, remote_id, file_type),
  -- 列序是 (status, id, lease_expires_at) 而不是 (status, lease_expires_at, id)，
  -- 这是 claimNext 的正确性依赖，不是性能微调。领取语句是
  -- `WHERE status=? [AND lease_expires_at < ?] ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
  -- status 是等值、排序键是 id。id 排在 lease_expires_at 前面时索引自带 id 序，
  -- LIMIT 1 锁到第一条就停手。反过来（lease_expires_at 在前）索引给不出 id 序，
  -- 优化器要 filesort，为了排序必须把**整个可领取集合**读出来并逐行加锁——
  -- 实测 2 万行历史 + 200 条待领时一次领取持有 400 把记录锁，于是并发 worker 的
  -- SKIP LOCKED 把它们全跳过、拿到 null 就收工，队列还有活却没人干。
  KEY idx_assets_claimable (status, id, lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_asset_probes (
  meeting_id     VARCHAR(64)   NOT NULL,
  sub_meeting_id VARCHAR(64)   NOT NULL DEFAULT '',
  asset_type     VARCHAR(64)   NOT NULL,
  state          VARCHAR(16)   NOT NULL DEFAULT 'probing',
  attempts       INT           NOT NULL DEFAULT 0,
  probe_after    BIGINT        NOT NULL DEFAULT 0,
  deadline_at    BIGINT        NOT NULL,
  last_reason    VARCHAR(128)  NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id, asset_type),
  KEY idx_probes_due (state, probe_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
