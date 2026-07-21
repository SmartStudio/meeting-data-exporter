# M1 网关加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉子项目 1 终审判定的 6 项「上线前必须修」（B1–B6），把导出网关从「代码完成」推进到「可投产」。

**Architecture:** 这不是新功能，是对既有 36 文件网关的定点加固。每项修复落在明确的文件与函数上，改动幅度从「一行守卫」到「新增一个浏览器确认页」不等。核心原则：安全默认值优先、失败可区分、多实例安全、不引入新依赖。

**Tech Stack:** Bun + TypeScript（strict）+ MySQL 5.7+（utf8mb4）+ mysql2/promise。测试用 `bun test`，store/http 层连真实隔离测试库（`TEST_DATABASE_URL`），仅在 `TencentClient` 与 `WecomClient` 两个边界打桩。

## Global Constraints

以下为全项目硬约束，每个任务的要求都隐含包含本节：

- **失败不可区分**：认证/授权失败一律返回统一措辞，绝不通过异常类型、消息、HTTP 码或响应时间泄露「账号/资产是否存在」。区分「不存在」与「无权限」本身就是信息泄露。
- **多实例安全**：网关是可横向扩展的服务端组件。任何跨请求状态必须入库或自包含，不得依赖单进程内存做正确性保证（限流的进程内桶是明确标注的例外，见 Task 1）。
- **腾讯错误分类依据 `error_info.error_code`，不是 HTTP status**（后者只有 400/500，承载不了区分）。分类：`fatal`（配置/权限，重试无意义）/ `transient`（可重试）/ `asset_permanent`（资产不存在，跳过）。
- **STS-Token 明文与腾讯 SecretKey 绝不落库明文**；落库前对称加密。
- **密钥不得跨信任域复用**：用户会话 JWT 签名密钥与 STS-Token 落库加密密钥必须是两把独立密钥。
- **策略引擎默认 deny**：无匹配规则即拒绝；未知字段、类型不匹配一律「不匹配」，绝不静默放行。
- **时间戳单位为秒**：`now()` 返回 `Math.floor(Date.now()/1000)`，全链路以秒为单位。
- **测试库连接串只经 `TEST_DATABASE_URL` 环境变量传入，绝不写进任何提交的文件**；bash 中必须单引号包裹（密码含 `!` 会触发历史展开）。
- **不新增运行时依赖**：仅用 Bun 内置（`Bun.password`、`node:crypto`）与既有 `mysql2`。

---

## 文件归属与冲突分析

| 任务 | 项 | 新建 | 修改 | 与谁冲突 | 批次 |
| --- | --- | --- | --- | --- | --- |
| T1 | B1 | `src/http/ratelimit.ts`、`tests/http/ratelimit.test.ts` | `src/auth/service.ts`、`src/http/router.ts`、`tests/auth/service.test.ts` | 独立 | 1（并行） |
| T2 | B3 | — | `src/policy/expr.ts`、`tests/policy/expr.test.ts` | 独立 | 1（并行） |
| T3 | B4 | `tests/http/upstream-error.test.ts` | `src/http/respond.ts` | 独立 | 1（并行） |
| T4 | B2 | — | `src/config.ts`、`src/index.ts`、`.env.example`、`tests/config.test.ts`、`docs/deploy.md` | **与 T5 争 `src/index.ts`** | 2（T4→T5 串行） |
| T5 | B5 | — | `src/index.ts`、`src/sts/manager.ts`、`src/store/sts.ts`、`tests/sts/manager.test.ts`、`tests/store/sts.test.ts` | **与 T4 争 `src/index.ts`** | 2（T4→T5 串行） |
| T6 | B6 | `src/http/handlers/device.ts`、`tests/http/device.test.ts` | `src/store/auth.ts`、`src/http/router.ts`、`src/http/respond.ts`、`src/http/handlers/auth.ts`、`src/auth/device.ts` | **与 T1 争 `router.ts`、与 T3 争 `respond.ts`** | 3（在批次 1 合并后） |

### 执行编排

```
批次 1（并行 3，git worktree 隔离）   T1 · T2 · T3        落点完全不相交
        │  三者审查通过并合并回 feat/m1-hardening
批次 2（串行 1，同一分支顺序做）      T4 → 合并 → T5      都碰 index.ts，不可并行
        │
批次 3（单独）                        T6                  碰 router.ts+respond.ts，
                                                         必须在批次 1 合并后才能 fork
```

**依赖说明**：T6 修改 `router.ts`（注册 `/device` 路由）与 `respond.ts`（抽出 `escapeHtml`），这两个文件分别被 T1、T3 改过。因此 T6 必须从「批次 1 已合并」的分支上 fork，让 T6 看到的是合并后的文件，避免三方合并冲突。T4/T5 都改 `index.ts`，串行执行：T4 合并后 T5 再从更新后的分支 fork。

### B6 归属决策（已定）

终审把 B6 标为「需先决策归属」，两个选项：网关自带最小 `/device` 页面，或划归桌面端/前端（子项目 4）。**本计划采用前者（roadmap 推荐项）**：设备授权流程是网关的对外契约，US-2.1「真人可登录」的前提就是「仅凭网关能走完登录」。最小页面成本极低（一个 302 跳转 handler），桌面端将来可用内嵌 webview 覆盖更好的体验，但网关必须自带这层兜底，不能把对外契约悬空。若项目方要改判为划归子项目 4，可在批次 1/2 执行期间叫停，仅 T6 受影响。

---

## Task 1（B1）: 登录端点限流 + 服务账号恒定时间比较

**Files:**
- Create: `src/http/ratelimit.ts`
- Modify: `src/auth/service.ts`
- Modify: `src/http/router.ts`
- Create: `tests/http/ratelimit.test.ts`
- Modify: `tests/auth/service.test.ts`

**Interfaces:**
- Produces: `createRateLimiter(cfg: { capacity: number; refillPerSec: number }): { allow(key: string, now: number): boolean }`（供 `router.ts` 内部使用，不进 `AppDeps`）。
- Consumes: `AppDeps.now`（`router.ts` 已有）、`ServiceAuthDeps.store.findServiceAccount`（`auth/store.ts` 已有）。

**背景**：两处独立缺陷合并为一个任务（同属「登录端点加固」，落点无重叠）。

- **B1a 时序预言机**：`service.ts` 在 `account === null` 时立即抛错，**跳过了昂贵的 `Bun.password.verify`**。账号存在时跑一次 argon2 校验（~100ms），不存在时立即返回——攻击者用响应时间就能区分「client_id 是否存在」，等于一个账号枚举预言机。
- **B1b 零限流**：`device/token` 轮询可被用于穷举 `device_code`、`service-token` 可被用于试探 `client_secret`，且任一端点都可当 DoS 入口。spec §5.4.7 明确要求登录端点限流。

- [ ] **Step 1: 写限流器的失败测试** — `tests/http/ratelimit.test.ts`

```ts
import { expect, test } from 'bun:test'
import { createRateLimiter } from '../../src/http/ratelimit'

test('桶满时放行，耗尽后拒绝', () => {
  const rl = createRateLimiter({ capacity: 3, refillPerSec: 1 })
  const now = 1000
  expect(rl.allow('k', now)).toBe(true)
  expect(rl.allow('k', now)).toBe(true)
  expect(rl.allow('k', now)).toBe(true)
  expect(rl.allow('k', now)).toBe(false) // 第 4 次，桶空
})

test('按经过秒数补充令牌，上限为 capacity', () => {
  const rl = createRateLimiter({ capacity: 2, refillPerSec: 1 })
  expect(rl.allow('k', 1000)).toBe(true)
  expect(rl.allow('k', 1000)).toBe(true)
  expect(rl.allow('k', 1000)).toBe(false)
  // 过 2 秒补 2 个令牌，但不超过 capacity=2
  expect(rl.allow('k', 1002)).toBe(true)
  expect(rl.allow('k', 1002)).toBe(true)
  expect(rl.allow('k', 1002)).toBe(false)
})

test('不同 key 互不影响', () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSec: 1 })
  expect(rl.allow('a', 1000)).toBe(true)
  expect(rl.allow('a', 1000)).toBe(false)
  expect(rl.allow('b', 1000)).toBe(true) // b 有独立的桶
})

test('时间倒流不产生负令牌（防御时钟异常）', () => {
  const rl = createRateLimiter({ capacity: 2, refillPerSec: 1 })
  expect(rl.allow('k', 1000)).toBe(true)
  expect(rl.allow('k', 999)).toBe(true) // now 回退，elapsed 视为 0，仍用桶内余量
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/http/ratelimit.test.ts`
Expected: FAIL —「Cannot find module '../../src/http/ratelimit'」

- [ ] **Step 3: 实现限流器** — `src/http/ratelimit.ts`

```ts
/**
 * 令牌桶限流器（进程内）。
 *
 * 【多实例说明】这是明确标注的「进程内内存状态」例外：桶不跨实例共享。
 * 网关部署在负载均衡后方，N 个实例的聚合放行速率是单实例的 N 倍——仍然有界，
 * 且分布式暴力的外层防线本就应由 LB/WAF 承担。这里要挡的是「单点无节流」这个
 * 硬缺陷（枚举 device_code / 试探 client_secret / 当 DoS 入口），进程内桶足以
 * 把单实例单 IP 的稳态速率压到 refillPerSec，配合 service.ts 的恒定时间校验与
 * 统一失败措辞，构成最小可用的加固。上线前若需强一致的跨实例限流，可换成
 * 基于 Redis/DB 的实现，接口 allow(key, now) 保持不变。
 */
export interface RateLimiter {
  /** 返回 true 放行、false 超限应拒绝。now 单位为秒（与 AppDeps.now 一致）。 */
  allow(key: string, now: number): boolean
}

export interface RateLimiterConfig {
  /** 桶容量：允许的突发上限 */
  capacity: number
  /** 每秒补充的令牌数：稳态放行速率 */
  refillPerSec: number
}

export function createRateLimiter(cfg: RateLimiterConfig): RateLimiter {
  const buckets = new Map<string, { tokens: number; last: number }>()
  return {
    allow(key, now) {
      const b = buckets.get(key) ?? { tokens: cfg.capacity, last: now }
      // 时钟只前进：now 倒退时 elapsed 归零，不凭空补令牌也不扣令牌
      const elapsed = Math.max(0, now - b.last)
      b.tokens = Math.min(cfg.capacity, b.tokens + elapsed * cfg.refillPerSec)
      b.last = now
      if (b.tokens < 1) {
        buckets.set(key, b)
        return false
      }
      b.tokens -= 1
      buckets.set(key, b)
      return true
    },
  }
}
```

- [ ] **Step 4: 运行限流器测试通过**

Run: `bun test tests/http/ratelimit.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 写路由层限流的集成失败测试** — 追加到 `tests/http/ratelimit.test.ts` 顶部补充 import 并新增

```ts
import { afterAll, beforeAll } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp } from './testApp'

let pool: Pool
let cleanup: () => Promise<void>
beforeAll(async () => { const db = await withTestDb(); pool = db.pool; cleanup = db.cleanup })
afterAll(() => cleanup())

function deviceCodeReq(ip: string): Request {
  return new Request('http://gw.example/api/v1/auth/device/code', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  })
}

test('登录端点按 IP 限流：超过突发上限返回 429', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_000_000 })
  // 默认 capacity=20：前 20 次放行（device/code 恒返回 200），第 21 次 429
  for (let i = 0; i < 20; i++) {
    const res = await app(deviceCodeReq('10.0.0.1'))
    expect(res.status).toBe(200)
  }
  const blocked = await app(deviceCodeReq('10.0.0.1'))
  expect(blocked.status).toBe(429)
  expect(await blocked.json()).toEqual({ error: 'rate_limited' })
})

test('限流按 IP 隔离：另一 IP 不受影响', async () => {
  const { app } = buildTestApp(pool, { now: () => 2_100_000 })
  for (let i = 0; i < 20; i++) await app(deviceCodeReq('10.0.0.2'))
  expect((await app(deviceCodeReq('10.0.0.2'))).status).toBe(429)
  expect((await app(deviceCodeReq('10.0.0.3'))).status).toBe(200) // 独立的桶
})

test('令牌随时间补充：等待后重新放行', async () => {
  let t = 2_200_000
  const { app } = buildTestApp(pool, { now: () => t })
  for (let i = 0; i < 20; i++) await app(deviceCodeReq('10.0.0.4'))
  expect((await app(deviceCodeReq('10.0.0.4'))).status).toBe(429)
  t += 5 // 过 5 秒，refill=1/s 补 5 个令牌
  expect((await app(deviceCodeReq('10.0.0.4'))).status).toBe(200)
})
```

- [ ] **Step 6: 运行确认集成测试失败**

Run: `TEST_DATABASE_URL='...' bun test tests/http/ratelimit.test.ts`（连接串经环境变量单引号传入）
Expected: FAIL —第 21 次仍为 200（限流未接线），断言 429 失败

- [ ] **Step 7: 在路由层接线限流** — 修改 `src/http/router.ts`

在文件顶部 import 区加入：

```ts
import { createRateLimiter } from './ratelimit'
```

在 `ROUTES` 常量定义之后、`createApp` 之前，新增模块级常量与工具函数：

```ts
/**
 * 登录端点限流参数。capacity=20 允许合理突发（设备端每 5 秒轮询一次远低于此），
 * refillPerSec=1 把单 IP 单端点的稳态速率压到 60 次/分钟——足以让穷举/试探在
 * argon2 校验成本之上再叠一层节流。数值是保守默认，可按上线观测调整。
 */
const LOGIN_BURST = 20
const LOGIN_REFILL_PER_SEC = 1

/** 仅对写型登录端点限流（webhook 是腾讯侧调用、GET /device 是浏览器页，均不在此列） */
const RATE_LIMITED = new Set([
  'POST /api/v1/auth/device/code',
  'POST /api/v1/auth/device/token',
  'POST /api/v1/auth/service-token',
  'POST /api/v1/auth/refresh',
])

/** 取客户端 IP：网关部署在可信代理后方，真实 IP 在 x-forwarded-for 首段 */
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}
```

修改 `createApp`，在闭包内构造限流器，并在路由匹配后、派发前做限流判断：

```ts
export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  // 限流器随 app 实例存活整个进程周期；用 deps.now 便于测试注入可控时钟
  const loginLimiter = createRateLimiter({ capacity: LOGIN_BURST, refillPerSec: LOGIN_REFILL_PER_SEC })

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // 限流在路由派发之前：按「方法+路径」精确匹配（这些端点无路径参数），
    // key 含 pathname，使每个端点对每个 IP 有独立的桶。
    if (RATE_LIMITED.has(`${req.method} ${url.pathname}`)) {
      if (!loginLimiter.allow(`${url.pathname}|${clientIp(req)}`, deps.now())) {
        return json(429, { error: 'rate_limited' })
      }
    }

    for (const route of ROUTES) {
      if (route.method !== req.method) continue
      const match = route.pattern.exec(url.pathname)
      if (!match) continue

      const params: Record<string, string> = {}
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1] ?? '')
      })

      try {
        return await route.handler(req, { params, deps })
      } catch (err) {
        return internalError(err)
      }
    }

    return json(404, { error: 'not_found' })
  }
}
```

- [ ] **Step 8: 写服务账号恒定时间的失败测试** — 追加到 `tests/auth/service.test.ts`

```ts
test('账号不存在与密钥错误：都跑一次 verify（消除时序预言机），且都抛同一错误', async () => {
  // 行为锁定：两条路径都必须抛 ServiceAuthError（不可区分）。恒定时间属性由
  // 「不存在时也对 dummy hash 跑一次 verify」的实现保证，见 service.ts。
  const store = memServiceAccountStore([
    {
      id: 'svc-1', name: '导出机器人', secretHash: correctHash,
      tmUserId: 'tm-svc-1', enabled: true, expiresAt: null, createdAt: 1000,
    },
  ])
  const auth = createServiceAuth({ store })
  await expect(auth.authenticate('does-not-exist', 'any', 2000)).rejects.toThrow(ServiceAuthError)
  await expect(auth.authenticate('svc-1', 'wrong-pass', 2000)).rejects.toThrow(ServiceAuthError)
})
```

- [ ] **Step 9: 运行确认失败**

Run: `bun test tests/auth/service.test.ts`
Expected: 新用例 PASS（行为本就成立），但下一步的实现改动要保持它仍绿——先运行确认基线

- [ ] **Step 10: 恒定时间实现** — 修改 `src/auth/service.ts`

在 import 之后、`ServiceAuthError` 之前，新增模块级 dummy hash：

```ts
/**
 * 账号不存在时也要跑一次 verify，否则「跳过昂贵的 argon2 校验」会让响应时间
 * 泄露 client_id 是否存在（枚举预言机）。这里预先算一个与真实密钥同算法
 * （argon2id，见 store 里 service_accounts.secret_hash 的生成方式）的 dummy hash，
 * 账号缺失时对它做一次等价耗时的校验。模块加载时算一次即可。
 */
const DUMMY_HASH_PROMISE = Bun.password.hash('invalid-placeholder-not-a-real-secret', {
  algorithm: 'argon2id',
})
```

把 `authenticate` 改为在两条路径都执行 verify，并合并后续判断，消除分支间的时序差异：

```ts
export function createServiceAuth(deps: ServiceAuthDeps): ServiceAuth {
  return {
    async authenticate(clientId, clientSecret, now) {
      const account = await deps.store.findServiceAccount(clientId)
      // 账号不存在时对 dummy hash 校验：耗时与真实校验一致，时序不可区分。
      const hashToCheck = account?.secretHash ?? (await DUMMY_HASH_PROMISE)
      const secretOk = await Bun.password.verify(clientSecret, hashToCheck)

      // 所有失败原因合并判定，统一抛同一错误：不区分不存在/密钥错/已禁用/已过期。
      if (
        account === null ||
        !secretOk ||
        !account.enabled ||
        (account.expiresAt !== null && now >= account.expiresAt)
      ) {
        throw new ServiceAuthError()
      }

      return { kind: 'service_account', wecomUserId: null, tmUserId: account.tmUserId }
    },
  }
}
```

- [ ] **Step 11: 运行 auth/service 与 http 全量测试**

Run: `TEST_DATABASE_URL='...' bun test tests/auth/service.test.ts tests/http/`
Expected: PASS（service 全部原有用例 + 新增用例；ratelimit 集成 3 用例；其余 http 用例不回归）

- [ ] **Step 12: typecheck**

Run: `bun run typecheck`
Expected: 无错误

- [ ] **Step 13: Commit**

```bash
git add src/http/ratelimit.ts src/auth/service.ts src/http/router.ts tests/http/ratelimit.test.ts tests/auth/service.test.ts
git commit -m "fix(auth): 登录端点限流 + 服务账号恒定时间校验（B1）"
```

---

## Task 2（B3）: 策略引擎类型不匹配一律不匹配（消除 NaN 静默放行）

**Files:**
- Modify: `src/policy/expr.ts`
- Modify: `tests/policy/expr.test.ts`

**Interfaces:**
- Consumes/Produces: `matchExpr(expr, meeting): boolean` 签名不变，仅收紧 `gte`/`lte` 的语义。

**背景**：`matchOne` 里 `Number(actual) < c.gte`，当 `actual` 是非数值字符串（如 subject）时 `Number(actual)` 得 `NaN`，`NaN < x` 恒为 `false`——于是**不 return false，落到末尾 `return true`（视为匹配）**。这与同文件「未知字段返回 false」的设计意图直接矛盾：字段名写错会拒绝，字段类型用错却放行，是一个授权中枢里查不出来的过度放行。

- [ ] **Step 1: 写失败测试** — 追加到 `tests/policy/expr.test.ts`

```ts
test('gte/lte 套在非数值字段上：一律不匹配（不得静默放行）', () => {
  // subject 是字符串字段，Number('季度评审') = NaN。NaN 比较恒 false，绝不能
  // 被理解成「通过」——必须显式判定为不匹配。
  expect(matchExpr({ subject: { gte: 0 } }, meeting)).toBe(false)
  expect(matchExpr({ subject: { lte: 9999999999 } }, meeting)).toBe(false)
  expect(matchExpr({ host_userid: { gte: 0 } }, meeting)).toBe(false)
})

test('gte/lte 的界值非数值：不匹配', () => {
  expect(matchExpr({ start_time: { gte: 'abc' as unknown as number } }, meeting)).toBe(false)
  expect(matchExpr({ start_time: { lte: 'abc' as unknown as number } }, meeting)).toBe(false)
})

test('数值字段的 gte/lte 仍按原语义工作（回归保护）', () => {
  expect(matchExpr({ start_time: { gte: 1767225600 } }, meeting)).toBe(true)
  expect(matchExpr({ start_time: { gte: 1767225601 } }, meeting)).toBe(false)
  expect(matchExpr({ start_time: { lte: 1767225600 } }, meeting)).toBe(true)
  expect(matchExpr({ start_time: { gte: 1767225500, lte: 1767225700 } }, meeting)).toBe(true)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/policy/expr.test.ts`
Expected: FAIL —「gte/lte 套在非数值字段上」用例期望 false 实得 true

- [ ] **Step 3: 收紧 matchOne** — 修改 `src/policy/expr.ts` 的 `matchOne` 函数

```ts
function matchOne(condition: unknown, actual: string | number): boolean {
  if (Array.isArray(condition)) return condition.includes(actual)
  if (condition !== null && typeof condition === 'object') {
    const c = condition as { not_in?: unknown[]; gte?: unknown; lte?: unknown }
    if (c.not_in !== undefined && Array.isArray(c.not_in) && c.not_in.includes(actual)) return false
    // gte/lte 只对数值有意义。actual 或界值任一非数值时 Number() 得 NaN，
    // 涉及 NaN 的比较全为 false——但「比较为 false」绝不能落到末尾的 return true
    // 被当成「通过」。显式判定：一旦不是有限数值就视为不匹配（return false）。
    if (c.gte !== undefined) {
      const a = Number(actual)
      const bound = Number(c.gte)
      if (!Number.isFinite(a) || !Number.isFinite(bound) || a < bound) return false
    }
    if (c.lte !== undefined) {
      const a = Number(actual)
      const bound = Number(c.lte)
      if (!Number.isFinite(a) || !Number.isFinite(bound) || a > bound) return false
    }
    return true
  }
  return condition === actual
}
```

- [ ] **Step 4: 运行 policy 全量测试通过**

Run: `bun test tests/policy/`
Expected: PASS（expr 原有 + 新增；engine 不回归）

- [ ] **Step 5: typecheck + Commit**

```bash
bun run typecheck
git add src/policy/expr.ts tests/policy/expr.test.ts
git commit -m "fix(policy): gte/lte 类型不匹配一律不匹配，消除 NaN 静默放行（B3）"
```

---

## Task 3（B4）: 腾讯错误分类在 HTTP 层映射（不再全塌 500）

**Files:**
- Modify: `src/http/respond.ts`
- Create: `tests/http/upstream-error.test.ts`

**Interfaces:**
- Consumes: `TencentApiError`（`src/tencent/errors.ts`，含 `classification: 'fatal' | 'transient' | 'asset_permanent'`、`errorCode`、`apiMessage`），只读 import，不改该文件。
- Produces: `internalError(err)` 行为增强 + 新增 export `upstreamError(err: TencentApiError): Response`。

**背景**：`tencent/errors.ts` 的三层分类在 HTTP 层零消费——`meetings.ts` 的 handler 只 catch `MeetingNotFoundInRangeError`，其余 `throw err`，`TencentApiError` 冒泡到 `router.ts` 的 catch → `internalError` → **不透明 500**。配错 SecretKey（9042）、operator 离职（200001/202004）时运维只看到 500，无任何排障信号。

**关键落点**：`router.ts` 的 catch 是唯一漏斗（`catch (err) { return internalError(err) }`），所有 handler 的未捕获异常都经此。因此只改 `respond.ts` 的 `internalError` 即可集中覆盖全部端点，**无需改 router.ts 或任何 handler**（这也让 T3 与改 router.ts 的 T1 无冲突）。

- [ ] **Step 1: 写失败测试** — `tests/http/upstream-error.test.ts`

```ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import type { ActorIdentity } from '../../src/domain/types'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp, JWT_SECRET } from './testApp'
import { signAccessToken } from '../../src/auth/tokens'
import { TencentApiError } from '../../src/tencent/errors'

let pool: Pool
let cleanup: () => Promise<void>
beforeAll(async () => { const db = await withTestDb(); pool = db.pool; cleanup = db.cleanup })
afterAll(() => cleanup())

const NOW = 1_700_000_000
const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-a', tmUserId: 'tm-a' }
function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken(alice, JWT_SECRET, NOW)}` }
}
function listReq(): Request {
  return new Request('http://gw.example/api/v1/meetings?from=1&to=2', { headers: bearer() })
}

test('腾讯 fatal 错误（如 9042 配错凭证）→ 502 upstream_config_error，透出 tencent_code', async () => {
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: () => { throw new TencentApiError(9042, 500, 'signature invalid') },
  })
  const res = await app(listReq())
  expect(res.status).toBe(502)
  expect(await res.json()).toEqual({ error: 'upstream_config_error', tencent_code: 9042 })
})

test('腾讯 transient 错误 → 503 upstream_unavailable', async () => {
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: () => { throw new TencentApiError(190310, 500, 'rate limited') },
  })
  const res = await app(listReq())
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ error: 'upstream_unavailable', tencent_code: 190310 })
})

test('腾讯 asset_permanent（4051）→ 404 asset_not_found', async () => {
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: () => { throw new TencentApiError(4051, 400, 'file not exist') },
  })
  const res = await app(listReq())
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: 'asset_not_found', tencent_code: 4051 })
})

test('非腾讯的未知异常仍返回不透明 500（不泄露内部细节）', async () => {
  const { app } = buildTestApp(pool, {
    now: () => NOW,
    tencentGet: () => { throw new Error('some internal boom') },
  })
  const res = await app(listReq())
  expect(res.status).toBe(500)
  expect(await res.json()).toEqual({ error: 'internal_error' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `TEST_DATABASE_URL='...' bun test tests/http/upstream-error.test.ts`
Expected: FAIL —fatal/transient/asset 三例都得到 500，而非 502/503/404

- [ ] **Step 3: 在 respond.ts 增加映射** — 修改 `src/http/respond.ts`

顶部加 import：

```ts
import { TencentApiError } from '../tencent/errors'
```

把 `internalError` 改为先识别 `TencentApiError`，并新增 `upstreamError`：

```ts
/** 兜底：处理函数内未被显式捕获的异常。腾讯 API 错误按分类映射，其余不泄露细节。 */
export function internalError(err: unknown): Response {
  if (err instanceof TencentApiError) return upstreamError(err)
  console.error('unhandled error in http handler', err)
  return json(500, { error: 'internal_error' })
}

/**
 * 腾讯 API 错误在 HTTP 层的映射。分类依据 error_info.error_code（见 tencent/errors.ts），
 * 绝不能全塌成 500：
 * - fatal：网关侧配置/权限问题（SecretKey 错、operator 离职），非调用方过错。
 *   502 + 透出腾讯 error_code 供运维排障，但不透出内部 message（避免细节泄露）。
 * - asset_permanent：该资产在平台侧不存在，语义上等价 404。
 * - transient：可重试，503 让客户端知道稍后再试。
 */
export function upstreamError(err: TencentApiError): Response {
  switch (err.classification) {
    case 'fatal':
      console.error('tencent fatal error', err.errorCode, err.apiMessage)
      return json(502, { error: 'upstream_config_error', tencent_code: err.errorCode })
    case 'asset_permanent':
      return json(404, { error: 'asset_not_found', tencent_code: err.errorCode })
    case 'transient':
      return json(503, { error: 'upstream_unavailable', tencent_code: err.errorCode })
  }
}
```

- [ ] **Step 4: 运行 http 全量测试通过**

Run: `TEST_DATABASE_URL='...' bun test tests/http/`
Expected: PASS（upstream-error 4 用例 + 其余 http 用例不回归）

- [ ] **Step 5: typecheck + Commit**

```bash
bun run typecheck
git add src/http/respond.ts tests/http/upstream-error.test.ts
git commit -m "fix(http): 腾讯错误分类在 HTTP 层映射为 502/503/404（B4）"
```

---

## Task 4（B2）: STS 加密密钥与 JWT_SECRET 分离 + JWT_SECRET 强度校验

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `.env.example`
- Modify: `tests/config.test.ts`
- Modify: `docs/deploy.md`

**Interfaces:**
- Produces: `AppConfig` 新增 `stsEncKey: string` 字段；`loadConfig` 新增 `STS_ENC_KEY` 必填项与 `JWT_SECRET` 长度校验。
- Consumes: `createTokenCipher(secret)`（`index.ts` 已有）——改为传 `config.stsEncKey`。

**背景**：`index.ts` 用 `createTokenCipher(config.jwtSecret)` 派生 STS 落库加密密钥（`SHA-256(JWT_SECRET)`），与用户会话 JWT 签名**同源**。单点泄露即可「伪造任意 tmUserId 令牌」+「解密全部 STS-Token」，影响面翻倍。且 `JWT_SECRET` 无强度校验，可用弱口令。

> **注意（先做基线）**：本任务是批次 2 的第一个，从「批次 1 已合并」的 `feat/m1-hardening` fork。开始前先跑一次全量测试确认基线全绿。

- [ ] **Step 1: 写 config 校验的失败测试** — 修改 `tests/config.test.ts`

先给 `validEnv` 补上新必填项（否则所有既有用例会因缺 `STS_ENC_KEY` 而报错）：

```ts
const validEnv = {
  TM_APP_ID: 'corp-1',
  TM_SDK_ID: 'sdk-1',
  TM_SECRET_ID: 'AKIDxxx',
  TM_SECRET_KEY: 'secret',
  TM_OPERATOR_ID: 'admin-uid',
  TM_WEBHOOK_TOKEN: 'a'.repeat(25),
  TM_WEBHOOK_AES_KEY: 'b'.repeat(43),
  WECOM_CORP_ID: 'ww-corp',
  WECOM_AGENT_ID: '1000002',
  WECOM_SECRET: 'wecom-secret',
  DATABASE_URL: 'mysql://user:pass@localhost:3306/gw?charset=utf8mb4',
  JWT_SECRET: 'c'.repeat(32),
  STS_ENC_KEY: 'd'.repeat(32),
  GATEWAY_BASE_URL: 'https://gw.example.com',
  IDENTITY_STRATEGY: 'direct',
}
```

新增用例：

```ts
test('loadConfig 暴露独立的 STS 加密密钥', () => {
  expect(loadConfig(validEnv).stsEncKey).toBe('d'.repeat(32))
})

test('loadConfig 拒绝过短的 JWT_SECRET（< 32）', () => {
  expect(() => loadConfig({ ...validEnv, JWT_SECRET: 'short' })).toThrow('JWT_SECRET')
})

test('loadConfig 拒绝过短的 STS_ENC_KEY（< 32）', () => {
  expect(() => loadConfig({ ...validEnv, STS_ENC_KEY: 'short' })).toThrow('STS_ENC_KEY')
})

test('loadConfig 拒绝 STS_ENC_KEY 与 JWT_SECRET 相同（必须跨信任域分离）', () => {
  const same = 'e'.repeat(32)
  expect(() => loadConfig({ ...validEnv, JWT_SECRET: same, STS_ENC_KEY: same }))
    .toThrow('STS_ENC_KEY')
})

test('loadConfig 缺失 STS_ENC_KEY 时报出字段名', () => {
  const { STS_ENC_KEY, ...incomplete } = validEnv
  expect(() => loadConfig(incomplete)).toThrow('STS_ENC_KEY')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/config.test.ts`
Expected: FAIL —`stsEncKey` undefined、长度/相同校验未实现

- [ ] **Step 3: config.ts 增加字段与校验** — 修改 `src/config.ts`

`AppConfig` 接口在 `jwtSecret: string` 之后加：

```ts
  jwtSecret: string
  stsEncKey: string
```

`loadConfig` 里，在 `strategy` 校验之后、`return` 之前，加密钥校验：

```ts
  const jwtSecret = required(env, 'JWT_SECRET')
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters')
  }

  const stsEncKey = required(env, 'STS_ENC_KEY')
  if (stsEncKey.length < 32) {
    throw new Error('STS_ENC_KEY must be at least 32 characters')
  }
  if (stsEncKey === jwtSecret) {
    throw new Error('STS_ENC_KEY must differ from JWT_SECRET (separate trust domains)')
  }
```

`return` 对象里，把 `jwtSecret: required(env, 'JWT_SECRET'),` 改为用上面的局部变量并加新字段：

```ts
    jwtSecret,
    stsEncKey,
    gatewayBaseUrl: required(env, 'GATEWAY_BASE_URL'),
    identityStrategy: strategy as IdentityStrategy,
```

- [ ] **Step 4: index.ts 用独立密钥装配 tokenCipher** — 修改 `src/index.ts`

把 `createTokenCipher` 的 JSDoc 更新，并把装配处的入参从 `config.jwtSecret` 改为 `config.stsEncKey`：

第 71 行：
```ts
  const tokenCipher = createTokenCipher(config.stsEncKey)
```

同时更新 `createTokenCipher` 上方注释（第 26–31 行）里「密钥派生自 JWT_SECRET」的表述：

```ts
/**
 * STS-Token 落库前的对称加密。设计文档 §5.8 建议用阿里云 KMS 托管或等效的
 * 密文存储——本实现用一把【独立于 JWT_SECRET】的密钥（STS_ENC_KEY）派生
 * AES-256-GCM 密钥，使会话签名域与 STS 加密域互不牵连：任一密钥泄露不会同时
 * 危及另一域。生产部署前仍建议替换为真正的 KMS 密钥托管。
 */
```

- [ ] **Step 5: 运行 config + 启动相关测试**

Run: `TEST_DATABASE_URL='...' bun test tests/config.test.ts`
Expected: PASS（原有 5 + 新增 5）

- [ ] **Step 6: 更新 .env.example** — 修改 `.env.example`

把 `JWT_SECRET` 那段注释改为强调 ≥32 位与「仅用于会话签名」，并在其后新增 `STS_ENC_KEY` 段：

```
# 网关签发/校验用户会话 JWT 的密钥，必须 >= 32 位随机字符串（例如 openssl rand -base64 32）。
# 仅用于会话签名，绝不能与 STS_ENC_KEY 相同。
JWT_SECRET=

# STS-Token 落库加密的独立密钥，必须 >= 32 位随机字符串，且必须与 JWT_SECRET 不同。
# 与 JWT_SECRET 分属两个信任域：任一泄露不牵连另一个（例如 openssl rand -base64 32）。
STS_ENC_KEY=
```

- [ ] **Step 7: 更新 deploy.md** — 修改 `docs/deploy.md`

- 第 5 节环境变量表（约 155 行）：把 `JWT_SECRET` 行的「与派生 STS-Token 落库加密密钥共用的根密钥」表述删除，改为「仅用于会话签名，必须 ≥32 位」；新增一行 `STS_ENC_KEY`，说明它是独立的 STS 落库加密密钥、必须 ≥32 位且与 `JWT_SECRET` 不同。
- 第 11 节技术债（约 486–489 行）：把「密钥由 SHA-256(JWT_SECRET) 派生……一旦 JWT_SECRET 泄露 STS-Token 密文也会」这段更新为「密钥由独立的 STS_ENC_KEY 派生，已与 JWT_SECRET 分离；仍建议上线后替换为 KMS 托管」。

- [ ] **Step 8: typecheck + Commit**

```bash
bun run typecheck
git add src/config.ts src/index.ts .env.example tests/config.test.ts docs/deploy.md
git commit -m "fix(config): STS 加密密钥与 JWT_SECRET 分离 + JWT_SECRET 强度校验（B2）"
```

---

## Task 5（B5）: STS 看门狗接线（调度 expireStale + ensureFresh 去重在途 pending）

**Files:**
- Modify: `src/store/sts.ts`
- Modify: `src/sts/manager.ts`
- Modify: `src/index.ts`
- Modify: `tests/store/sts.test.ts`
- Modify: `tests/sts/manager.test.ts`

**Interfaces:**
- Produces: `StsStore` 新增 `hasRecentPending(now: number): Promise<boolean>`；`StsManager` 新增 `pruneStale(now: number): Promise<number>`。
- Consumes: `StsStore.expireStale`（已有）、`StsStore.getActive`（已有）。

**背景（两处）**：
- **看门狗只接一半**：`index.ts` 的 `renewLoop` 只调 `stsManager.ensureFresh`，从不调 `expireStale`——`expireStale` 有实现有测试却从未被调度。STS 长期异常时 `pending` 行无界增长，永不清理。
- **ensureFresh 不去重在途**：`ensureFresh` 只看 `getActive`（已 fulfilled 的 token），不检查是否已有 `state='pending'` 的在途申请。若定时任务的调用间隔短于 webhook 回调到达时间，会**重复 POST 申请**，产生多条 pending 记录并浪费腾讯 API 配额。

> **注意**：本任务是批次 2 的第二个，必须在 **T4 已合并** 后从更新后的 `feat/m1-hardening` fork（两者都改 `index.ts`）。开始前先跑基线确认 T4 的改动已在且全绿。

- [ ] **Step 1: 写 store 层 hasRecentPending 的失败测试** — 追加到 `tests/store/sts.test.ts`（沿用该文件既有的 `withTestDb` / pool 夹具与命名风格）

```ts
test('hasRecentPending：存在未过陈旧窗口的 pending 时为 true', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-recent', 10_000)
  // 陈旧窗口 3600s：now=10_500 时 req-recent（10_000）仍在窗口内
  expect(await store.hasRecentPending(10_500)).toBe(true)
})

test('hasRecentPending：pending 已超陈旧窗口（>1h）时为 false', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-old', 20_000)
  // now 比 requested_at 晚超过 3600s
  expect(await store.hasRecentPending(20_000 + 3601)).toBe(false)
})

test('hasRecentPending：已 fulfilled 的记录不算在途', async () => {
  const store = createStsStore(pool)
  await store.createRequest('req-done', 30_000)
  await store.fulfill('req-done', 'cipher', 30_000 + 86_400, 30_100)
  expect(await store.hasRecentPending(30_200)).toBe(false)
})

test('hasRecentPending：无任何 pending 时为 false', async () => {
  const store = createStsStore(pool)
  expect(await store.hasRecentPending(999_999_999)).toBe(false)
})
```

> 若该测试文件全文件共享一个 pool 且用例间不回滚（台账 [T4] 已记录此特性），为上述用例选用互不冲突的 `req_id` 与远隔的时间戳，避免与既有用例串扰。

- [ ] **Step 2: 运行确认失败**

Run: `TEST_DATABASE_URL='...' bun test tests/store/sts.test.ts`
Expected: FAIL —`hasRecentPending` 不是函数

- [ ] **Step 3: store 实现 hasRecentPending** — 修改 `src/store/sts.ts`

`StsStore` 接口在 `expireStale` 之后加：

```ts
  /** 是否存在「未超陈旧窗口（1h）」的在途 pending 申请，用于 ensureFresh 去重 */
  hasRecentPending(now: number): Promise<boolean>
```

实现（放在 `expireStale` 之后）：

```ts
    async hasRecentPending(now) {
      // 与 expireStale 用同一个 1h 陈旧阈值：更早的 pending 视为已废弃（将被
      // expireStale 标记为 expired），不应再阻止发起新申请。
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT 1 FROM sts_token_requests
          WHERE state = 'pending' AND requested_at >= ?
          LIMIT 1`,
        [now - 3600],
      )
      return rows.length > 0
    },
```

- [ ] **Step 4: 运行 store 测试通过**

Run: `TEST_DATABASE_URL='...' bun test tests/store/sts.test.ts`
Expected: PASS

- [ ] **Step 5: 写 manager 层去重 + pruneStale 的失败测试** — 修改 `tests/sts/manager.test.ts`

在该文件的 in-memory `StsStore` 桩上新增 `hasRecentPending` 与 `expireStale`（若尚未实现），并新增用例。桩的默认 `hasRecentPending` 返回 `false`。用例：

```ts
test('ensureFresh：已有在途 pending 时不再重复 POST 申请（去重）', async () => {
  let postCount = 0
  // 构造：getActive 返回 null（无有效 token），hasRecentPending 返回 true
  const store = memStsStore({ active: null, recentPending: true })
  const client = { post: async () => { postCount++; return { req_id: 'x' } } }
  const mgr = createStsManager({ ...baseDeps, store, client } as any)
  await mgr.ensureFresh(1000)
  expect(postCount).toBe(0) // 在途申请已存在，不重复打腾讯 API
})

test('ensureFresh：无有效 token 且无在途 pending 时发起一次 POST', async () => {
  let postCount = 0
  const store = memStsStore({ active: null, recentPending: false })
  const client = { post: async () => { postCount++; return { req_id: 'new-req' } } }
  const mgr = createStsManager({ ...baseDeps, store, client } as any)
  await mgr.ensureFresh(1000)
  expect(postCount).toBe(1)
})

test('pruneStale：委托 store.expireStale 并返回清理条数', async () => {
  const store = memStsStore({ active: null, recentPending: false, expireStaleReturns: 3 })
  const mgr = createStsManager({ ...baseDeps, store } as any)
  expect(await mgr.pruneStale(1000)).toBe(3)
})
```

> 上述 `memStsStore` / `baseDeps` 为该测试文件已有的构造方式的占位名；实现时按文件里现有的桩工厂与依赖构造对齐（该文件已存在 createStsManager 的测试，复用其桩），只需让桩支持 `active`、`recentPending`、`expireStaleReturns` 三个可控点。

- [ ] **Step 6: 运行确认失败**

Run: `bun test tests/sts/manager.test.ts`
Expected: FAIL —`pruneStale` 不是函数；去重用例中 postCount=1（未去重）

- [ ] **Step 7: manager 实现去重与 pruneStale** — 修改 `src/sts/manager.ts`

`StsManager` 接口新增：

```ts
  ensureFresh(now: number): Promise<void>
  pruneStale(now: number): Promise<number>
  getToken(now: number): Promise<string>
  handleWebhook(req: WebhookRequest, now: number): Promise<void>
```

`ensureFresh` 改为在发起 POST 前检查在途 pending：

```ts
    async ensureFresh(now) {
      const active = await deps.store.getActive(now)
      if (active !== null) {
        const remaining = active.expireTs - now
        if (remaining > VALID_TIME_HOURS * 3600 * RENEW_THRESHOLD_RATIO) return
      }
      // 去重：已有未超陈旧窗口的在途申请时，等 webhook 回调即可，不重复 POST，
      // 避免调用间隔短于回调到达时间时产生多条 pending 并浪费腾讯 API 配额。
      if (await deps.store.hasRecentPending(now)) return

      const res = await deps.client.post<{ req_id: string }>('/v1/app/sts-token', {
        operator_id: deps.operatorId,
        operator_id_type: 1,
        valid_time: VALID_TIME_HOURS,
      })
      await deps.store.createRequest(res.req_id, now)
    },

    /** 看门狗：把超陈旧窗口仍未回调的 pending 标记为 expired，返回清理条数 */
    async pruneStale(now) {
      return deps.store.expireStale(now)
    },
```

- [ ] **Step 8: index.ts 在续期循环里接入 pruneStale** — 修改 `src/index.ts` 的 `renewLoop`

```ts
  const renewLoop = (): void => {
    const t = now()
    stsManager.ensureFresh(t).catch((err: unknown) => {
      console.error('sts ensureFresh failed', err)
    })
    // 看门狗另一半：清理超时未回调的 pending，防止其无界增长
    stsManager.pruneStale(t).catch((err: unknown) => {
      console.error('sts pruneStale failed', err)
    })
  }
```

- [ ] **Step 9: 运行 sts 全量 + 全库回归**

Run: `TEST_DATABASE_URL='...' bun test tests/sts/ tests/store/sts.test.ts`
Expected: PASS

- [ ] **Step 10: typecheck + Commit**

```bash
bun run typecheck
git add src/store/sts.ts src/sts/manager.ts src/index.ts tests/store/sts.test.ts tests/sts/manager.test.ts
git commit -m "fix(sts): 接入 expireStale 看门狗 + ensureFresh 去重在途 pending（B5）"
```

---

## Task 6（B6）: 企微扫码登录接通（网关自带最小 /device 确认页）

**Files:**
- Create: `src/http/handlers/device.ts`
- Modify: `src/store/auth.ts`
- Modify: `src/http/router.ts`
- Modify: `src/http/respond.ts`
- Modify: `src/http/handlers/auth.ts`
- Modify: `src/auth/device.ts`
- Create: `tests/http/device.test.ts`

**Interfaces:**
- Produces: `AuthStore` 新增 `findByUserCode(userCode: string): Promise<DeviceAuth | null>`；`respond.ts` 新增 export `escapeHtml(s: string): string`；`GET /device` 路由。
- Consumes: `WecomClient.buildAuthorizeUrl(redirectUri, state)`（已有）、`AppDeps.gatewayBaseUrl`（已有）、`AppDeps.authStore`（已有）。

**背景**：`verification_uri` 指向的 `${baseUrl}/device` 页面不存在（路由表里没有），访问 404。设备授权流程的浏览器确认环节断裂——`buildAuthorizeUrl` 成了死代码（仅测试桩引用），仅凭网关走不完真人登录，US-2.1 待接通。

**登录链路（补全后）**：
```
客户端 POST /api/v1/auth/device/code → 得 user_code + verification_uri（=/device?user_code=X）
用户浏览器打开 /device?user_code=X
  → 本 handler 凭 user_code 查出待授权记录，取其 state
  → 302 跳转企微扫码登录页 buildAuthorizeUrl(${gatewayBaseUrl}/auth/wecom/callback, state)
用户扫码授权 → 企微回调 /auth/wecom/callback?code=&state=
  → wecomCallback 换取身份、completeAuthorization(state) 标记设备已授权
客户端下次轮询 /api/v1/auth/device/token → 拿到会话令牌
```

> **注意**：本任务从「批次 1 已合并」的分支 fork——它改的 `router.ts`（T1 动过）与 `respond.ts`（T3 动过）需是合并后的版本。开始前先跑基线确认全绿。

- [ ] **Step 1: 写 /device 页面的失败测试** — `tests/http/device.test.ts`

```ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Pool } from '../../src/store/db'
import { withTestDb } from '../helpers/testdb'
import { buildTestApp } from './testApp'
import { createAuthStore } from '../../src/store/auth'

let pool: Pool
let cleanup: () => Promise<void>
beforeAll(async () => { const db = await withTestDb(); pool = db.pool; cleanup = db.cleanup })
afterAll(() => cleanup())

async function seedDeviceAuth(o: { userCode: string; state: string; expiresAt: number }): Promise<void> {
  const store = createAuthStore(pool)
  await store.createDeviceAuth({
    deviceCode: `dc-${o.userCode}`, userCode: o.userCode, state: o.state,
    expiresAt: o.expiresAt, now: 1_700_000_000,
  })
}

function deviceReq(qs: string): Request {
  return new Request(`http://gw.example/device${qs}`)
}

test('有效 user_code：302 跳转企微授权页，带上记录里的 state', async () => {
  await seedDeviceAuth({ userCode: 'GOOD-01', state: 'state-good-01', expiresAt: 1_700_000_300 })
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 })
  const res = await app(deviceReq('?user_code=GOOD-01'))
  expect(res.status).toBe(302)
  const loc = res.headers.get('Location')!
  // testApp 的 stubWecomClient.buildAuthorizeUrl 返回 wecom.example/authorize?state=...&redirect=...
  expect(loc).toContain('wecom.example/authorize')
  expect(loc).toContain('state=state-good-01')
  expect(loc).toContain(encodeURIComponent('https://gw.example/auth/wecom/callback'))
})

test('缺 user_code：400 错误页', async () => {
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 })
  const res = await app(deviceReq(''))
  expect(res.status).toBe(400)
  expect(res.headers.get('content-type')).toContain('text/html')
})

test('未知 user_code：400（不区分不存在/已用过/过期）', async () => {
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 })
  const res = await app(deviceReq('?user_code=NOPE'))
  expect(res.status).toBe(400)
})

test('已过期的 user_code：400', async () => {
  await seedDeviceAuth({ userCode: 'EXP-01', state: 'state-exp', expiresAt: 1_700_000_050 })
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 }) // now > expiresAt
  const res = await app(deviceReq('?user_code=EXP-01'))
  expect(res.status).toBe(400)
})

test('已授权（非 pending）的 user_code：400（不可复用）', async () => {
  await seedDeviceAuth({ userCode: 'USED-01', state: 'state-used', expiresAt: 1_700_000_300 })
  const store = createAuthStore(pool)
  await store.authorize('state-used', 'ww-x', 'tm-x') // 置为 authorized
  const { app } = buildTestApp(pool, { now: () => 1_700_000_100 })
  const res = await app(deviceReq('?user_code=USED-01'))
  expect(res.status).toBe(400)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `TEST_DATABASE_URL='...' bun test tests/http/device.test.ts`
Expected: FAIL —`/device` 未注册，全部返回 404

- [ ] **Step 3: store 新增 findByUserCode** — 修改 `src/store/auth.ts`

`AuthStore` 接口在 `findByState` 之后加：

```ts
  /** 按 user_code 查设备授权记录（/device 确认页用 user_code 反查其 state） */
  findByUserCode(userCode: string): Promise<DeviceAuth | null>
```

实现（放在 `findByState` 之后，复用 `mapDeviceAuthRow`）：

```ts
    async findByUserCode(userCode) {
      const [rows] = await pool.execute<DeviceAuthRow[]>(
        `SELECT device_code, user_code, state, status, wecom_userid, tm_userid,
                expires_at, last_polled_at, created_at
           FROM device_authorizations
          WHERE user_code = ?`,
        [userCode],
      )
      const r = rows[0]
      return r ? mapDeviceAuthRow(r) : null
    },
```

- [ ] **Step 4: respond.ts 抽出可复用的 escapeHtml** — 修改 `src/http/respond.ts`

新增 export（放在 `html` 之后）：

```ts
/** HTML 文本转义：用于把不可信内容安全嵌入服务端渲染页面 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}
```

- [ ] **Step 5: handlers/auth.ts 改用共享 escapeHtml + 更新过时注释** — 修改 `src/http/handlers/auth.ts`

- 顶部 import 从 `../respond` 加入 `escapeHtml`：`import { escapeHtml, html, json, readJson } from '../respond'`
- 删除文件底部本地的 `escapeHtml` 函数（第 252–254 行）。
- 更新 `deviceCode` 上方 JSDoc 里「verification_uri 指向的 /device 尚未实现，当前会 404」这段——改为说明 `/device` 已由网关提供，浏览器打开即可跳转企微扫码授权。

- [ ] **Step 6: 新增 /device 页面 handler** — `src/http/handlers/device.ts`

```ts
import { escapeHtml, html } from '../respond'
import type { RouteCtx } from '../router'

/**
 * GET /device?user_code=XXX
 *
 * 设备授权流程（RFC 8628）的人机确认页。CLI/桌面端拿到 user_code 后引导用户在
 * 浏览器打开本页；本页凭 user_code 找到对应的待授权会话、取出其 state，302 跳转到
 * 企业微信扫码登录页。用户扫码授权后企微回调 /auth/wecom/callback?code=&state=，
 * 由 wecomCallback 完成身份映射与设备授权。这样「仅凭网关」即可走完真人登录
 * （US-2.1 的前提）。桌面端将来可用内嵌 webview 覆盖更顺滑的体验。
 */
export async function devicePage(req: Request, ctx: RouteCtx): Promise<Response> {
  const url = new URL(req.url)
  const userCode = url.searchParams.get('user_code')
  if (!userCode) {
    return html(400, errorPage('缺少 user_code 参数，请从客户端重新发起登录。'))
  }

  const record = await ctx.deps.authStore.findByUserCode(userCode)
  const now = ctx.deps.now()
  // 不存在 / 已过期 / 非 pending（已授权或已用过）：统一同一措辞的错误页，
  // 不区分具体原因，避免把「user_code 是否有效」变成可探测信号。
  if (!record || now >= record.expiresAt || record.status !== 'pending') {
    return html(400, errorPage('该登录码无效或已过期，请从客户端重新发起登录。'))
  }

  const redirectUri = `${ctx.deps.gatewayBaseUrl}/auth/wecom/callback`
  const authorizeUrl = ctx.deps.wecomClient.buildAuthorizeUrl(redirectUri, record.state)
  return new Response(null, { status: 302, headers: { Location: authorizeUrl } })
}

function errorPage(message: string): string {
  return `<!doctype html><html><body><h1>登录失败</h1><p>${escapeHtml(message)}</p></body></html>`
}
```

- [ ] **Step 7: 注册 /device 路由** — 修改 `src/http/router.ts`

顶部 import 区加：

```ts
import * as deviceHandlers from './handlers/device'
```

在 `ROUTES` 里，紧跟 wecom 回调那条之后加：

```ts
  compile('GET', '/device', deviceHandlers.devicePage),
```

- [ ] **Step 8: 更新 device.ts 的过时「缺口」注释** — 修改 `src/auth/device.ts`

把 `start()` 里第 85–92 行「已知缺口：/device 验证页面尚未实现……归属待定」的整段注释，更新为：`/device` 页面已由网关提供（见 http/handlers/device.ts），浏览器打开 verification_uri 即会 302 跳转企微扫码授权。同时更新 `DeviceFlowStart.verificationUri` 字段上方第 42 行的「该验证页面尚未实现」注释。

- [ ] **Step 9: 运行 device + http 全量测试通过**

Run: `TEST_DATABASE_URL='...' bun test tests/http/ tests/auth/ tests/store/auth.test.ts`
Expected: PASS（device 5 用例 + auth/http 不回归；handlers/auth.ts 改动后 wecom 回调相关用例仍绿）

- [ ] **Step 10: typecheck + Commit**

```bash
bun run typecheck
git add src/http/handlers/device.ts src/store/auth.ts src/http/router.ts src/http/respond.ts src/http/handlers/auth.ts src/auth/device.ts tests/http/device.test.ts
git commit -m "feat(auth): 网关自带 /device 确认页，接通企微扫码登录（B6）"
```

---

## 最终整体审查

六个任务全部合并后，对整条 `feat/m1-hardening` 分支做一次 opus 全分支审查，重点验证接缝：

- B1 限流是否覆盖全部写型登录端点、恒定时间校验是否在两条路径都真正跑了 verify；
- B4 的集中映射是否真的覆盖所有 handler（包括 download-url 里 catalog 抛的 TencentApiError）；
- B2/B5 都改 `index.ts`，装配区与续期循环是否都正确、无相互覆盖；
- B6 的 state 是否端到端一致（/device 取的 state == 企微回调带回的 state == completeAuthorization 用的 state）；
- 全量 `bun test` 全绿、`bun run typecheck` 干净。

审查通过后走 superpowers:finishing-a-development-branch 收尾。

---

## Self-Review

**Spec 覆盖**：6 项终审「上线前必须修」（B1–B6）各有一个任务，逐项对应。台账里「可带上线的技术债」（meeting_cache TTL、审计列复用、webhook 常量时间验签等）明确不在 M1 范围。

**Placeholder 扫描**：所有生产代码步骤都给了完整可粘贴的代码；测试步骤给了完整用例。唯一以「占位名对齐既有桩」表述的是 T5 的 `memStsStore`/`baseDeps`——因为该测试文件已有 createStsManager 的桩工厂，实现者应复用而非新造，这是刻意保留的对齐指令而非占位。

**类型一致性**：新增接口方法签名前后一致——`createRateLimiter` 返回 `{ allow(key, now) }`；`StsStore.hasRecentPending(now)`、`StsManager.pruneStale(now)`；`AuthStore.findByUserCode(userCode)`；`AppConfig.stsEncKey`；`respond.escapeHtml(s)`。各任务的 Interfaces 块已声明 Produces/Consumes，供只读到本任务的实现者对齐邻接任务的名字与类型。

**冲突复核**：批次 1（T1/T2/T3）落点集合 {ratelimit.ts, service.ts, router.ts} / {expr.ts} / {respond.ts} 两两不相交；T6 因改 router.ts+respond.ts 必须在批次 1 合并后 fork；T4/T5 共用 index.ts 故串行。编排已据此排定。
