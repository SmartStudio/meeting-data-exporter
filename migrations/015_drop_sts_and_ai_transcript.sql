-- 015: 下线 STS-Token 链路与「逐字稿（智能优化版）」资产（2026-09-10）
--
-- 五类资产（video / audio / meeting_summary / ai_minutes / chapters）没有一类依赖
-- STS-Token：前三类走批量 /v1/addresses，后两类走 /v1/smart/*，都是 AK/SK 签名直调。
-- 唯一要 STS 的是详情接口 /v1/addresses/{record_file_id} 独有的 ai_meeting_transcripts
-- （客户端资产键 ai_transcript）。这条链路的代价——网关 webhook 路由、AES 解密、
-- token 落库加密、每 5 分钟的续期检查、「一个应用只有一枚有效 token」导致本机与
-- 服务器互相打掉对方凭据——全部只为这一类资产，而本项目从未真正下载到过它。
-- 因此把资产类型与 STS 整体移除：src/sts/、src/store/sts.ts、webhook handler、
-- STS_ENC_KEY / TM_WEBHOOK_TOKEN / TM_WEBHOOK_AES_KEY 三个环境变量一并删去。
--
-- 本文件做三件事：
--   1. 丢掉 sts_token_requests 表（里面只有会自己过期的临时凭据申请记录）；
--   2. 清掉四张资产表里 asset_type = 'ai_meeting_transcripts' 的行——代码里的
--      AssetType 联合已不含它，留下的行会被读侧当成「认不出的类型」；
--   3. 从四处 asset_types JSON（规则、授权、会议改写、采集程序自动授权）里摘掉 'ai_transcript'，
--      否则规则页会对每一条这样的规则报「不是合法的资产键，已忽略」。
--      JSON_SEARCH 'one' 只找第一处；这些数组按约定不重复存同一个键。
--
-- 注意：本文件除语句结束符外不许出现分号（src/store/db.ts 按分号朴素切分）。

DROP TABLE IF EXISTS sts_token_requests;

DELETE FROM asset_contents WHERE asset_type = 'ai_meeting_transcripts';

DELETE FROM archived_assets WHERE asset_type = 'ai_meeting_transcripts';

DELETE FROM meeting_asset_probes WHERE asset_type = 'ai_meeting_transcripts';

DELETE FROM meeting_assets WHERE asset_type = 'ai_meeting_transcripts';

UPDATE policy_rules
   SET asset_types = JSON_REMOVE(asset_types, JSON_UNQUOTE(JSON_SEARCH(asset_types, 'one', 'ai_transcript')))
 WHERE JSON_SEARCH(asset_types, 'one', 'ai_transcript') IS NOT NULL;

UPDATE meeting_grants
   SET asset_types = JSON_REMOVE(asset_types, JSON_UNQUOTE(JSON_SEARCH(asset_types, 'one', 'ai_transcript')))
 WHERE asset_types IS NOT NULL
   AND JSON_SEARCH(asset_types, 'one', 'ai_transcript') IS NOT NULL;

UPDATE meeting_overrides
   SET asset_types = JSON_REMOVE(asset_types, JSON_UNQUOTE(JSON_SEARCH(asset_types, 'one', 'ai_transcript')))
 WHERE asset_types IS NOT NULL
   AND JSON_SEARCH(asset_types, 'one', 'ai_transcript') IS NOT NULL;

UPDATE service_accounts
   SET auto_grant_asset_types = JSON_REMOVE(auto_grant_asset_types, JSON_UNQUOTE(JSON_SEARCH(auto_grant_asset_types, 'one', 'ai_transcript')))
 WHERE auto_grant_asset_types IS NOT NULL
   AND JSON_SEARCH(auto_grant_asset_types, 'one', 'ai_transcript') IS NOT NULL;
