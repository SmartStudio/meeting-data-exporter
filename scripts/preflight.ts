#!/usr/bin/env bun
/**
 * 部署前自检脚本（Task 16）。
 *
 * 用法：
 *   bun scripts/preflight.ts [--sample-user <企微 userid>] [--sample-email <邮箱>]
 *                             [--skip-webhook-check] [--webhook-timeout-ms <毫秒数>]
 *
 * 依次检查：
 *   1   配置完整性        loadConfig 不抛错
 *   2   数据库连通性      SELECT 1
 *   2b  数据库字符集      必须 utf8mb4 / utf8mb4_unicode_ci
 *   2c  数据库版本        >= 5.7
 *   3   腾讯凭证与签名    调 GET /v1/records 取最近 1 天
 *   4   账号版本          由第 3 步的成败推出（免费版/专业版会在第 3 步失败）
 *   5   企微凭证          调 gettoken
 *   6   身份映射策略      用 --sample-user 实测能否解析出腾讯会议 userid
 *   7   STS-Token 可达性  发起一次真实申请，等待 Webhook 回调完成配对
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
import { createRecordsApi } from '../src/tencent/records'
import { createStsStore } from '../src/store/sts'
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
  skipWebhook: boolean
  webhookTimeoutMs: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sampleUser: null, sampleEmail: null, skipWebhook: false, webhookTimeoutMs: 30_000 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--sample-user') {
      args.sampleUser = argv[++i] ?? null
    } else if (arg === '--sample-email') {
      args.sampleEmail = argv[++i] ?? null
    } else if (arg === '--skip-webhook-check') {
      args.skipWebhook = true
    } else if (arg === '--webhook-timeout-ms') {
      args.webhookTimeoutMs = Number(argv[++i] ?? '30000')
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
  --skip-webhook-check           跳过第 7 项（该项会向腾讯会议发起一次真实的 STS-Token 申请）
  --webhook-timeout-ms <毫秒数>  第 7 项等待 Webhook 回调的超时时间，默认 30000
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
        'TM_WEBHOOK_TOKEN 必须恰好 25 位；IDENTITY_STRATEGY 必须是 direct / email / table 三者之一。',
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
    if (cs === 'utf8mb4' && co === 'utf8mb4_unicode_ci') {
      record('2b', '数据库字符集', 'pass', `字符集 ${cs} / 排序规则 ${co}，符合要求。`)
    } else {
      record(
        '2b',
        '数据库字符集',
        'fail',
        `当前字符集为 "${cs || '未知'}" / 排序规则为 "${co || '未知'}"，不是要求的 utf8mb4 / utf8mb4_unicode_ci。`,
        '会议主题里的中文与 emoji 属于 4 字节字符，MySQL 默认的 utf8（3 字节）会插入失败——' +
          '测试数据多为 ASCII，不会提前暴露这个问题，真实数据上线后才会报错。' +
          '修复：重建数据库为 `CREATE DATABASE ... CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`；' +
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
    const match = /^(\d+)\.(\d+)/.exec(version)
    const major = match ? Number(match[1]) : 0
    const minor = match ? Number(match[2]) : 0
    const ok = major > 5 || (major === 5 && minor >= 7)
    if (ok) {
      record('2c', '数据库版本', 'pass', `MySQL 版本 "${version}"，满足 >= 5.7 的要求。`)
    } else {
      record(
        '2c',
        '数据库版本',
        'fail',
        `MySQL 版本 "${version}"，低于要求的 5.7。`,
        '升级 MySQL 实例到 5.7 及以上（推荐 8.0+）——网关依赖的 JSON 列类型等特性需要该版本。',
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
    now: () => Math.floor(Date.now() / 1000),
  })
  const recordsApi = createRecordsApi(client, cfg.tencent.operatorId)
  const now = Math.floor(Date.now() / 1000)

  try {
    // 取最近 1 天：成功即证明签名算法与账号权限均正确，不要求这个窗口里真的有会议。
    await recordsApi.listMeetings({ kind: 'range', from: now - 86400, to: now }, now)
    record('3', '腾讯凭证与签名', 'pass', '成功调用 GET /v1/records 取最近 1 天的会议列表，签名与权限校验通过。')
    record(
      '4',
      '账号版本',
      'pass',
      '上一步 /v1/records 调用成功，说明企业账号版本满足要求（免费版/专业版会在这一步直接被拒绝）。',
    )
    return true
  } catch (err) {
    if (err instanceof TencentApiError) {
      record(
        '3',
        '腾讯凭证与签名',
        'fail',
        `调用 /v1/records 失败: error_code=${err.errorCode} message="${err.apiMessage}"`,
        tencentErrorHint(err.errorCode),
      )
      record('4', '账号版本', 'fail', '上一步 /v1/records 调用失败，无法确认账号版本是否满足要求。', '先修复第 3 项后重新运行本脚本。')
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
// 第 7 项：STS-Token 可达性（Webhook）
// ---------------------------------------------------------------------------

interface StsRequestRow extends RowDataPacket {
  state: string
}

async function stepWebhook(
  cfg: AppConfig,
  pool: Pool | null,
  tencentOk: boolean,
  skip: boolean,
  timeoutMs: number,
): Promise<void> {
  if (skip) {
    record(
      '7',
      'STS-Token 可达性',
      'skip',
      '已通过 --skip-webhook-check 跳过（该检查会向腾讯会议发起一次真实的 STS-Token 生成请求）。',
    )
    return
  }
  if (!pool) {
    record('7', 'STS-Token 可达性', 'skip', '依赖第 2 项数据库连通性，未执行。')
    return
  }
  if (!tencentOk) {
    record('7', 'STS-Token 可达性', 'skip', '依赖第 3 项腾讯凭证与签名，未执行（该项需要一个可用的腾讯会议客户端）。')
    return
  }

  const client = createTencentClient(cfg.tencent, {
    fetch: withTimeout(fetch, 10_000),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Math.floor(Date.now() / 1000),
  })
  const stsStore = createStsStore(pool)
  const now = Math.floor(Date.now() / 1000)

  try {
    const res = await client.post<{ req_id: string }>('/v1/app/sts-token', {
      operator_id: cfg.tencent.operatorId,
      operator_id_type: 1,
      valid_time: 24,
    })
    await stsStore.createRequest(res.req_id, now)

    const pollIntervalMs = 2000
    const deadline = Date.now() + timeoutMs
    let fulfilled = false
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      const [rows] = await pool.execute<StsRequestRow[]>(
        'SELECT state FROM sts_token_requests WHERE req_id = ?',
        [res.req_id],
      )
      if (rows[0]?.state === 'fulfilled') {
        fulfilled = true
        break
      }
    }

    if (fulfilled) {
      record(
        '7',
        'STS-Token 可达性',
        'pass',
        `已发起 STS-Token 申请（req_id=${res.req_id}），并在 ${timeoutMs / 1000} 秒内收到 Webhook 回调完成配对。`,
      )
    } else {
      record(
        '7',
        'STS-Token 可达性',
        'fail',
        `已发起 STS-Token 申请（req_id=${res.req_id}），但 ${timeoutMs / 1000} 秒内未收到 Webhook 回调。`,
        '依次检查：' +
          '1) GATEWAY_BASE_URL 是否为公网可达的 HTTPS 域名；' +
          '2) 腾讯会议企管后台的事件订阅 URL / Token / EncodingAESKey 是否与部署环境的 ' +
          'TM_WEBHOOK_TOKEN / TM_WEBHOOK_AES_KEY 完全一致；' +
          '3) 是否已在企管后台勾选「STS Token 生成」事件订阅；' +
          '4) 网关服务本身是否正在运行并监听 /webhook/tencent-meeting；' +
          '5) 安全组/防火墙是否放行腾讯会议服务器发起的入站请求。',
      )
    }
  } catch (err) {
    record('7', 'STS-Token 可达性', 'fail', `发起 STS-Token 申请失败: ${errMessage(err)}`)
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
  const { sampleUser, sampleEmail, skipWebhook, webhookTimeoutMs } = parseArgs(process.argv.slice(2))

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
      ['7', 'STS-Token 可达性'],
    ]
    for (const [id, title] of remaining) {
      skipStep(id, title, '依赖第 1 项配置完整性，未执行。')
    }
    finish()
    return
  }

  const pool = await stepDatabase(cfg)
  const tencentOk = await stepTencent(cfg)
  await stepWecom(cfg)
  await stepIdentity(cfg, pool, sampleUser, sampleEmail)
  await stepWebhook(cfg, pool, tencentOk, skipWebhook, webhookTimeoutMs)

  if (pool) await pool.end()
  finish()
}

main().catch((err: unknown) => {
  // main() 内部的每一步都已自行兜底；能走到这里的只可能是脚本自身的 bug。
  console.error('preflight 脚本自身发生未捕获的异常:', err)
  process.exitCode = 1
})
