import type { RowDataPacket } from 'mysql2'
import type { Pool } from './db'

/**
 * 腾讯会议成员姓名的本地副本（`tm_users` 表）的读写。
 *
 * 表的语义、`username IS NULL` 为什么不是「还没查」、为什么不加索引，全部写在
 * `migrations/012_tm_users.sql` 的表头，那里是唯一的权威说明，本文件不复述。
 *
 * 这一层只做三件事，且**一件都不碰腾讯接口**：谁该去查（`listMissing`）、
 * 查回来的落库（`upsertMany`）、把名字批量取出来给控制台（`namesFor`）。
 * 真正的调用与错误分类在 `src/worker/host-names.ts`——那边才知道哪一类错误
 * 该写 NULL、哪一类该本轮跳过。分开是为了让「该查谁」这条判据能在测试里
 * 不碰网络地钉死。
 *
 * ## 三个方法都是批量的，没有单条版本
 *
 * 与 `MeetingCacheStore.upsertMany` 同一个理由：调用点全是「一批 id」——
 * 控制台列一页 50 行、同步轮一次 50 个。一条一句 SQL 会让列一页发 50 次往返，
 * 而那正是 `console-meetings.ts` 文件头「查询数与行数无关」那条验收要防的事。
 */

/** 一行 `tm_users`。`username` 为 null = 查过，腾讯说没有这个成员 */
export interface TmUserRow {
  tmUserId: string
  username: string | null
  /** unix 秒，这一行是什么时候问的腾讯 */
  fetchedAt: number
}

export interface TmUsersStore {
  /**
   * 这一批 id 里**该去问腾讯**的那些：既不在表里、也不是 `staleSec` 秒内问过的。
   *
   * 「不在表里」与「表里 username 是 NULL」是两件事，这里只把前者和**过期的后者**
   * 挑出来：一个查过确实不存在的 id，在 `staleSec` 内不该被反复去问——那是在拿
   * 接口配额换一个已经知道的答案。
   *
   * 返回顺序与传入顺序一致：调用方每轮只取前 N 个（`MAX_PER_ROUND`），顺序不稳
   * 会让同一批 id 每轮换一个子集去查，谁都补不齐。
   */
  listMissing(ids: readonly string[], now: number, staleSec: number): Promise<string[]>
  /** 查回来的结果整批落库。同一个 id 已经有行时**覆盖**（姓名会改，人也会离职） */
  upsertMany(rows: readonly TmUserRow[]): Promise<void>
  /**
   * 这一批 id 的姓名。**查无此人（username IS NULL）与不在表里在这里同义**——
   * 两者都不出现在返回的 Map 里。
   *
   * 读侧要的答案只有「知不知道他叫什么」，而 NULL 那一行说的正是「不知道」。
   * 把它当成一个「已知的空名字」带出去，界面就会把空串当姓名渲染成一行空白。
   */
  namesFor(ids: readonly string[]): Promise<Map<string, string>>
}

interface TmUserSqlRow extends RowDataPacket {
  tm_userid: string
  username: string | null
  fetched_at: number | string
}

interface TmUserIdRow extends RowDataPacket {
  tm_userid: string
}

/**
 * `meetings` 表里出现过的主持人 id。**同步侧的枚举源**，与本表是一问一答的两半：
 * 这边说「有这些人要认」，`tm_users` 说「这些人我认得几个」。
 *
 * 为什么和 `TmUsersStore` 住在一个文件里、而不是 `console-meetings.ts`：那一个是
 * 控制台的读侧，整个模块是围绕「拼装一行会议」组织的，把一条只有后台同步轮会用的
 * 查询挂进去，等于让控制台的 store 出现在同步链路上。而这条查询与 `tm_users` 是
 * **一起用的**（`listHostUserIds` 的输出直接喂给 `listMissing`），放在一起读得懂。
 *
 * 它**只读 `meetings` 一列**，一个字都不写。
 */
export interface MeetingHostIdsStore {
  /**
   * `meetings.host_userid` 去重后的全部取值。
   *
   * **NULL 与空串不在结果里**：前者是元数据没拉回来，后者是设备账号发起的快速会议
   * （腾讯确实返回了空串，见 `console/src/lib/host.ts` 的「无主持人」那一支）。
   * 两者都不是一个可以拿去问腾讯的成员 id，混进来只会换回一次必然失败的调用。
   */
  listHostUserIds(): Promise<string[]>
}

/** `IN (?, ?, …)` 的占位符，与 `keyInFragment` 同一种拼法 */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

export function createTmUsersStore(pool: Pool): TmUsersStore {
  return {
    async listMissing(ids, now, staleSec) {
      if (ids.length === 0) return []
      // 去重后再查：调用方传进来的是「会议表里出现过的 host_userid」，同一个人
      // 主持了 40 场会就会出现 40 次
      const unique = [...new Set(ids)]

      // 问库要的是**已经新鲜的那些**，然后在内存里做差集。反过来（让 SQL 直接
      // 算差集）要么写成 NOT IN 子查询 + 一张临时表，要么逐个 id 判一次——
      // 前者复杂、后者是 N 次往返，而这里的 N 就是一页会议的主持人数
      const [rows] = await pool.query<TmUserIdRow[]>(
        `SELECT tm_userid
           FROM tm_users
          WHERE tm_userid IN (${placeholders(unique.length)})
            AND fetched_at > ?`,
        [...unique, now - staleSec],
      )
      const fresh = new Set(rows.map((r) => r.tm_userid))
      // 顺序跟着入参走，见接口上的注释
      return unique.filter((id) => !fresh.has(id))
    },

    async upsertMany(rows) {
      if (rows.length === 0) return
      // 一条 INSERT … VALUES (…), (…) … ON DUPLICATE KEY UPDATE，不是 N 条。
      // `username` 与 `fetched_at` 都要覆盖：人改了名要跟上，而 fetched_at 不覆盖
      // 的话「一天内不重查」这条判据就永远停在第一次查的那一刻
      const values = rows.map(() => '(?, ?, ?)').join(', ')
      const params = rows.flatMap((r) => [r.tmUserId, r.username, r.fetchedAt])
      await pool.query(
        `INSERT INTO tm_users (tm_userid, username, fetched_at)
         VALUES ${values}
         ON DUPLICATE KEY UPDATE username = VALUES(username), fetched_at = VALUES(fetched_at)`,
        params,
      )
    },

    async namesFor(ids) {
      if (ids.length === 0) return new Map()
      const unique = [...new Set(ids)]
      const [rows] = await pool.query<TmUserSqlRow[]>(
        `SELECT tm_userid, username, fetched_at
           FROM tm_users
          WHERE tm_userid IN (${placeholders(unique.length)})
            AND username IS NOT NULL`,
        unique,
      )
      const out = new Map<string, string>()
      for (const r of rows) {
        // 空串在这一列里和 NULL 是同一件事：腾讯返回过一个没有名字的成员。
        // 让它进 Map 的话，界面会把「已知姓名」渲染成一行空白，比「未知主持人」更难查
        const name = (r.username ?? '').trim()
        if (name !== '') out.set(r.tm_userid, name)
      }
      return out
    },
  }
}

export function createMeetingHostIdsStore(pool: Pool): MeetingHostIdsStore {
  return {
    async listHostUserIds() {
      const [rows] = await pool.query<TmUserIdRow[]>(
        `SELECT DISTINCT host_userid AS tm_userid
           FROM meetings
          WHERE host_userid IS NOT NULL AND host_userid <> ''
          ORDER BY host_userid`,
      )
      return rows.map((r) => r.tm_userid)
    },
  }
}
