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
   * innodb_lock_wait_timeout（默认 50s），用例超时会先把它判红。
   *
   * 超时值显式写成 5000 而不是靠 bun 的隐式默认：这条用例的红/绿完全取决于
   * 「用例超时 < innodb_lock_wait_timeout」，谁要是在 bunfig.toml 里配了更大的
   * 全局 [test] timeout，它就会退化成一条要等 50s 才现形的用例。用例赖以成立的
   * 前提就写在用例里。
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
  }, 5000)

  /**
   * 领取语句的**加锁足迹不许随队列长度增长**。
   *
   * 这是本文件里唯一一条必须造生产数据分布的用例，原因就是上面两条并发用例
   * 都在空表上跑，而空表上优化器选主键（`type=index key=PRIMARY rows=1`），
   * 一次领取只锁 1 行——什么毛病都藏得住。历史 completed 一多，优化器翻到
   * `range + idx_assets_claimable + filesort`：为了给 ORDER BY id 排序，它必须把
   * **整个可领取集合**读出来，`FOR UPDATE` 于是把每一行都锁上。实测这个数据量下
   * 一次领取持有 400 把记录锁。后果不是变慢，是并发 worker 的 SKIP LOCKED 把
   * 它们全跳过、拿到 null，而 runExecutor 的 `if (!row) return` 让 worker 就此退出：
   * **队列里还有 200 条活，worker 却集体收工**。
   *
   * 所以断言是「20 路并发每一路都领到活」，而不是「没有重复领取」——重复领取
   * 是另一个失效模式，那个上面的用例管。
   *
   * 20000 这个数字不是随手写的：实测 5000 条历史时优化器仍选主键（用例会变成
   * 一条什么都测不到的绿灯），20000 才翻过去。造数据约 300ms。
   */
  test('领取的加锁足迹不随队列长度增长——生产数据分布下并发 worker 不会集体空转', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)

      const HISTORY = 20_000
      const PENDING = 200
      const CHUNK = 2000
      const COLS = 'meeting_id,sub_meeting_id,asset_type,remote_id,status,file_type,created_at,updated_at'
      for (let off = 0; off < HISTORY; off += CHUNK) {
        const ph: string[] = []
        const vals: unknown[] = []
        for (let i = 0; i < CHUNK; i++) {
          ph.push('(?,?,?,?,?,?,?,?)')
          vals.push(`h${off + i}`, '', 'video', `hr${off + i}`, 'completed', 'mp4', 100, 100)
        }
        await pool.query(`INSERT INTO meeting_assets (${COLS}) VALUES ${ph.join(',')}`, vals)
      }
      const ph: string[] = []
      const vals: unknown[] = []
      for (let i = 0; i < PENDING; i++) {
        ph.push('(?,?,?,?,?,?,?,?)')
        vals.push('m1', '', 'video', `pr${i}`, 'pending', 'mp4', 100, 100)
      }
      await pool.query(`INSERT INTO meeting_assets (${COLS}) VALUES ${ph.join(',')}`, vals)
      // 不 ANALYZE 的话优化器可能还拿着空表时的统计信息，测不到真实计划
      await pool.query('ANALYZE TABLE meeting_assets')

      const CLAIMERS = 20
      const got = await Promise.all(
        Array.from({ length: CLAIMERS }, () => s.claimNext(200, 60)),
      )
      const rows = got.filter((r) => r !== null)
      // 200 条待领 vs 20 路并发，每一路都该领到活。锁住整个集合时这里会塌成个位数。
      expect(rows.length).toBe(CLAIMERS)
      expect(new Set(rows.map((r) => r.id)).size).toBe(CLAIMERS)
    })
  }, 30_000)

  /**
   * 上一条用例依赖 idx_assets_claimable 的列序是 (status, id, …)：status 等值 +
   * id 紧随其后，索引才自带 ORDER BY id 需要的顺序，LIMIT 1 才能锁一行就停手。
   * 列序换回 (status, lease_expires_at, id) 就又要 filesort。
   *
   * 单独钉住它，是因为上一条用例红的时候只会说「并发领取塌了」，看不出根因在
   * 索引列序上；将来有人「顺手优化」这个索引时，这条用例会直接指着列序说话。
   */
  test('idx_assets_claimable 的列序把 id 排在 lease_expires_at 之前', async () => {
    await withDb(async (pool) => {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT column_name FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = 'meeting_assets'
            AND index_name = 'idx_assets_claimable' ORDER BY seq_in_index`,
      )
      const cols = rows.map((r) => (r.column_name ?? r.COLUMN_NAME) as string)
      expect(cols).toEqual(['status', 'id', 'lease_expires_at'])
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

  /**
   * 钉住「同一 meeting_id 有多个 sub_meeting_id 时谁胜出」的当前行为：
   * Map 键只有 meeting_id，后一行覆盖前一行，配上 ORDER BY 之后胜出的确定是
   * sub_meeting_id 最大的那条。
   *
   * 这个行为本身是个洞，本任务不修（SQLite 宿主也一样）：周期性会议各场次共享
   * meeting_id，而胜出行的 start_time 会进目录名，于是所有场次的文件会落进
   * 某一场次的目录。将来根治那条任务改到这里时，这条用例会明确告诉他改动了什么，
   * 而不是让他猜原来是什么行为。
   */
  test('meetingsForPaths 同 meeting_id 多 sub_meeting 时由 sub_meeting_id 最大的一条胜出', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      // 故意先插 's1' 再插 ''，让「插入顺序」与「sub_meeting_id 序」相反，
      // 否则两种可能的行序会给出同样的结果，用例就区分不出来了
      await s.upsertMeeting({ ...M, subMeetingId: 's1', subject: '第二场', startTime: 2000 }, 100)
      await s.upsertMeeting({ ...M, subMeetingId: '', subject: '第一场', startTime: 1000 }, 100)

      const map = await s.meetingsForPaths()
      expect(map.size).toBe(1) // 两条会议行，塌成一个 Map 条目——这就是那个洞
      expect(map.get('m1')).toEqual({
        subject: '第二场', startTime: 2000, meetingCode: '881', endTime: 2000, subMeetingId: 's1',
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
