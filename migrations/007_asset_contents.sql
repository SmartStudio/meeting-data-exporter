-- 控制台阶段 4 · T4：文本类资产的正文入库（A6 的写侧）。
--
-- 计划：docs/superpowers/plans/2026-08-26-console-stage4-api-and-scheduler.md §3 T4
--
-- ## 这张表存什么
--
-- 六类纪要 + 转写的**正文**，即 packages/engine 的 ALL_ASSET_KEYS 里除 video / audio
-- 之外的那六个（transcript / ai_transcript / ai_minutes / ai_topic_minutes /
-- ai_speaker_minutes / ai_ds_minutes，落到本表的是它们对应的网关 asset_type，
-- 见 ASSET_KEY_TO_GATEWAY_TYPE）。**录像与音频不入库**——它们不是文本，
-- 而且单个可以有几个 GB。
--
-- ## 为什么正文要单独存一份，而不是预览时现读文件（计划 E-f）
--
-- spec §4.9：到期只删本地文件，数据库记录永久保留。**纪要正文属于「记录」**——
-- 本地文件被清理之后还要能预览，现读那一刻文件已经不在了。
--
-- ## 只入 txt，docx / pdf 明确留一行「未解析」
--
-- docx / pdf 不是纯文本，要装一个解析器，那是另一件事、不在阶段 4 的范围内。
-- 但**不许静默跳过**：碰到这两种格式照样写一行，status 记成 unsupported_format、
-- reason 写清为什么。区别是 content 为 NULL。
--
-- 为什么值得为「没解析出来」占一行：A6 的预览页要能说出「这份纪要是 docx，本版本
-- 不解析」，而不是「查无此物」。后者与「这场会议压根没有纪要」在界面上长得一模一样,
-- 而这两件事的处理方式完全不同。将来接上 docx 解析器时，这些行会被同一个键覆盖成
-- parsed，不需要额外的迁移。
--
-- status 的三个取值都是**终局判断**，不是「还没轮到」：
--   parsed              正文已入库，content / content_hash 非 NULL
--   unsupported_format  格式不是 txt，或文件不是合法的 UTF-8（例如 GBK 编码的 txt）
--   too_large           超过 MEDIUMTEXT 的 16MB 上限
--
-- **too_large 是明确拒绝，不是截断。** 截断过的纪要在预览页上看起来是完整的,
-- 读的人不会知道后半截没了——这比没有更危险。
--
-- 「读文件失败 / 正文哈希与 archived_assets.nas_hash 对不上 / 写库失败」这三类
-- **不写行**，只留日志与计数：它们是暂时性的或异常的，下一次跑回填脚本还应该重试，
-- 而写了行就等于宣布「这一条已经处理过了」，回填脚本（只处理本表里没有的行）
-- 再也不会回头看它。这与 archived_assets 对哈希校验失败的处理是同一口径:
-- 不留记录 = 下一轮重来。
--
-- ## 主键为什么是五段，而计划里写的是四段
--
-- 计划 §3 T4 的表结构写成 (meeting_id, sub_meeting_id, asset_type, file_type)，
-- 并注为「与 archived_assets 同键的前四段」。**照抄会撞键**：archived_assets 的主键
-- 是五段，第四段是 remote_id，file_type 排第五。而同一场会议的同一类文本资产
-- **可以有多段**（引擎的 assetKeyToFilename 专门为此留了 transcript_2.txt 这种
-- 序号消歧，见 packages/engine/src/domain/types.ts 的 FILENAME_HAS_REMOTE_ID）,
-- 多段之间正是靠 remote_id 区分的。少这一段的后果是第二段转写与第一段争同一行:
-- 走 upsert 就是**静默覆盖**（预览页显示的是最后归档的那一段，没有任何痕迹说明
-- 还有另一段），走普通 INSERT 就是每一轮都撞主键报错。
--
-- 所以裁定：**五段，与 archived_assets 逐列对齐**。这样本表与 archived_assets 能按
-- 完整自然键 JOIN（回填脚本靠这条 JOIN 找出「已归档但还没入库」的资产），
-- 而不是按一个会漏项的前缀 JOIN。
--
-- 注意 runMigrations 按分号朴素切分语句，本文件任何注释里都不许出现分号。

CREATE TABLE IF NOT EXISTS asset_contents (
  meeting_id     VARCHAR(64)  NOT NULL,
  sub_meeting_id VARCHAR(64)  NOT NULL DEFAULT '',
  asset_type     VARCHAR(64)  NOT NULL,
  remote_id      VARCHAR(128) NOT NULL,
  file_type      VARCHAR(32)  NOT NULL DEFAULT '',
  -- parsed / unsupported_format / too_large，含义见表头
  status         VARCHAR(24)  NOT NULL,
  -- 正文。NULL = 没解析出来，原因看 reason。MEDIUMTEXT 上限 16MB,
  -- 装不下的走 too_large 明确拒绝，绝不截断后当成完整正文存进来
  content        MEDIUMTEXT   NULL,
  -- 正文源字节的 sha256，与 archived_assets.nas_hash **逐字相同**：入库前重新读
  -- NAS 上的那份副本、重新算一次哈希、对不上就不入库。一份和 NAS 上不一致的正文
  -- 比没入更糟——预览页会显示一份查不出出处的内容
  content_hash   VARCHAR(64)  NULL,
  -- NAS 副本的字节数（不是字符数）。未解析的行也有值，好让预览页说得出
  -- 「这份 docx 有 240KB，只是本版本不解析」
  bytes          BIGINT       NOT NULL,
  -- 未解析的原因，一句人话，会直接出现在预览页上。parsed 时为 NULL
  reason         VARCHAR(255) NULL,
  parsed_at      BIGINT       NOT NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id, asset_type, remote_id, file_type),
  -- 两条约束都是**写入侧拦死**，理由与 006 给 meeting_overrides.kind 加 CHECK 相同:
  -- store 层的 put 已经按类型挡了一轮，这一条管住绕开 store 的直接 SQL 与回填脚本
  -- 将来的改动。第二条尤其重要——一行 status='parsed' 但 content IS NULL 的记录，
  -- 在预览页上与「正文是空文件」无法区分,
  -- 而一行未解析却没有 reason 的记录，等于把「不许静默跳过」这条约束绕了过去
  CONSTRAINT ck_asset_content_status
    CHECK (status IN ('parsed', 'unsupported_format', 'too_large')),
  CONSTRAINT ck_asset_content_shape
    CHECK (
      (status = 'parsed' AND content IS NOT NULL AND content_hash IS NOT NULL AND reason IS NULL)
      OR
      (status <> 'parsed' AND content IS NULL AND content_hash IS NULL AND reason IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
