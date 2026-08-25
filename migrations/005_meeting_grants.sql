-- 控制台阶段 3：逐会议授权（meeting_grants）与单场会议的人工改写（meeting_overrides）。
--
-- spec.md §1.3 把「外部程序真能取到」定义成三个「与」，三者由不同的表管、
-- 由不同的人在不同页面维护，谁都不许替另外两个做决定：
--   有授权      → meeting_grants（本文件新增）
--   在保留期内  → meeting_archives（003）
--   规则允许    → policy_rules + src/policy/stacks.ts
-- 本文件只管第一个「与」。它不读、不写、也不缓存另外两个的任何状态——
-- 一场会议「授权给了 kb-indexer」与「kb-indexer 现在拿得到」是两句不同的话，
-- 中间隔着另外两个条件，把它们并进一列会让这三个「与」变成一个说不清的布尔值。
--
-- meeting_overrides 是 spec §5.4「单场会议的人工改写优先于所有规则」的存储。
-- 它刻意**不进 policy_rules**：改写是「这一场就这么办」，规则是「符合条件的都这么办」，
-- 混进同一张表就要靠一个「只匹配这一个 meeting_id」的伪条件来表达，规则列表里
-- 会长出成百上千条只服务一场会议的规则，影响预览（§5.5）也再算不出
-- 「命中(旧规则) ∪ 命中(新规则)」这个集合。改写在引擎之外，是设计，不是偷懒。
--
-- ── 撤销用软删除，不删行 ────────────────────────────────────────────────
-- 两张表都有 revoked_at，撤销 = 写时间戳，不是 DELETE。
-- §4.10 的操作审计要能回答「这场会议什么时候授权给谁、什么时候撤的」，删了行就答不了。
-- 重新授权是**插入新行**，不是把旧行的 revoked_at 清零——历史是一串事件，
-- 不是一个可翻转的开关，把旧行翻回来等于把「曾经撤销过」这件事从库里抹掉。
--
-- ── 「同时只能有一条生效授权」由数据库保证，不由应用约定 ────────────────
-- revoked_at BIGINT NOT NULL DEFAULT 0，0 表示未撤销，配 uk_grant_active
-- (meeting_id, sub_meeting_id, program_id, revoked_at)：生效行的 revoked_at 恒为 0，
-- 于是同一 (会议, 场次, 程序) 只能有一条生效行，已撤销的多行因 revoked_at 互不相同而共存。
--
-- **这一列绝不能改成 NULLABLE**。MySQL 的唯一索引里 NULL 互不相等，
-- 若用 NULL 表示「未撤销」，(m, '', p, NULL) 可以插进任意多行，这道约束会静默失效——
-- 表面上还写着 UNIQUE KEY，实际什么都没挡住。用 0 当哨兵是为了让约束真的生效，
-- 不是为了省一个 NULL。TS 侧再把 0 映射回 null，域模型不必背着这个哨兵。
--
-- 已知的窄窗口：同一毫秒内先后撤销同一 (会议, 场次, 程序) 的**两条不同的行**
-- （授权→撤销→重新授权→再撤销，两次撤销落在同一毫秒）会撞这个唯一键。
-- src/store/grants.ts 的 revoke 显式处理它：把 revoked_at 让开一格重试，
-- **绝不允许吞掉异常当无事发生**——那会让一条管理员明确要求撤销的授权继续生效。
--
-- ── asset_types 的三种取值 ──────────────────────────────────────────────
-- 两张表的 asset_types JSON NULL 都按同一套读：
--   NULL        本条不额外限制资产类型，以规则栈的判定为准
--   非空 JSON 数组  白名单，只覆盖数组里列的这几类
--   []（空数组）    什么都不覆盖
-- **空数组不是「不限制」**。在授权中枢里让空集合意外等价于全集，正是
-- 「不许静默放行」这条全局约束要防的事故。三者是三个意思，读写两侧都不许合并。
--
-- ── kind 与三栈同名 ─────────────────────────────────────────────────────
-- meeting_overrides.kind 取 'fetch' / 'archive' / 'allow'，与 src/policy/stacks.ts
-- 的 StackKind 逐字一致（store 那边用 type-only import 引它，靠编译器钉住而不是靠约定）。
-- 一场会议的每个 kind 各自独立改写，改了 allow 不影响 fetch。
-- effect 存 VARCHAR(255) 而不是 ENUM：归档栈的 effect 是目录模板
-- （形如 /nas/meetings-finance/{年}/），不是枚举，三栈共用一列就只能取最宽的那种。
--
-- 注意 runMigrations 按分号朴素切分语句，本文件任何注释里都不许出现分号。

CREATE TABLE IF NOT EXISTS meeting_grants (
  id             BIGINT      NOT NULL AUTO_INCREMENT,
  meeting_id     VARCHAR(64) NOT NULL,
  sub_meeting_id VARCHAR(64) NOT NULL DEFAULT '',
  -- 对应 service_accounts.id。与仓库里其它表一致不建 FK：授权行是审计事实，
  -- 一个程序被删掉不该顺带抹掉「它曾经被授权过哪些会议」这段历史
  program_id     VARCHAR(64) NOT NULL,
  -- NULL = 不限制 / 非空数组 = 白名单 / [] = 什么都不授权，见表头
  asset_types    JSON        NULL,
  granted_at     BIGINT      NOT NULL,
  -- 0 = 未撤销。不许改成 NULLABLE，理由见表头
  revoked_at     BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_grant_active (meeting_id, sub_meeting_id, program_id, revoked_at),
  -- §4.5「现在可取走 N 场会议」是按程序问的，这是那一页的热查询。
  -- 反过来「这场会议授权给了谁」走 uk_grant_active 的 (meeting_id, sub_meeting_id)
  -- 前缀就够，不再单开一条索引
  KEY idx_grant_program_active (program_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_overrides (
  id             BIGINT       NOT NULL AUTO_INCREMENT,
  meeting_id     VARCHAR(64)  NOT NULL,
  sub_meeting_id VARCHAR(64)  NOT NULL DEFAULT '',
  -- 'fetch' / 'archive' / 'allow'，与 StackKind 逐字一致
  kind           VARCHAR(16)  NOT NULL,
  -- fetch: all/skip · allow: allow/deny · archive: 目录模板。故不用 ENUM
  effect         VARCHAR(255) NOT NULL,
  -- 与 meeting_grants.asset_types 同一套三态语义。
  -- 有这一列是必需的：没有它，一条 allow 改写就只能表示「全部八类都放行」，
  -- 而它优先于所有规则，等于一次人工改写会把规则原本限定的资产范围悄悄放宽
  asset_types    JSON         NULL,
  -- §1.3 要求界面随时能回答「为什么这场会议这个程序取不到」。规则那边这句话
  -- 来自 policy_rules.note（§6.3），改写优先于规则，就必须有等价的一句话可显示，
  -- 否则被改写的会议在详情抽屉里只剩一个没有出处的结论
  reason         VARCHAR(255) NOT NULL DEFAULT '',
  created_at     BIGINT       NOT NULL,
  -- 0 = 未撤销，同 meeting_grants
  revoked_at     BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_override_active (meeting_id, sub_meeting_id, kind, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
