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
  KEY idx_assets_claimable (status, lease_expires_at, id)
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
