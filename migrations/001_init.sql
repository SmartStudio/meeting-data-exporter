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
