-- 腾讯会议成员姓名的本地副本。控制台会议列表把 `meetings.host_userid`
-- （一串 32 位机器 id）翻成人看得懂的名字，唯一的数据源就是这张表。
--
-- 规格：docs/console/spec.md §4.2「会议记录」的主持人一列
-- 写侧：src/worker/host-names.ts（定时任务一每轮补一批）、scripts/sync-host-names.ts（回填）
-- 读侧：src/store/console-meetings.ts 的 loadHostNames
--
-- ## 为什么要有这张表，而不是继续查 identity_map
--
-- `identity_map` 是**身份映射**表（企微 userid ↔ 腾讯会议 userid ↔ 邮箱），它
-- **没有姓名列**，能给出的最接近姓名的东西是邮箱的本地部分。而且本部署的
-- identity_map 是空表、没有任何自动填充路径，于是列表上每一行都是「未知主持人」。
--
-- 姓名的真正出处是腾讯会议自己的成员接口（GET /v1/users/{userid}），它返回
-- username。本表就是那个接口的答案存下来的地方——**它不替代 identity_map，
-- 也不改 identity_map 的语义**：那张表回答「这三个身份是同一个人」，这张表回答
-- 「这个腾讯会议成员叫什么」。读侧先问本表，问不到才退回 identity_map 那条老路。
--
-- ## 三列各自的语义，尤其是 username 的 NULL
--
--   tm_userid   腾讯会议的成员 id，与 meetings.host_userid 同一个取值空间。
--               **空串不会出现在这里**：设备账号发起的快速会议 host_userid 是
--               空串（见 src/tencent/ 那一侧 2026-09-03 的修复），那是「这场会议
--               没有主持人」，不是「有个叫空串的人」，同步侧直接跳过不查
--   username    真实姓名。**NULL 不是「还没查」，是「查过了，腾讯说没有这个人」**
--               ——离职回收掉的账号、跨企业来开会的外部成员都会落到这一支。
--               两者必须分得开：查过而无人 与 从没查过 的处理方式相反，前者一天内
--               不该再问腾讯（白白吃掉接口配额），后者该尽快去问。「从没查过」在
--               这张表里的表示是**压根没有这一行**，所以 NULL 只剩一个含义
--   fetched_at  unix 秒，上一次问过腾讯的时刻（问到姓名与问到「查无此人」都算）。
--               同步侧据它判「一天之内问过的不再问」，见 host-names.ts 的 STALE_SEC
--
-- ## 为什么不加 updated_at / created_at
--
-- 这张表没有「改」这个动作——每一行都是一次 GET 的答案原样落下来，覆盖写。
-- 再加两列时间戳，读的人就得先分清它们和 fetched_at 谁说了算，而它们三个在这里
-- 永远是同一个数。
--
-- ## 为什么没有索引（除主键外）
--
-- 两个读法都走主键：按 id 批量取名字（`WHERE tm_userid IN (…)`），以及同步侧
-- 按 id 批量查「哪些还没问过」。控制台搜索框那条 `username LIKE '%…%'` 是全表扫，
-- 但这张表的规模是「公司人数」，不是「会议数」——真到了需要索引的规模，
-- 那是一条纯增量的 migration，不改本表任何一行数据。
--
-- 迁移的两条硬约束见 src/store/db.ts 的 runMigrations：按分号朴素切分语句
-- （注释里也不许出现分号），且每次启动都重跑（所以是 CREATE TABLE IF NOT EXISTS）。

CREATE TABLE IF NOT EXISTS tm_users (
  tm_userid  VARCHAR(128) NOT NULL,
  -- NULL = 查过，腾讯说没有这个成员。**不是**「还没查」——那是「没有这一行」
  username   VARCHAR(255) NULL,
  -- unix 秒。上一次问腾讯的时刻，查到与查无此人都算
  fetched_at BIGINT       NOT NULL,
  PRIMARY KEY (tm_userid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
