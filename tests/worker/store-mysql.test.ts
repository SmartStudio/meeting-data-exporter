import { describe, expect, test } from 'bun:test'
import type { RowDataPacket } from 'mysql2'
import { meetingPathKey } from '@yaowu/mde-engine'
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
   * 所以断言是「每一路并发都领到活」，而不是「没有重复领取」——重复领取
   * 是另一个失效模式，那个上面的用例管。
   *
   * HISTORY = 20000 是这条用例的**承重结构**，不是随手写的常数：实测 5000 条历史时
   * 优化器仍选主键，一次只锁 1 行，坏代码照样绿灯。所以下面在造完数据之后先立一道
   * 守卫，把「数据量够不够」这件事也做成断言——谁为了让测试跑快把 HISTORY 调小，
   * 守卫会直接指着 fixture 报错，而不是让这条用例悄悄退化成永远绿的摆设。
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

      // ---- fixture 守卫：确认数据量真的把优化器逼离了主键 ----
      // 这里 EXPLAIN 的是**旧的 OR 形式**，不是实现现在用的语句。故意的：这条守卫
      // 量的是 fixture 而不是实现——「历史行多到让优化器放弃主键、改走
      // range + filesort」正是本用例赖以成立的前提，而 OR 形式是对这个前提最敏感的
      // 探针（5000 行时它走 PRIMARY，20000 行时才翻成 range + filesort）。
      // 实现自己的两条查询已经从结构上不会 filesort 了，拿它们探不出数据量够不够。
      const [plan] = await pool.query<RowDataPacket[]>(
        `EXPLAIN SELECT id FROM meeting_assets
          WHERE status='pending' OR (status='running' AND lease_expires_at < ?)
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [200],
      )
      const extra = String(plan[0]?.Extra ?? '')
      const key = String(plan[0]?.key ?? '')
      expect(`${key} / ${extra}`).toContain('filesort')

      // CLAIMERS 大于 createPool 的 connectionLimit(10)，所以实际是 10 路真并发 +
      // 10 路在连接池里排队。这不影响判别力（坏代码下实测只有 1~3 路领到活），
      // 但别把它读成「20 路同时打进数据库」。
      const CLAIMERS = 20
      const got = await Promise.all(
        Array.from({ length: CLAIMERS }, () => s.claimNext(200, 60)),
      )
      const rows = got.filter((r) => r !== null)
      // 200 条待领 vs 20 次领取，每一次都该领到活。锁住整个集合时这里会塌成个位数。
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
      await s.markCompleted(done.id, 'hash', 12, 210)
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
      await s.markFailed(a.id, 'boom', 210, 510)
      await s.markDead(b.id, 'gave up', 210)
      await s.markSkipped(c.id, 'not allowed', 210)

      const f = await s.failures()
      expect(f.map((r) => r.id)).toEqual([a.id, b.id]) // ORDER BY id；skipped 不算失败
      expect(f[0]!.last_error).toBe('boom')
      // failed 行的 lease_expires_at 是「最早可再领取时间」，不再是 NULL
      expect(f[0]!.lease_expires_at).toBe(510)
      expect(f[1]!.lease_expires_at).toBeNull() // dead 是终态，仍然清空

      expect(await s.resetFailed(300)).toBe(2) // affectedRows
      const counts = await s.counts()
      expect(counts.pending).toBe(2)
      expect(counts.skipped).toBe(1)
      expect(counts.failed).toBe(0)
      expect(counts.dead).toBe(0)
      expect((await s.failures()).length).toBe(0)
      expect(await s.resetFailed(310)).toBe(0) // 没有可重置的了
      // 打回 pending 的行不留下那个"最早可再领取时间"——它对 pending 没有含义
      const [reset] = await pool.query<RowDataPacket[]>(
        `SELECT lease_expires_at FROM meeting_assets WHERE id=?`, [a.id],
      )
      expect(reset[0]!.lease_expires_at).toBeNull()
    })
  })

  // ── 失败重试：failed 行按退避重新入队 ──────────────────────────
  //
  // 修复之前 `failed` 是事实上的终态：claim 只看 pending 与过期的 running，
  // upsertAsset 不重置 status，resetFailed 在服务端没有调用方。一个视频只要网络
  // 抖一次就永久卡住，attempts 停在 1，MAX_ATTEMPTS=5 那道门永远走不到。
  // 下面三条钉的是这条路真的通了，以及它没有把领取顺序弄乱。

  test('markFailed 写下最早可再领取时间：没到点领不到，到点了领得到且 attempts 递增', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'a', fileType: 'mp4' }, 100)

      const first = (await s.claimNext(200, 60))!
      expect(first.attempts).toBe(1)
      const retryAt = 200 + 300 // executor 的 downloadBackoff(1) = 5 分钟
      await s.markFailed(first.id, 'HTTP 500', 210, retryAt)

      expect(await s.claimNext(retryAt - 1, 60)).toBeNull() // 没到点，领不到
      // 边界与租约那条**严格同款**：`lease_expires_at < now` 才算可领，所以卡在
      // retryAt 这一秒上还不行。两条查询同形是 pickClaimable 加锁足迹的前提，
      // 不值得为一秒把它们拆成两种写法。
      expect(await s.claimNext(retryAt, 60)).toBeNull()
      const again = (await s.claimNext(retryAt + 1, 60))!
      expect(again.id).toBe(first.id)
      expect(again.status).toBe('running')
      expect(again.attempts).toBe(2) // 领取本身就是计数的那一步
      expect(again.last_error).toBe('HTTP 500') // 上一次的错留着，转 dead 时要用
    })
  })

  test('领取顺序仍是"全局 id 最小"：到点的 failed 排在 id 更大的 pending 前面', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'old', fileType: 'mp4' }, 100)
      const old = (await s.claimNext(200, 60))!
      await s.markFailed(old.id, 'boom', 210, 500)
      // 失败之后才发现的新资产，id 更大
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'new', fileType: 'mp4' }, 300)

      // 三条单 status 查询取 id 最小的那个（见 pickClaimable）：拆成三条是为了加锁
      // 足迹，不是为了给 pending 优先权——优先级必须还是原来那个「全局最小 id」。
      const got = (await s.claimNext(501, 60))!
      expect(got.id).toBe(old.id)
      expect(got.remote_id).toBe('old')
    })
  })

  test('改动之前留下的 failed 行（lease_expires_at 为 NULL）也能被领回来', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'a', fileType: 'mp4' }, 100)
      const row = (await s.claimNext(200, 60))!
      // 老版 markFailed 写的就是这一行 SQL（lease_expires_at=NULL）
      await pool.query(
        `UPDATE meeting_assets SET status='failed', last_error='legacy', lease_expires_at=NULL WHERE id=?`,
        [row.id],
      )
      // `NULL < ?` 不成立，所以不特判的话这些存量行会继续永远卡死——
      // 而服务端没有 mde retry 那个逃生口
      const again = (await s.claimNext(1000, 60))!
      expect(again.id).toBe(row.id)
      expect(again.attempts).toBe(2)
    })
  })

  test('deadAssets 给此刻全部 dead 的行（不分轮次）、带 attempts、不含 failed', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      for (const [rid, type] of [['a', 'video'], ['b', 'meeting_summary'], ['c', 'video']] as const) {
        await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: type, remoteId: rid, fileType: 'mp4' }, 100)
      }
      const [a, b, c] = [(await s.claimNext(200, 60))!, (await s.claimNext(200, 60))!, (await s.claimNext(200, 60))!]
      await s.markDead(a.id, '上一轮就放弃了', 500)
      await s.markDead(b.id, 'HTTP 404', 1000)
      await s.markFailed(c.id, '还在重试', 1000, 1300) // failed 是会自动重试的中间态，不该惊动运维

      // 不带时间窗：失败项是「资产此刻是否 dead」的镜像，上一轮放弃的只要还 dead 就要在
      const got = await s.deadAssets()
      expect(got).toEqual([
        { meetingId: 'm1', subMeetingId: '', assetType: 'video', lastError: '上一轮就放弃了', attempts: 1 },
        { meetingId: 'm1', subMeetingId: '', assetType: 'meeting_summary', lastError: 'HTTP 404', attempts: 1 },
      ])

      // 被人打回队列（resetFailed）之后它不再是 dead，也就不再出现——失败项由此关掉
      await s.resetFailed(2000)
      expect(await s.deadAssets()).toEqual([])
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

  // 与 SQLite 版配对：不 await 的 touchProgress 可能落在 markCompleted 之后。
  // MySQL 宿主下这条路是池化连接上的高频 UPDATE，最现实的正是它。
  test('touchProgress 不回写终态的行：迟到的检查点不许盖掉真实文件大小', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'a', fileType: 'mp4' }, 100)
      const row = (await s.claimNext(200, 60))!
      await s.markCompleted(row.id, 'h', 12_345, 210)
      await s.touchProgress(row.id, 8 * 1024 * 1024, 220, 60)   // 迟到的那一次

      const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM meeting_assets WHERE id=?', [row.id])
      expect(Number(rows[0]!.bytes_written)).toBe(12_345)
      expect(rows[0]!.status).toBe('completed')
      expect(rows[0]!.lease_expires_at).toBeNull()
    })
  })

  // 与 packages/engine/tests/store/index.test.ts 里同名的 SQLite 用例配对。
  // 两个宿主各有一份 markCompleted 实现，只改一处的话服务端会**静默**失效：
  // 下载照样成功、清单照样写出来，只是 bytes 永远是 null，没有任何报错。
  test('markCompleted 用真实文件大小覆盖 touchProgress 留下的进度检查点', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'a', fileType: 'mp4' }, 100)
      const row = (await s.claimNext(200, 60))!
      await s.touchProgress(row.id, 8 * 1024 * 1024, 210, 60)      // 最后一次 8MB 检查点
      await s.markCompleted(row.id, 'h', 8 * 1024 * 1024 + 4242, 220)

      const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM meeting_assets WHERE id=?', [row.id])
      expect(rows[0]!.status).toBe('completed')
      expect(Number(rows[0]!.bytes_written)).toBe(8 * 1024 * 1024 + 4242)
      expect(rows[0]!.lease_expires_at).toBeNull()
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

  test('meetingsForPaths 按 (meeting_id, sub_meeting_id) 建键，值里带回两段原文', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertMeeting({
        meetingId: 'm2', subMeetingId: 's1', meetingCode: null, subject: null,
        hostUserId: null, startTime: null, endTime: null,
      }, 100)
      const map = await s.meetingsForPaths()
      expect(map.size).toBe(2)
      expect(map.get(meetingPathKey('m1', ''))).toEqual({
        meetingId: 'm1', subMeetingId: '', subject: '周会',
        startTime: 1000, meetingCode: '881', endTime: 2000,
      })
      expect(map.get(meetingPathKey('m2', 's1'))).toEqual({
        meetingId: 'm2', subMeetingId: 's1', subject: null,
        startTime: null, meetingCode: null, endTime: null,
      })
    })
  })

  /**
   * 2026-09-09 之前这里钉的是「同 meeting_id 多 sub_meeting 时 sub_meeting_id 最大的
   * 一条胜出」——那是个洞：周期会议的所有场次会共用胜出那一场的目录。现在钉的是补好
   * 之后的行为：两个场次各一项，各自带着自己的 start_time（也就是各自的目录）。
   */
  test('meetingsForPaths 同 meeting_id 多场次时各成一项，不再互相覆盖', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      // 故意先插 'rec-2' 再插 'rec-1'，插入顺序与键序相反，塌成一条时立刻看得出来
      await s.upsertMeeting({ ...M, subMeetingId: 'rec-2', subject: '第二场', startTime: 2000 }, 100)
      await s.upsertMeeting({ ...M, subMeetingId: 'rec-1', subject: '第一场', startTime: 1000 }, 100)

      const map = await s.meetingsForPaths()
      expect(map.size).toBe(2)
      expect(map.get(meetingPathKey('m1', 'rec-1'))!.subject).toBe('第一场')
      expect(map.get(meetingPathKey('m1', 'rec-1'))!.startTime).toBe(1000)
      expect(map.get(meetingPathKey('m1', 'rec-2'))!.subject).toBe('第二场')
      expect(map.get(meetingPathKey('m1', 'rec-2'))!.startTime).toBe(2000)
    })
  })

  test('upsertMeeting 二次投递更新元数据而不新增行', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertMeeting({ ...M, subject: '改过的主题', endTime: 3000 }, 200)
      const map = await s.meetingsForPaths()
      expect(map.size).toBe(1)
      expect(map.get(meetingPathKey('m1', ''))!.subject).toBe('改过的主题')
      expect(map.get(meetingPathKey('m1', ''))!.endTime).toBe(3000)
    })
  })

  // -------------------------------------------------------------------------
  // sidecar（meeting.json / _manifest.json）要的两个读方法，与 SQLite 版逐条对齐
  // -------------------------------------------------------------------------

  test('getMeeting 按精确 (meeting_id, sub_meeting_id) 取回，不存在给 null', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertMeeting({ ...M, subMeetingId: 's1', subject: '第二场', startTime: 2000 }, 100)
      expect(await s.getMeeting('m1', '')).toEqual(M)
      expect((await s.getMeeting('m1', 's1'))!.subject).toBe('第二场') // 不被兄弟场次盖掉
      expect(await s.getMeeting('m1', 'nope')).toBeNull()
      expect(await s.getMeeting('nope', '')).toBeNull()
    })
  })

  test('getMeeting 的空值列如实给 null，时间列是数字不是字符串', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting({
        meetingId: 'm9', subMeetingId: '', meetingCode: null, subject: null,
        hostUserId: null, startTime: null, endTime: null,
      }, 100)
      expect(await s.getMeeting('m9', '')).toEqual({
        meetingId: 'm9', subMeetingId: '', meetingCode: null, subject: null,
        hostUserId: null, startTime: null, endTime: null,
      })
      await s.upsertMeeting(M, 100)
      expect(typeof (await s.getMeeting('m1', ''))!.startTime).toBe('number')
    })
  })

  test('assetsForMeeting 只给本场次的行、按 id 升序，各状态一并给出', async () => {
    await withDb(async (pool) => {
      const s = createMysqlStore(pool)
      await s.upsertMeeting(M, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'video', remoteId: 'r1' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: '', assetType: 'audio', remoteId: 'r2' }, 100)
      await s.upsertAsset({ meetingId: 'm1', subMeetingId: 's1', assetType: 'video', remoteId: 'r3' }, 100)
      await s.upsertAsset({ meetingId: 'm2', subMeetingId: '', assetType: 'video', remoteId: 'r4' }, 100)
      const first = (await s.claimNext(200, 60))!
      await s.markCompleted(first.id, 'h', 12, 200)

      const rows = await s.assetsForMeeting('m1', '')
      expect(rows.map((r) => r.remote_id)).toEqual(['r1', 'r2'])
      expect(rows.map((r) => r.status)).toEqual(['completed', 'pending'])
      expect(await s.assetsForMeeting('m1', 's1')).toHaveLength(1)
    })
  })
})
