#!/usr/bin/env bun
/**
 * 部署前自检脚本（Task 16）。
 *
 * 用法：
 *   bun scripts/preflight.ts [--sample-user <企微 userid>] [--sample-email <邮箱>]
 *
 * 依次检查：
 *   1   配置完整性        loadConfig 不抛错
 *   2   数据库连通性      SELECT 1
 *   2b  数据库字符集      必须 utf8mb4 / utf8mb4_unicode_ci
 *   2c  数据库版本        >= 8.0.19
 *   3   腾讯凭证与签名    调 GET /v1/corp/records 取最近 1 天
 *   4   账号版本          由第 3 步的成败推出（免费版/专业版会在第 3 步失败）
 *   5   企微凭证          调 gettoken
 *   6   身份映射策略      用 --sample-user 实测能否解析出腾讯会议 userid
 *
 * 对应用户故事 US-1.1（确认接入条件）与 US-1.4（确认身份映射可用）。详见
 * docs/deploy.md。
 *
 * 设计原则：任何一步失败都不能让脚本崩溃退出——运维需要一次性看到全部问题，
 * 而不是修一个、重跑一次、又冒出下一个。因此每一步都在自己的 try/catch 内
 * 完成，异常一律转换为该步骤的 FAIL/SKIP 结果，绝不向上抛出中断整个脚本。
 *
 * PASS / FAIL / SKIP 的区分：
 *   PASS  该项已被真实验证为符合要求
 *   FAIL  已联系到目标系统，但收到的是一个明确的错误（配置/权限/版本问题），
 *         需要人工修复
 *   SKIP  受限于当前运行环境（缺少出网权限、未提供必要参数、依赖的前置步骤
 *         未通过）而**无法**完成验证——不代表配置一定有问题，但也不能当作
 *         "已验证通过"，上线前必须在具备条件的环境中重新运行本脚本补齐。
 */

import type { RowDataPacket } from 'mysql2'
import { loadConfig, type AppConfig, type IdentityStrategy } from '../src/config'
import { createPool, type Pool } from '../src/store/db'
import { createTencentClient } from '../src/tencent/client'
import { createCorpRecordsApi } from '../src/tencent/records'
import { createAuthStore } from '../src/store/auth'
import { createIdentityMapper } from '../src/auth/identity'
import { TencentApiError } from '../src/tencent/errors'

type Status = 'pass' | 'fail' | 'skip'

interface StepResult {
  id: string
  title: string
  status: Status
  detail: string
  hint?: string
}

const LABEL: Record<Status, string> = { pass: '[PASS]', fail: '[FAIL]', skip: '[SKIP]' }
const results: StepResult[] = []

function record(id: string, title: string, status: Status, detail: string, hint?: string): void {
  const r: StepResult = { id, title, status, detail, hint }
  results.push(r)
  console.log(`${LABEL[status]} ${id}. ${title}`)
  console.log(`       ${detail}`)
  if (hint) console.log(`       修复指引: ${hint}`)
  console.log('')
}

function skipStep(id: string, title: string, reason: string): void {
  record(id, title, 'skip', reason)
}

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------

interface Args {
  sampleUser: string | null
  sampleEmail: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sampleUser: null, sampleEmail: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--sample-user') {
      args.sampleUser = argv[++i] ?? null
    } else if (arg === '--sample-email') {
      args.sampleEmail = argv[++i] ?? null
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp(): void {
  console.log(`用法: bun scripts/preflight.ts [选项]

选项:
  --sample-user <企微 userid>    用一个真实的企微 userid 实测身份映射策略（第 6 项）
  --sample-email <邮箱>          IDENTITY_STRATEGY=email 时，配合 --sample-user 一起提供
  -h, --help                     显示本帮助信息

所需环境变量见 .env.example；使用说明与常见错误码见 docs/deploy.md。`)
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 给 fetch 包一层超时——本脚本可能在没有出网权限的环境里运行，不能无限期挂起 */
function withTimeout(base: typeof fetch, timeoutMs: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await base(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }) as typeof fetch
}

// ---------------------------------------------------------------------------
// 第 1 项：配置完整性
// ---------------------------------------------------------------------------

function stepConfig(): AppConfig | null {
  try {
    const cfg = loadConfig(process.env)
    record('1', '配置完整性', 'pass', 'loadConfig 成功加载，全部必填环境变量均已提供且通过格式校验。')
    return cfg
  } catch (err) {
    record(
      '1',
      '配置完整性',
      'fail',
      `loadConfig 抛出异常: ${errMessage(err)}`,
      '对照 .env.example 逐项核对：缺失字段会在错误信息里明确指出字段名；' +
        'IDENTITY_STRATEGY 必须是 direct / email / table 三者之一。',
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// 第 2 / 2b / 2c 项：数据库
// ---------------------------------------------------------------------------

interface CharsetRow extends RowDataPacket {
  cs: string | null
  co: string | null
}

interface VersionRow extends RowDataPacket {
  v: string
}

async function stepCharset(pool: Pool): Promise<void> {
  try {
    const [rows] = await pool.query<CharsetRow[]>(
      'SELECT @@character_set_database AS cs, @@collation_database AS co',
    )
    const cs = rows[0]?.cs ?? ''
    const co = rows[0]?.co ?? ''

    // 硬要求只有一条：字符集必须是 utf8mb4。会议主题里的中文与 emoji 是 4 字节
    // 字符，MySQL 历史默认的 utf8（3 字节）会插入失败。
    //
    // 排序规则只要与字符集配套（utf8mb4_*）即可，**不限定具体变体**：
    // MySQL 8.0 建库时的默认值是 utf8mb4_0900_ai_ci（基于 Unicode 9.0，比
    // utf8mb4_unicode_ci 的 Unicode 4.0 更新），5.7 时代才默认 utf8mb4_general_ci。
    // 它影响的是比较与排序语义，不影响「能不能存下 4 字节字符」——本项目没有
    // 依赖特定排序语义的查询。早先把 utf8mb4_unicode_ci 写成硬判据，会让任何
    // 按 MySQL 8 默认建的库（含阿里云 RDS）判 FAIL，且修复指引直接建议
    // 「重建数据库」——一个会误导人去动生产库的假红。
    if (cs === 'utf8mb4' && co.startsWith('utf8mb4_')) {
      const note = co === 'utf8mb4_unicode_ci' ? '' : '（非 utf8mb4_unicode_ci，但同属 utf8mb4，不影响 4 字节字符存储）'
      record('2b', '数据库字符集', 'pass', `字符集 ${cs} / 排序规则 ${co}，符合要求${note}。`)
    } else {
      record(
        '2b',
        '数据库字符集',
        'fail',
        `当前字符集为 "${cs || '未知'}" / 排序规则为 "${co || '未知'}"，字符集必须是 utf8mb4。`,
        '会议主题里的中文与 emoji 属于 4 字节字符，MySQL 默认的 utf8（3 字节）会插入失败——' +
          '测试数据多为 ASCII，不会提前暴露这个问题，真实数据上线后才会报错。' +
          '修复：重建数据库为 `CREATE DATABASE ... CHARACTER SET utf8mb4`（排序规则用该版本默认值即可）；' +
          '阿里云 RDS 还需确认实例参数 character_set_server = utf8mb4。详见 docs/deploy.md「MySQL 准备」。',
      )
    }
  } catch (err) {
    record('2b', '数据库字符集', 'fail', `查询字符集失败: ${errMessage(err)}`)
  }
}

async function stepVersion(pool: Pool): Promise<void> {
  try {
    const [rows] = await pool.query<VersionRow[]>('SELECT VERSION() AS v')
    const version = rows[0]?.v ?? ''
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version)
    const major = match ? Number(match[1]) : 0
    const minor = match ? Number(match[2]) : 0
    const patch = match?.[3] ? Number(match[3]) : 0
    // worker 的 upsert 用 `VALUES (...) AS new` 行别名，8.0.19 才有；8.0.0 到 8.0.18 上是语法错误
    const ok = major > 8 || (major === 8 && (minor > 0 || patch >= 19))
    if (ok) {
      record('2c', '数据库版本', 'pass', `MySQL 版本 "${version}"，满足 >= 8.0.19 的要求。`)
    } else {
      record(
        '2c',
        '数据库版本',
        'fail',
        `MySQL 版本 "${version}"，低于要求的 8.0.19。`,
        '升级 MySQL 实例到 8.0.19 及以上——worker 依赖 SKIP LOCKED 与 VALUES (...) AS new 行别名。',
      )
    }
  } catch (err) {
    record('2c', '数据库版本', 'fail', `查询版本失败: ${errMessage(err)}`)
  }
}

async function stepDatabase(cfg: AppConfig): Promise<Pool | null> {
  let pool: Pool
  try {
    pool = createPool(cfg.databaseUrl)
    await pool.query('SELECT 1')
  } catch (err) {
    record(
      '2',
      '数据库连通性',
      'fail',
      `无法连接数据库: ${errMessage(err)}`,
      '检查 DATABASE_URL 中的 host / port / 用户名 / 密码是否正确；' +
        '确认目标 MySQL 实例的安全组或白名单允许来自本网关部署环境的入站连接；' +
        '确认 URL 中指定的数据库已提前创建（见 docs/deploy.md「MySQL 准备」）。',
    )
    skipStep('2b', '数据库字符集', '依赖 2 数据库连通性，未执行。')
    skipStep('2c', '数据库版本', '依赖 2 数据库连通性，未执行。')
    return null
  }

  record('2', '数据库连通性', 'pass', 'SELECT 1 执行成功。')
  await stepCharset(pool)
  await stepVersion(pool)
  return pool
}

// ---------------------------------------------------------------------------
// 第 3 / 4 项：腾讯会议凭证、签名与账号版本
// ---------------------------------------------------------------------------

function tencentErrorHint(code: number): string {
  switch (code) {
    case 9042:
      return '权限受限或鉴权失败——检查 TM_SECRET_ID / TM_SECRET_KEY 是否正确，' +
        '以及该企业自建应用是否已被授予相应的 API 调用权限。'
    case 500014:
      return '账号无权限——检查 TM_OPERATOR_ID 对应的账号（企管后台 -> 成员管理）是否具备' +
        '「管理企业录制」/「查看企业录制」权限。'
    case 190301:
      return '请求重放——检查部署服务器的系统时钟，与标准时间的偏差必须小于 5 分钟' +
        '（建议启用 NTP 时间同步）。'
    case 190303:
      return '鉴权失败——检查 TM_APP_ID 与 TM_SECRET_ID 是否正确、是否互相匹配；' +
        '若该应用未分配 SdkId，确认签名头部未错误携带 TM_SDK_ID。'
    case 190004:
      return '参数非法，属于网关自身的实现问题，请上报给开发者复核请求参数。'
    case 200001:
      return '请求头缺失必填字段，属于网关自身的实现问题，请上报给开发者复核签名头部。'
    case 190310:
      return '调用超限——已自动降速重试仍失败，请稍后重试，或调低 TM_QPS 环境变量。'
    default:
      return `未知错误码 ${code}，请对照腾讯会议开放平台文档核实` +
        '（https://cloud.tencent.com/document/product/1095）。'
  }
}

async function stepTencent(cfg: AppConfig): Promise<boolean> {
  const client = createTencentClient(cfg.tencent, {
    fetch: withTimeout(fetch, 10_000),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowMs: Date.now,
  })
  // 只要**窗口枚举**那一层：这一项探的是凭证、签名与账号权限，不该顺手拽上
  // meeting_cache（数据库连不连得上是第 1 项自己的事）。createRecordsApi 那一层
  // 多出来的只有缓存，打的还是同一个接口、同一组参数。
  const corpRecords = createCorpRecordsApi(client, cfg.tencent.operatorId)
  const now = Math.floor(Date.now() / 1000)

  try {
    // 取最近 1 天：成功即证明签名算法与账号权限均正确，不要求这个窗口里真的有会议。
    // 打的是 /v1/corp/records（企业维度）——那是网关向腾讯要会议列表的**唯一**接口，
    // worker 主路径与按会议号点名查询都走它，它要求录制管理的查看/编辑权限。
    await corpRecords.listRange(now - 86400, now)
    record(
      '3',
      '腾讯凭证与签名',
      'pass',
      '成功调用 GET /v1/corp/records（账户级会议录制列表）取最近 1 天的会议列表，签名与权限校验通过。' +
        '这是网关向腾讯要会议列表的唯一接口——全公司持续归档与按会议号点名查询都走它，' +
        '它要求账号具备录制管理的查看/编辑权限，所以这一项过了才说明全公司归档拿得到数据。',
    )
    record(
      '4',
      '账号版本',
      'pass',
      '上一步 /v1/corp/records 调用成功，说明企业账号版本满足要求（免费版/专业版会在这一步直接被拒绝）。',
    )
    return true
  } catch (err) {
    if (err instanceof TencentApiError) {
      record(
        '3',
        '腾讯凭证与签名',
        'fail',
        `调用 /v1/corp/records 失败: error_code=${err.errorCode} message="${err.apiMessage}"`,
        tencentErrorHint(err.errorCode),
      )
      record('4', '账号版本', 'fail', '上一步 /v1/corp/records 调用失败，无法确认账号版本是否满足要求。', '先修复第 3 项后重新运行本脚本。')
      return false
    }
    record(
      '3',
      '腾讯凭证与签名',
      'skip',
      `无法连接腾讯会议开放平台（${cfg.tencent.baseUrl}）: ${errMessage(err)}`,
      '这通常意味着当前运行环境没有访问公网的出站权限（例如本地开发机或未配置 NAT 网关的容器沙箱），' +
        '而不是凭证本身有问题。请在具备公网出站访问的实际部署环境中重新运行本脚本以完成该项校验。',
    )
    record('4', '账号版本', 'skip', '依赖第 3 项的调用结果，未能验证。')
    return false
  }
}

// ---------------------------------------------------------------------------
// 第 5 项：企微凭证
// ---------------------------------------------------------------------------

interface WecomTokenResponse {
  access_token?: string
  errcode?: number
  errmsg?: string
}

function wecomErrorHint(errcode: number | undefined): string {
  switch (errcode) {
    case 40013:
      return 'corpid 不正确——检查 WECOM_CORP_ID 是否与企业微信管理后台「我的企业」页面显示的企业 ID 一致。'
    case 40001:
    case 40125:
      return 'secret 不正确或已过期——检查 WECOM_SECRET 是否与自建应用详情页当前显示的 Secret 一致' +
        '（管理员重置 Secret 后旧值会立即失效）。'
    default:
      return `未知错误码 ${errcode ?? '(空)'}，请对照企业微信开放文档核实` +
        '（https://developer.work.weixin.qq.com/document/path/91039）。'
  }
}

async function stepWecom(cfg: AppConfig): Promise<void> {
  // 企微未配置 = 本次部署明确不启用扫码登录（见 config.ts 的 wecom 注释）。
  // 这是一个合法的部署形态，不是配置缺失，因此判 skip 而非 fail——
  // 一个永远红的检查会训练人忽略红色，届时真正的红也会被一起忽略。
  if (cfg.wecom === null) {
    record(
      '5',
      '企微凭证',
      'skip',
      '本部署未配置企业微信自建应用（WECOM_* 三项均未设置），扫码登录流程已停用。',
      '如需启用真人扫码登录，按 docs/deploy.md §4 配置企微自建应用并补齐 ' +
        'WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET 三项。' +
        '仅用服务账号认证的部署无需理会本项。',
    )
    return
  }

  const url =
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.wecom.corpId)}` +
    `&corpsecret=${encodeURIComponent(cfg.wecom.secret)}`

  try {
    const res = await withTimeout(fetch, 10_000)(url)
    const body = (await res.json()) as WecomTokenResponse
    if (body.access_token) {
      record('5', '企微凭证', 'pass', 'gettoken 调用成功，已取得 access_token。')
    } else {
      record(
        '5',
        '企微凭证',
        'fail',
        `gettoken 返回错误: errcode=${body.errcode ?? '未知'} errmsg="${body.errmsg ?? '未知'}"`,
        wecomErrorHint(body.errcode),
      )
    }
  } catch (err) {
    record(
      '5',
      '企微凭证',
      'skip',
      `无法连接企业微信开放平台: ${errMessage(err)}`,
      '这通常意味着当前运行环境没有访问公网的出站权限。请在具备公网出站访问的实际部署环境中重新运行本脚本。',
    )
  }
}

// ---------------------------------------------------------------------------
// 第 6 项：身份映射策略
// ---------------------------------------------------------------------------

function identityHint(strategy: IdentityStrategy): string {
  if (strategy === 'direct') {
    return '策略为 direct 时理论上不应失败（原样透传企微 userid 作为腾讯会议 userid）；' +
      '若仍失败，检查是否传入了空字符串给 --sample-user。'
  }
  if (strategy === 'table') {
    return '在 identity_map 表中为该企微用户补一行映射：\n' +
      "       INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at)\n" +
      "       VALUES ('<企微 userid>', '<对应的腾讯会议 userid>', NULL, UNIX_TIMESTAMP());"
  }
  return '在 identity_map 表中为该企微用户补一行映射，email 列填两侧一致的邮箱：\n' +
    "       INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at)\n" +
    "       VALUES ('<企微 userid>', '<对应的腾讯会议 userid>', '<邮箱>', UNIX_TIMESTAMP());"
}

async function stepIdentity(
  cfg: AppConfig,
  pool: Pool | null,
  sampleUser: string | null,
  sampleEmail: string | null,
): Promise<void> {
  if (!sampleUser) {
    record(
      '6',
      '身份映射策略',
      'skip',
      `未提供 --sample-user 参数，跳过实测（当前配置的策略为 "${cfg.identityStrategy}"）。`,
      '重新运行本脚本并带上 --sample-user <一个真实的企微 userid>' +
        '（策略为 email 时再加 --sample-email <该用户的邮箱>），用真实账号验证能否解析出腾讯会议 userid——' +
        '这正是 US-1.4 的核心诉求，不能凭假设认为策略选对了。',
    )
    return
  }

  if (cfg.identityStrategy === 'email' && !sampleEmail) {
    record(
      '6',
      '身份映射策略',
      'fail',
      'IDENTITY_STRATEGY=email 时必须同时提供 --sample-email，否则无法实测该策略。',
      '重新运行并加上 --sample-email <该企微用户的邮箱>。',
    )
    return
  }

  if (!pool) {
    record('6', '身份映射策略', 'skip', '依赖第 2 项数据库连通性，未执行。')
    return
  }

  const authStore = createAuthStore(pool)
  const mapper = createIdentityMapper(cfg.identityStrategy, {
    lookupTable: async (id) => (await authStore.lookupIdentityMap(id))?.tmUserId ?? null,
    lookupByEmail: async (email) => (await authStore.lookupIdentityByEmail(email))?.tmUserId ?? null,
  })

  try {
    const tmUserId = await mapper.toTmUserId(sampleUser, sampleEmail)
    record(
      '6',
      '身份映射策略',
      'pass',
      `策略 "${cfg.identityStrategy}" 成功将企微 userid "${sampleUser}" 解析为腾讯会议 userid "${tmUserId}"。`,
    )
  } catch (err) {
    record('6', '身份映射策略', 'fail', errMessage(err), identityHint(cfg.identityStrategy))
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function finish(): void {
  const pass = results.filter((r) => r.status === 'pass').length
  const fail = results.filter((r) => r.status === 'fail').length
  const skip = results.filter((r) => r.status === 'skip').length

  console.log(`共 ${results.length} 项：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`)

  if (fail > 0) {
    console.log('存在未通过项，不建议上线。请对照上方「修复指引」逐项处理后重新运行本脚本。')
    process.exitCode = 1
  } else if (skip > 0) {
    console.log('部分检查因当前运行环境受限而被跳过——这不等于「已验证通过」。' +
      '请在具备真实凭证与公网访问的部署环境中重新运行本脚本，确认全部项目变为 PASS 后再上线。')
    process.exitCode = 0
  } else {
    console.log('全部检查通过。')
    process.exitCode = 0
  }
}

async function main(): Promise<void> {
  const { sampleUser, sampleEmail } = parseArgs(process.argv.slice(2))

  console.log('腾讯会议导出网关 —— 部署前自检\n')

  const cfg = stepConfig()
  if (!cfg) {
    const remaining: Array<[string, string]> = [
      ['2', '数据库连通性'],
      ['2b', '数据库字符集'],
      ['2c', '数据库版本'],
      ['3', '腾讯凭证与签名'],
      ['4', '账号版本'],
      ['5', '企微凭证'],
      ['6', '身份映射策略'],
    ]
    for (const [id, title] of remaining) {
      skipStep(id, title, '依赖第 1 项配置完整性，未执行。')
    }
    finish()
    return
  }

  const pool = await stepDatabase(cfg)
  await stepTencent(cfg)
  await stepWecom(cfg)
  await stepIdentity(cfg, pool, sampleUser, sampleEmail)

  if (pool) await pool.end()
  finish()
}

main().catch((err: unknown) => {
  // main() 内部的每一步都已自行兜底；能走到这里的只可能是脚本自身的 bug。
  console.error('preflight 脚本自身发生未捕获的异常:', err)
  process.exitCode = 1
})
