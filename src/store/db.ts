import { readdir } from 'node:fs/promises'
import mysql, { type RowDataPacket } from 'mysql2/promise'

export type Pool = mysql.Pool

/**
 * 池上限。导出是因为**调用方的并发度必须对着它来定**：
 * `store-mysql.ts` 的 `claimNext` 在事务期间独占一条连接，归档 worker 的每个
 * 执行体在下载期间还压着一条未 await 的 `touchProgress`，所以
 * 「执行体数 × 2 ≤ 本上限」是 worker 启动时的硬校验（见 src/worker/index.ts）。
 *
 * ⚠️ **`× 2` 是稳态的典型值，不是最坏值。** `touchProgress` 不被 await，
 * 在途量的真实上界是**无界**的，由 `queueLimit` 兜（见 worker 侧的
 * `poolQueueLimitFor`）。这道硬校验挡的是「稳态就已经配过头」，
 * 挡不住在途堆积——两道闸门管的不是同一件事。
 */
export const POOL_CONNECTION_LIMIT = 10

export interface PoolTuning {
  /**
   * 连接都被占满后，最多允许多少个请求**排队**等连接。
   *
   * mysql2 的默认是 `0` = 不限队列，配合默认的 `waitForConnections: true`，
   * 池耗尽的表现是**无限期静默挂起**：没有超时、没有报错、没有日志，进程看起来
   * 活着但一件事都不干。
   *
   * ⚠️ **它限的是队列长度，不是等待时长**，而 mysql2 **没有取连接超时**。
   * 所以有限的 queueLimit 只能挡住「等待者无界堆积」，**挡不住「已经排上队的
   * 请求无限期地等」**——队列没满时行为与默认值完全一样。谁想靠它保证
   * 「池耗尽会喊出来」，会失望。归档 worker 用它兜的是 fire-and-forget 的
   * `touchProgress` 堆积（见 src/worker/index.ts 的 poolQueueLimitFor）。
   *
   * 而**一旦队列真的满了**，mysql2 对**所有**调用方一律以 `Queue limit reached.`
   * 拒绝，不区分是谁排上来的。对 worker 而言这意味着下一次 `claimNext` 当场抛出
   * ——整轮失败、退出码 1、已领取的行卡在 `running` 直到租约过期。
   * 这道闸门把「无界堆积到 OOM」换成了「一轮当场失败」，**不是**换成了
   * 「继续跑、只是多几行 warn」。
   *
   * 默认仍是 mysql2 的行为（不限），因为 HTTP 网关那边改成有限值意味着请求高峰
   * 期把「多等一会儿」换成「直接 500」，那是另一个需要单独权衡的决定，不在
   * 归档 worker 的射程内。worker 自己显式传一个够得着的有限值。
   */
  queueLimit?: number
}

/**
 * charset 必须显式设为 utf8mb4——MySQL 默认的 utf8 只有 3 字节，
 * 会议主题中的 emoji（4 字节）会插入失败。
 */
export function createPool(databaseUrl: string, tuning: PoolTuning = {}): Pool {
  return mysql.createPool({
    uri: databaseUrl,
    connectionLimit: POOL_CONNECTION_LIMIT,
    queueLimit: tuning.queueLimit ?? 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
  })
}

/**
 * 放弃等待连接池关闭的时限。
 *
 * 这不是「慢一点也没关系」的那种超时——正常的 `end()` 是毫秒级的。5 秒还没关掉
 * 就不是慢，是卡死了（见 `closePool` 的注释），再等只是把进程钉在那儿。
 */
export const POOL_CLOSE_TIMEOUT_MS = 5_000

/** `closePool` 只需要这一个方法，测试里就不必伪造整个 `mysql.Pool`。 */
export interface ClosablePool {
  end(): Promise<void>
}

/**
 * 关连接池，**但不把进程押在它身上**。
 *
 * `pool.end()` 会等池里所有在途调用归还连接才 resolve。麻烦在于本项目的进度回写
 * 是 fire-and-forget（见上面 `queueLimit` 那段：在途量无界，而 mysql2 **没有取
 * 连接超时**）：信号落下时可能还有一批回写排在取连接的队列里，而 `end()` 之后池
 * 不再分配连接——排队者永远等不到连接，`end()` 也就永远等着这批排队者。
 * **那是个死锁，不是慢，等下去不会变好。**
 *
 * 2026-09-01 的调度器就是这样：SIGTERM 之后任务全部收尾、库里一行 running 都没有、
 * CPU 时间不再增长，进程却又活了两分多钟，最后只能 kill -9。
 *
 * 所以超时就放弃：连接由内核在进程退出时一并收掉，这一步本来就只是「客气地道别」。
 * 放弃时必须留下一行——悄悄放弃等于把死锁藏起来，下次照样查不出来。
 *
 * **超时之前**的失败照旧往上抛：那是「关池失败」这件事本身，与本函数要挡的
 * 挂起是两码事，退出码语义不该被这道兜底顺手改掉。
 */
export async function closePool(
  pool: ClosablePool,
  opts: { timeoutMs?: number; log?: (msg: string) => void } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? POOL_CLOSE_TIMEOUT_MS
  const log = opts.log ?? ((msg: string): void => console.warn(msg))

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // race 会给 end() 挂上 reject 处理，所以放弃之后才到的失败不会变成
    // 未处理的拒绝——进程正在退出的路上，最不需要的就是再崩一次。
    const outcome = await Promise.race([
      pool.end().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])
    if (outcome === 'timeout') {
      log(
        `连接池 ${timeoutMs}ms 内没关掉，不再等它，进程照常退出。` +
          '池里多半还压着没归还的连接（进度回写是 fire-and-forget），' +
          'end() 之后池不再分配连接，排队者就永远等不到——那是死锁，等下去不会好',
      )
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 逐个执行 migrations/ 下的 .sql，按文件名升序（001、002、…）。
 * migration 文件含多条语句，逐条执行（连接池禁用 multipleStatements）。
 *
 * 切分方式是按分号朴素 split，所以 .sql 文件里除语句结束符外不许出现分号，
 * 注释里也不行。
 *
 * **全部语句跑在同一条连接上**，而不是每条各从池里取一条。会话变量（`SET @x`）
 * 与预处理语句（`PREPARE` / `EXECUTE`）都是**会话级**的，换一条连接就全没了。
 * 004 用这套写法实现幂等的条件 DDL（MySQL 的 ADD/DROP COLUMN 没有 IF EXISTS），
 * 靠池「多半会把刚归还的那条连接再发出来」是碰运气，一旦不成立，迁移会以
 * 「@变量是 NULL、条件判空、DDL 静默不执行」的方式失败——查不出来的那一种。
 *
 * **整段迁移在一把 MySQL 命名锁（`GET_LOCK`）里跑。** 网关与调度器两个进程启动时
 * 各跑一遍本函数，同时起的话两边会同时走到同一份幂等迁移：`SELECT COUNT(*) FROM
 * information_schema.COLUMNS` 判「列不存在」与随后的 `ALTER TABLE ADD COLUMN` 之间
 * 有一个窗口，另一个进程的 ALTER 恰好落在窗口里，这边就撞 `Duplicate column`
 * 直接 fatal 退出（2026-09-03 迁移 011 上线时网关就是这么死的一次）。
 * 幂等只保证「先后跑两遍」没事，保证不了「同时跑两遍」——那要靠互斥。
 *
 * 锁名按**当前库名**派生（`mde_mig_` + 库名的 SHA2 前 40 位，48 字符，在 MySQL
 * 64 字符的锁名上限之内）：`GET_LOCK` 是服务器级的，不按库分；不带库名的话，
 * 同一台 MySQL 上并行跑测试的几十个测试库会排成一队，各等前一个建完库。
 * 锁是**会话级**的，所以它和迁移语句必须在同一条连接上——这也是本函数只用一条
 * 连接的第二个理由。`finally` 里先 `RELEASE_LOCK` 再归还连接：连接断开锁也会自动
 * 释放，但归还回池的连接不会断开，不显式释放的话锁会跟着这条连接活到池关闭。
 *
 * 拿不到锁（`lockTimeoutSec` 内另一个进程一直没跑完）就**抛**，不静默跳过：跳过等于
 * 在另一个进程还没建完表的时候就开始服务请求。缺省 120 秒——本地实测一整套迁移
 * 2.6–6.8 秒，留 20 倍余量给慢磁盘；测试里把它调小来验证超时路径。
 */
export const MIGRATION_LOCK_TIMEOUT_SEC = 120

/**
 * 锁名的 SQL 表达式（不是字面量：锁名要在服务器上按 `DATABASE()` 现算）。
 * 导出给测试用 `IS_FREE_LOCK(...)` 核对锁确实释放了；生产代码只在本文件用。
 */
export const MIGRATION_LOCK_NAME_SQL = "CONCAT('mde_mig_', LEFT(SHA2(DATABASE(), 256), 40))"

export interface RunMigrationsOptions {
  /** 等锁最多多少秒，缺省 `MIGRATION_LOCK_TIMEOUT_SEC` */
  lockTimeoutSec?: number
}

export async function runMigrations(pool: Pool, opts: RunMigrationsOptions = {}): Promise<void> {
  const dir = `${import.meta.dir}/../../migrations`
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const lockTimeoutSec = opts.lockTimeoutSec ?? MIGRATION_LOCK_TIMEOUT_SEC

  const conn = await pool.getConnection()
  let locked = false
  try {
    // GET_LOCK：1 = 拿到，0 = 等到超时还没拿到，NULL = 出错（比如锁名非法）。
    // 三种都要分开说：0 是「另一个进程还在跑迁移」，NULL 是「这条路本身坏了」
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT GET_LOCK(${MIGRATION_LOCK_NAME_SQL}, ?) AS got`,
      [lockTimeoutSec],
    )
    const got = rows[0]?.got
    if (got === null || got === undefined) {
      throw new Error('迁移锁 GET_LOCK 返回 NULL：MySQL 没能建这把锁，迁移没有开始')
    }
    if (Number(got) !== 1) {
      throw new Error(
        `等迁移锁 ${lockTimeoutSec} 秒没等到：另一个进程（网关或调度器）正在这个库上跑迁移还没跑完。` +
          '本进程没有开始任何迁移，也不能在别人建表的半路上开始服务，请稍后重启',
      )
    }
    locked = true

    for (const name of files) {
      const sql = await Bun.file(`${dir}/${name}`).text()
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      for (const stmt of statements) {
        await conn.query(stmt)
      }
    }
  } finally {
    // 先放锁再还连接。RELEASE_LOCK 本身失败（连接已经断了之类）不该盖掉迁移
    // 真正的错误：连接一断锁自动没了，吞掉这一个异常不会让锁泄漏
    if (locked) {
      try {
        await conn.query(`SELECT RELEASE_LOCK(${MIGRATION_LOCK_NAME_SQL})`)
      } catch {
        /* 见上 */
      }
    }
    conn.release()
  }
}
