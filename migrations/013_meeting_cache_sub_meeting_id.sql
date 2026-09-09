-- 场次身份回填：sub_meeting_id = meeting_record_id（spec 2026-09-09 §2.1）。
--
-- meeting_cache 的主键本来就是 meeting_record_id，也就是说这张表**一直**是按场次
-- 存的，只有 sub_meeting_id 这一列写着上线之前的空串。这条 UPDATE 把那一列的含义
-- 与主键对齐，之后 src/tencent/records.ts 写进来的新行本身就带着 record id。
--
-- 放进迁移而不是放进一次性脚本，是因为它**没有文件副作用**，所有环境（本机、测试库、
-- 服务器）都要跑，而且幂等——WHERE 把已经回填过的行排除在外，重复执行是空操作。
UPDATE meeting_cache SET sub_meeting_id = meeting_record_id WHERE sub_meeting_id = '';
