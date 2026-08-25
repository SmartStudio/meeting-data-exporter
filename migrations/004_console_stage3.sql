-- 控制台阶段 3：三栈规则引擎的数据模型（R1 · T1）。
--
-- 计划：docs/superpowers/plans/2026-08-25-console-stage3-rules-and-grants.md
-- 003 已被阶段 2 占用，本阶段用 004。
--
-- ## 这次改了什么
--
-- policy_rules 从「单栈 · 表达式条件 · 主体是人」换成「三栈 · 结构化条件 ·
-- allow 栈的主体是采集程序」：
--
--   kind          新增  fetch / archive / allow，三栈各自独立求值
--   join_op       新增  and / or。一条规则内只有一个连接词，不支持括号与混用
--   conds         新增  [{f, op, v}]，取代 resource_expr
--   resource_expr 删除  换表示法，不做双向转换（backend-gap §3 已判：会长期漏语义）
--   effect        扩容  VARCHAR(8) → VARCHAR(255)。archive 栈的 effect 是目录模板
--   subject_type  扩展  增加 'program'（对应 service_accounts.id）。fetch/archive 留空
--   note          新增  说明文字，会出现在规则列表和每场会议的判定理由里
--   created_by    新增  建这条规则的管理员（admin_accounts.id）
--   idx_policy_lookup  (enabled, priority, id) → (kind, enabled, priority, id)
--
-- ## 旧规则怎么办：全量备份到 policy_rules_legacy，然后清空
--
-- 2026-08-25 实测生产库 policy_rules 全表 1 行。单条规则不存在排序问题
-- （降序还是升序，它命中就是它、不命中就走兜底，判定结果完全相同），
-- 平局语义从「deny 优先」换成「id 升序」也无从适用，所以计划 §1.2 三种方案里
-- 走最轻的那种：声明规则集可重建。
--
-- **但不自动转换那条规则的语义。** 旧规则的主体是人（subject_type='user'，
-- subject_value 是腾讯会议 userid），新 allow 栈的主体是采集程序
-- （service_accounts.id）。这两者之间没有机械的对应关系——一个人可能对应
-- 零个或多个服务账号，猜哪一个都是在替管理员做他没做过的授权决定。
--
-- 所以：整表复制进 policy_rules_legacy（不丢数据，将来有人问「我的规则呢」，
-- 答案在那张表里），然后按新结构重建空的 policy_rules，由管理员按新语义重新建规则。
-- 重建期间没有任何规则 = allow 栈兜底 deny = 谁都取不走数据，这是安全侧。
--
-- ## 为什么是「重建表」而不是一串 ALTER
--
-- runMigrations 每次启动都会把 migrations/ 全跑一遍（没有版本记录表），所以本文件
-- 必须幂等。MySQL 的 ADD COLUMN / DROP COLUMN 没有 IF [NOT] EXISTS，一串 ALTER
-- 第二次跑就会报错。而这张表反正要清空，重建能一次得到确定的目标结构，不会因为
-- 半途失败留下「加了三列、少了两列」的中间态。
--
-- 幂等的判据是「policy_rules 还有没有 resource_expr 列」：有就是旧结构，做一次
-- 备份 + 重建；没有就整段跳过（DO 0），管理员后来新建的规则一行都不会被碰。
-- 条件 DDL 只能靠 PREPARE 动态语句实现，因此 runMigrations 把整个迁移跑在
-- 同一条连接上（见 src/store/db.ts）——会话变量与预处理语句都是会话级的。
--
-- 注意 runMigrations 按分号朴素切分语句，本文件任何注释里都不许出现分号。

SET @mig004_old_shape := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'policy_rules'
     AND COLUMN_NAME = 'resource_expr'
);

-- 备份：CREATE TABLE ... LIKE 连索引一起复制，legacy 因此保留旧表的主键，
-- 下一句的 INSERT IGNORE 靠它去重（上一次跑到一半崩在这里时可以安全重跑）。
SET @mig004_sql := IF(@mig004_old_shape > 0,
  'CREATE TABLE IF NOT EXISTS policy_rules_legacy LIKE policy_rules',
  'DO 0');
PREPARE mig004 FROM @mig004_sql;
EXECUTE mig004;
DEALLOCATE PREPARE mig004;

SET @mig004_sql := IF(@mig004_old_shape > 0,
  'INSERT IGNORE INTO policy_rules_legacy SELECT * FROM policy_rules',
  'DO 0');
PREPARE mig004 FROM @mig004_sql;
EXECUTE mig004;
DEALLOCATE PREPARE mig004;

SET @mig004_sql := IF(@mig004_old_shape > 0, 'DROP TABLE policy_rules', 'DO 0');
PREPARE mig004 FROM @mig004_sql;
EXECUTE mig004;
DEALLOCATE PREPARE mig004;

-- 三栈共用一张表，靠 kind 分栈：三栈的算法完全相同，只有主体匹配与兜底不同
-- （src/policy/stacks.ts），分三张表只会让「取出本栈全部启用规则」这件事写三遍。
--
-- subject_type / subject_value 保持 NOT NULL 并默认空串：fetch / archive 是系统级
-- 行为，这两列对它们没有意义，留空而不是塞一个假主体。引擎对系统级栈上残留的主体
-- 是**显式忽略**（并在判定理由里说出来），不是「恰好匹配不上」。
--
-- note / created_by 可空：NULL 表示「没写说明 / 不知道是谁建的」，与空串是两回事，
-- 判定理由里对二者的措辞也不同。
CREATE TABLE IF NOT EXISTS policy_rules (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  kind          VARCHAR(8)   NOT NULL,
  priority      INT          NOT NULL,
  join_op       VARCHAR(3)   NOT NULL DEFAULT 'and',
  conds         JSON         NOT NULL,
  subject_type  VARCHAR(16)  NOT NULL DEFAULT '',
  subject_value VARCHAR(128) NOT NULL DEFAULT '',
  asset_types   JSON         NOT NULL,
  effect        VARCHAR(255) NOT NULL,
  note          VARCHAR(255) NULL,
  created_by    VARCHAR(128) NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    BIGINT       NOT NULL,
  updated_at    BIGINT       NOT NULL,
  PRIMARY KEY (id),
  KEY idx_policy_lookup (kind, enabled, priority, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
