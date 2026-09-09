/**
 * 失败项的两个动作端点（规格 2026-09-09 §2.3）。
 *
 * ## 为什么这一族跑真库，而 tests/http/console-jobs.test.ts 用假 store
 *
 * 那个文件测的是**胶水**（下次运行算得对不对、手动触发到底排没排队），假 store
 * 够用。这两个端点不是胶水：它们的全部内容就是「哪些行被改成了什么状态」——
 * 一场会议的 dead 资产回到 pending、attempts 清零、别的会议一行没动、失败项那一行
 * 被关掉。这些在假 store 上只能看到「返回了 200」。
 *
 * 所以这里把 `createJobsStore` 与 `createMysqlStore` 都接在同一个临时库上，
 * 只有管理员会话是假的。
 */
import { expect, test } from 'bun:test'
import { withTestDb } from '../helpers/testdb'
import { createJobsStore, jobFailureTarget } from '../../src/store/jobs'
import { createMysqlStore } from '../../src/worker/store-mysql'
import { ignoreFailures, retryFailures } from '../../src/http/handlers/console/jobs'
import { AdminSessionInvalidError } from '../../src/auth/admin'
import type { AdminAuth, AdminIdentity } from '../../src/auth/admin'
import type { AuditEntry } from '../../src/store/audit'
import type { AppDeps, RouteCtx } from '../../src/http/router'

const NOW = 1_800_000_000
const ADMIN: AdminIdentity = { adminId: 'admin-1', username: 'alice', role: 'admin' }
const READONLY: AdminIdentity = { adminId: 'admin-2', username: 'bob', role: 'readonly' }

function fakeAdminAuth(identity: AdminIdentity | null): AdminAuth {
  return {
    async authenticate() { throw new Error('not stubbed') },
    async hashPassword() { throw new Error('not stubbed') },
    async issueSession() { throw new Error('not stubbed') },
    async verifySession() {
      if (identity === null) throw new AdminSessionInvalidError()
      return identity
    },
    async revokeSession() { throw new Error('not stubbed') },
    async revokeAllSessionsFor() { throw new Error('not stubbed') },
    async revokeOtherSessionsFor() { throw new Error('not stubbed') },
  }
}

interface Rig {
  ctx: RouteCtx
  audits: AuditEntry[]
  jobs: ReturnType<typeof createJobsStore>
  store: ReturnType<typeof createMysqlStore>
}

async function withRig(
  fn: (rig: Rig) => Promise<void>,
  identity: AdminIdentity | null = ADMIN,
): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try {
    const jobs = createJobsStore(pool)
    const store = createMysqlStore(pool)
    const audits: AuditEntry[] = []
    const deps = {
      now: () => NOW,
      adminAuth: fakeAdminAuth(identity),
      jobs: {
        jobs,
        assets: store,
        audit: { async record(e: AuditEntry) { audits.push(e) } },
        tzOffsetSec: 0,
        fetchLookbackHours: 24,
      },
    } as unknown as AppDeps
    await fn({ ctx: { params: {}, deps }, audits, jobs, store })
  } finally {
    await cleanup()
  }
}

function post(path: string, body: unknown): Request {
  return new Request(`https://gw.example${path}`, {
    method: 'POST',
    headers: { cookie: 'mde_admin_session=t', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 一场会议 + 一条 dead 资产 + 一条对应的失败项，返回失败项 id */
async function seedDeadMeeting(
  rig: Rig,
  o: { meetingId: string; subMeetingId?: string; jobName?: string } ,
): Promise<number> {
  const subMeetingId = o.subMeetingId ?? ''
  await rig.store.upsertMeeting({
    meetingId: o.meetingId, subMeetingId, meetingCode: '881', subject: '周会',
    hostUserId: 'u1', startTime: 1000, endTime: 2000,
  }, NOW - 9000)
  await rig.store.upsertAsset({
    meetingId: o.meetingId, subMeetingId, assetType: 'video', remoteId: `r-${o.meetingId}`, fileType: 'mp4',
  }, NOW - 9000)
  const row = (await rig.store.claimNext(NOW - 8000, 60))!
  await rig.store.markDead(row.id, 'http 404', NOW - 7000)
  await rig.jobs.recordFailure({
    jobName: o.jobName ?? 'fetch_recordings',
    target: jobFailureTarget(o.meetingId, subMeetingId),
    targetLabel: '', meetingId: o.meetingId, subMeetingId,
    reason: '录像：腾讯那边没有这个文件', detail: `video/r-${o.meetingId}/mp4: http 404`,
    impact: '影响', attempts: 5, maxAttempts: 5, now: NOW - 7000,
  })
  const f = (await rig.jobs.listFailures()).find((x) => x.meetingId === o.meetingId)!
  return f.id
}

test('重试：资产回队列且 attempts 清零，失败项当场关掉', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await retryFailures(post('/api/v1/admin/jobs/failures/retry', { ids: [id] }), rig.ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ affected: 1, skipped: [] })

    const asset = (await rig.store.assetsForMeeting('m-1', ''))[0]!
    expect(asset.status).toBe('pending')
    expect(asset.attempts).toBe(0)          // 不清零的话回队列只剩一次机会
    expect(asset.last_error).toBeNull()
    // 「需要处理」上当场就没有它了，不用等下一轮拉取
    expect(await rig.jobs.listFailures()).toEqual([])
  })
})

test('忽略：dead 转 skipped(ignored_by_admin)，下一轮不会再被登记', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await ignoreFailures(post('/api/v1/admin/jobs/failures/ignore', { ids: [id] }), rig.ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ affected: 1, skipped: [] })

    const asset = (await rig.store.assetsForMeeting('m-1', ''))[0]!
    expect(asset.status).toBe('skipped')
    expect(asset.last_error).toBe('ignored_by_admin')
    // 资产不再是 dead → deadAssets 不再给它 → recordDeadAssets 不会重记
    expect(await rig.store.deadAssets()).toEqual([])
  })
})

test('不是可操作的那种：归档任务的失败项一行不改，进 skipped', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1', jobName: 'archive_nas' })
    const res = await retryFailures(post('/api/v1/admin/jobs/failures/retry', { ids: [id] }), rig.ctx)
    expect(await res.json()).toEqual({ affected: 0, skipped: [id] })
    // 归档失败项每轮自己判定、自己恢复，端点碰它只会把两套机制搅在一起
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('dead')
    expect(await rig.jobs.listFailures()).toHaveLength(1)
  })
})

test('已经恢复的、以及库里没有的 id：都进 skipped，不报错也不假装做了', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    await rig.jobs.resolveFailuresByIds([id], NOW - 100)
    const res = await retryFailures(
      post('/api/v1/admin/jobs/failures/retry', { ids: [id, 999_999] }), rig.ctx,
    )
    expect(await res.json()).toEqual({ affected: 0, skipped: [id, 999_999] })
  })
})

test('一次多条：能做的做了，不能做的逐个报回去', async () => {
  await withRig(async (rig) => {
    const ok1 = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const ok2 = await seedDeadMeeting(rig, { meetingId: 'm-2' })
    const bad = await seedDeadMeeting(rig, { meetingId: 'm-3', jobName: 'archive_nas' })
    const res = await retryFailures(
      post('/api/v1/admin/jobs/failures/retry', { ids: [ok1, bad, ok2] }), rig.ctx,
    )
    expect(await res.json()).toEqual({ affected: 2, skipped: [bad] })
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('pending')
    expect((await rig.store.assetsForMeeting('m-2', ''))[0]!.status).toBe('pending')
  })
})

test('周期性会议按场次动，不串到同 meeting_id 的另一场', async () => {
  await withRig(async (rig) => {
    const s1 = await seedDeadMeeting(rig, { meetingId: 'm-9', subMeetingId: 's-1' })
    await seedDeadMeeting(rig, { meetingId: 'm-9', subMeetingId: 's-2' })
    await retryFailures(post('/api/v1/admin/jobs/failures/retry', { ids: [s1] }), rig.ctx)
    expect((await rig.store.assetsForMeeting('m-9', 's-1'))[0]!.status).toBe('pending')
    expect((await rig.store.assetsForMeeting('m-9', 's-2'))[0]!.status).toBe('dead')
  })
})

test('每条动作一条审计：记得下是哪场会议、哪个动作、这一批有多少条', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    await ignoreFailures(post('/api/v1/admin/jobs/failures/ignore', { ids: [id] }), rig.ctx)
    expect(rig.audits).toHaveLength(1)
    const a = rig.audits[0]!
    expect(a.action).toBe('job_failure_ignore')
    expect(a.actorType).toBe('admin')
    expect(a.actorId).toBe('admin-1')
    expect(a.decision).toBe('allow')
    expect(a.clientKind).toBe('console')
    expect(a.meetingId).toBe('m-1')
    expect(a.assetId).toBe(`failure:${jobFailureTarget('m-1', '')}`)
    expect(a.detail).toContain('忽略')
    expect(JSON.parse(a.detail!.split('\n')[1]!)).toMatchObject({ failureId: id, batchSize: 1 })
  })
})

test('请求体不合规一律 400，且一行都不改', async () => {
  await withRig(async (rig) => {
    await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const bodies: unknown[] = [
      {},                                   // 没有 ids
      { ids: [] },                          // 空数组不是「全选」
      { ids: Array.from({ length: 101 }, (_, i) => i + 1) },  // 超过 100
      { ids: ['1'] },                       // 字符串 id
      { ids: [1.5] },                       // 非整数
      { ids: [0] },                         // 自增主键从 1 起
    ]
    for (const b of bodies) {
      const res = await retryFailures(post('/api/v1/admin/jobs/failures/retry', b), rig.ctx)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('invalid_ids')
    }
    // 「一行都不改」是这条用例的重点：一次手滑不该变成一次做了一半的批量操作
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('dead')
    expect(await rig.jobs.listFailures()).toHaveLength(1)
    expect(rig.audits).toHaveLength(0)
  })
})

test('同一个 id 报两次只做一遍——affected 不许因为重复而虚报', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await retryFailures(
      post('/api/v1/admin/jobs/failures/retry', { ids: [id, id] }), rig.ctx,
    )
    expect(await res.json()).toEqual({ affected: 1, skipped: [] })
    expect(rig.audits).toHaveLength(1)
  })
})

test('只读角色 403，未登录 401——两种都不许改任何一行', async () => {
  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await retryFailures(post('/api/v1/admin/jobs/failures/retry', { ids: [id] }), rig.ctx)
    expect(res.status).toBe(403)
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('dead')
    expect(rig.audits).toHaveLength(0)
  }, READONLY)

  await withRig(async (rig) => {
    const id = await seedDeadMeeting(rig, { meetingId: 'm-1' })
    const res = await ignoreFailures(post('/api/v1/admin/jobs/failures/ignore', { ids: [id] }), rig.ctx)
    expect(res.status).toBe(401)
    expect((await rig.store.assetsForMeeting('m-1', ''))[0]!.status).toBe('dead')
  }, null)
})
