-- 控制台阶段 5 · A8（缺口 1）：给 admin_accounts 补一列 role。
--
-- 计划：docs/superpowers/plans/2026-08-26-console-stage5-frontend-wiring.md §11.1
-- 规格：docs/console/spec.md §2「角色与权限」· §11 缺口 1
--
-- ## 为什么这一列非有不可
--
-- spec §2 写着两个角色，而 admin_accounts（003）只有 id / username /
-- password_hash / created_at。少了这一列，后端就没有任何依据去拒绝一个只读账号
-- 发来的写请求——而**前端藏起来的按钮不是权限**：控制台的每一条写端点都是
-- 一个可以用 curl 直接打的 HTTP 接口，判断只有落在服务端才算数。
--
-- ## 取值只有两个，且认不出来的一律当 readonly
--
--   admin     全部：改规则、改授权、延长保留、手动触发任务、看内容
--   readonly  只能看，不能改任何状态
--
-- 不做成 ENUM 是为了让「将来多一个角色」不必再开一次 DDL——但也因此，
-- 库里可能出现第三个值（手工 UPDATE 写错、将来降级回滚）。
-- `src/auth/admin.ts` 的 parseAdminRole 把**除 'admin' 之外的一切**折成 readonly：
-- 认不出来的角色按最小权限处理，不是按最大权限。反过来写就是一次静默提权。
--
-- ## 默认值 'admin' 是必须的，不是顺手
--
-- 这张表里已经有账号。加一列没有默认值（或者默认成 'readonly'）的后果是：
-- 迁移跑完的那一刻，**现有的每一个管理员都变成了只读**——包括唯一那个能把别人
-- 改回 admin 的人。没有人能再改任何东西，而且从界面上看不出是为什么。
-- 所以默认值必须是 'admin'：加一列不改变任何既有账号的权限。
--
-- ## 迁移本身的两条硬约束（src/store/db.ts 的 runMigrations）
--
-- 1. 它按分号**朴素切分**语句，所以除语句结束符之外本文件不许出现分号，注释里尤其不行
-- 2. 它**每次启动都重跑**。ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，
--    必须走 information_schema 守卫 + PREPARE/EXECUTE（写法照抄 008 加 detail 那段）。
--    会话变量与预处理语句都是会话级的——runMigrations 把整个迁移跑在同一条连接上
--
-- role 在 MySQL 8.0 里是非保留字，不加反引号也能用，但下面仍然加了：
-- CREATE ROLE / SET ROLE 这一族语法存在，读到裸 role 的人得先想一下它是不是关键字。

SET @mig009_has_role := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'admin_accounts'
     AND COLUMN_NAME = 'role'
);

SET @mig009_sql := IF(@mig009_has_role = 0,
  'ALTER TABLE admin_accounts ADD COLUMN `role` VARCHAR(16) NOT NULL DEFAULT ''admin''',
  'DO 0');

PREPARE mig009 FROM @mig009_sql;
EXECUTE mig009;
DEALLOCATE PREPARE mig009;
