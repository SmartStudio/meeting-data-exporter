-- 控制台阶段 2：管理员账号与会话、归档记录、系统级设置。
--
-- admin_accounts / admin_sessions 是与 device_authorizations / refresh_tokens
-- 完全独立的第三条认证线（D1，见 dev-plan.md）——不共用任何一张已有的登录相关表，
-- 这是刻意的隔离，不是遗漏。
--
-- meeting_assets（002）只管单个资产的本地下载状态，本文件新增的两张表
-- 各自管一层，三者不重叠、不互相改写对方的列：
--   archived_assets  单个资产的 NAS 副本状态（本表新增）——归档流水线（Task 7）
--                    只在这张表里写 NAS 路径与哈希，绝不回写 meeting_assets——
--                    否则一旦回写覆盖了 target_path，到期清理（Task 8）就再也
--                    找不到本地文件原来在哪，只删本地、留 NAS 路径这条硬要求
--                    就没法实现。meeting_assets 从下载完成后就是只读的历史事实。
--   meeting_archives 整场会议的保留窗口（本表新增）——时钟是这场会议，不是
--                    这个资产（spec.md §4.3：本地保留段显示的是一个归档日、
--                    一个到期日，不是每个资产各自的）
--
-- system_settings 是通用键值表，本次只用两个 key：
--   cleanup_paused         到期清理暂停开关，必须持久化（dev-plan.md §6 硬要求 2）
--   default_retention_days 新归档会议的默认保留天数（US-5.5）
-- 用一张通用表而不是各开一个专属字段，是因为这两个值都是系统级单例配置，
-- 以后大概率还会再长出几个同类配置项，不必每次都开一次迁移加列。
--
-- 注意 runMigrations 按分号朴素切分语句，本文件任何注释里都不许出现分号。

CREATE TABLE IF NOT EXISTS admin_accounts (
  id            VARCHAR(64)  NOT NULL,
  username      VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    BIGINT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  token_hash VARCHAR(64)  NOT NULL,
  admin_id   VARCHAR(64)  NOT NULL,
  expires_at BIGINT       NOT NULL,
  created_at BIGINT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_admin_session_token (token_hash),
  KEY idx_admin_session_admin (admin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 与 meeting_assets 共用同一组自然键（meeting_id, sub_meeting_id, asset_type,
-- remote_id, file_type），可直接 JOIN；PRIMARY KEY 顺带当唯一约束，防止同一个
-- 资产被并发的两轮归档各写一行。
CREATE TABLE IF NOT EXISTS archived_assets (
  meeting_id     VARCHAR(64)   NOT NULL,
  sub_meeting_id VARCHAR(64)   NOT NULL DEFAULT '',
  asset_type     VARCHAR(64)   NOT NULL,
  remote_id      VARCHAR(128)  NOT NULL,
  file_type      VARCHAR(32)   NOT NULL DEFAULT '',
  -- 与 meeting_assets.target_path 的值相同（本地相对路径的副本，不是唯一来源）——
  -- 复制一份进来是为了到期清理（Task 8）不必再跨表回查 meeting_assets 就知道
  -- 删哪个本地文件。meeting_assets 自己那一份仍然保留、永远不改，两处只是
  -- 恰好同值，不构成两个来源的不一致风险，因为这一列写入之后不会再更新。
  local_path     VARCHAR(1024) NOT NULL,
  nas_path       VARCHAR(1024) NOT NULL,
  nas_hash       VARCHAR(64)   NOT NULL,
  archived_at    BIGINT        NOT NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id, asset_type, remote_id, file_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_archives (
  meeting_id      VARCHAR(64)   NOT NULL,
  sub_meeting_id  VARCHAR(64)   NOT NULL DEFAULT '',
  nas_dir         VARCHAR(1024) NOT NULL,
  archived_at     BIGINT        NOT NULL,
  retention_days  INT           NOT NULL,
  extended_days   INT           NOT NULL DEFAULT 0,
  -- NULL = 本地文件还在；非 NULL = 已到期清理，记录与 nas_dir 永久保留（spec §4.9）
  local_purged_at BIGINT        NULL,
  created_at      BIGINT        NOT NULL,
  updated_at      BIGINT        NOT NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id),
  KEY idx_archives_expiry (local_purged_at, archived_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key   VARCHAR(64) NOT NULL,
  setting_value TEXT        NOT NULL,
  updated_at    BIGINT      NOT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
