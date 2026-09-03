import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Pool } from './db'

/**
 * 采集程序（`service_accounts` 表）的控制台侧读写（阶段 4 · T7）。
 *
 * ## 为什么现在才有这个 store
 *
 * 这张表此前只有两个访问点：`src/store/auth.ts` 的 `findServiceAccount`（认证路径，
 * 要读 `secret_hash`）和 `scripts/seed-dev.ts` 里手写的那段 SQL（建号）。spec §4.5 的
 * 「接入新程序」把建号搬进了控制台，于是那段手写 SQL 需要一个有测试、有类型的家。
 *
 * ## 一、读侧的返回值里**没有** `secret_hash` 这个字段
 *
 * 不是「记得别下发」，是**类型上不存在**：`ServiceProgram` 没有这个键，SELECT 也不取
 * 这一列。凭据哈希只有认证路径（`src/auth/service.ts` → `AuthStore.findServiceAccount`）
 * 需要，控制台这一侧从头到尾用不上它。
 *
 * 靠 handler 里一句「passwordHash 绝不出现在响应里」的注释来防（`handlers/console/auth.ts`
 * 的 listAccounts 就是那么写的）在只有一个调用点时够用，但采集授权页会有列表、详情、
 * 向导好几个出口，每个出口都记得挑字段是靠不住的。**在 store 这一层把它摘干净，
 * 下游想漏也漏不出去。**
 *
 * ## 二、`create` 撞 id 时返回 false，**绝不 UPSERT**
 *
 * `seed-dev.ts` 用的是 `ON DUPLICATE KEY UPDATE secret_hash = VALUES(secret_hash)`，
 * 那对一个「重跑即轮换」的开发脚本是对的行为。**控制台这条路上是错的**：
 * 管理员在向导里填了一个已经存在的 id，UPSERT 会把那个**正在跑的采集程序**的凭据
 * 悄悄换掉——旧凭据当场失效、对接方的定时任务开始 401，而管理员那边显示的是
 * 「接入成功，这是你的新凭据」。谁都不会把两件事联系起来。
 *
 * 所以这里靠主键冲突挡回去，由 handler 报 409。**轮换凭据是另一个动作**，
 * 该有自己的端点和自己的审计记录，不能是「建号恰好撞了名字」的副作用。
 *
 * ## 三、`auto_grant_asset_types` 读到坏 JSON 时**抛**，不落任何一侧默认值
 *
 * 这一列（migrations/011）只有两个合法形态：NULL = 不额外限制，非空数组 = 白名单。
 * 坏数据（不是数组、不是合法 JSON）没有一个安全的兜底可落：
 *
 *   - 折成 `null` 是**静默放宽**——本来只该授权 AI 纪要的程序，从此按规则放行的
 *     全部八类自动授权出去，两边界面都显示「已开自动授权」，谁都看不出变宽了
 *   - 折成 `[]` 更糟：自动授权轮会照着它写出一批**资产范围为空**的真授权行，
 *     那些行一类资产都取不到，却又满足「已有生效授权」于是永远挡住这场会议
 *     日后被正确地自动授权。一次读侧的兜底变成了一批不可逆的错误写入
 *
 * 所以与 `store/grants.ts` 的 `parseAssetTypes` 同一个口径：**抛**。本模块自己只写
 * 规范化过的键数组，出现坏数据意味着库外有别的写入者或数据损坏，那是该被看见的事故。
 * 代价是自动授权那一轮整轮 failed（`job_runs` 一行 failed + 一条 `__round__` 失败项）、
 * 采集授权页 500——两者都响亮，而响亮正是这里要的：这一列决定着往授权表里写什么。
 */

/**
 * 一个采集程序，控制台视角。
 *
 * 与 `src/store/auth.ts` 的 `ServiceAccount` 是同一张表的两个投影，故意不复用：
 * 那一个带 `secretHash`（认证要）、这一个不带（控制台不要）。合并成一个类型的话，
 * 「不下发哈希」就重新变成一件每个调用点各自记得的事。
 */
export interface ServiceProgram {
  /** 也是采集权限规则（allow 栈）的主体值，见 `scripts/seed-dev.ts` 的文件头 */
  id: string
  name: string
  /** 这个程序调腾讯 API 与留痕时的操作者身份。**不参与策略判定** */
  tmUserId: string
  enabled: boolean
  /** unix 秒；null = 不过期 */
  expiresAt: number | null
  createdAt: number
  /**
   * 开没开**程序级自动授权**（方案 2）：开了之后由后台任务「自动授权」把规则放行、
   * 文件还在本地、尚无生效授权、且从未被人工撤销过的会议真的写进 `meeting_grants`。
   *
   * 它不改任何判定——清单、网关闸门、审计、撤销全部原样能用，只是多了一个
   * 「系统代为授权」的来源。`enabled = 0` 时整个程序跳过：停用 = 先别取，
   * 不该在停用期间替它堆授权。
   */
  autoGrant: boolean
  /**
   * 自动写出去的那些授权行的资产范围。**两态，不是三态**：
   * `null` = 不额外限制（以采集权限规则的判定为准）；非空数组 = 白名单（八类资产键）。
   *
   * `[]` **不允许存进来**（写侧 400，见 `handlers/console/grants.ts` 的 patchProgram）：
   * 「什么都不授权的自动授权」写出来的每一行都是取不到任何东西的空授权，
   * 而那些行随后还会挡住这场会议将来被正确地自动授权。
   *
   * 改这个范围**只对之后写出去的授权生效**，已经写出去的授权行一个字都不改——
   * 要改那些去会议记录页。
   */
  autoGrantAssetTypes: string[] | null
}

export interface ProgramsStore {
  /** 全部采集程序，顺序稳定（见实现里的 ORDER BY 注释）。spec §4.5 一张卡片一个 */
  list(): Promise<ServiceProgram[]>
  find(id: string): Promise<ServiceProgram | null>
  /**
   * 接入新程序。**id 已存在时返回 false 且一个字节都不改**（见文件头第二节）。
   *
   * 传进来的是**哈希**不是明文：明文只在 handler 那一次响应里出现，不进这一层，
   * 也就不可能被哪个日志或异常栈捎带出去。
   */
  create(input: {
    id: string
    name: string
    secretHash: string
    tmUserId: string
    expiresAt: number | null
    now: number
  }): Promise<boolean>
  /**
   * 停用 / 启用一个程序（阶段 5 · A8，spec §11 缺口 4）。
   * 返回是否真的改到了一行——id 不存在时 false，由 handler 报 404。
   *
   * **停用不动它的授权。** 停用是一个可逆动作，连带删授权会让「停用再启用」
   * 变成一次不可逆的数据丢失（几十场逐会议授权没有地方可以恢复）。
   * 「停用之后取不到数据」由 `src/policy/access.ts` 的 AccessGate 保证，
   * 它在读规则和改写**之前**就因 `enabled = 0` 拒绝。
   */
  setEnabled(id: string, enabled: boolean): Promise<boolean>
  /**
   * 轮换凭据（阶段 5 · A8，spec §11 缺口 4）。返回是否真的改到了一行。
   *
   * 传进来的是**哈希**不是明文，与 `create` 同一个理由：明文只在 handler 那一次
   * 响应里出现，不进这一层，也就不可能被哪个日志或异常栈捎带出去。
   *
   * **没有配套的"再看一次"方法，也不会有。** 库里只有哈希，服务端此后无从还原
   * ——那正是哈希存储的意义。想找回只能再轮换一次。
   */
  rotateSecret(id: string, secretHash: string): Promise<boolean>
  /**
   * 开关程序级自动授权，并设定自动写出去的授权行的资产范围（方案 2）。
   * 返回是否真的改到了一行——id 不存在时 false，由 handler 报 404。
   *
   * `assetTypes`：`null` = 不额外限制（以规则判定为准），非空数组 = 白名单。
   * **`[]` 不该走到这里**：它在 handler 那一层就被 400 挡回去了（写出来的每一行
   * 都是取不到任何东西的空授权，还会挡住这场会议日后被正确地自动授权）。
   *
   * **两列一起写。** 分成两个方法的话，「关掉开关」与「改范围」之间会出现一个
   * 「开着、范围却是上一轮的」的中间态，而中间那一刻自动授权轮可能正好跑过去。
   *
   * **关掉开关不收回已有授权**：这个方法只碰 `service_accounts` 这一行，
   * `meeting_grants` 一个字都不动。可逆动作不该带不可逆后果——要收回请去
   * 会议记录页批量收回。同理，改范围只对**之后**写出去的授权生效。
   */
  setAutoGrant(id: string, input: { enabled: boolean; assetTypes: string[] | null }): Promise<boolean>
}

/** SELECT 列表里**没有 secret_hash**，这是本模块的核心约束，不是省了一列 */
const COLS =
  'id, name, tm_userid, enabled, expires_at, created_at, auto_grant, auto_grant_asset_types'

interface ProgramRow extends RowDataPacket {
  id: string
  name: string
  tm_userid: string
  enabled: number
  expires_at: number | null
  created_at: number
  auto_grant: number
  auto_grant_asset_types: unknown
}

/**
 * 读 `auto_grant_asset_types` 这一 JSON 列。**坏数据抛，不落任何一侧默认值**，
 * 完整理由见文件头第三节（两侧的兜底一个是静默放宽、一个会写出一批挡路的空授权）。
 *
 * 与 `store/grants.ts` 的 `parseAssetTypes` 同一段逻辑、同一个口径。没有把两处合成
 * 一个工具函数：那边的三态里 `[]` 是**合法且有意义**的一态（「什么都不授权」），
 * 这边 `[]` 是不该存在的值；共用一个函数会让哪天有人给它加一句「空数组归一化成 X」
 * 时，同时改掉两种不同的语义。
 */
function parseAutoGrantAssetTypes(value: unknown, where: string): string[] | null {
  if (value === null || value === undefined) return null

  let parsed: unknown = value
  if (typeof value === 'string') {
    // mysql2 对 JSON 列通常已经解析好，但驱动版本差异下可能返回字符串
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`auto_grant_asset_types is not valid JSON (${where}): ${value}`)
    }
  }
  if (parsed === null) return null
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
    throw new Error(
      `auto_grant_asset_types must be NULL or a JSON array of strings (${where}), ` +
        `got: ${JSON.stringify(parsed)}`,
    )
  }
  return parsed as string[]
}

function mapRow(r: ProgramRow): ServiceProgram {
  return {
    id: r.id,
    name: r.name,
    tmUserId: r.tm_userid,
    // TINYINT(1) 过来是 0/1。原样下发会让前端拿到一个数字当布尔用，
    // 而 `0` 在 JSON 里既不是 false 也不是 true（`!0` 才是）
    enabled: Number(r.enabled) !== 0,
    // BIGINT 在部分驱动配置下是字符串；expires_at 会参与 `now >= expiresAt` 比较，
    // 字符串比较出来的结果是另一回事
    expiresAt: r.expires_at === null ? null : Number(r.expires_at),
    createdAt: Number(r.created_at),
    // 同 enabled：TINYINT(1) 的 0/1 换成真布尔。这一个更要紧——自动授权轮按它决定
    // 要不要替这个程序往授权表里写行，一个数字 0 在 `if (p.autoGrant)` 里是假，
    // 但下发到前端的开关上就变成了一个说不清开没开的值
    autoGrant: Number(r.auto_grant) !== 0,
    autoGrantAssetTypes: parseAutoGrantAssetTypes(r.auto_grant_asset_types, `service_accounts#${r.id}`),
  }
}

function isDuplicateEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY'
}

export function createProgramsStore(pool: Pool): ProgramsStore {
  return {
    async list() {
      // created_at 升序 = 接入顺序，与 §4.5 卡片从上到下的阅读顺序一致；
      // 同一秒建的两个程序（脚本批量接入时很常见）再按 id 定序——不加第二键的话，
      // 列表顺序会跟着执行计划变，管理员每刷新一次卡片就换个位置
      const [rows] = await pool.execute<ProgramRow[]>(
        `SELECT ${COLS} FROM service_accounts ORDER BY created_at ASC, id ASC`,
      )
      return rows.map(mapRow)
    },

    async find(id) {
      const [rows] = await pool.execute<ProgramRow[]>(
        `SELECT ${COLS} FROM service_accounts WHERE id = ?`,
        [id],
      )
      return rows[0] ? mapRow(rows[0]) : null
    },

    async create(input) {
      try {
        const [res] = await pool.execute<ResultSetHeader>(
          // auto_grant / auto_grant_asset_types **不在列表里**，走库里的默认值
          // （0 / NULL，见 migrations/011）。新接进来的程序不该自带一个会往授权表里
          // 写行的开关——接入向导里没有这一步，管理员没有对它做过任何表示
          `INSERT INTO service_accounts
             (id, name, secret_hash, tm_userid, enabled, expires_at, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [input.id, input.name, input.secretHash, input.tmUserId, input.expiresAt, input.now],
        )
        return res.affectedRows > 0
      } catch (err) {
        // 主键冲突是**预期内**的一种结果（管理员填了个已存在的 id），不是故障：
        // 返回 false 让 handler 报 409。其余错误照抛——把它们一起吞成 false，
        // 会让一次真正的写库失败显示成「这个 id 已被占用」，管理员换个名字再试，
        // 然后再失败一次，永远查不到原因
        if (isDuplicateEntry(err)) return false
        throw err
      }
    },

    async setEnabled(id, enabled) {
      const [res] = await pool.execute<ResultSetHeader>(
        `UPDATE service_accounts SET enabled = ? WHERE id = ?`,
        [enabled ? 1 : 0, id],
      )
      // affectedRows 而不是 changedRows：把一个已经停用的程序再停用一次，
      // changedRows 是 0 而这一行确实存在。调用方要区分的是「有没有这个程序」，
      // 不是「值有没有变」——用 changedRows 会让重复点一次停用报 404
      return res.affectedRows === 1
    },

    async rotateSecret(id, secretHash) {
      const [res] = await pool.execute<ResultSetHeader>(
        `UPDATE service_accounts SET secret_hash = ? WHERE id = ?`,
        [secretHash, id],
      )
      // 只写 secret_hash 一列：enabled / expires_at / name 一个都不碰。
      // 轮换凭据不该顺手把一个停用的程序启用回来
      return res.affectedRows === 1
    },

    async setAutoGrant(id, input) {
      const [res] = await pool.execute<ResultSetHeader>(
        `UPDATE service_accounts SET auto_grant = ?, auto_grant_asset_types = ? WHERE id = ?`,
        [
          input.enabled ? 1 : 0,
          // `null` → SQL NULL（不额外限制）。数组序列化成 JSON 文本，与
          // meeting_grants.asset_types 的写法一致
          input.assetTypes === null ? null : JSON.stringify(input.assetTypes),
          id,
        ],
      )
      // affectedRows 而不是 changedRows，与 setEnabled 同一个理由：
      // 把同一个开关重复设成同一个值时 changedRows 是 0，而那一行确实存在
      return res.affectedRows === 1
    },
  }
}
