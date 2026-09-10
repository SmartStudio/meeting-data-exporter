# 2026-09-10 上线：下线 STS-Token 链路与「逐字稿（智能优化版）」

迁移：`migrations/015_drop_sts_and_ai_transcript.sql`

## 0. 为什么

五类资产没有一类依赖 STS-Token：

| 资产 | 取地址方式 | 要 STS |
|---|---|---|
| video / audio / transcript（网关叫 `meeting_summary`） | 批量 `GET /v1/addresses`，AK/SK 签名，链接 6 小时 | 否 |
| ai_minutes / chapters | `/v1/smart/minutes`、`/v1/smart/chapters`，AK/SK 直调，正文内嵌成 `data:` URL | 否 |
| ~~ai_transcript~~（网关叫 `ai_meeting_transcripts`） | 详情接口 `GET /v1/addresses/{record_file_id}`，链接 5 分钟 | **是** |

只有最后一类要 STS，而它从未真正下载到过（本机全量验收库里 0 条；回调只能到公网网关，
本机永远拿不到 token）。为它维持的东西：`src/sts/` 约 380 行（申请、AES 解密、验签、
续期）、网关 `/webhook/tencent-meeting` 路由、`sts_token_requests` 表、
`STS_ENC_KEY` / `TM_WEBHOOK_TOKEN` / `TM_WEBHOOK_AES_KEY` 三个环境变量、网关每 5 分钟
一次的续期检查、preflight 第 7 项，以及「一个应用只有一枚有效 token」导致本机调度器
一跑就把服务器 token 打成非法的坑。全部一起删。

## 1. 部署

    git pull && bun install && bun run typecheck

`.env` 里 **删掉** `STS_ENC_KEY`、`TM_WEBHOOK_TOKEN`、`TM_WEBHOOK_AES_KEY` 三行
（留着也不报错，`loadConfig` 已不读它们；删掉是为了别再有人以为它们生效）。

    # 1) 先起网关（启动时跑迁移 015）
    # 2) 再 build 控制台：cd console && bun run build && cd ..
    # 3) 最后起调度器

迁移 015 做三件事，全部幂等，重跑安全：

1. `DROP TABLE IF EXISTS sts_token_requests`；
2. 删 `meeting_assets` / `meeting_asset_probes` / `archived_assets` / `asset_contents` 里
   `asset_type = 'ai_meeting_transcripts'` 的行；
3. 从 `policy_rules` / `meeting_grants` / `meeting_overrides` / `service_accounts.auto_grant_asset_types`
   的 JSON 里摘掉 `'ai_transcript'`。

服务器上先备一份再起：`mysqldump <db> sts_token_requests meeting_assets archived_assets policy_rules meeting_grants > backup-sts-2026-09-10.sql`。
第 2 步删的是库里的行，**不动磁盘**——如果某场会议目录下真有 `ai_transcript.*` 文件
（本机没有），它会变成没有台账的孤儿文件，按需手删。

## 2. 确认

    SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'sts_token_requests';   -- 0
    SELECT COUNT(*) FROM meeting_assets WHERE asset_type = 'ai_meeting_transcripts';                                          -- 0
    SELECT id, asset_types FROM policy_rules WHERE JSON_SEARCH(asset_types, 'one', 'ai_transcript') IS NOT NULL;              -- 空

- 网关日志里不再出现 `sts ensureFresh` / `sts pruneStale`。
- `bun scripts/preflight.ts` 现在共 6 项，没有第 7 项。
- 控制台「规则」页的资产类型下拉是五项：录像 / 音频 / 逐字稿 / 纪要 / 时间轴。
- 腾讯会议企管后台「事件订阅」里配的回调 URL 与「STS Token 生成」事件可以取消订阅；
  不取消也只是腾讯那边推送到一个 404 的地址，无害。

## 3. 回滚

`git revert` 这一批提交后重启即可恢复代码；但 015 已经 `DROP` 掉的表与删掉的行**不会自动回来**，
需要从第 1 节的备份里 `mysql < backup-sts-2026-09-10.sql` 灌回，并把三个环境变量填回 `.env`。
