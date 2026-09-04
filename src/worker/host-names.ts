import { USER_DETAIL_QUOTA_KEY, type TencentClient } from '../tencent/client'
import { TencentApiError } from '../tencent/errors'
import type { MeetingHostIdsStore, TmUserRow, TmUsersStore } from '../store/tm-users'

/**
 * 主持人姓名同步（`tm_users` 的写侧）。
 *
 * 控制台会议列表的主持人一列此前是「未知主持人 · …尾号」——`meetings.host_userid`
 * 是一串 32 位机器 id，而唯一的翻译来源 `identity_map` 在本部署是空表、没有任何
 * 自动填充路径。姓名的真正出处是腾讯会议自己的成员接口
 * `GET /v1/users/{userid}`，本文件就是把那个接口的答案搬进 `tm_users` 的那一段。
 *
 * 表的语义（尤其 `username IS NULL` 为什么不是「还没查」）见
 * `migrations/012_tm_users.sql` 的表头。读侧见 `src/store/console-meetings.ts`
 * 的 `loadHostNames`。
 *
 * ## 三条规矩
 *
 * 1. **一轮最多问 `MAX_PER_ROUND` 个。** 这是姓名同步，不在任何人等待的路径上，
 *    而它与下载、归档共用同一个腾讯令牌桶。一轮把配额吃光的代价不是「姓名慢了」，
 *    是**下载被限流拖慢**——190310 触发的 `converge()` 是全局降速。历史数据靠
 *    多跑几轮补齐，或者跑一次 `scripts/sync-host-names.ts`。
 * 2. **查过的一天内不重查，「查无此人」也算查过。** 离职回收掉的账号、跨企业来
 *    开会的外部成员会永远查不到，不记一笔的话它们每一轮都在吃配额，而答案不会变。
 *    这一笔就是 `username = NULL` 那一行（见表头）。
 * 3. **分不清是不是「这个人不存在」时，什么都不写。** 限流、网络抖动、权限没开
 *    统统本轮跳过，下一轮再来。写错方向的代价是不对称的：漏写只是这一轮没补上
 *    姓名，写错（把一次限流记成「查无此人」）会让一个真实存在的人整整一天
 *    显示成「未知主持人」，而且没有任何地方会报错。
 */

/**
 * 一轮最多问几个成员。
 *
 * 50 这个数是按「一轮至多占掉成员详情接口约 50 秒的配额」定的
 * （`ENDPOINT_QUOTAS_PER_MINUTE` 给它 60/min），而任务一是 15 分钟一轮——
 * 也就是任意时刻这条同步最多占掉这个接口 6% 的时间片，剩下的留给别的。
 *
 * 调大之前先想清楚它挤的是谁：同一个令牌桶后面排着录制文件的下载。
 */
export const MAX_PER_ROUND = 50

/**
 * 查过的多久之内不再问（秒）。
 *
 * 一天。姓名不是每天都在变的东西，而这个值直接决定同步的稳态成本：公司有 N 个
 * 主持人时，稳态每天问 N 次接口。取一小时的话，同一批人一天要问 24 遍，
 * 换回来的是「有人改名后早几个小时更新」——那不值。
 */
export const STALE_SEC = 86_400

/**
 * 「腾讯说没有这个成员」的错误码，命中它才会写 `username = NULL`。
 *
 * **这个集合是保守的，宁可漏不可错**（规矩 3）。目前只有一个成员：4049
 * 「记录不存在」——`errors.ts` 已经认得它，而且把它归成 `asset_permanent`，
 * 也就是**不重试、当场抛**，正好是我们想要的行为（对一个不存在的 id 重试 5 次
 * 纯属浪费配额）。
 *
 * 集合之外的错误一律按「这一轮没查成」处理，日志里带上错误码。**这不会静默
 * 出错**：真实的「查无此人」若是别的码，表现是那些 id 每轮都被重新查一遍
 * （因为始终没有落行），日志里会连续出现同一个码——那时把它加进这个集合即可，
 * 一行改动。反过来，把一个猜的码加进来而它其实表示「限流」，表现是一批真实
 * 存在的人被写成 NULL、整天显示「未知主持人」，而且没有任何东西会报错。
 *
 * HTTP 404 也按「没有这个成员」处理，见 `classifyFailure`：那是 REST 语义本身，
 * 不依赖任何一个具体错误码。
 */
export const USER_ABSENT_ERROR_CODES: ReadonlySet<number> = new Set([4049])

/**
 * `GET /v1/users/{userid}` 的响应里我们要的那一个字段。
 *
 * 只声明 `username`：这个接口还返回 `status`、`update_time`、手机号等等，
 * 声明了就早晚会有人存进库——而那些是通讯录数据，本功能一个字节都不需要。
 */
interface RawUserDetail {
  username?: string
}

export interface HostNamesDeps {
  /** 只用 `get`：本文件不发任何写请求 */
  client: Pick<TencentClient, 'get'>
  /** `cfg.tencent.operatorId`。成员接口按企业管理员身份查，与其它接口同一口径 */
  operatorId: string
  store: TmUsersStore
  /** 「有哪些主持人要认」的枚举源，见 `MeetingHostIdsStore` */
  meetings: MeetingHostIdsStore
  /** unix 秒。冻结的一刻，整轮共用——落库的 `fetched_at` 与判新鲜用的是同一个数 */
  now: number
  /** 缺省 `console.log`。传进来是为了让测试不打印，也让脚本能加前缀 */
  log?: (line: string) => void
  /** 本轮上限，缺省 `MAX_PER_ROUND`。回填脚本按轮循环，不改这个值 */
  maxPerRound?: number
  /** 「查过的多久内不重查」，缺省 `STALE_SEC`。测试用它钉边界 */
  staleSec?: number
}

/** 一轮的结果。四个计数分开，因为需要人做的事完全不同 */
export interface HostNamesRound {
  /** `meetings` 表里去重后的主持人 id 总数（空串与 NULL 已排除） */
  hosts: number
  /** 其中该去问腾讯的（既没查过、或查过但过期了）。可能远大于本轮上限 */
  due: number
  /** 本轮真的发出去的请求数 */
  attempted: number
  /** 问到了姓名 */
  named: number
  /** 腾讯说没有这个成员，落了一行 `username = NULL` */
  absent: number
  /** 没问成（限流、网络、权限）。**没写表**，下一轮还会再问 */
  failed: number
  /**
   * 提前收工的原因，没有提前收工时为 null。
   *
   * 两种：权限一类的致命错误（每个 id 都会同样失败，问下去只是把配额烧完），
   * 以及 190310 调用超限（继续问只会让全局令牌桶收敛得更狠，连累下载）。
   */
  stoppedEarly: string | null
}

/** 这一个 id 这一次的结局 */
type Outcome =
  | { kind: 'named'; username: string }
  /** 腾讯明确说没有这个人，或者返回了一个没有名字的人 */
  | { kind: 'absent'; why: string }
  /** 没问成，不写表 */
  | { kind: 'failed'; why: string }
  /** 没问成，而且**整轮别再问了** */
  | { kind: 'stop'; why: string }

/**
 * 一次失败的分类。规矩 3 的落点：只有明确说「没有这个成员」的那一类才写 NULL。
 */
function classifyFailure(err: unknown): Outcome {
  if (!(err instanceof TencentApiError)) {
    // fetch 抛出的网络错误、JSON 解析失败之类。**一定不是**「这个人不存在」
    return { kind: 'failed', why: err instanceof Error ? err.message : String(err) }
  }
  if (USER_ABSENT_ERROR_CODES.has(err.errorCode) || err.httpStatus === 404) {
    return { kind: 'absent', why: `腾讯返回 ${err.errorCode}（http ${err.httpStatus}）` }
  }
  if (err.requiresBackoff) {
    // 190310：这个接口的配额已经超了。剩下的 id 继续问只会让令牌桶收敛得更狠,
    // 而收敛是全局的——排在后面的是录制文件的下载
    return { kind: 'stop', why: `调用超限（${err.errorCode}），本轮不再问，下一轮继续` }
  }
  if (err.classification === 'fatal') {
    // 权限没开、签名不对、账号没权限：每一个 id 都会以同样的方式失败。
    // 问下去唯一的效果是把配额烧完，而答案在第一个 id 上就已经知道了
    return { kind: 'stop', why: `${err.message}——每个成员都会同样失败，本轮不再问` }
  }
  return { kind: 'failed', why: err.message }
}

async function fetchOne(deps: HostNamesDeps, tmUserId: string): Promise<Outcome> {
  try {
    const res = await deps.client.get<RawUserDetail>(
      // userid 是腾讯生成的 base64 串（含 `_` 与 `-`），理论上不需要转义，
      // 但它来自数据库、而这里是在拼 URL 路径——不转义就是把库里的内容当路径用
      `/v1/users/${encodeURIComponent(tmUserId)}`,
      { operator_id: deps.operatorId, operator_id_type: 1 },
      // path 带变量，按 path 匹配不上任何配额，必须指到常量键上（见 client.ts）
      { quotaKey: USER_DETAIL_QUOTA_KEY },
    )
    const username = (res.username ?? '').trim()
    if (username === '') {
      // 200 但没有名字。**与「查无此人」同一个处理**：我们问过了，答案是
      // 「不知道他叫什么」，一天之内不必再问一遍。写空串是不行的——那会让读侧
      // 把一行空白当成已知姓名渲染出来
      return { kind: 'absent', why: '腾讯返回了这个成员，但没有 username' }
    }
    return { kind: 'named', username }
  } catch (err) {
    return classifyFailure(err)
  }
}

/**
 * 补一轮主持人姓名。
 *
 * 调用方：定时任务一（`scheduler.ts` 的 fetchRound，`runFetchRound` 之后）与
 * 回填脚本 `scripts/sync-host-names.ts`。**它自己不吞异常也不重试整轮**——
 * 库炸了就往上抛，由调用方决定这算不算一轮失败（调度器那边不算，见接线处的注释）。
 */
export async function syncHostNames(deps: HostNamesDeps): Promise<HostNamesRound> {
  const log = deps.log ?? ((line: string): void => console.log(line))
  const maxPerRound = deps.maxPerRound ?? MAX_PER_ROUND
  const staleSec = deps.staleSec ?? STALE_SEC

  const hosts = await deps.meetings.listHostUserIds()
  const round: HostNamesRound = {
    hosts: hosts.length,
    due: 0,
    attempted: 0,
    named: 0,
    absent: 0,
    failed: 0,
    stoppedEarly: null,
  }
  if (hosts.length === 0) return round

  const due = await deps.store.listMissing(hosts, deps.now, staleSec)
  round.due = due.length
  if (due.length === 0) return round

  const batch = due.slice(0, maxPerRound)
  const rows: TmUserRow[] = []

  for (const tmUserId of batch) {
    round.attempted++
    const outcome = await fetchOne(deps, tmUserId)
    if (outcome.kind === 'named') {
      round.named++
      rows.push({ tmUserId, username: outcome.username, fetchedAt: deps.now })
      continue
    }
    if (outcome.kind === 'absent') {
      round.absent++
      // NULL = 查过、腾讯说没有这个人。这一行是「一天内别再问」的唯一载体
      rows.push({ tmUserId, username: null, fetchedAt: deps.now })
      continue
    }
    // 剩下两种都不写表：分不清是不是「这个人不存在」时什么都不写（规矩 3）
    round.failed++
    log(`主持人姓名同步：${tmUserId} 这一轮没问成——${outcome.why}`)
    if (outcome.kind === 'stop') {
      round.stoppedEarly = outcome.why
      break
    }
  }

  // 已经问到的先落库，**包括提前收工的那一轮**：前面几个的答案是真的，
  // 丢掉它们等于下一轮再问一遍同样的问题
  await deps.store.upsertMany(rows)

  log(
    `主持人姓名同步：主持人 ${round.hosts} 人 · 待补 ${round.due} · ` +
      `本轮问了 ${round.attempted}（查到 ${round.named} · 查无此人 ${round.absent} · 失败 ${round.failed}）` +
      (round.stoppedEarly === null ? '' : ` · 提前收工：${round.stoppedEarly}`),
  )
  return round
}
