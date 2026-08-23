import { describe, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import type { Meeting } from '@yaowu/mde-engine'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { createMysqlStore } from '../../src/worker/store-mysql'

const M: Meeting = {
  meetingId: 'm1', subMeetingId: '', meetingCode: '881', subject: '周会',
  hostUserId: 'u1', startTime: 1000, endTime: 2000,
}

/**
 * 每个用例一个独立库：counts() 统计的是整张表，共享库会让用例互相污染。
 * withTestDb() 的真实签名是 `(): Promise<{pool, cleanup}>`（无回调参数），
 * 这里包一层回调形态，顺便保证用例抛错时也 DROP 掉临时库。
 */
async function withDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try {
    await fn(pool)
  } finally {
    await cleanup()
  }
}

describe('createMysqlStore', () => {
  test('upsertAsset 按 file_type 区分同一 record_file 的多种格式', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      for (const ft of ['txt', 'docx', 'pdf']) {
        await s.upsertAsset({
          meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary',
          remoteId: 'r1', fileType: ft,
        }, 100)
      }
      expect((await s.counts()).pending).toBe(3)
    })
  })

  test('upsertAsset 重复投递同一唯一键只留一行，且不被后来的 null 冲掉已有值', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      const key = { meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1', fileType: 'mp4' }
      await s.upsertAsset({ ...key, assetId: 'a-1', bytesExpected: 42 }, 100)
      await s.upsertAsset({ ...key }, 110) // 第二次没带 assetId / bytesExpected
      expect((await s.counts()).pending).toBe(1)
      const row = (await s.claimNext(200, 60))!
      expect(row.asset_id).toBe('a-1') // COALESCE：不被 null 冲掉
      expect(row.bytes_expected).toBe(42)
    })
  })

  test('claimNext 并发领取不重复', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      for (let i = 0; i < 20; i++) {
        await s.upsertAsset({
          meetingId: 'm1', subMeetingId: '', assetType: 'video',
          remoteId: `r${i}`, fileType: 'mp4',
        }, 100)
      }
      // 40 路并发抢 20 条：每条只许被一个抢到，剩下 20 次拿到 null
      const got = await Promise.all(
        Array.from({ length: 40 }, () => s.claimNext(200, 60)),
      )
      const rows = got.filter((r) => r !== null)
      const ids = new Set(rows.map((r) => r.id))
      expect(rows.length).toBe(20)
      expect(ids.size).toBe(20) // ← 无重复领取
      expect((await s.counts()).running).toBe(20)
    })
  })

  /**
   * 上面那条并发用例只能证明「领取是互斥的」——把 SKIP LOCKED 去掉、只留
   * FOR UPDATE，它照样会过（FOR UPDATE 也互斥，只是并发方在同一行上排队）。
   * 换句话说它测不到 SKIP LOCKED 本身。
   *
   * 这条用例专门测 SKIP LOCKED：另开一条连接锁住 id 最小的那行，claimNext
   * 必须**跳过**它去领下一条。没有 SKIP LOCKED 时这里会一直等到
   * innodb_lock_wait_timeout（默认 50s），bun 的 5s 用例超时会先把它判红。
   */
  test('claimNext 跳过被别人锁住的行，而不是排队等锁', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'a', fileType: 'mp4' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'b', fileType: 'mp4' }, 100)

      const blocker = await pool.getConnection()
      try {
        await blocker.beginTransaction()
        const [locked] = await blocker.query<RowDataPacket[]>(
          'SELECT id FROM meeting_assets ORDER BY id LIMIT 1 FOR UPDATE',
        )
        const lockedId = locked[0]!.id as number

        const got = await s.claimNext(200, 60)
        expect(got).not.toBeNull()
        expect(got!.id).not.toBe(lockedId) // 跳过了被锁的那行
      } finally {
        await blocker.rollback()
        blocker.release()
      }
    })
  })

  test('租约过期后可被重新领取，attempts 累加', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({
        meetingId: 'm1', subMeetingId: '', assetType: 'video',
        remoteId: 'r1', fileType: 'mp4',
      }, 100)
      const first = await s.claimNext(200, 60) // 租约到 260
      expect(first).not.toBeNull()
      expect(first!.status).toBe('running')
      expect(first!.attempts).toBe(1)
      expect(first!.lease_expires_at).toBe(260)
      expect(await s.claimNext(250, 60)).toBeNull() // 未过期，抢不到
      const again = await s.claimNext(300, 60) // 已过期
      expect(again!.id).toBe(first!.id)
      expect(again!.attempts).toBe(2)
    })
  })

  test('siblingRank 按 file_type 分组——多格式不加序号，多段才加', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      // 同 asset_type、同 file_type、不同 remote_id 的两段 → 组内序号 1、2
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'a', fileType: 'txt' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'b', fileType: 'txt' }, 100)
      // 另一种格式 → 自己一组，序号 1（靠扩展名就能区分，不该被编成 _3）
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'a', fileType: 'pdf' }, 100)

      // claimNext 是 ORDER BY id，取回顺序即插入顺序
      const r1 = (await s.claimNext(200, 60))!
      const r2 = (await s.claimNext(200, 60))!
      const r3 = (await s.claimNext(200, 60))!

      expect(await s.siblingRank(r1)).toEqual({ ordinal: 1, total: 2 }) // txt 组第 1
      expect(await s.siblingRank(r2)).toEqual({ ordinal: 2, total: 2 }) // txt 组第 2 → transcript_2.txt
      expect(await s.siblingRank(r3)).toEqual({ ordinal: 1, total: 1 }) // pdf 组独一份 → transcript.pdf
    })
  })

  test('markSkippedByKey 不回退已完成、不打断执行中', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'a', fileType: 'mp4' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'b', fileType: 'mp4' }, 100)
      const done = (await s.claimNext(200, 60))!
      await s.markCompleted(done.id, 'hash', 210)
      await s.markSkippedByKey({ meetingId: 'm1', subMeetingId: '', assetType: 'video' }, 'no', 220)
      const c = await s.counts()
      expect(c.completed).toBe(1)
      expect(c.skipped).toBe(1)
    })
  })

  test('markSkippedByKey 不打断 running 中的资产', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'a', fileType: 'mp4' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'b', fileType: 'mp4' }, 100)
      await s.claimNext(200, 60) // a → running，租约未过期
      await s.markSkippedByKey({ meetingId: 'm1', subMeetingId: '', assetType: 'video' }, 'no', 220)
      const c = await s.counts()
      expect(c.running).toBe(1)
      expect(c.skipped).toBe(1)
    })
  })

  test('失败与死信的登记、查询与重置', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      for (const r of ['a', 'b', 'c']) {
        await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: r, fileType: 'mp4' }, 100)
      }
      const a = (await s.claimNext(200, 60))!
      const b = (await s.claimNext(200, 60))!
      const c = (await s.claimNext(200, 60))!
      await s.markFailed(a.id, 'boom', 210)
      await s.markDead(b.id, 'gave up', 210)
      await s.markSkipped(c.id, 'not allowed', 210)

      const f = await s.failures()
      expect(f.map((r) => r.id)).toEqual([a.id, b.id]) // ORDER BY id；skipped 不算失败
      expect(f[0]!.last_error).toBe('boom')
      expect(f[0]!.lease_expires_at).toBeNull()

      expect(await s.resetFailed(300)).toBe(2) // affectedRows
      const counts = await s.counts()
      expect(counts.pending).toBe(2)
      expect(counts.skipped).toBe(1)
      expect(counts.failed).toBe(0)
      expect(counts.dead).toBe(0)
      expect((await s.failures()).length).toBe(0)
      expect(await s.resetFailed(310)).toBe(0) // 没有可重置的了
    })
  })

  test('touchProgress / setTargetPath 落库，file_type 传 null 时保留原值', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'a', fileType: '' }, 100)
      const row = (await s.claimNext(200, 60))!
      await s.touchProgress(row.id, 4096, 230, 60)
      await s.setTargetPath(row.id, 'a/b/video.mp4', 'mp4', 230)
      await s.setTargetPath(row.id, 'a/b/video.mp4', null, 240)

      const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM meeting_assets WHERE id=?', [row.id])
      expect(rows[0]!.bytes_written).toBe(4096)
      expect(rows[0]!.lease_expires_at).toBe(290) // 230 + 60，续租
      expect(rows[0]!.target_path).toBe('a/b/video.mp4')
      expect(rows[0]!.file_type).toBe('mp4')
    })
  })

  test('probe 的 upsert / due / bump / resolve / abandon', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      const k = { meetingId: 'm1', subMeetingId: '', assetType: 'video' }
      await s.upsertProbe({ ...k, deadlineAt: 5000, probeAfter: 100 })
      expect((await s.dueProbes(99)).length).toBe(0)
      const due = await s.dueProbes(100)
      expect(due.length).toBe(1)
      expect(due[0]!.state).toBe('probing')
      expect(due[0]!.deadline_at).toBe(5000)
      expect(due[0]!.attempts).toBe(0)

      // 重复 upsert 只更新 deadline_at，不重置 attempts / probe_after
      await s.bumpProbe(k, 400)
      await s.upsertProbe({ ...k, deadlineAt: 6000, probeAfter: 999 })
      const after = await s.dueProbes(400)
      expect(after.length).toBe(1)
      expect(after[0]!.attempts).toBe(1)
      expect(after[0]!.deadline_at).toBe(6000)
      expect((await s.dueProbes(399)).length).toBe(0) // probe_after 停在 bump 的 400

      await s.resolveProbe(k)
      expect((await s.dueProbes(9999)).length).toBe(0)

      const k2 = { meetingId: 'm2', subMeetingId: '', assetType: 'audio' }
      await s.upsertProbe({ ...k2, deadlineAt: 5000, probeAfter: 0 })
      await s.abandonProbe(k2, '超时')
      expect((await s.dueProbes(9999)).length).toBe(0)
    })
  })

  test('meetingsForPaths 返回按 meeting_id 索引的会议元数据', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertMeeting({
        meetingId: 'm2', subMeetingId: 's1', meetingCode: null, subject: null,
        hostUserId: null, startTime: null, endTime: null,
      }, 100)
      const map = await s.meetingsForPaths()
      expect(map.size).toBe(2)
      expect(map.get('m1')).toEqual({
        subject: '周会', startTime: 1000, meetingCode: '881', endTime: 2000, subMeetingId: '',
      })
      expect(map.get('m2')).toEqual({
        subject: null, startTime: null, meetingCode: null, endTime: null, subMeetingId: 's1',
      })
    })
  })

  test('upsertMeeting 二次投递更新元数据而不新增行', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertMeeting({ ...M, subject: '改过的主题', endTime: 3000 }, 200)
      const map = await s.meetingsForPaths()
      expect(map.size).toBe(1)
      expect(map.get('m1')!.subject).toBe('改过的主题')
      expect(map.get('m1')!.endTime).toBe(3000)
    })
  })
})
