CREATE TABLE IF NOT EXISTS sts_token_requests (
  req_id       VARCHAR(128) NOT NULL,
  state        VARCHAR(16)  NOT NULL,
  requested_at BIGINT       NOT NULL,
  fulfilled_at BIGINT       NULL,
  expire_ts    BIGINT       NULL,
  token_cipher TEXT         NULL,
  PRIMARY KEY (req_id),
  KEY idx_sts_state (state, expire_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS policy_rules (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  priority      INT          NOT NULL,
  subject_type  VARCHAR(16)  NOT NULL,
  subject_value VARCHAR(128) NOT NULL,
  resource_expr JSON         NOT NULL,
  asset_types   JSON         NOT NULL,
  effect        VARCHAR(8)   NOT NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    BIGINT       NOT NULL,
  updated_at    BIGINT       NOT NULL,
  PRIMARY KEY (id),
  KEY idx_policy_lookup (enabled, priority, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  occurred_at  BIGINT       NOT NULL,
  actor_type   VARCHAR(32)  NOT NULL,
  actor_id     VARCHAR(128) NOT NULL,
  action       VARCHAR(32)  NOT NULL,
  -- action = issue_download_url 的记录里，本列存的是 meeting_record_id（record
  -- 维度 ID），不是腾讯会议的 meeting_id：缓存未命中时网关只能拿到
  -- meeting_record_id（真正的 meeting_id 无从得知），为使同一列在所有
  -- download-url 审计记录里语义一致，统一填 meeting_record_id
  -- （见 src/http/handlers/meetings.ts 的 downloadUrl / src/audit/recorder.ts）。
  meeting_id   VARCHAR(64)  NULL,
  asset_id     VARCHAR(255) NULL,
  asset_type   VARCHAR(64)  NULL,
  decision     VARCHAR(8)   NOT NULL,
  matched_rule BIGINT       NULL,
  client_kind  VARCHAR(32)  NULL,
  PRIMARY KEY (id),
  KEY idx_audit_time (occurred_at DESC),
  KEY idx_audit_actor (actor_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_accounts (
  id          VARCHAR(64)  NOT NULL,
  name        VARCHAR(128) NOT NULL,
  secret_hash VARCHAR(255) NOT NULL,
  tm_userid   VARCHAR(128) NOT NULL,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  expires_at  BIGINT       NULL,
  created_at  BIGINT       NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_authorizations (
  device_code    VARCHAR(64)  NOT NULL,
  user_code      VARCHAR(16)  NOT NULL,
  state          VARCHAR(64)  NOT NULL,
  status         VARCHAR(16)  NOT NULL,
  wecom_userid   VARCHAR(128) NULL,
  tm_userid      VARCHAR(128) NULL,
  expires_at     BIGINT       NOT NULL,
  last_polled_at BIGINT       NULL,
  created_at     BIGINT       NOT NULL,
  PRIMARY KEY (device_code),
  UNIQUE KEY uk_user_code (user_code),
  UNIQUE KEY uk_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  token_hash   VARCHAR(64)  NOT NULL,
  wecom_userid VARCHAR(128) NOT NULL,
  tm_userid    VARCHAR(128) NOT NULL,
  family_id    VARCHAR(64)  NOT NULL,
  revoked      TINYINT(1)   NOT NULL DEFAULT 0,
  expires_at   BIGINT       NOT NULL,
  created_at   BIGINT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_token_hash (token_hash),
  KEY idx_refresh_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_map (
  wecom_userid VARCHAR(128) NOT NULL,
  tm_userid    VARCHAR(128) NOT NULL,
  email        VARCHAR(255) NULL,
  updated_at   BIGINT       NOT NULL,
  PRIMARY KEY (wecom_userid),
  KEY idx_identity_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 会议元数据缓存：assetId 格式为 <meetingRecordId>:<recordFileId>:<assetType>:<index>，
-- 不含 meeting_id / host_user_id / start_time 等策略判定所需字段，而 /v1/records 不支持
-- 按 meeting_record_id 反查。download-url 端点据此表由 meetingRecordId 重建完整 Meeting
-- 以供 policyEngine.decide 使用（这是真正的安全边界，见 Task 14 报告的设计说明）。
-- 写入时机：每次成功列出会议（GET /meetings*）机会性 upsert；MySQL 共享存储，多实例安全。
CREATE TABLE IF NOT EXISTS meeting_cache (
  meeting_record_id VARCHAR(128) NOT NULL,
  meeting_id        VARCHAR(64)  NOT NULL,
  sub_meeting_id    VARCHAR(64)  NOT NULL DEFAULT '',
  meeting_code      VARCHAR(64)  NOT NULL,
  subject           VARCHAR(512) NOT NULL,
  host_user_id      VARCHAR(128) NOT NULL,
  start_time        BIGINT       NOT NULL,
  end_time          BIGINT       NOT NULL,
  state             VARCHAR(16)  NOT NULL,
  updated_at        BIGINT       NOT NULL,
  PRIMARY KEY (meeting_record_id),
  KEY idx_meeting_cache_meeting_id (meeting_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
