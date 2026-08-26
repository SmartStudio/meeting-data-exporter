import { expect, test } from 'bun:test'
import { createAuditRecorder } from '../../src/audit/recorder'
import type { AuditEntry, AuditStore } from '../../src/store/audit'
import type { ActorIdentity } from '../../src/domain/types'

function memStore(): AuditStore & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = []
  return { entries, async record(e) { entries.push(e) } }
}

const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-a', tmUserId: 'tm-a', programId: null }

test('签发下载地址时记录完整上下文', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordDownloadUrl({
    actor: alice, meetingId: 'm1', assetId: 'f1:video:0',
    assetType: 'video', decision: 'allow', matchedRuleId: 7, clientKind: 'cli',
    reason: '采集权限 #7「财务放行」覆盖 video',
  })
  expect(store.entries[0]).toEqual({
    occurredAt: 1700, actorType: 'wecom_user', actorId: 'tm-a',
    action: 'issue_download_url', meetingId: 'm1', assetId: 'f1:video:0',
    assetType: 'video', decision: 'allow', matchedRuleId: 7, clientKind: 'cli',
    detail: '采集权限 #7「财务放行」覆盖 video',
  })
})

test('拒绝同样留下记录，且判定理由进 detail——spec §4.10 要求被拒绝的记录写明原因', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordDownloadUrl({
    actor: alice, meetingId: 'm1', assetId: 'a1',
    assetType: 'video', decision: 'deny', matchedRuleId: null, clientKind: 'desktop',
    reason: '一条采集权限规则都没命中，按兜底拒绝',
  })
  expect(store.entries[0]!.decision).toBe('deny')
  expect(store.entries[0]!.detail).toBe('一条采集权限规则都没命中，按兜底拒绝')
})

test('给不出判定理由时 detail 是 null，不在这一层编一句', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordDownloadUrl({
    actor: alice, meetingId: 'm1', assetId: 'a1',
    assetType: 'video', decision: 'deny', matchedRuleId: null, clientKind: 'cli', reason: null,
  })
  expect(store.entries[0]!.detail).toBeNull()
})

test('登录成功与失败均记录，失败原因进 detail 而不再硬塞 asset_type', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordLogin(alice, true)
  await r.recordLogin(alice, false, 'identity_mapping_failed')
  expect(store.entries.map((e) => e.decision)).toEqual(['allow', 'deny'])
  expect(store.entries.map((e) => e.action)).toEqual(['login', 'login'])
  expect(store.entries.map((e) => e.detail)).toEqual([null, 'identity_mapping_failed'])
  // asset_type 是 VARCHAR(64) 的「资产类型」列，不再当自由文本用
  expect(store.entries.map((e) => e.assetType)).toEqual([null, null])
})

test('列会议的条数进 detail，人话与数字都留下', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordListing(alice, 42)
  const e = store.entries[0]!
  expect(e.assetType).toBeNull()
  expect(e.detail).toContain('42')
  expect(JSON.parse(e.detail!.split('\n')[1]!)).toEqual({ count: 42 })
})

test('服务账号的 actorType 正确', async () => {
  const store = memStore()
  const svc: ActorIdentity = { kind: 'service_account', wecomUserId: null, tmUserId: 'tm-svc', programId: 'svc-1' }
  const r = createAuditRecorder(store, () => 1700)
  await r.recordLogin(svc, true)
  expect(store.entries[0]!.actorType).toBe('service_account')
})
