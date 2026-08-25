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
  })
  expect(store.entries[0]).toEqual({
    occurredAt: 1700, actorType: 'wecom_user', actorId: 'tm-a',
    action: 'issue_download_url', meetingId: 'm1', assetId: 'f1:video:0',
    assetType: 'video', decision: 'allow', matchedRuleId: 7, clientKind: 'cli',
  })
})

test('拒绝同样留下记录', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordDownloadUrl({
    actor: alice, meetingId: 'm1', assetId: 'a1',
    assetType: 'video', decision: 'deny', matchedRuleId: null, clientKind: 'desktop',
  })
  expect(store.entries[0]!.decision).toBe('deny')
})

test('登录成功与失败均记录', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordLogin(alice, true)
  await r.recordLogin(alice, false, 'identity_mapping_failed')
  expect(store.entries.map((e) => e.decision)).toEqual(['allow', 'deny'])
  expect(store.entries.map((e) => e.action)).toEqual(['login', 'login'])
})

test('服务账号的 actorType 正确', async () => {
  const store = memStore()
  const svc: ActorIdentity = { kind: 'service_account', wecomUserId: null, tmUserId: 'tm-svc', programId: 'svc-1' }
  const r = createAuditRecorder(store, () => 1700)
  await r.recordLogin(svc, true)
  expect(store.entries[0]!.actorType).toBe('service_account')
})
