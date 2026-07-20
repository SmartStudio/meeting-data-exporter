# 导出网关实现计划（子项目 1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建企业内部署的导出网关，持有腾讯会议 AK/SK 并对客户端提供受策略管控的会议资产清单与临时下载地址。

**Architecture:** 控制平面与数据平面分离——网关处理鉴权、策略、清单（低流量），客户端凭网关签发的临时地址直连对象存储下载（高流量）。模块依赖严格自上而下，`domain` 零依赖，`tencent` 层吸收全部平台细节。

**Tech Stack:** Bun + TypeScript · PostgreSQL · 阿里云部署（Docker）

**Spec:** [`docs/superpowers/specs/2026-07-20-meeting-export-gateway-design.md`](../specs/2026-07-20-meeting-export-gateway-design.md)
**用户故事:** [`docs/superpowers/specs/2026-07-20-user-stories.md`](../specs/2026-07-20-user-stories.md)

## Global Constraints

以下为项目级约束，**每个任务的要求都隐含包含本节**。数值均从 spec 逐字复制。

- **运行时**：Bun ≥ 1.1，TypeScript strict 模式。禁用 `any`（`noImplicitAny` + `strict`）。
- **API Host**：`https://api.meeting.qq.com`，基础路径 `/v1`，Content-Type 恒为 `application/json`（GET 也必须携带）。
- **签名**：`Base64( lowerHex( HmacSHA256(secretKey, stringToSign) ) )` —— HMAC 结果先转小写十六进制字符串，**再**做 Base64。
- **URL 编码先于签名**：query 特殊字符须先 urlencode 再参与签名。URL 构造必须只有一个出口函数，返回 `{ url, uriForSigning }`。
- **错误分类依据**：响应体 `error_info.error_code`，**不得**使用 HTTP status（其只有 400/500 两种取值）。
- **时间单位**：网关对外一律 Unix **秒** + UTC。平台返回的毫秒须在 `tencent` 层归一。
- **查询窗口**：`/v1/records` 单次区间 **≤ 31 天**，`start_time` / `end_time` 为**必填**。
- **分页上限**：`/v1/records` page_size 最大 **20**；`/v1/addresses` 最大 **50**。
- **限流**：对腾讯的调用默认 **5 QPS** 令牌桶，遇 `190310` 自动收敛。
- **下载链接时效**：`/v1/addresses` 6 小时；`/v1/addresses/{id}` **5 分钟**。
- **operator**：全部请求携带 `operator_id` + `operator_id_type=1`（userid）。
- **令牌**：`access_token` JWT 15 分钟；`refresh_token` 不透明串 7 天，存 hash，刷新即轮换。
- **策略默认 deny**：无匹配规则一律拒绝。
- **密钥存储**：SecretKey 与 STS-Token 明文不入库。
- **提交信息**：使用 Conventional Commits（`feat:` / `fix:` / `test:` / `chore:`）。

---

## 依赖图与并行批次

**关键约束：同一批次内的任务不修改同一文件**，可安全并行分派给不同 SubAgent。

```
批次 0（串行 · 1 个）
  T1  项目脚手架 + 领域类型 + 配置
        │
        ├──────────┬──────────┬──────────┐
批次 1（并行 · 4 个）                      │
  T2 签名与URL   T3 错误分类  T4 数据库   T5 令牌工具
        │            │           │           │
        └────┬───────┘           │           │
批次 2（并行 · 3 个）              │           │
  T6 API客户端      T7 Webhook解密  T8 策略引擎
        │                 │           │
        ├─────────────────┤           │
批次 3（并行 · 3 个）                  │
  T9 录制查询    T10 STS生命周期   T11 认证流程
        │              │                │
        └──────┬───────┘                │
批次 4（并行 · 2 个）                    │
  T12 资产清单聚合          T13 审计记录 │
        │                        │       │
        └────────────┬───────────┴───────┘
批次 5（串行 · 1 个）
  T14 HTTP 路由层（组装全部模块）
        │
        ├──────────────┐
批次 6（并行 · 2 个）
  T15 端到端测试    T16 打包与部署自检
```

| 批次 | 任务 | 并行度 | 前置 |
| --- | --- | --- | --- |
| 0 | T1 | 1 | — |
| 1 | T2, T3, T4, T5 | **4** | T1 |
| 2 | T6, T7, T8 | **3** | T2,T3 / T1 / T4 |
| 3 | T9, T10, T11 | **3** | T6 / T6,T7,T4 / T4,T5 |
| 4 | T12, T13 | **2** | T9,T10 / T4 |
| 5 | T14 | 1 | 全部 |
| 6 | T15, T16 | **2** | T14 |

**文件归属表**（防并行冲突，每个文件只由一个任务创建）：

| 任务 | 独占文件 |
| --- | --- |
| T1 | `package.json`, `tsconfig.json`, `src/domain/*`, `src/config.ts` |
| T2 | `src/tencent/signer.ts`, `src/tencent/url.ts` |
| T3 | `src/tencent/errors.ts` |
| T4 | `migrations/*`, `src/store/*` |
| T5 | `src/auth/tokens.ts` |
| T6 | `src/tencent/client.ts`, `src/tencent/ratelimit.ts` |
| T7 | `src/sts/crypto.ts` |
| T8 | `src/policy/*` |
| T9 | `src/tencent/records.ts`, `src/tencent/window.ts` |
| T10 | `src/sts/manager.ts` |
| T11 | `src/auth/device.ts`, `src/auth/wecom.ts`, `src/auth/identity.ts`, `src/auth/service.ts` |
| T12 | `src/catalog/*`, `src/tencent/addresses.ts` |
| T13 | `src/audit/*` |
| T14 | `src/http/*`, `src/index.ts` |
| T15 | `tests/e2e/*`, `tests/fake-tencent/*` |
| T16 | `Dockerfile`, `scripts/preflight.ts`, `docs/deploy.md` |

---

## 前置说明：阻断性未决项

spec §6 列出的阻断项中，**T11 的身份映射依赖 Q1 的答案**（企微 userid 与腾讯会议 userid 的对应关系）。

处理方式：T11 实现三种策略（`direct` / `email` / `table`）与选择机制，**三种都实现**，配置项决定用哪个。这样 Q1 的答案不阻塞编码，只影响部署配置。T16 的 preflight 脚本负责实测验证。

---

## Task 1: 项目脚手架与领域类型

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`
- Create: `src/domain/types.ts`, `src/domain/time.ts`, `src/config.ts`
- Test: `tests/domain/time.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `AssetType`, `RecordState`, `Meeting`, `Asset`, `MeetingSelector`, `ActorIdentity` (types)
  - `msToSec(ms: number | string): number`
  - `secToMs(sec: number): number`
  - `loadConfig(env: Record<string, string | undefined>): AppConfig`
  - `AppConfig` (type)

- [ ] **Step 1: 初始化项目**

```bash
bun init -y
```

写入 `package.json`：

```json
{
  "name": "@yaowu/meeting-export-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

写入 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 2: 写领域类型**

创建 `src/domain/types.ts`：

```ts
/** 八类资产，取值来自腾讯会议 API 响应字段名 */
export const ASSET_TYPES = [
  'video',
  'audio',
  'meeting_summary',
  'ai_meeting_transcripts',
  'ai_minutes',
  'ai_topic_minutes',
  'ai_speaker_minutes',
  'ai_ds_minutes',
] as const

export type AssetType = (typeof ASSET_TYPES)[number]

/** 平台 state：1 录制中 / 2 转码中 / 3 转码完成 */
export type RecordState = 'recording' | 'transcoding' | 'completed'

export interface Meeting {
  meetingId: string
  subMeetingId: string
  meetingRecordId: string
  meetingCode: string
  subject: string
  hostUserId: string
  /** unix 秒 UTC */
  startTime: number
  endTime: number
  state: RecordState
}

export interface Asset {
  /** 网关生成的稳定 ID：<recordFileId>:<assetType>:<index> */
  assetId: string
  meetingId: string
  subMeetingId: string
  assetType: AssetType
  recordFileId: string
  fileType: string | null
  bytesExpected: number | null
  allowDownload: boolean
}

export type MeetingSelector =
  | { kind: 'range'; from: number; to: number }
  | { kind: 'code'; meetingCode: string; from?: number; to?: number }
  | { kind: 'id'; meetingId: string; from?: number; to?: number }

export interface ActorIdentity {
  kind: 'wecom_user' | 'service_account'
  /** 企微 userid；服务账号为 null */
  wecomUserId: string | null
  /** 腾讯会议 userid，策略判定的依据 */
  tmUserId: string
}
```

- [ ] **Step 3: 写时间归一的失败测试**

创建 `tests/domain/time.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { msToSec, secToMs } from '../../src/domain/time'

test('msToSec 把毫秒数字转为秒', () => {
  expect(msToSec(1609313201465)).toBe(1609313201)
})

test('msToSec 接受字符串型毫秒（record_info.start_time 为字符串）', () => {
  expect(msToSec('1603089930577')).toBe(1603089930)
})

test('msToSec 向下取整而非四舍五入', () => {
  expect(msToSec(1999)).toBe(1)
})

test('secToMs 是 msToSec 的逆向', () => {
  expect(secToMs(1609313201)).toBe(1609313201000)
})

test('msToSec 拒绝非法输入', () => {
  expect(() => msToSec('abc')).toThrow('invalid millisecond timestamp')
})
```

- [ ] **Step 4: 运行测试确认失败**

Run: `bun test tests/domain/time.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/time'`

- [ ] **Step 5: 实现时间归一**

创建 `src/domain/time.ts`：

```ts
/**
 * 平台时间戳单位不统一：查询参数为秒，media_start_time / record_*_time 为毫秒，
 * record_info.start_time 为字符串型毫秒。统一在此归一为秒。
 */
export function msToSec(ms: number | string): number {
  const n = typeof ms === 'string' ? Number(ms) : ms
  if (!Number.isFinite(n)) {
    throw new Error(`invalid millisecond timestamp: ${ms}`)
  }
  return Math.floor(n / 1000)
}

export function secToMs(sec: number): number {
  return sec * 1000
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test tests/domain/time.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 7: 写配置加载的失败测试**

创建 `tests/config.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { loadConfig } from '../src/config'

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
  DATABASE_URL: 'postgres://localhost/gw',
  JWT_SECRET: 'c'.repeat(32),
  GATEWAY_BASE_URL: 'https://gw.example.com',
  IDENTITY_STRATEGY: 'direct',
}

test('loadConfig 接受完整配置', () => {
  const cfg = loadConfig(validEnv)
  expect(cfg.tencent.appId).toBe('corp-1')
  expect(cfg.identityStrategy).toBe('direct')
})

test('loadConfig 缺失必填项时报出具体字段名', () => {
  const { TM_SECRET_KEY, ...incomplete } = validEnv
  expect(() => loadConfig(incomplete)).toThrow('TM_SECRET_KEY')
})

test('loadConfig 拒绝非法的 IDENTITY_STRATEGY', () => {
  expect(() => loadConfig({ ...validEnv, IDENTITY_STRATEGY: 'guess' }))
    .toThrow('IDENTITY_STRATEGY')
})

test('loadConfig 校验 webhook token 长度为 25', () => {
  expect(() => loadConfig({ ...validEnv, TM_WEBHOOK_TOKEN: 'short' }))
    .toThrow('TM_WEBHOOK_TOKEN')
})

test('限流默认 5 QPS', () => {
  expect(loadConfig(validEnv).tencent.qps).toBe(5)
})
```

- [ ] **Step 8: 运行测试确认失败**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config'`

- [ ] **Step 9: 实现配置加载**

创建 `src/config.ts`：

```ts
export type IdentityStrategy = 'direct' | 'email' | 'table'

export interface AppConfig {
  tencent: {
    appId: string
    sdkId: string
    secretId: string
    secretKey: string
    operatorId: string
    qps: number
    baseUrl: string
  }
  webhook: {
    token: string
    aesKey: string
  }
  wecom: {
    corpId: string
    agentId: string
    secret: string
  }
  databaseUrl: string
  jwtSecret: string
  gatewayBaseUrl: string
  identityStrategy: IdentityStrategy
}

const IDENTITY_STRATEGIES: readonly IdentityStrategy[] = ['direct', 'email', 'table']

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key]
  if (v === undefined || v === '') {
    throw new Error(`missing required config: ${key}`)
  }
  return v
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const webhookToken = required(env, 'TM_WEBHOOK_TOKEN')
  if (webhookToken.length !== 25) {
    throw new Error('TM_WEBHOOK_TOKEN must be exactly 25 characters')
  }

  const strategy = required(env, 'IDENTITY_STRATEGY')
  if (!IDENTITY_STRATEGIES.includes(strategy as IdentityStrategy)) {
    throw new Error(
      `IDENTITY_STRATEGY must be one of ${IDENTITY_STRATEGIES.join(' | ')}, got: ${strategy}`,
    )
  }

  return {
    tencent: {
      appId: required(env, 'TM_APP_ID'),
      sdkId: required(env, 'TM_SDK_ID'),
      secretId: required(env, 'TM_SECRET_ID'),
      secretKey: required(env, 'TM_SECRET_KEY'),
      operatorId: required(env, 'TM_OPERATOR_ID'),
      qps: Number(env.TM_QPS ?? 5),
      baseUrl: env.TM_BASE_URL ?? 'https://api.meeting.qq.com',
    },
    webhook: {
      token: webhookToken,
      aesKey: required(env, 'TM_WEBHOOK_AES_KEY'),
    },
    wecom: {
      corpId: required(env, 'WECOM_CORP_ID'),
      agentId: required(env, 'WECOM_AGENT_ID'),
      secret: required(env, 'WECOM_SECRET'),
    },
    databaseUrl: required(env, 'DATABASE_URL'),
    jwtSecret: required(env, 'JWT_SECRET'),
    gatewayBaseUrl: required(env, 'GATEWAY_BASE_URL'),
    identityStrategy: strategy as IdentityStrategy,
  }
}
```

创建 `.env.example`，内容为上述所有 key 各一行，值留空并加注释说明来源（`TM_*` 来自腾讯会议企管后台应用凭证，`WECOM_*` 来自企微自建应用）。

- [ ] **Step 10: 运行全部测试与类型检查**

Run: `bun test && bun run typecheck`
Expected: PASS — 10 tests，无类型错误

- [ ] **Step 11: 提交**

```bash
git add package.json tsconfig.json .env.example src/domain src/config.ts tests/
git commit -m "feat: 项目脚手架、领域类型与配置加载"
```

---

## Task 2: AK/SK 签名与 URL 构造

**Files:**
- Create: `src/tencent/signer.ts`, `src/tencent/url.ts`
- Test: `tests/tencent/signer.test.ts`, `tests/tencent/url.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，仅依赖 Bun 内置 crypto）
- Produces:
  - `sign(params: SignParams): string`
  - `SignParams = { secretId, secretKey, method, nonce, timestamp, requestUri, body }`
  - `buildUrl(baseUrl: string, path: string, query: QueryParams): BuiltUrl`
  - `BuiltUrl = { url: string; uriForSigning: string }`
  - `QueryParams = Record<string, string | number | undefined>`
  - `buildAuthHeaders(cfg, method, built, body, stsToken?): Record<string,string>`

- [ ] **Step 1: 写 URL 构造的失败测试**

创建 `tests/tencent/url.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { buildUrl } from '../../src/tencent/url'

test('buildUrl 产出的 url 与 uriForSigning 查询串完全一致', () => {
  const b = buildUrl('https://api.meeting.qq.com', '/v1/records', {
    start_time: 1602950400,
    end_time: 1603123200,
    operator_id: 'KM4Ss4Th09ogUw1JiK',
  })
  const qs = b.url.slice(b.url.indexOf('?'))
  const signQs = b.uriForSigning.slice(b.uriForSigning.indexOf('?'))
  expect(qs).toBe(signQs)
})

test('uriForSigning 不含 host，以 / 开头', () => {
  const b = buildUrl('https://api.meeting.qq.com', '/v1/records', { page: 1 })
  expect(b.uriForSigning).toBe('/v1/records?page=1')
  expect(b.url).toBe('https://api.meeting.qq.com/v1/records?page=1')
})

test('特殊字符被 urlencode（+ 必须编码为 %2B）', () => {
  const b = buildUrl('https://api.meeting.qq.com', '/v1/meetings', {
    userid: '123+123',
  })
  expect(b.uriForSigning).toBe('/v1/meetings?userid=123%2B123')
  expect(b.url).toContain('userid=123%2B123')
})

test('undefined 值的参数被剔除', () => {
  const b = buildUrl('https://api.meeting.qq.com', '/v1/records', {
    page: 1,
    meeting_code: undefined,
  })
  expect(b.uriForSigning).toBe('/v1/records?page=1')
})

test('参数按字典序排列，保证同一组参数产出稳定字符串', () => {
  const a = buildUrl('https://x', '/v1/r', { b: 2, a: 1 })
  const c = buildUrl('https://x', '/v1/r', { a: 1, b: 2 })
  expect(a.uriForSigning).toBe(c.uriForSigning)
  expect(a.uriForSigning).toBe('/v1/r?a=1&b=2')
})

test('无查询参数时不产生问号', () => {
  const b = buildUrl('https://x', '/v1/app/sts-token', {})
  expect(b.uriForSigning).toBe('/v1/app/sts-token')
  expect(b.url).toBe('https://x/v1/app/sts-token')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/tencent/url.test.ts`
Expected: FAIL — `Cannot find module '../../src/tencent/url'`

- [ ] **Step 3: 实现 URL 构造**

创建 `src/tencent/url.ts`：

```ts
export type QueryParams = Record<string, string | number | undefined>

export interface BuiltUrl {
  /** 实际发起请求用的完整 URL */
  url: string
  /** 参与签名计算的 URI（不含 host，含完整查询串） */
  uriForSigning: string
}

/**
 * URL 构造的唯一出口。
 *
 * 平台要求参与签名的 URI 必须与实际请求 URL 逐字节一致，且 query 中的特殊字符
 * （? + = 等）须先 urlencode 再参与签名。因此两者必须由同一处产出——分开拼接
 * 必然出现不一致，且失败时的错误码（190301 / 9042）不会指向真正原因。
 */
export function buildUrl(baseUrl: string, path: string, query: QueryParams): BuiltUrl {
  const entries = Object.entries(query)
    .filter((e): e is [string, string | number] => e[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')

  const uriForSigning = qs === '' ? path : `${path}?${qs}`
  return {
    url: `${baseUrl}${uriForSigning}`,
    uriForSigning,
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/tencent/url.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: 写签名的失败测试**

创建 `tests/tencent/signer.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { sign } from '../../src/tencent/signer'

/** 独立于实现重算一遍，验证双重编码顺序 */
function reference(secretKey: string, stringToSign: string): string {
  const hex = createHmac('sha256', secretKey).update(stringToSign, 'utf8').digest('hex')
  return Buffer.from(hex, 'utf8').toString('base64')
}

const base = {
  secretId: 'AKIDtest',
  secretKey: 'SecretKeyTest',
  method: 'GET' as const,
  nonce: '88080',
  timestamp: '1572168600',
  requestUri: '/v1/records?end_time=2&start_time=1',
  body: '',
}

test('签名等于 base64(lowerHex(hmacSha256))，而非 base64(hmacBytes)', () => {
  const stringToSign =
    'GET\n' +
    'X-TC-Key=AKIDtest&X-TC-Nonce=88080&X-TC-Timestamp=1572168600\n' +
    '/v1/records?end_time=2&start_time=1\n' +
    ''
  expect(sign(base)).toBe(reference(base.secretKey, stringToSign))
})

test('十六进制部分为小写', () => {
  const hexOfSig = Buffer.from(sign(base), 'base64').toString('utf8')
  expect(hexOfSig).toBe(hexOfSig.toLowerCase())
  expect(hexOfSig).toMatch(/^[0-9a-f]{64}$/)
})

test('POST 请求体参与签名', () => {
  const withBody = { ...base, method: 'POST' as const, body: '{"a":1}' }
  const withoutBody = { ...base, method: 'POST' as const, body: '' }
  expect(sign(withBody)).not.toBe(sign(withoutBody))
})

test('nonce 变化导致签名变化（重试须重新签名）', () => {
  expect(sign(base)).not.toBe(sign({ ...base, nonce: '88081' }))
})

test('timestamp 变化导致签名变化', () => {
  expect(sign(base)).not.toBe(sign({ ...base, timestamp: '1572168601' }))
})

test('查询串参与签名', () => {
  expect(sign(base)).not.toBe(sign({ ...base, requestUri: '/v1/records' }))
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `bun test tests/tencent/signer.test.ts`
Expected: FAIL — `Cannot find module '../../src/tencent/signer'`

- [ ] **Step 7: 实现签名器**

创建 `src/tencent/signer.ts`：

```ts
import { createHmac, randomInt } from 'node:crypto'
import type { BuiltUrl } from './url'

export interface SignParams {
  secretId: string
  secretKey: string
  method: 'GET' | 'POST'
  nonce: string
  /** 秒级 unix 时间戳的字符串形式 */
  timestamp: string
  /** 含完整查询串的 URI，须来自 buildUrl 的 uriForSigning */
  requestUri: string
  /** GET 传空串 */
  body: string
}

/**
 * 双重编码：HMAC-SHA256 结果先转小写十六进制字符串，再对该字符串做 Base64。
 * 不是 base64(hmacBytes)——这是最常见的实现错误。
 */
export function sign(p: SignParams): string {
  const headerString =
    `X-TC-Key=${p.secretId}` +
    `&X-TC-Nonce=${p.nonce}` +
    `&X-TC-Timestamp=${p.timestamp}`

  const stringToSign = `${p.method}\n${headerString}\n${p.requestUri}\n${p.body}`

  const hex = createHmac('sha256', p.secretKey).update(stringToSign, 'utf8').digest('hex')
  return Buffer.from(hex, 'utf8').toString('base64')
}

export interface AuthHeaderInput {
  appId: string
  sdkId: string
  secretId: string
  secretKey: string
}

/**
 * 组装全部必需请求头。每次调用生成新的 nonce 与 timestamp——
 * 平台要求二者在五分钟内不可重复（错误码 190301），因此重试时
 * 必须重新调用本函数，不可复用已签名的请求。
 */
export function buildAuthHeaders(
  cfg: AuthHeaderInput,
  method: 'GET' | 'POST',
  built: BuiltUrl,
  body: string,
  stsToken?: string,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = String(randomInt(1, 2 ** 31 - 1))

  const signature = sign({
    secretId: cfg.secretId,
    secretKey: cfg.secretKey,
    method,
    nonce,
    timestamp,
    requestUri: built.uriForSigning,
    body,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-TC-Key': cfg.secretId,
    'X-TC-Timestamp': timestamp,
    'X-TC-Nonce': nonce,
    'X-TC-Signature': signature,
    AppId: cfg.appId,
    SdkId: cfg.sdkId,
    'X-TC-Registered': '1',
  }
  if (stsToken !== undefined) {
    headers['STS-Token'] = stsToken
  }
  return headers
}
```

- [ ] **Step 8: 写请求头组装的测试**

追加到 `tests/tencent/signer.test.ts`：

```ts
import { buildAuthHeaders } from '../../src/tencent/signer'
import { buildUrl } from '../../src/tencent/url'

const authCfg = { appId: 'corp', sdkId: 'sdk', secretId: 'AKIDx', secretKey: 'k' }

test('buildAuthHeaders 含全部必需头，X-TC-Registered 固定为 1', () => {
  const built = buildUrl('https://x', '/v1/records', { page: 1 })
  const h = buildAuthHeaders(authCfg, 'GET', built, '')
  expect(h['Content-Type']).toBe('application/json')
  expect(h['X-TC-Registered']).toBe('1')
  expect(h.AppId).toBe('corp')
  expect(h.SdkId).toBe('sdk')
  expect(h['X-TC-Signature']).toBeTruthy()
  expect(h['STS-Token']).toBeUndefined()
})

test('传入 stsToken 时附加 STS-Token 头', () => {
  const built = buildUrl('https://x', '/v1/addresses/1', {})
  const h = buildAuthHeaders(authCfg, 'GET', built, '', 'tok-123')
  expect(h['STS-Token']).toBe('tok-123')
})

test('两次调用产生不同的 nonce（保证重试时签名不重放）', () => {
  const built = buildUrl('https://x', '/v1/records', { page: 1 })
  const a = buildAuthHeaders(authCfg, 'GET', built, '')
  const b = buildAuthHeaders(authCfg, 'GET', built, '')
  expect(a['X-TC-Nonce']).not.toBe(b['X-TC-Nonce'])
})
```

- [ ] **Step 9: 运行测试确认全部通过**

Run: `bun test tests/tencent/ && bun run typecheck`
Expected: PASS — 15 tests

- [ ] **Step 10: 提交**

```bash
git add src/tencent/signer.ts src/tencent/url.ts tests/tencent/
git commit -m "feat: AK/SK 签名与 URL 单一出口构造"
```

---

## Task 3: 错误分类

**Files:**
- Create: `src/tencent/errors.ts`
- Test: `tests/tencent/errors.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `TencentApiError` (class，含 `errorCode`, `httpStatus`, `apiMessage`, `classification`)
  - `ErrorClass = 'fatal' | 'transient' | 'asset_permanent'`
  - `parseErrorResponse(httpStatus: number, body: unknown): TencentApiError`
  - `classify(errorCode: number): ErrorClass`

- [ ] **Step 1: 写失败测试**

创建 `tests/tencent/errors.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { classify, parseErrorResponse, TencentApiError } from '../../src/tencent/errors'

test('致命错误：鉴权与参数问题不可重试', () => {
  expect(classify(9042)).toBe('fatal')
  expect(classify(500014)).toBe('fatal')
  expect(classify(190004)).toBe('fatal')
  expect(classify(200001)).toBe('fatal')
})

test('瞬时错误：网络与限流可重试', () => {
  expect(classify(960000)).toBe('transient')
  expect(classify(41)).toBe('transient')
  expect(classify(28)).toBe('transient')
  expect(classify(190310)).toBe('transient')
  expect(classify(190301)).toBe('transient')
})

test('资产级永久错误：跳过该资产但不中断整体', () => {
  expect(classify(4051)).toBe('asset_permanent')
  expect(classify(4049)).toBe('asset_permanent')
})

test('未知错误码保守归为瞬时', () => {
  expect(classify(999999)).toBe('transient')
})

/** 关键回归测试：两个都是 HTTP 500，但分类不同 */
test('分类依据 error_code 而非 HTTP status', () => {
  const rateLimited = parseErrorResponse(500, {
    error_info: { error_code: 190310, message: 'rate limited' },
  })
  const deleted = parseErrorResponse(500, {
    error_info: { error_code: 4051, message: 'record deleted' },
  })
  expect(rateLimited.httpStatus).toBe(500)
  expect(deleted.httpStatus).toBe(500)
  expect(rateLimited.classification).toBe('transient')
  expect(deleted.classification).toBe('asset_permanent')
})

test('parseErrorResponse 提取错误码与消息', () => {
  const e = parseErrorResponse(500, {
    error_info: { error_code: 9003, message: 'MEETING NOT EXIST' },
  })
  expect(e).toBeInstanceOf(TencentApiError)
  expect(e.errorCode).toBe(9003)
  expect(e.apiMessage).toBe('MEETING NOT EXIST')
})

test('响应体不含 error_info 时不崩溃，归为瞬时', () => {
  const e = parseErrorResponse(502, 'gateway timeout html page')
  expect(e.errorCode).toBe(-1)
  expect(e.classification).toBe('transient')
})

test('190301 需要重新签名的标记', () => {
  const e = parseErrorResponse(400, {
    error_info: { error_code: 190301, message: 'replay' },
  })
  expect(e.requiresResign).toBe(true)
})

test('190310 需要收敛限流的标记', () => {
  const e = parseErrorResponse(500, {
    error_info: { error_code: 190310, message: 'too many' },
  })
  expect(e.requiresBackoff).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/tencent/errors.test.ts`
Expected: FAIL — `Cannot find module '../../src/tencent/errors'`

- [ ] **Step 3: 实现错误分类**

创建 `src/tencent/errors.ts`：

```ts
export type ErrorClass = 'fatal' | 'transient' | 'asset_permanent'

/** 配置或权限问题，重试无意义，应立即失败并明确告知 */
const FATAL = new Set([9042, 500014, 190004, 200001, 202004])

/** 资产本身不存在，跳过该资产但不影响其他 */
const ASSET_PERMANENT = new Set([4051, 4049])

/**
 * 分类依据是响应体的 error_code，不是 HTTP status——
 * 后者只有 400 与 500 两种取值，承载不了这个区分。
 */
export function classify(errorCode: number): ErrorClass {
  if (FATAL.has(errorCode)) return 'fatal'
  if (ASSET_PERMANENT.has(errorCode)) return 'asset_permanent'
  return 'transient'
}

export class TencentApiError extends Error {
  readonly classification: ErrorClass

  constructor(
    readonly errorCode: number,
    readonly httpStatus: number,
    readonly apiMessage: string,
  ) {
    super(`tencent api error ${errorCode} (http ${httpStatus}): ${apiMessage}`)
    this.name = 'TencentApiError'
    this.classification = classify(errorCode)
  }

  /** X-TC-Nonce / X-TC-Timestamp 五分钟内不可重复，重试须重新签名 */
  get requiresResign(): boolean {
    return this.errorCode === 190301
  }

  /** 每分钟调用超限，除退避外还应收敛令牌桶速率 */
  get requiresBackoff(): boolean {
    return this.errorCode === 190310
  }
}

interface ErrorEnvelope {
  error_info?: { error_code?: number; message?: string }
}

export function parseErrorResponse(httpStatus: number, body: unknown): TencentApiError {
  const envelope = (typeof body === 'object' && body !== null ? body : {}) as ErrorEnvelope
  const code = envelope.error_info?.error_code ?? -1
  const message = envelope.error_info?.message ?? 'unparseable error response'
  return new TencentApiError(code, httpStatus, message)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/tencent/errors.test.ts && bun run typecheck`
Expected: PASS — 9 tests

- [ ] **Step 5: 提交**

```bash
git add src/tencent/errors.ts tests/tencent/errors.test.ts
git commit -m "feat: 腾讯 API 错误三层分类，依据 error_code 而非 HTTP status"
```

---

## Task 4: 数据库 Schema 与 Store 层

**Files:**
- Create: `migrations/001_init.sql`
- Create: `src/store/db.ts`, `src/store/sts.ts`, `src/store/policy.ts`, `src/store/auth.ts`, `src/store/audit.ts`
- Test: `tests/store/*.test.ts`, `tests/helpers/testdb.ts`

**Interfaces:**
- Consumes: `AppConfig` (T1)
- Produces:
  - `createPool(databaseUrl: string): Pool`
  - `runMigrations(pool: Pool): Promise<void>`
  - `StsStore` — `createRequest`, `fulfill`, `getActive`, `expireStale`
  - `PolicyStore` — `listEnabledRules`
  - `AuthStore` — `createDeviceAuth`, `findByUserCode`, `findByState`, `authorize`, `pollDevice`, `saveRefreshToken`, `findRefreshToken`, `revokeFamily`, `findServiceAccount`, `lookupIdentityMap`
  - `AuditStore` — `record`
  - 类型：`StsTokenRecord`, `PolicyRule`, `DeviceAuth`, `RefreshTokenRecord`, `ServiceAccount`, `AuditEntry`

- [ ] **Step 1: 安装 PostgreSQL 驱动**

```bash
bun add postgres
```

- [ ] **Step 2: 写 migration**

创建 `migrations/001_init.sql`（内容为 spec §5.8 的全部建表语句）：

```sql
CREATE TABLE IF NOT EXISTS sts_token_requests (
  req_id        TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  requested_at  BIGINT NOT NULL,
  fulfilled_at  BIGINT,
  expire_ts     BIGINT,
  token_cipher  TEXT
);

CREATE TABLE IF NOT EXISTS policy_rules (
  id            BIGSERIAL PRIMARY KEY,
  priority      INTEGER NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_value TEXT NOT NULL,
  resource_expr JSONB NOT NULL,
  asset_types   TEXT[] NOT NULL,
  effect        TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  BIGINT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  action       TEXT NOT NULL,
  meeting_id   TEXT,
  asset_id     TEXT,
  asset_type   TEXT,
  decision     TEXT NOT NULL,
  matched_rule BIGINT,
  client_kind  TEXT
);

CREATE TABLE IF NOT EXISTS service_accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  tm_userid   TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  expires_at  BIGINT,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_authorizations (
  device_code    TEXT PRIMARY KEY,
  user_code      TEXT NOT NULL UNIQUE,
  state          TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL,
  wecom_userid   TEXT,
  tm_userid      TEXT,
  expires_at     BIGINT NOT NULL,
  last_polled_at BIGINT,
  created_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           BIGSERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  wecom_userid TEXT NOT NULL,
  tm_userid    TEXT NOT NULL,
  family_id    TEXT NOT NULL,
  revoked      BOOLEAN NOT NULL DEFAULT false,
  expires_at   BIGINT NOT NULL,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_map (
  wecom_userid TEXT PRIMARY KEY,
  tm_userid    TEXT NOT NULL,
  email        TEXT,
  updated_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sts_state ON sts_token_requests (state);
```

- [ ] **Step 3: 写测试数据库辅助**

创建 `tests/helpers/testdb.ts`：

```ts
import postgres from 'postgres'
import { runMigrations } from '../../src/store/db'

/**
 * store 层不 mock 数据库——这一层的价值几乎全在 SQL 语义里
 * （UNIQUE 冲突、原子更新、JSONB 查询），mock 掉等于没测。
 * 需要本地或 CI 提供 TEST_DATABASE_URL。
 */
export async function withTestDb(): Promise<{
  sql: postgres.Sql
  cleanup: () => Promise<void>
}> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL not set')

  const schema = `t_${Math.random().toString(36).slice(2, 10)}`
  const sql = postgres(url, { onnotice: () => {} })
  await sql.unsafe(`CREATE SCHEMA ${schema}`)
  await sql.unsafe(`SET search_path TO ${schema}`)
  await runMigrations(sql)

  return {
    sql,
    cleanup: async () => {
      await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await sql.end()
    },
  }
}
```

- [ ] **Step 4: 写 STS store 的失败测试**

创建 `tests/store/sts.test.ts`：

```ts
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type postgres from 'postgres'
import { withTestDb } from '../helpers/testdb'
import { createStsStore } from '../../src/store/sts'

let sql: postgres.Sql
let cleanup: () => Promise<void>

beforeAll(async () => {
  const db = await withTestDb()
  sql = db.sql
  cleanup = db.cleanup
})
afterAll(() => cleanup())

test('createRequest 写入 pending 记录', async () => {
  const store = createStsStore(sql)
  await store.createRequest('req-1', 1000)
  const active = await store.getActive(1000)
  expect(active).toBeNull()
})

test('fulfill 后可取到有效 token', async () => {
  const store = createStsStore(sql)
  await store.createRequest('req-2', 1000)
  await store.fulfill('req-2', 'cipher-abc', 9999, 1100)
  const active = await store.getActive(2000)
  expect(active?.tokenCipher).toBe('cipher-abc')
  expect(active?.expireTs).toBe(9999)
})

test('getActive 忽略已过期的 token', async () => {
  const store = createStsStore(sql)
  await store.createRequest('req-3', 1000)
  await store.fulfill('req-3', 'old', 500, 1100)
  const active = await store.getActive(600)
  expect(active?.tokenCipher).not.toBe('old')
})

test('getActive 取过期时间最晚的一个（新旧并存时用新的）', async () => {
  const store = createStsStore(sql)
  await store.createRequest('req-4', 1000)
  await store.fulfill('req-4', 'newer', 99999, 1200)
  const active = await store.getActive(2000)
  expect(active?.tokenCipher).toBe('newer')
})

test('fulfill 未知 req_id 时抛错（回调无法配对是异常）', async () => {
  const store = createStsStore(sql)
  await expect(store.fulfill('nope', 'x', 1, 1)).rejects.toThrow('unknown req_id')
})
```

- [ ] **Step 5: 运行测试确认失败**

Run: `TEST_DATABASE_URL=postgres://localhost/gw_test bun test tests/store/sts.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/db'`

- [ ] **Step 6: 实现 db 与 sts store**

创建 `src/store/db.ts`：

```ts
import postgres from 'postgres'

export type Sql = postgres.Sql

export function createPool(databaseUrl: string): Sql {
  return postgres(databaseUrl, { max: 10, onnotice: () => {} })
}

export async function runMigrations(sql: Sql): Promise<void> {
  const file = Bun.file(`${import.meta.dir}/../../migrations/001_init.sql`)
  await sql.unsafe(await file.text())
}
```

创建 `src/store/sts.ts`：

```ts
import type { Sql } from './db'

export interface StsTokenRecord {
  reqId: string
  tokenCipher: string
  expireTs: number
}

export interface StsStore {
  createRequest(reqId: string, now: number): Promise<void>
  fulfill(reqId: string, tokenCipher: string, expireTs: number, now: number): Promise<void>
  /** 返回当前有效且过期最晚的 token；无有效 token 时返回 null */
  getActive(now: number): Promise<StsTokenRecord | null>
  expireStale(now: number): Promise<number>
}

export function createStsStore(sql: Sql): StsStore {
  return {
    async createRequest(reqId, now) {
      await sql`
        INSERT INTO sts_token_requests (req_id, state, requested_at)
        VALUES (${reqId}, 'pending', ${now})
        ON CONFLICT (req_id) DO NOTHING
      `
    },

    async fulfill(reqId, tokenCipher, expireTs, now) {
      const rows = await sql`
        UPDATE sts_token_requests
           SET state = 'fulfilled', token_cipher = ${tokenCipher},
               expire_ts = ${expireTs}, fulfilled_at = ${now}
         WHERE req_id = ${reqId}
        RETURNING req_id
      `
      if (rows.length === 0) throw new Error(`unknown req_id: ${reqId}`)
    },

    async getActive(now) {
      const rows = await sql<{ req_id: string; token_cipher: string; expire_ts: number }[]>`
        SELECT req_id, token_cipher, expire_ts
          FROM sts_token_requests
         WHERE state = 'fulfilled' AND expire_ts > ${now}
         ORDER BY expire_ts DESC
         LIMIT 1
      `
      const r = rows[0]
      return r ? { reqId: r.req_id, tokenCipher: r.token_cipher, expireTs: Number(r.expire_ts) } : null
    },

    async expireStale(now) {
      const rows = await sql`
        UPDATE sts_token_requests SET state = 'expired'
         WHERE state = 'pending' AND requested_at < ${now - 3600}
        RETURNING req_id
      `
      return rows.length
    },
  }
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `TEST_DATABASE_URL=postgres://localhost/gw_test bun test tests/store/sts.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 8: 实现其余三个 store 并各写测试**

创建 `src/store/policy.ts`：

```ts
import type { Sql } from './db'

export interface PolicyRule {
  id: number
  priority: number
  subjectType: 'user' | 'department' | 'role'
  subjectValue: string
  resourceExpr: Record<string, unknown>
  assetTypes: string[]
  effect: 'allow' | 'deny'
}

export interface PolicyStore {
  listEnabledRules(): Promise<PolicyRule[]>
}

export function createPolicyStore(sql: Sql): PolicyStore {
  return {
    async listEnabledRules() {
      const rows = await sql<
        {
          id: number
          priority: number
          subject_type: string
          subject_value: string
          resource_expr: Record<string, unknown>
          asset_types: string[]
          effect: string
        }[]
      >`
        SELECT id, priority, subject_type, subject_value, resource_expr, asset_types, effect
          FROM policy_rules
         WHERE enabled = true
         ORDER BY priority ASC, id ASC
      `
      return rows.map((r) => ({
        id: Number(r.id),
        priority: r.priority,
        subjectType: r.subject_type as PolicyRule['subjectType'],
        subjectValue: r.subject_value,
        resourceExpr: r.resource_expr,
        assetTypes: r.asset_types,
        effect: r.effect as PolicyRule['effect'],
      }))
    },
  }
}
```

创建 `src/store/auth.ts`（`AuthStore` 接口，方法见 Interfaces 块）与 `src/store/audit.ts`（`AuditStore.record`）。为每个 store 写测试，覆盖：

- `tests/store/auth.test.ts`：device_code 唯一、user_code 唯一、state 唯一、`authorize` 只对 pending 生效、refresh token 按 hash 查找、`revokeFamily` 吊销整条链
- `tests/store/audit.test.ts`：写入后可按时间倒序查出，`decision` 字段必填
- `tests/store/policy.test.ts`：按 priority 升序返回，`enabled=false` 的规则不返回

- [ ] **Step 9: 运行全部 store 测试**

Run: `TEST_DATABASE_URL=postgres://localhost/gw_test bun test tests/store/ && bun run typecheck`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add migrations src/store tests/store tests/helpers package.json bun.lockb
git commit -m "feat: PostgreSQL schema 与 store 层"
```

---

## Task 5: 令牌工具

**Files:**
- Create: `src/auth/tokens.ts`
- Test: `tests/auth/tokens.test.ts`

**Interfaces:**
- Consumes: `ActorIdentity` (T1)
- Produces:
  - `signAccessToken(identity: ActorIdentity, secret: string, now: number): string`
  - `verifyAccessToken(token: string, secret: string, now: number): ActorIdentity`
  - `generateDeviceCode(): string`（32 字节 base64url）
  - `generateUserCode(): string`（8 位，去除易混字符）
  - `generateOpaqueToken(): string`
  - `hashToken(token: string): string`（sha256 hex）
  - `AccessTokenExpiredError`, `AccessTokenInvalidError` (classes)

- [ ] **Step 1: 写失败测试**

创建 `tests/auth/tokens.test.ts`：

```ts
import { expect, test } from 'bun:test'
import type { ActorIdentity } from '../../src/domain/types'
import {
  AccessTokenExpiredError,
  AccessTokenInvalidError,
  generateDeviceCode,
  generateOpaqueToken,
  generateUserCode,
  hashToken,
  signAccessToken,
  verifyAccessToken,
} from '../../src/auth/tokens'

const identity: ActorIdentity = {
  kind: 'wecom_user',
  wecomUserId: 'ww-alice',
  tmUserId: 'tm-alice',
}
const SECRET = 'x'.repeat(32)

test('签发的令牌可被验证并还原身份', () => {
  const t = signAccessToken(identity, SECRET, 1000)
  expect(verifyAccessToken(t, SECRET, 1100)).toEqual(identity)
})

test('令牌 15 分钟后过期', () => {
  const t = signAccessToken(identity, SECRET, 1000)
  expect(() => verifyAccessToken(t, SECRET, 1000 + 901)).toThrow(AccessTokenExpiredError)
  expect(() => verifyAccessToken(t, SECRET, 1000 + 899)).not.toThrow()
})

test('错误密钥签发的令牌被拒绝', () => {
  const t = signAccessToken(identity, 'y'.repeat(32), 1000)
  expect(() => verifyAccessToken(t, SECRET, 1100)).toThrow(AccessTokenInvalidError)
})

test('篡改载荷的令牌被拒绝', () => {
  const t = signAccessToken(identity, SECRET, 1000)
  const [h, p, s] = t.split('.')
  const tampered = `${h}.${Buffer.from('{"tmUserId":"tm-bob"}').toString('base64url')}.${s}`
  expect(() => verifyAccessToken(tampered, SECRET, 1100)).toThrow(AccessTokenInvalidError)
})

test('令牌中不含策略判定结果（策略须实时评估）', () => {
  const t = signAccessToken(identity, SECRET, 1000)
  const payload = JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString())
  expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'kind', 'tmUserId', 'wecomUserId'])
})

test('user_code 为 8 位且不含易混字符 0 O 1 I', () => {
  for (let i = 0; i < 200; i++) {
    const c = generateUserCode()
    expect(c).toHaveLength(8)
    expect(c).not.toMatch(/[0O1I]/)
  }
})

test('device_code 与 opaque token 每次不同且足够长', () => {
  expect(generateDeviceCode()).not.toBe(generateDeviceCode())
  expect(generateDeviceCode().length).toBeGreaterThanOrEqual(43)
  expect(generateOpaqueToken()).not.toBe(generateOpaqueToken())
})

test('hashToken 稳定且为 sha256 hex', () => {
  expect(hashToken('abc')).toBe(hashToken('abc'))
  expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/auth/tokens.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/tokens'`

- [ ] **Step 3: 实现令牌工具**

创建 `src/auth/tokens.ts`：

```ts
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ActorIdentity } from '../domain/types'

export const ACCESS_TOKEN_TTL_SEC = 900 // 15 分钟
export const REFRESH_TOKEN_TTL_SEC = 7 * 24 * 3600

export class AccessTokenExpiredError extends Error {
  constructor() {
    super('access token expired')
    this.name = 'AccessTokenExpiredError'
  }
}

export class AccessTokenInvalidError extends Error {
  constructor(reason: string) {
    super(`access token invalid: ${reason}`)
    this.name = 'AccessTokenInvalidError'
  }
}

interface Payload {
  kind: ActorIdentity['kind']
  wecomUserId: string | null
  tmUserId: string
  iat: number
  exp: number
}

const b64u = (s: string | Buffer): string => Buffer.from(s).toString('base64url')

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest()
}

/**
 * 载荷只含身份，不含策略判定结果——否则管理员收紧策略后，
 * 持旧令牌者仍可继续导出，出现最长 15 分钟的管控空窗。
 */
export function signAccessToken(identity: ActorIdentity, secret: string, now: number): string {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload: Payload = {
    kind: identity.kind,
    wecomUserId: identity.wecomUserId,
    tmUserId: identity.tmUserId,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SEC,
  }
  const body = `${header}.${b64u(JSON.stringify(payload))}`
  return `${body}.${b64u(hmac(secret, body))}`
}

export function verifyAccessToken(token: string, secret: string, now: number): ActorIdentity {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AccessTokenInvalidError('malformed')
  const [header, payloadPart, sig] = parts as [string, string, string]

  const expected = hmac(secret, `${header}.${payloadPart}`)
  const actual = Buffer.from(sig, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AccessTokenInvalidError('signature mismatch')
  }

  let payload: Payload
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString())
  } catch {
    throw new AccessTokenInvalidError('unparseable payload')
  }
  if (now >= payload.exp) throw new AccessTokenExpiredError()

  return {
    kind: payload.kind,
    wecomUserId: payload.wecomUserId,
    tmUserId: payload.tmUserId,
  }
}

/** 去除 0/O/1/I 等易混字符——user_code 会被用户读出并手工输入 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateUserCode(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length]
  }
  return out
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url')
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/auth/tokens.test.ts && bun run typecheck`
Expected: PASS — 8 tests

- [ ] **Step 5: 提交**

```bash
git add src/auth/tokens.ts tests/auth/tokens.test.ts
git commit -m "feat: JWT 签发校验与一次性码生成"
```

---

## Task 6: 腾讯 API 客户端（限流与重试）

**Files:**
- Create: `src/tencent/ratelimit.ts`, `src/tencent/client.ts`
- Test: `tests/tencent/ratelimit.test.ts`, `tests/tencent/client.test.ts`

**Interfaces:**
- Consumes: `buildUrl`, `buildAuthHeaders` (T2)；`TencentApiError`, `parseErrorResponse` (T3)；`AppConfig` (T1)
- Produces:
  - `createTokenBucket(qps: number): TokenBucket`（`take()`, `converge()`, `currentQps()`）
  - `createTencentClient(cfg, deps): TencentClient`
  - `TencentClient.get<T>(path: string, query: QueryParams, opts?: { stsToken?: string }): Promise<T>`
  - `TencentClient.post<T>(path: string, body: object, opts?): Promise<T>`
  - `TencentClientDeps = { fetch: typeof fetch; sleep: (ms:number)=>Promise<void>; now: ()=>number }`

- [ ] **Step 1: 写令牌桶失败测试**

创建 `tests/tencent/ratelimit.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { createTokenBucket } from '../../src/tencent/ratelimit'

test('初始允许突发到容量上限', async () => {
  const b = createTokenBucket(5)
  for (let i = 0; i < 5; i++) expect(b.tryTake(0)).toBe(true)
  expect(b.tryTake(0)).toBe(false)
})

test('按速率恢复令牌', () => {
  const b = createTokenBucket(5)
  for (let i = 0; i < 5; i++) b.tryTake(0)
  expect(b.tryTake(200)).toBe(true)   // 200ms 恢复 1 个
  expect(b.tryTake(200)).toBe(false)
})

test('converge 收敛速率至一半，下限 1 QPS', () => {
  const b = createTokenBucket(8)
  b.converge()
  expect(b.currentQps()).toBe(4)
  b.converge(); b.converge(); b.converge(); b.converge()
  expect(b.currentQps()).toBe(1)
})
```

- [ ] **Step 2: 运行确认失败，实现令牌桶**

Run: `bun test tests/tencent/ratelimit.test.ts` → FAIL

创建 `src/tencent/ratelimit.ts`：

```ts
export interface TokenBucket {
  tryTake(nowMs: number): boolean
  converge(): void
  currentQps(): number
}

/**
 * 对腾讯的调用集中于网关，限流也集中于此。
 * 遇 190310 时调用 converge() 主动降速，避免持续触发限流。
 */
export function createTokenBucket(initialQps: number): TokenBucket {
  let qps = initialQps
  let tokens = initialQps
  let lastMs = 0

  return {
    tryTake(nowMs) {
      const elapsed = Math.max(0, nowMs - lastMs)
      tokens = Math.min(qps, tokens + (elapsed / 1000) * qps)
      lastMs = nowMs
      if (tokens >= 1) {
        tokens -= 1
        return true
      }
      return false
    },
    converge() {
      qps = Math.max(1, Math.floor(qps / 2))
      tokens = Math.min(tokens, qps)
    },
    currentQps: () => qps,
  }
}
```

- [ ] **Step 3: 写客户端失败测试**

创建 `tests/tencent/client.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { createTencentClient } from '../../src/tencent/client'
import { TencentApiError } from '../../src/tencent/errors'

const cfg = {
  appId: 'corp', sdkId: 'sdk', secretId: 'AKIDx', secretKey: 'k',
  operatorId: 'admin', qps: 5, baseUrl: 'https://api.test',
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0
  const calls: Request[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(input, init))
    const r = responses[Math.min(i++, responses.length - 1)]!
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

const deps = (f: typeof fetch) => ({
  fetch: f,
  sleep: async () => {},
  now: () => 1_700_000_000_000,
})

test('成功响应直接返回解析后的 body', async () => {
  const { fn } = fakeFetch([{ status: 200, body: { total_count: 3 } }])
  const c = createTencentClient(cfg, deps(fn))
  expect(await c.get<{ total_count: number }>('/v1/records', { page: 1 })).toEqual({ total_count: 3 })
})

test('请求携带全部必需头', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: {} }])
  const c = createTencentClient(cfg, deps(fn))
  await c.get('/v1/records', { page: 1 })
  const h = calls[0]!.headers
  expect(h.get('X-TC-Registered')).toBe('1')
  expect(h.get('X-TC-Signature')).toBeTruthy()
  expect(h.get('Content-Type')).toBe('application/json')
})

test('致命错误立即抛出，不重试', async () => {
  const { fn, calls } = fakeFetch([
    { status: 400, body: { error_info: { error_code: 9042, message: 'auth failed' } } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await expect(c.get('/v1/records', {})).rejects.toThrow(TencentApiError)
  expect(calls).toHaveLength(1)
})

test('瞬时错误重试后成功', async () => {
  const { fn, calls } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 960000, message: 'net' } } },
    { status: 200, body: { ok: true } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  expect(await c.get<{ ok: boolean }>('/v1/records', {})).toEqual({ ok: true })
  expect(calls).toHaveLength(2)
})

test('190301 重试时使用新的 nonce 与 timestamp', async () => {
  const { fn, calls } = fakeFetch([
    { status: 400, body: { error_info: { error_code: 190301, message: 'replay' } } },
    { status: 200, body: { ok: true } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await c.get('/v1/records', {})
  expect(calls[0]!.headers.get('X-TC-Nonce')).not.toBe(calls[1]!.headers.get('X-TC-Nonce'))
})

test('190310 触发限流收敛', async () => {
  const { fn } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 190310, message: 'limit' } } },
    { status: 200, body: { ok: true } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await c.get('/v1/records', {})
  expect(c.currentQps()).toBeLessThan(5)
})

test('资产级永久错误不重试', async () => {
  const { fn, calls } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 4051, message: 'deleted' } } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await expect(c.get('/v1/addresses/1', {})).rejects.toMatchObject({ classification: 'asset_permanent' })
  expect(calls).toHaveLength(1)
})

test('超过重试上限后抛出最后一次错误', async () => {
  const { fn, calls } = fakeFetch([
    { status: 500, body: { error_info: { error_code: 41, message: 'timeout' } } },
  ])
  const c = createTencentClient(cfg, deps(fn))
  await expect(c.get('/v1/records', {})).rejects.toThrow(TencentApiError)
  expect(calls).toHaveLength(5)
})
```

- [ ] **Step 4: 运行确认失败**

Run: `bun test tests/tencent/client.test.ts`
Expected: FAIL — `Cannot find module '../../src/tencent/client'`

- [ ] **Step 5: 实现客户端**

创建 `src/tencent/client.ts`：

```ts
import { buildAuthHeaders } from './signer'
import { buildUrl, type QueryParams } from './url'
import { parseErrorResponse, TencentApiError } from './errors'
import { createTokenBucket } from './ratelimit'

export interface TencentClientConfig {
  appId: string
  sdkId: string
  secretId: string
  secretKey: string
  operatorId: string
  qps: number
  baseUrl: string
}

export interface TencentClientDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface RequestOptions {
  stsToken?: string
}

export interface TencentClient {
  get<T>(path: string, query: QueryParams, opts?: RequestOptions): Promise<T>
  post<T>(path: string, body: object, opts?: RequestOptions): Promise<T>
  currentQps(): number
}

const MAX_ATTEMPTS = 5

export function createTencentClient(
  cfg: TencentClientConfig,
  deps: TencentClientDeps,
): TencentClient {
  const bucket = createTokenBucket(cfg.qps)

  async function acquire(): Promise<void> {
    while (!bucket.tryTake(deps.now())) {
      await deps.sleep(1000 / Math.max(1, bucket.currentQps()))
    }
  }

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    query: QueryParams,
    bodyObj: object | null,
    opts: RequestOptions,
  ): Promise<T> {
    const body = bodyObj === null ? '' : JSON.stringify(bodyObj)
    let lastError: TencentApiError | null = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await acquire()

      // 每次重试都重新构造 URL 与请求头——nonce 与 timestamp 必须换新，
      // 否则触发 190301 请求重放错误。
      const built = buildUrl(cfg.baseUrl, path, query)
      const headers = buildAuthHeaders(cfg, method, built, body, opts.stsToken)

      const res = await deps.fetch(built.url, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
      })

      if (res.ok) return (await res.json()) as T

      let parsed: unknown
      try {
        parsed = await res.json()
      } catch {
        parsed = await res.text()
      }
      const err = parseErrorResponse(res.status, parsed)
      lastError = err

      if (err.classification === 'fatal' || err.classification === 'asset_permanent') throw err
      if (err.requiresBackoff) bucket.converge()
      if (attempt < MAX_ATTEMPTS) await deps.sleep(2 ** attempt * 100)
    }

    throw lastError ?? new TencentApiError(-1, 0, 'exhausted retries')
  }

  return {
    get: (path, query, opts = {}) => request('GET', path, query, null, opts),
    post: (path, body, opts = {}) => request('POST', path, {}, body, opts),
    currentQps: () => bucket.currentQps(),
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test tests/tencent/ && bun run typecheck`
Expected: PASS — 全部通过

- [ ] **Step 7: 提交**

```bash
git add src/tencent/client.ts src/tencent/ratelimit.ts tests/tencent/
git commit -m "feat: 腾讯 API 客户端，含令牌桶限流与分类重试"
```

---

## Task 7: Webhook 验签与解密

**Files:**
- Create: `src/sts/crypto.ts`
- Test: `tests/sts/crypto.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `verifySignature(token: string, timestamp: string, nonce: string, encrypted: string, signature: string): boolean`
  - `decryptEvent(aesKey: string, encrypted: string): string`
  - `parseStsEvent(json: string): StsTokenPayload`
  - `StsTokenPayload = { reqId: string; stsToken: string; expireTs: number; operatorUserId: string }`
  - `WebhookVerificationError` (class)

- [ ] **Step 1: 写失败测试**

创建 `tests/sts/crypto.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { parseStsEvent, verifySignature, WebhookVerificationError } from '../../src/sts/crypto'

const TOKEN = 'a'.repeat(25)

function makeSig(token: string, ts: string, nonce: string, data: string): string {
  return createHash('sha1').update([token, ts, nonce, data].sort().join('')).digest('hex')
}

test('正确签名通过校验', () => {
  const sig = makeSig(TOKEN, '1700000000', 'n1', 'cipher')
  expect(verifySignature(TOKEN, '1700000000', 'n1', 'cipher', sig)).toBe(true)
})

test('篡改密文导致校验失败', () => {
  const sig = makeSig(TOKEN, '1700000000', 'n1', 'cipher')
  expect(verifySignature(TOKEN, '1700000000', 'n1', 'TAMPERED', sig)).toBe(false)
})

test('错误 token 无法produce 正确签名', () => {
  const sig = makeSig('b'.repeat(25), '1700000000', 'n1', 'cipher')
  expect(verifySignature(TOKEN, '1700000000', 'n1', 'cipher', sig)).toBe(false)
})

test('parseStsEvent 提取 req_id 与 token', () => {
  const payload = parseStsEvent(
    JSON.stringify({
      event: 'common.sts-token',
      trace_id: 'trace-1',
      payload: [
        {
          operate_time: 1609313201465,
          operator: { userid: 'admin', user_name: 'Admin' },
          token_info: { req_id: 'req-9', sts_token: 'tok-9', expire_ts: 1609399601 },
        },
      ],
    }),
  )
  expect(payload).toEqual({
    reqId: 'req-9',
    stsToken: 'tok-9',
    expireTs: 1609399601,
    operatorUserId: 'admin',
  })
})

test('非 sts-token 事件被拒绝', () => {
  expect(() => parseStsEvent(JSON.stringify({ event: 'other.event', payload: [] })))
    .toThrow(WebhookVerificationError)
})

test('payload 为空数组时报错而非静默返回', () => {
  expect(() => parseStsEvent(JSON.stringify({ event: 'common.sts-token', payload: [] })))
    .toThrow(WebhookVerificationError)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/sts/crypto.test.ts` → FAIL

- [ ] **Step 3: 实现验签与事件解析**

创建 `src/sts/crypto.ts`：

```ts
import { createHash, createDecipheriv } from 'node:crypto'

export class WebhookVerificationError extends Error {
  constructor(reason: string) {
    super(`webhook verification failed: ${reason}`)
    this.name = 'WebhookVerificationError'
  }
}

/**
 * 回调 URL 公开可达，不验签等于允许任何人投递伪造的 STS-Token。
 * 算法：token / timestamp / nonce / 密文 四者字典序拼接后 sha1。
 */
export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
  signature: string,
): boolean {
  const expected = createHash('sha1')
    .update([token, timestamp, nonce, encrypted].sort().join(''))
    .digest('hex')
  return expected === signature
}

/**
 * EncodingAESKey 为 43 字符 base64，补 '=' 后解出 32 字节 AES key，
 * 密文前 16 字节为 IV。明文结构：16 随机字节 + 4 字节网络序长度 + JSON + corpid。
 */
export function decryptEvent(aesKey: string, encrypted: string): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const cipher = Buffer.from(encrypted, 'base64')
  const iv = key.subarray(0, 16)

  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  const padded = Buffer.concat([decipher.update(cipher), decipher.final()])

  const padLen = padded[padded.length - 1] ?? 0
  const plain = padded.subarray(0, padded.length - padLen)

  const msgLen = plain.readUInt32BE(16)
  return plain.subarray(20, 20 + msgLen).toString('utf8')
}

export interface StsTokenPayload {
  reqId: string
  stsToken: string
  expireTs: number
  operatorUserId: string
}

export function parseStsEvent(json: string): StsTokenPayload {
  let parsed: {
    event?: string
    payload?: Array<{
      operator?: { userid?: string }
      token_info?: { req_id?: string; sts_token?: string; expire_ts?: number }
    }>
  }
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new WebhookVerificationError('payload is not valid json')
  }

  if (parsed.event !== 'common.sts-token') {
    throw new WebhookVerificationError(`unexpected event: ${parsed.event}`)
  }
  const first = parsed.payload?.[0]
  const info = first?.token_info
  if (!info?.req_id || !info.sts_token || typeof info.expire_ts !== 'number') {
    throw new WebhookVerificationError('missing token_info fields')
  }

  return {
    reqId: info.req_id,
    stsToken: info.sts_token,
    expireTs: info.expire_ts,
    operatorUserId: first?.operator?.userid ?? '',
  }
}
```

> **实现注记**：`verifySignature` 与 `decryptEvent` 的具体算法须以
> [事件加解密文档](https://cloud.tencent.com/document/product/1095/54658) 为准。
> 本任务先按上述通用企业回调约定实现并通过单元测试；接入联调时若与文档不符，
> 只需修改这两个函数，其调用方（T10）不受影响。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/sts/crypto.test.ts && bun run typecheck`
Expected: PASS — 6 tests

- [ ] **Step 5: 提交**

```bash
git add src/sts/crypto.ts tests/sts/crypto.test.ts
git commit -m "feat: Webhook 验签与 STS 事件解析"
```

---

## Task 8: 策略引擎

**Files:**
- Create: `src/policy/expr.ts`, `src/policy/engine.ts`
- Test: `tests/policy/expr.test.ts`, `tests/policy/engine.test.ts`

**Interfaces:**
- Consumes: `Meeting`, `AssetType`, `ActorIdentity` (T1)；`PolicyRule`, `PolicyStore` (T4)
- Produces:
  - `matchExpr(expr: Record<string, unknown>, meeting: Meeting): boolean`
  - `createPolicyEngine(store: PolicyStore): PolicyEngine`
  - `PolicyEngine.decide(input: PolicyInput): Promise<PolicyDecision>`
  - `PolicyInput = { actor: ActorIdentity; meeting: Meeting; assetType: AssetType }`
  - `PolicyDecision = { effect: 'allow' | 'deny'; matchedRuleId: number | null }`

- [ ] **Step 1: 写表达式求值失败测试**

创建 `tests/policy/expr.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { matchExpr } from '../../src/policy/expr'
import type { Meeting } from '../../src/domain/types'

const meeting: Meeting = {
  meetingId: 'm1', subMeetingId: '', meetingRecordId: 'r1', meetingCode: '88123456',
  subject: '季度评审', hostUserId: 'tm-alice', startTime: 1767225600,
  endTime: 1767229200, state: 'completed',
}

test('空表达式匹配任何会议', () => {
  expect(matchExpr({}, meeting)).toBe(true)
})

test('等值匹配', () => {
  expect(matchExpr({ host_userid: 'tm-alice' }, meeting)).toBe(true)
  expect(matchExpr({ host_userid: 'tm-bob' }, meeting)).toBe(false)
})

test('集合包含匹配', () => {
  expect(matchExpr({ host_userid: ['tm-alice', 'tm-bob'] }, meeting)).toBe(true)
  expect(matchExpr({ host_userid: ['tm-bob'] }, meeting)).toBe(false)
})

test('not_in 操作', () => {
  expect(matchExpr({ host_userid: { not_in: ['tm-bob'] } }, meeting)).toBe(true)
  expect(matchExpr({ host_userid: { not_in: ['tm-alice'] } }, meeting)).toBe(false)
})

test('时间区间 gte / lte', () => {
  expect(matchExpr({ start_time: { gte: 1767225600 } }, meeting)).toBe(true)
  expect(matchExpr({ start_time: { gte: 1767225601 } }, meeting)).toBe(false)
  expect(matchExpr({ start_time: { lte: 1767225600 } }, meeting)).toBe(true)
})

test('多个键之间为 AND', () => {
  expect(matchExpr({ host_userid: 'tm-alice', meeting_code: '88123456' }, meeting)).toBe(true)
  expect(matchExpr({ host_userid: 'tm-alice', meeting_code: '99' }, meeting)).toBe(false)
})

test('未知字段名不匹配（防拼写错误导致规则意外放行）', () => {
  expect(matchExpr({ nonexistent_field: 'x' }, meeting)).toBe(false)
})
```

- [ ] **Step 2: 运行确认失败，实现表达式求值**

Run: `bun test tests/policy/expr.test.ts` → FAIL

创建 `src/policy/expr.ts`：

```ts
import type { Meeting } from '../domain/types'

/** 仅支持等值、集合包含、时间区间——策略需被管理员读懂并审计，可编程性不是目标 */
const FIELD_ACCESSORS: Record<string, (m: Meeting) => string | number> = {
  host_userid: (m) => m.hostUserId,
  meeting_code: (m) => m.meetingCode,
  meeting_id: (m) => m.meetingId,
  subject: (m) => m.subject,
  start_time: (m) => m.startTime,
  end_time: (m) => m.endTime,
}

function matchOne(condition: unknown, actual: string | number): boolean {
  if (Array.isArray(condition)) return condition.includes(actual)
  if (condition !== null && typeof condition === 'object') {
    const c = condition as { not_in?: unknown[]; gte?: number; lte?: number }
    if (c.not_in !== undefined && c.not_in.includes(actual)) return false
    if (c.gte !== undefined && Number(actual) < c.gte) return false
    if (c.lte !== undefined && Number(actual) > c.lte) return false
    return true
  }
  return condition === actual
}

export function matchExpr(expr: Record<string, unknown>, meeting: Meeting): boolean {
  for (const [field, condition] of Object.entries(expr)) {
    const accessor = FIELD_ACCESSORS[field]
    if (!accessor) return false // 未知字段一律不匹配，避免拼写错误意外放行
    if (!matchOne(condition, accessor(meeting))) return false
  }
  return true
}
```

- [ ] **Step 3: 写引擎失败测试**

创建 `tests/policy/engine.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { createPolicyEngine } from '../../src/policy/engine'
import type { PolicyRule, PolicyStore } from '../../src/store/policy'
import type { ActorIdentity, Meeting } from '../../src/domain/types'

const meeting: Meeting = {
  meetingId: 'm1', subMeetingId: '', meetingRecordId: 'r1', meetingCode: '881',
  subject: 'S', hostUserId: 'tm-alice', startTime: 100, endTime: 200, state: 'completed',
}
const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-a', tmUserId: 'tm-alice' }

function stubStore(rules: PolicyRule[]): PolicyStore {
  return { listEnabledRules: async () => rules }
}

const rule = (o: Partial<PolicyRule>): PolicyRule => ({
  id: 1, priority: 10, subjectType: 'user', subjectValue: 'tm-alice',
  resourceExpr: {}, assetTypes: ['*'], effect: 'allow', ...o,
})

test('无规则时默认拒绝', async () => {
  const e = createPolicyEngine(stubStore([]))
  expect(await e.decide({ actor: alice, meeting, assetType: 'video' }))
    .toEqual({ effect: 'deny', matchedRuleId: null })
})

test('匹配的 allow 规则放行', async () => {
  const e = createPolicyEngine(stubStore([rule({})]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('allow')
})

test('主体不匹配时不适用该规则', async () => {
  const e = createPolicyEngine(stubStore([rule({ subjectValue: 'tm-bob' })]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('deny')
})

test('资产类型不在规则范围内时不适用', async () => {
  const e = createPolicyEngine(stubStore([rule({ assetTypes: ['ai_minutes'] })]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('deny')
})

test('低 priority 值优先', async () => {
  const e = createPolicyEngine(stubStore([
    rule({ id: 2, priority: 20, effect: 'allow' }),
    rule({ id: 1, priority: 10, effect: 'deny' }),
  ]))
  const d = await e.decide({ actor: alice, meeting, assetType: 'video' })
  expect(d).toEqual({ effect: 'deny', matchedRuleId: 1 })
})

test('同优先级下 deny 优先于 allow', async () => {
  const e = createPolicyEngine(stubStore([
    rule({ id: 1, priority: 10, effect: 'allow' }),
    rule({ id: 2, priority: 10, effect: 'deny' }),
  ]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('deny')
})

test('resourceExpr 参与匹配', async () => {
  const e = createPolicyEngine(stubStore([
    rule({ resourceExpr: { host_userid: 'tm-bob' } }),
  ]))
  expect((await e.decide({ actor: alice, meeting, assetType: 'video' })).effect).toBe('deny')
})

test('服务账号同样受策略约束', async () => {
  const svc: ActorIdentity = { kind: 'service_account', wecomUserId: null, tmUserId: 'tm-svc' }
  const e = createPolicyEngine(stubStore([rule({})]))
  expect((await e.decide({ actor: svc, meeting, assetType: 'video' })).effect).toBe('deny')
})
```

- [ ] **Step 4: 运行确认失败，实现引擎**

Run: `bun test tests/policy/engine.test.ts` → FAIL

创建 `src/policy/engine.ts`：

```ts
import type { ActorIdentity, AssetType, Meeting } from '../domain/types'
import type { PolicyRule, PolicyStore } from '../store/policy'
import { matchExpr } from './expr'

export interface PolicyInput {
  actor: ActorIdentity
  meeting: Meeting
  assetType: AssetType
}

export interface PolicyDecision {
  effect: 'allow' | 'deny'
  matchedRuleId: number | null
}

export interface PolicyEngine {
  decide(input: PolicyInput): Promise<PolicyDecision>
}

function subjectMatches(rule: PolicyRule, actor: ActorIdentity): boolean {
  // 当前仅支持按 user 匹配；department / role 需组织架构数据，属后续能力
  if (rule.subjectType === 'user') return rule.subjectValue === actor.tmUserId
  return false
}

function assetMatches(rule: PolicyRule, assetType: AssetType): boolean {
  return rule.assetTypes.includes('*') || rule.assetTypes.includes(assetType)
}

/**
 * 默认 deny：无任何匹配规则时拒绝。归档工具面对全公司会议录音，
 * 安全默认值优于可用默认值。
 */
export function createPolicyEngine(store: PolicyStore): PolicyEngine {
  return {
    async decide({ actor, meeting, assetType }) {
      const rules = await store.listEnabledRules()
      const applicable = rules.filter(
        (r) => subjectMatches(r, actor) && assetMatches(r, assetType) && matchExpr(r.resourceExpr, meeting),
      )
      if (applicable.length === 0) return { effect: 'deny', matchedRuleId: null }

      // 按 priority 升序取第一条；同优先级下 deny 优先
      applicable.sort((a, b) =>
        a.priority !== b.priority
          ? a.priority - b.priority
          : a.effect === b.effect ? 0 : a.effect === 'deny' ? -1 : 1,
      )
      const winner = applicable[0]!
      return { effect: winner.effect, matchedRuleId: winner.id }
    },
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/policy/ && bun run typecheck`
Expected: PASS — 15 tests

- [ ] **Step 6: 提交**

```bash
git add src/policy tests/policy
git commit -m "feat: 策略引擎，默认拒绝且 deny 优先"
```

---

## Task 9: 录制查询与窗口切分

**Files:**
- Create: `src/tencent/window.ts`, `src/tencent/records.ts`
- Test: `tests/tencent/window.test.ts`, `tests/tencent/records.test.ts`

**Interfaces:**
- Consumes: `TencentClient` (T6)；`Meeting`, `MeetingSelector`, `msToSec` (T1)
- Produces:
  - `splitWindows(from: number, to: number): Array<{ from: number; to: number }>`
  - `MAX_WINDOW_SEC = 31 * 24 * 3600`
  - `DEFAULT_WINDOW_SEC = 31 * 24 * 3600`
  - `createRecordsApi(client, operatorId): RecordsApi`
  - `RecordsApi.listMeetings(selector: MeetingSelector, now: number): Promise<Meeting[]>`
  - `MeetingNotFoundInRangeError` (class)

- [ ] **Step 1: 写窗口切分失败测试**

创建 `tests/tencent/window.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { MAX_WINDOW_SEC, splitWindows } from '../../src/tencent/window'

const DAY = 86400

test('小于 31 天返回单个窗口', () => {
  expect(splitWindows(0, 10 * DAY)).toEqual([{ from: 0, to: 10 * DAY }])
})

test('恰好 31 天不切分', () => {
  expect(splitWindows(0, MAX_WINDOW_SEC)).toHaveLength(1)
})

test('90 天切成 3 个窗口', () => {
  const w = splitWindows(0, 90 * DAY)
  expect(w).toHaveLength(3)
  expect(w[0]!.from).toBe(0)
  expect(w[2]!.to).toBe(90 * DAY)
})

test('窗口左闭右开，无重叠无遗漏', () => {
  const w = splitWindows(0, 90 * DAY)
  for (let i = 1; i < w.length; i++) {
    expect(w[i]!.from).toBe(w[i - 1]!.to)
  }
})

test('每个窗口都不超过上限', () => {
  for (const win of splitWindows(0, 200 * DAY)) {
    expect(win.to - win.from).toBeLessThanOrEqual(MAX_WINDOW_SEC)
  }
})

test('from 大于 to 时抛错', () => {
  expect(() => splitWindows(100, 50)).toThrow('invalid range')
})
```

- [ ] **Step 2: 运行确认失败，实现窗口切分**

Run: `bun test tests/tencent/window.test.ts` → FAIL

创建 `src/tencent/window.ts`：

```ts
/** 平台限制：/v1/records 单次查询区间不得超过 31 天 */
export const MAX_WINDOW_SEC = 31 * 24 * 3600
export const DEFAULT_WINDOW_SEC = 31 * 24 * 3600

export interface Window {
  from: number
  to: number
}

/** 左闭右开切分，保证无重叠无遗漏 */
export function splitWindows(from: number, to: number): Window[] {
  if (from > to) throw new Error(`invalid range: from ${from} > to ${to}`)
  const windows: Window[] = []
  let cursor = from
  while (cursor < to) {
    const next = Math.min(cursor + MAX_WINDOW_SEC, to)
    windows.push({ from: cursor, to: next })
    cursor = next
  }
  return windows.length > 0 ? windows : [{ from, to }]
}
```

- [ ] **Step 3: 写录制查询失败测试**

创建 `tests/tencent/records.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { createRecordsApi, MeetingNotFoundInRangeError } from '../../src/tencent/records'
import type { QueryParams } from '../../src/tencent/url'
import type { TencentClient } from '../../src/tencent/client'

const NOW = 1_800_000_000

function stubClient(pages: unknown[]): { client: TencentClient; queries: QueryParams[] } {
  const queries: QueryParams[] = []
  let i = 0
  return {
    queries,
    client: {
      get: async <T,>(_p: string, q: QueryParams) => {
        queries.push(q)
        return (pages[Math.min(i++, pages.length - 1)] ?? {}) as T
      },
      post: async <T,>() => ({}) as T,
      currentQps: () => 5,
    },
  }
}

const onePage = (meetings: unknown[]) => ({
  total_count: meetings.length, current_size: meetings.length,
  current_page: 1, total_page: 1, record_meetings: meetings,
})

const rawMeeting = {
  meeting_record_id: 'rec-1', meeting_id: 'm-1', meeting_code: '88123456',
  host_user_id: 'tm-alice', media_start_time: 1767225600000, subject: '评审',
  state: 3, record_type: 0, record_files: [],
}

test('毫秒时间戳被归一为秒', async () => {
  const { client } = stubClient([onePage([rawMeeting])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.startTime).toBe(1767225600)
})

test('state 数字映射为语义值', async () => {
  const { client } = stubClient([onePage([{ ...rawMeeting, state: 2 }])])
  const api = createRecordsApi(client, 'admin')
  const [m] = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(m!.state).toBe('transcoding')
})

test('查询携带 operator_id 与 operator_id_type=1', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin-uid')
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries[0]!.operator_id).toBe('admin-uid')
  expect(queries[0]!.operator_id_type).toBe(1)
})

test('page_size 不超过 20', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(Number(queries[0]!.page_size)).toBeLessThanOrEqual(20)
})

test('90 天范围触发 3 次窗口查询', async () => {
  const { client, queries } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'range', from: 0, to: 90 * 86400 }, NOW)
  expect(queries).toHaveLength(3)
})

test('多页时自动翻页', async () => {
  const { client, queries } = stubClient([
    { total_count: 25, current_size: 20, current_page: 1, total_page: 2, record_meetings: [rawMeeting] },
    { total_count: 25, current_size: 5, current_page: 2, total_page: 2, record_meetings: [rawMeeting] },
  ])
  const api = createRecordsApi(client, 'admin')
  const ms = await api.listMeetings({ kind: 'range', from: 0, to: 1000 }, NOW)
  expect(queries).toHaveLength(2)
  expect(ms).toHaveLength(2)
})

test('未指定时间时按会议号查，默认取最近 31 天', async () => {
  const { client, queries } = stubClient([onePage([rawMeeting])])
  const api = createRecordsApi(client, 'admin')
  await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  expect(queries[0]!.meeting_code).toBe('88123456')
  expect(Number(queries[0]!.end_time)).toBe(NOW)
  expect(Number(queries[0]!.start_time)).toBe(NOW - 31 * 86400)
})

test('会议号命中多场时全部返回，不擅自择一', async () => {
  const { client } = stubClient([
    onePage([rawMeeting, { ...rawMeeting, meeting_id: 'm-2', meeting_record_id: 'rec-2' }]),
  ])
  const api = createRecordsApi(client, 'admin')
  const ms = await api.listMeetings({ kind: 'code', meetingCode: '88123456' }, NOW)
  expect(ms).toHaveLength(2)
})

test('按 ID 查询但范围内无结果时抛出可区分的错误', async () => {
  const { client } = stubClient([onePage([])])
  const api = createRecordsApi(client, 'admin')
  await expect(api.listMeetings({ kind: 'id', meetingId: 'm-x' }, NOW))
    .rejects.toThrow(MeetingNotFoundInRangeError)
})
```

- [ ] **Step 4: 运行确认失败，实现录制查询**

Run: `bun test tests/tencent/records.test.ts` → FAIL

创建 `src/tencent/records.ts`：

```ts
import type { Meeting, MeetingSelector, RecordState } from '../domain/types'
import { msToSec } from '../domain/time'
import type { TencentClient } from './client'
import { DEFAULT_WINDOW_SEC, splitWindows } from './window'

const PAGE_SIZE = 20 // 平台上限

export class MeetingNotFoundInRangeError extends Error {
  constructor(readonly identifier: string, readonly from: number, readonly to: number) {
    super(
      `meeting ${identifier} not found within [${from}, ${to}]. ` +
        'The meeting may exist outside this range — widen the time range and retry.',
    )
    this.name = 'MeetingNotFoundInRangeError'
  }
}

interface RawRecordMeeting {
  meeting_record_id: string
  meeting_id: string
  meeting_code: string
  host_user_id: string
  media_start_time: number
  subject: string
  state: number
}

interface RawListResponse {
  total_page?: number
  record_meetings?: RawRecordMeeting[]
}

const STATE_MAP: Record<number, RecordState> = {
  1: 'recording',
  2: 'transcoding',
  3: 'completed',
}

export interface RecordsApi {
  listMeetings(selector: MeetingSelector, now: number): Promise<Meeting[]>
}

export function createRecordsApi(client: TencentClient, operatorId: string): RecordsApi {
  async function fetchWindow(
    from: number,
    to: number,
    extra: { meeting_id?: string; meeting_code?: string },
  ): Promise<Meeting[]> {
    const out: Meeting[] = []
    let page = 1
    let totalPage = 1

    do {
      const res = await client.get<RawListResponse>('/v1/records', {
        operator_id: operatorId,
        operator_id_type: 1,
        start_time: from,
        end_time: to,
        page,
        page_size: PAGE_SIZE,
        ...extra,
      })
      totalPage = res.total_page ?? 1
      for (const r of res.record_meetings ?? []) {
        out.push({
          meetingId: r.meeting_id,
          subMeetingId: '',
          meetingRecordId: r.meeting_record_id,
          meetingCode: r.meeting_code,
          subject: r.subject,
          hostUserId: r.host_user_id,
          startTime: msToSec(r.media_start_time),
          endTime: msToSec(r.media_start_time),
          state: STATE_MAP[r.state] ?? 'recording',
        })
      }
      page++
    } while (page <= totalPage)

    return out
  }

  return {
    async listMeetings(selector, now) {
      // 平台要求 start_time / end_time 必填，不存在仅凭 ID 查询的路径。
      // 未指定时间时补默认窗口（最近 31 天，正好是单次查询上限）。
      const from = selector.kind === 'range' ? selector.from : (selector.from ?? now - DEFAULT_WINDOW_SEC)
      const to = selector.kind === 'range' ? selector.to : (selector.to ?? now)

      const extra =
        selector.kind === 'code'
          ? { meeting_code: selector.meetingCode }
          : selector.kind === 'id'
            ? { meeting_id: selector.meetingId }
            : {}

      const results: Meeting[] = []
      for (const w of splitWindows(from, to)) {
        results.push(...(await fetchWindow(w.from, w.to, extra)))
      }

      if (results.length === 0 && selector.kind !== 'range') {
        const id = selector.kind === 'code' ? selector.meetingCode : selector.meetingId
        throw new MeetingNotFoundInRangeError(id, from, to)
      }
      return results
    },
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/tencent/ && bun run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/tencent/records.ts src/tencent/window.ts tests/tencent/
git commit -m "feat: 录制列表查询、31 天窗口切分与选择器"
```

---

## Task 10: STS-Token 生命周期管理

**Files:**
- Create: `src/sts/manager.ts`
- Test: `tests/sts/manager.test.ts`

**Interfaces:**
- Consumes: `TencentClient` (T6)；`parseStsEvent`, `verifySignature`, `decryptEvent` (T7)；`StsStore` (T4)
- Produces:
  - `createStsManager(deps): StsManager`
  - `StsManager.ensureFresh(now: number): Promise<void>`
  - `StsManager.getToken(now: number): Promise<string>`
  - `StsManager.handleWebhook(raw: WebhookRequest, now: number): Promise<void>`
  - `StsTokenUnavailableError` (class)
  - `WebhookRequest = { timestamp: string; nonce: string; signature: string; encrypted: string }`

- [ ] **Step 1: 写失败测试**

创建 `tests/sts/manager.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { createStsManager, StsTokenUnavailableError } from '../../src/sts/manager'
import type { StsStore, StsTokenRecord } from '../../src/store/sts'

function memStore(): StsStore & { records: Map<string, StsTokenRecord & { state: string }> } {
  const records = new Map<string, StsTokenRecord & { state: string }>()
  return {
    records,
    async createRequest(reqId) {
      records.set(reqId, { reqId, tokenCipher: '', expireTs: 0, state: 'pending' })
    },
    async fulfill(reqId, cipher, expireTs) {
      const r = records.get(reqId)
      if (!r) throw new Error(`unknown req_id: ${reqId}`)
      records.set(reqId, { reqId, tokenCipher: cipher, expireTs, state: 'fulfilled' })
    },
    async getActive(now) {
      const valid = [...records.values()].filter((r) => r.state === 'fulfilled' && r.expireTs > now)
      valid.sort((a, b) => b.expireTs - a.expireTs)
      return valid[0] ?? null
    },
    async expireStale() { return 0 },
  }
}

const deps = (store: StsStore, posts: string[] = []) => ({
  store,
  client: {
    get: async <T,>() => ({}) as T,
    post: async <T,>(_p: string, body: object) => {
      posts.push(JSON.stringify(body))
      return { req_id: `req-${posts.length}` } as T
    },
    currentQps: () => 5,
  },
  operatorId: 'admin',
  webhookToken: 'a'.repeat(25),
  aesKey: 'b'.repeat(43),
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ''),
  verify: () => true,
  decryptEvent: (_k: string, c: string) => c,
})

test('无有效 token 时 getToken 抛出可识别错误', async () => {
  const m = createStsManager(deps(memStore()))
  await expect(m.getToken(1000)).rejects.toThrow(StsTokenUnavailableError)
})

test('ensureFresh 在无 token 时发起申请', async () => {
  const posts: string[] = []
  const m = createStsManager(deps(memStore(), posts))
  await m.ensureFresh(1000)
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0]!).valid_time).toBe(24)
})

test('剩余有效期大于 1/3 时不重复申请', async () => {
  const store = memStore()
  const posts: string[] = []
  const m = createStsManager(deps(store, posts))
  await store.createRequest('r1', 0)
  await store.fulfill('r1', 'enc(tok)', 1000 + 24 * 3600, 0)
  await m.ensureFresh(1000)
  expect(posts).toHaveLength(0)
})

test('剩余有效期低于 1/3 时提前续期', async () => {
  const store = memStore()
  const posts: string[] = []
  const m = createStsManager(deps(store, posts))
  await store.createRequest('r1', 0)
  await store.fulfill('r1', 'enc(tok)', 1000 + 3600, 0) // 剩 1 小时 < 24h/3
  await m.ensureFresh(1000)
  expect(posts).toHaveLength(1)
})

test('handleWebhook 验签失败时拒绝且不写入', async () => {
  const store = memStore()
  const d = { ...deps(store), verify: () => false }
  const m = createStsManager(d)
  await expect(
    m.handleWebhook({ timestamp: '1', nonce: 'n', signature: 'bad', encrypted: 'x' }, 1000),
  ).rejects.toThrow('webhook verification failed')
  expect(store.records.size).toBe(0)
})

test('handleWebhook 成功后 token 可用', async () => {
  const store = memStore()
  const m = createStsManager(deps(store))
  await store.createRequest('req-9', 0)
  const event = JSON.stringify({
    event: 'common.sts-token',
    payload: [{ operator: { userid: 'admin' }, token_info: { req_id: 'req-9', sts_token: 'tok-9', expire_ts: 99999 } }],
  })
  await m.handleWebhook({ timestamp: '1', nonce: 'n', signature: 'ok', encrypted: event }, 1000)
  expect(await m.getToken(2000)).toBe('tok-9')
})

test('新旧 token 并存时返回过期最晚的', async () => {
  const store = memStore()
  const m = createStsManager(deps(store))
  await store.createRequest('old', 0)
  await store.fulfill('old', 'enc(old-tok)', 5000, 0)
  await store.createRequest('new', 0)
  await store.fulfill('new', 'enc(new-tok)', 9000, 0)
  expect(await m.getToken(1000)).toBe('new-tok')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/sts/manager.test.ts` → FAIL

- [ ] **Step 3: 实现管理器**

创建 `src/sts/manager.ts`：

```ts
import type { TencentClient } from '../tencent/client'
import type { StsStore } from '../store/sts'
import { parseStsEvent, WebhookVerificationError } from './crypto'

/** 平台枚举值：6 / 12 / 24 小时 */
const VALID_TIME_HOURS = 24
const RENEW_THRESHOLD_RATIO = 1 / 3

export class StsTokenUnavailableError extends Error {
  constructor() {
    super(
      'no valid STS-Token available; AI minutes are temporarily unavailable. ' +
        'Recording, audio and transcript are unaffected.',
    )
    this.name = 'StsTokenUnavailableError'
  }
}

export interface WebhookRequest {
  timestamp: string
  nonce: string
  signature: string
  encrypted: string
}

export interface StsManagerDeps {
  store: StsStore
  client: TencentClient
  operatorId: string
  webhookToken: string
  aesKey: string
  encrypt: (plain: string) => string
  decrypt: (cipher: string) => string
  verify: (token: string, ts: string, nonce: string, enc: string, sig: string) => boolean
  decryptEvent: (aesKey: string, encrypted: string) => string
}

export interface StsManager {
  ensureFresh(now: number): Promise<void>
  getToken(now: number): Promise<string>
  handleWebhook(req: WebhookRequest, now: number): Promise<void>
}

export function createStsManager(deps: StsManagerDeps): StsManager {
  return {
    /**
     * 回调是异步的——不能等到过期才申请，那时无法同步取得凭证。
     * 因此在剩余有效期低于 1/3 时提前续期，新旧 token 并存。
     */
    async ensureFresh(now) {
      const active = await deps.store.getActive(now)
      if (active !== null) {
        const remaining = active.expireTs - now
        if (remaining > (VALID_TIME_HOURS * 3600) * RENEW_THRESHOLD_RATIO) return
      }
      const res = await deps.client.post<{ req_id: string }>('/v1/app/sts-token', {
        operator_id: deps.operatorId,
        operator_id_type: 1,
        valid_time: VALID_TIME_HOURS,
      })
      await deps.store.createRequest(res.req_id, now)
    },

    async getToken(now) {
      const active = await deps.store.getActive(now)
      if (active === null) throw new StsTokenUnavailableError()
      return deps.decrypt(active.tokenCipher)
    },

    async handleWebhook(req, now) {
      if (!deps.verify(deps.webhookToken, req.timestamp, req.nonce, req.encrypted, req.signature)) {
        throw new WebhookVerificationError('signature mismatch')
      }
      const plain = deps.decryptEvent(deps.aesKey, req.encrypted)
      const payload = parseStsEvent(plain)
      await deps.store.fulfill(
        payload.reqId,
        deps.encrypt(payload.stsToken),
        payload.expireTs,
        now,
      )
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/sts/ && bun run typecheck`
Expected: PASS — 13 tests

- [ ] **Step 5: 提交**

```bash
git add src/sts/manager.ts tests/sts/manager.test.ts
git commit -m "feat: STS-Token 生命周期，提前续期与双 token 并存"
```

---

## Task 11: 认证流程（设备授权 + 企微 + 身份映射）

**Files:**
- Create: `src/auth/identity.ts`, `src/auth/wecom.ts`, `src/auth/device.ts`, `src/auth/service.ts`
- Test: `tests/auth/identity.test.ts`, `tests/auth/device.test.ts`, `tests/auth/service.test.ts`

**Interfaces:**
- Consumes: `AuthStore` (T4)；令牌工具 (T5)；`ActorIdentity` (T1)
- Produces:
  - `createIdentityMapper(strategy, deps): IdentityMapper`
  - `IdentityMapper.toTmUserId(wecomUserId: string, email: string | null): Promise<string>`
  - `IdentityMappingError` (class)
  - `createWecomClient(cfg, deps): WecomClient`（`buildAuthorizeUrl`, `exchangeCode`）
  - `createDeviceFlow(deps): DeviceFlow`（`start`, `completeAuthorization`, `poll`）
  - `DeviceFlowPending`, `DeviceFlowSlowDown`, `DeviceFlowExpired` (classes)
  - `createServiceAuth(deps): ServiceAuth`（`authenticate`）

- [ ] **Step 1: 写身份映射失败测试**

创建 `tests/auth/identity.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { createIdentityMapper, IdentityMappingError } from '../../src/auth/identity'

const table = new Map([['ww-alice', 'tm-alice']])
const deps = {
  lookupTable: async (id: string) => table.get(id) ?? null,
  lookupByEmail: async (email: string) => (email === 'a@x.com' ? 'tm-alice' : null),
}

test('direct 策略直接返回企微 userid', async () => {
  const m = createIdentityMapper('direct', deps)
  expect(await m.toTmUserId('ww-alice', null)).toBe('ww-alice')
})

test('table 策略查映射表', async () => {
  const m = createIdentityMapper('table', deps)
  expect(await m.toTmUserId('ww-alice', null)).toBe('tm-alice')
})

test('table 策略查不到时抛 IdentityMappingError', async () => {
  const m = createIdentityMapper('table', deps)
  await expect(m.toTmUserId('ww-bob', null)).rejects.toThrow(IdentityMappingError)
})

test('email 策略按邮箱关联', async () => {
  const m = createIdentityMapper('email', deps)
  expect(await m.toTmUserId('ww-alice', 'a@x.com')).toBe('tm-alice')
})

test('email 策略缺少邮箱时抛错', async () => {
  const m = createIdentityMapper('email', deps)
  await expect(m.toTmUserId('ww-alice', null)).rejects.toThrow(IdentityMappingError)
})

/** 关键：映射失败是配置缺陷，不是权限结论，二者不可混同 */
test('IdentityMappingError 明确区别于无权限', async () => {
  const m = createIdentityMapper('table', deps)
  try {
    await m.toTmUserId('ww-bob', null)
    throw new Error('should have thrown')
  } catch (e) {
    expect(e).toBeInstanceOf(IdentityMappingError)
    expect((e as IdentityMappingError).message).toContain('not provisioned')
    expect((e as IdentityMappingError).message).not.toContain('permission')
  }
})
```

- [ ] **Step 2: 运行确认失败，实现身份映射**

Run: `bun test tests/auth/identity.test.ts` → FAIL

创建 `src/auth/identity.ts`：

```ts
import type { IdentityStrategy } from '../config'

/**
 * 映射失败必须区别于「无权限」：前者是配置缺陷，后者是策略的正常结论。
 * 混为一谈会让管理员看到用户抱怨没权限，却在策略表里找不到任何问题。
 */
export class IdentityMappingError extends Error {
  constructor(wecomUserId: string, strategy: IdentityStrategy) {
    super(
      `account not provisioned: WeCom user "${wecomUserId}" has no corresponding ` +
        `Tencent Meeting account under strategy "${strategy}". ` +
        'This is a configuration issue, not a permission denial.',
    )
    this.name = 'IdentityMappingError'
  }
}

export interface IdentityMapperDeps {
  lookupTable: (wecomUserId: string) => Promise<string | null>
  lookupByEmail: (email: string) => Promise<string | null>
}

export interface IdentityMapper {
  toTmUserId(wecomUserId: string, email: string | null): Promise<string>
}

export function createIdentityMapper(
  strategy: IdentityStrategy,
  deps: IdentityMapperDeps,
): IdentityMapper {
  return {
    async toTmUserId(wecomUserId, email) {
      if (strategy === 'direct') return wecomUserId

      if (strategy === 'table') {
        const found = await deps.lookupTable(wecomUserId)
        if (found === null) throw new IdentityMappingError(wecomUserId, strategy)
        return found
      }

      if (email === null || email === '') throw new IdentityMappingError(wecomUserId, strategy)
      const byEmail = await deps.lookupByEmail(email)
      if (byEmail === null) throw new IdentityMappingError(wecomUserId, strategy)
      return byEmail
    },
  }
}
```

- [ ] **Step 3: 实现企微客户端**

创建 `src/auth/wecom.ts`：

```ts
export interface WecomConfig {
  corpId: string
  agentId: string
  secret: string
}

export interface WecomUser {
  userId: string
  email: string | null
}

export interface WecomClientDeps {
  fetch: typeof fetch
  now: () => number
}

export interface WecomClient {
  buildAuthorizeUrl(redirectUri: string, state: string): string
  exchangeCode(code: string): Promise<WecomUser>
}

export function createWecomClient(cfg: WecomConfig, deps: WecomClientDeps): WecomClient {
  let cachedToken: { value: string; expiresAt: number } | null = null

  async function accessToken(): Promise<string> {
    const now = deps.now()
    if (cachedToken !== null && cachedToken.expiresAt > now) return cachedToken.value
    const res = await deps.fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpId}&corpsecret=${cfg.secret}`,
    )
    const body = (await res.json()) as { access_token?: string; expires_in?: number; errmsg?: string }
    if (!body.access_token) throw new Error(`wecom gettoken failed: ${body.errmsg ?? 'unknown'}`)
    cachedToken = { value: body.access_token, expiresAt: now + (body.expires_in ?? 7200) - 300 }
    return body.access_token
  }

  return {
    buildAuthorizeUrl(redirectUri, state) {
      const q = new URLSearchParams({
        login_type: 'CorpApp',
        appid: cfg.corpId,
        agentid: cfg.agentId,
        redirect_uri: redirectUri,
        state,
      })
      return `https://login.work.weixin.qq.com/wwlogin/sso/login?${q.toString()}`
    },

    async exchangeCode(code) {
      const token = await accessToken()
      const res = await deps.fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${token}&code=${encodeURIComponent(code)}`,
      )
      const body = (await res.json()) as { userid?: string; errmsg?: string }
      if (!body.userid) throw new Error(`wecom getuserinfo failed: ${body.errmsg ?? 'unknown'}`)
      return { userId: body.userid, email: null }
    },
  }
}
```

- [ ] **Step 4: 写设备流程失败测试**

创建 `tests/auth/device.test.ts`，覆盖：

```ts
import { expect, test } from 'bun:test'
import {
  createDeviceFlow, DeviceFlowExpired, DeviceFlowPending, DeviceFlowSlowDown,
} from '../../src/auth/device'
import type { DeviceAuth } from '../../src/store/auth'

function memAuthStore() {
  const rows = new Map<string, DeviceAuth>()
  return {
    rows,
    async createDeviceAuth(d: DeviceAuth) { rows.set(d.deviceCode, d) },
    async findByState(state: string) {
      return [...rows.values()].find((r) => r.state === state) ?? null
    },
    async authorize(state: string, wecomUserId: string, tmUserId: string) {
      const r = [...rows.values()].find((x) => x.state === state)
      if (!r || r.status !== 'pending') return false
      rows.set(r.deviceCode, { ...r, status: 'authorized', wecomUserId, tmUserId })
      return true
    },
    async pollDevice(deviceCode: string, now: number) {
      const r = rows.get(deviceCode)
      if (r) rows.set(deviceCode, { ...r, lastPolledAt: now })
      return r ?? null
    },
  }
}

test('start 返回 user_code 与验证地址', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  expect(r.userCode).toHaveLength(8)
  expect(r.verificationUri).toContain('https://gw')
  expect(r.interval).toBe(5)
  expect(r.expiresIn).toBe(300)
})

test('授权前轮询返回 pending', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  await expect(flow.poll(r.deviceCode, 1010)).rejects.toThrow(DeviceFlowPending)
})

test('早于 interval 轮询返回 slow_down', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  await flow.poll(r.deviceCode, 1010).catch(() => {})
  await expect(flow.poll(r.deviceCode, 1012)).rejects.toThrow(DeviceFlowSlowDown)
})

test('授权后轮询返回身份', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  await flow.completeAuthorization(r.state, 'ww-alice', 'tm-alice')
  expect(await flow.poll(r.deviceCode, 1100)).toEqual({
    kind: 'wecom_user', wecomUserId: 'ww-alice', tmUserId: 'tm-alice',
  })
})

test('超过 ttl 后轮询报过期', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  await expect(flow.poll(r.deviceCode, 1400)).rejects.toThrow(DeviceFlowExpired)
})

test('重放已使用的 state 不再生效（防会话绑定攻击）', async () => {
  const store = memAuthStore()
  const flow = createDeviceFlow({ store: store as never, baseUrl: 'https://gw', ttlSec: 300 })
  const r = await flow.start(1000)
  expect(await flow.completeAuthorization(r.state, 'ww-alice', 'tm-alice')).toBe(true)
  expect(await flow.completeAuthorization(r.state, 'ww-mallory', 'tm-mallory')).toBe(false)
})
```

- [ ] **Step 5: 实现设备流程与服务账号认证**

创建 `src/auth/device.ts`（`start` / `completeAuthorization` / `poll`，`interval` 固定 5 秒，`ttlSec` 默认 300）与 `src/auth/service.ts`（`authenticate(clientId, clientSecret, now)`，用 `Bun.password.verify` 校验 argon2id hash，检查 `enabled` 与 `expires_at`）。

服务账号测试 `tests/auth/service.test.ts` 覆盖：密钥正确、密钥错误、已禁用、已过期、不存在——五种情形。

- [ ] **Step 6: 运行全部认证测试**

Run: `bun test tests/auth/ && bun run typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/auth tests/auth
git commit -m "feat: 设备授权流程、企微对接与身份映射"
```

---

## Task 12: 资产清单聚合

**Files:**
- Create: `src/tencent/addresses.ts`, `src/catalog/assets.ts`
- Test: `tests/tencent/addresses.test.ts`, `tests/catalog/assets.test.ts`

**Interfaces:**
- Consumes: `TencentClient` (T6)；`StsManager` (T10)；`Asset`, `AssetType` (T1)
- Produces:
  - `createAddressesApi(client, operatorId): AddressesApi`
  - `AddressesApi.listByRecordId(meetingRecordId): Promise<RawAddressFile[]>`
  - `AddressesApi.detailByFileId(recordFileId, stsToken): Promise<RawDetail>`
  - `createCatalog(deps): Catalog`
  - `Catalog.listAssets(meeting: Meeting): Promise<Asset[]>`
  - `Catalog.resolveDownloadUrl(asset: Asset): Promise<{ url: string; expiresAt: number }>`

- [ ] **Step 1: 写资产解析失败测试**

创建 `tests/catalog/assets.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { extractAssets } from '../../src/catalog/assets'

const detail = {
  record_file_id: 'f1',
  download_address: 'https://cos/video.mp4',
  download_address_file_type: 'mp4',
  audio_address: 'https://cos/audio.m4a',
  audio_address_file_type: 'm4a',
  meeting_summary: [{ download_address: 'https://cos/s.txt', file_type: 'txt' }],
  ai_meeting_transcripts: [{ download_address: 'https://cos/t.txt', file_type: 'txt' }],
  ai_minutes: [{ download_address: 'https://cos/m.txt', file_type: 'txt' }],
  ai_topic_minutes: [{ download_address: 'https://cos/tm.htm', file_type: 'htm' }],
  ai_speaker_minutes: [{ download_address: 'https://cos/sm.htm', file_type: 'htm' }],
  ai_ds_minutes: [{ download_address: 'https://cos/ds.htm', file_type: 'htm' }],
}

test('提取全部八类资产', () => {
  const assets = extractAssets('m1', '', detail, true)
  expect(assets.map((a) => a.assetType).sort()).toEqual([
    'ai_ds_minutes', 'ai_meeting_transcripts', 'ai_minutes', 'ai_speaker_minutes',
    'ai_topic_minutes', 'audio', 'meeting_summary', 'video',
  ])
})

test('assetId 唯一且含字段名与索引（防六类纪要被压成一行）', () => {
  const assets = extractAssets('m1', '', detail, true)
  const ids = assets.map((a) => a.assetId)
    expect(new Set(ids).size).toBe(ids.length)
  expect(ids).toContain('f1:ai_minutes:0')
})

test('同一字段的数组含多项时各自成为独立资产', () => {
  const multi = { ...detail, ai_minutes: [
    { download_address: 'a', file_type: 'txt' },
    { download_address: 'b', file_type: 'pdf' },
  ] }
  const assets = extractAssets('m1', '', multi, true).filter((a) => a.assetType === 'ai_minutes')
  expect(assets).toHaveLength(2)
  expect(assets[1]!.fileType).toBe('pdf')
})

test('fileType 来自平台，不写死扩展名', () => {
  const assets = extractAssets('m1', '', detail, true)
  expect(assets.find((a) => a.assetType === 'ai_topic_minutes')!.fileType).toBe('htm')
  expect(assets.find((a) => a.assetType === 'video')!.fileType).toBe('mp4')
})

test('allowDownload=false 时 ai_* 资产被标记不可下载', () => {
  const assets = extractAssets('m1', '', detail, false)
  const ai = assets.filter((a) => a.assetType.startsWith('ai_'))
  expect(ai.every((a) => a.allowDownload === false)).toBe(true)
  expect(assets.find((a) => a.assetType === 'video')!.allowDownload).toBe(true)
})

test('字段缺失时不产生该资产（而非产生空资产）', () => {
  const partial = { record_file_id: 'f1', download_address: 'u', download_address_file_type: 'mp4' }
  const assets = extractAssets('m1', '', partial, true)
  expect(assets).toHaveLength(1)
  expect(assets[0]!.assetType).toBe('video')
})

test('空数组字段不产生资产', () => {
  const empty = { ...detail, ai_minutes: [] }
  expect(extractAssets('m1', '', empty, true).some((a) => a.assetType === 'ai_minutes')).toBe(false)
})
```

- [ ] **Step 2: 运行确认失败，实现资产提取**

Run: `bun test tests/catalog/assets.test.ts` → FAIL

创建 `src/catalog/assets.ts`：

```ts
import type { Asset, AssetType } from '../domain/types'

export interface RawFileEntry {
  download_address?: string
  file_type?: string
}

export interface RawDetail {
  record_file_id: string
  download_address?: string
  download_address_file_type?: string
  audio_address?: string
  audio_address_file_type?: string
  meeting_summary?: RawFileEntry[]
  ai_meeting_transcripts?: RawFileEntry[]
  ai_minutes?: RawFileEntry[]
  ai_topic_minutes?: RawFileEntry[]
  ai_speaker_minutes?: RawFileEntry[]
  ai_ds_minutes?: RawFileEntry[]
}

/** 数组型字段 → 资产类型。从字段名派生，新增纪要引擎时只需加一行 */
const ARRAY_FIELDS: Array<[keyof RawDetail, AssetType]> = [
  ['meeting_summary', 'meeting_summary'],
  ['ai_meeting_transcripts', 'ai_meeting_transcripts'],
  ['ai_minutes', 'ai_minutes'],
  ['ai_topic_minutes', 'ai_topic_minutes'],
  ['ai_speaker_minutes', 'ai_speaker_minutes'],
  ['ai_ds_minutes', 'ai_ds_minutes'],
]

/**
 * assetId 必须含字段名与索引：六类文本资产同属一个 record_file，
 * 若只用 record_file_id 作标识，它们会在下游的唯一约束下被压成一行。
 */
export function extractAssets(
  meetingId: string,
  subMeetingId: string,
  detail: RawDetail,
  allowDownload: boolean,
): Asset[] {
  const fileId = detail.record_file_id
  const out: Asset[] = []

  const push = (t: AssetType, idx: number, fileType: string | null, allowed: boolean): void => {
    out.push({
      assetId: `${fileId}:${t}:${idx}`,
      meetingId,
      subMeetingId,
      assetType: t,
      recordFileId: fileId,
      fileType,
      bytesExpected: null,
      allowDownload: allowed,
    })
  }

  if (detail.download_address) {
    push('video', 0, detail.download_address_file_type ?? null, true)
  }
  if (detail.audio_address) {
    push('audio', 0, detail.audio_address_file_type ?? null, true)
  }

  for (const [field, assetType] of ARRAY_FIELDS) {
    const entries = detail[field] as RawFileEntry[] | undefined
    if (!Array.isArray(entries)) continue
    entries.forEach((e, i) => {
      if (!e.download_address) return
      // ai_* 系列在 allow_download=false 时平台返回空，此处显式标记
      const allowed = assetType.startsWith('ai_') ? allowDownload : true
      push(assetType, i, e.file_type ?? null, allowed)
    })
  }

  return out
}
```

- [ ] **Step 3: 实现 addresses API 与 catalog 编排**

创建 `src/tencent/addresses.ts`：封装 `GET /v1/addresses`（按 `meeting_record_id`，6 小时链接）与 `GET /v1/addresses/{record_file_id}`（需 STS-Token，5 分钟链接）。

创建 `src/catalog/index.ts`：`listAssets` 优先用 51174（无需 STS-Token），需要 `ai_*` 时用 51180；`resolveDownloadUrl` 返回 `{ url, expiresAt }`，`expiresAt` 按来源接口分别取 `now + 6*3600` 或 `now + 300`。

对应测试 `tests/tencent/addresses.test.ts` 覆盖：STS-Token 缺失时 `ai_*` 降级为不可得但视频仍可用、两个接口的 `expiresAt` 差异。

- [ ] **Step 4: 运行测试并提交**

Run: `bun test tests/catalog/ tests/tencent/ && bun run typecheck`
Expected: PASS

```bash
git add src/catalog src/tencent/addresses.ts tests/catalog tests/tencent
git commit -m "feat: 八类资产提取与下载地址解析"
```

---

## Task 13: 审计记录

**Files:**
- Create: `src/audit/recorder.ts`
- Test: `tests/audit/recorder.test.ts`

**Interfaces:**
- Consumes: `AuditStore` (T4)；`ActorIdentity` (T1)
- Produces:
  - `createAuditRecorder(store: AuditStore, now: () => number): AuditRecorder`
  - `AuditRecorder.recordDownloadUrl(input): Promise<void>`
  - `AuditRecorder.recordLogin(actor, success, reason?): Promise<void>`
  - `AuditRecorder.recordListing(actor, count): Promise<void>`

- [ ] **Step 1: 写失败测试**

创建 `tests/audit/recorder.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { createAuditRecorder } from '../../src/audit/recorder'
import type { AuditEntry, AuditStore } from '../../src/store/audit'
import type { ActorIdentity } from '../../src/domain/types'

function memStore(): AuditStore & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = []
  return { entries, async record(e) { entries.push(e) } }
}

const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-a', tmUserId: 'tm-a' }

test('签发下载地址时记录完整上下文', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordDownloadUrl({
    actor: alice, meetingId: 'm1', assetId: 'f1:video:0',
    assetType: 'video', decision: 'allow', matchedRuleId: 7, clientKind: 'cli',
  })
  expect(store.entries[0]).toEqual({
    occurredAt: 1700, actorType: 'wecom_user', actorId: 'tm-a',
    action: 'issue_download_url', meetingId: 'm1', assetId: 'f1:video:0',
    assetType: 'video', decision: 'allow', matchedRuleId: 7, clientKind: 'cli',
  })
})

test('拒绝同样留下记录', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordDownloadUrl({
    actor: alice, meetingId: 'm1', assetId: 'a1',
    assetType: 'video', decision: 'deny', matchedRuleId: null, clientKind: 'desktop',
  })
  expect(store.entries[0]!.decision).toBe('deny')
})

test('登录成功与失败均记录', async () => {
  const store = memStore()
  const r = createAuditRecorder(store, () => 1700)
  await r.recordLogin(alice, true)
  await r.recordLogin(alice, false, 'identity_mapping_failed')
  expect(store.entries.map((e) => e.decision)).toEqual(['allow', 'deny'])
  expect(store.entries.map((e) => e.action)).toEqual(['login', 'login'])
})

test('服务账号的 actorType 正确', async () => {
  const store = memStore()
  const svc: ActorIdentity = { kind: 'service_account', wecomUserId: null, tmUserId: 'tm-svc' }
  const r = createAuditRecorder(store, () => 1700)
  await r.recordLogin(svc, true)
  expect(store.entries[0]!.actorType).toBe('service_account')
})
```

- [ ] **Step 2: 运行确认失败，实现记录器**

Run: `bun test tests/audit/recorder.test.ts` → FAIL

创建 `src/audit/recorder.ts`：

```ts
import type { ActorIdentity, AssetType } from '../domain/types'
import type { AuditStore } from '../store/audit'

export interface DownloadUrlAudit {
  actor: ActorIdentity
  meetingId: string
  assetId: string
  assetType: AssetType
  decision: 'allow' | 'deny'
  matchedRuleId: number | null
  clientKind: string
}

export interface AuditRecorder {
  recordDownloadUrl(input: DownloadUrlAudit): Promise<void>
  recordLogin(actor: ActorIdentity, success: boolean, reason?: string): Promise<void>
  recordListing(actor: ActorIdentity, count: number): Promise<void>
}

/** 管控若无法事后核查，等于没有管控 */
export function createAuditRecorder(store: AuditStore, now: () => number): AuditRecorder {
  return {
    async recordDownloadUrl(i) {
      await store.record({
        occurredAt: now(),
        actorType: i.actor.kind,
        actorId: i.actor.tmUserId,
        action: 'issue_download_url',
        meetingId: i.meetingId,
        assetId: i.assetId,
        assetType: i.assetType,
        decision: i.decision,
        matchedRuleId: i.matchedRuleId,
        clientKind: i.clientKind,
      })
    },

    async recordLogin(actor, success, reason) {
      await store.record({
        occurredAt: now(),
        actorType: actor.kind,
        actorId: actor.tmUserId,
        action: 'login',
        meetingId: null,
        assetId: null,
        assetType: reason ?? null,
        decision: success ? 'allow' : 'deny',
        matchedRuleId: null,
        clientKind: null,
      })
    },

    async recordListing(actor, count) {
      await store.record({
        occurredAt: now(),
        actorType: actor.kind,
        actorId: actor.tmUserId,
        action: 'list_meetings',
        meetingId: null,
        assetId: null,
        assetType: String(count),
        decision: 'allow',
        matchedRuleId: null,
        clientKind: null,
      })
    },
  }
}
```

- [ ] **Step 3: 运行测试并提交**

Run: `bun test tests/audit/ && bun run typecheck`
Expected: PASS — 4 tests

```bash
git add src/audit tests/audit
git commit -m "feat: 审计记录器"
```

---

## Task 14: HTTP 路由层

**Files:**
- Create: `src/http/router.ts`, `src/http/middleware.ts`, `src/http/handlers/auth.ts`, `src/http/handlers/meetings.ts`, `src/http/handlers/webhook.ts`, `src/index.ts`
- Test: `tests/http/*.test.ts`

**Interfaces:**
- Consumes: 全部前置任务的 Produces
- Produces:
  - `createApp(deps: AppDeps): (req: Request) => Promise<Response>`
  - `AppDeps` 聚合全部模块实例

- [ ] **Step 1: 写鉴权中间件失败测试**

创建 `tests/http/middleware.test.ts`：

```ts
import { expect, test } from 'bun:test'
import { requireAuth } from '../../src/http/middleware'
import { signAccessToken } from '../../src/auth/tokens'
import type { ActorIdentity } from '../../src/domain/types'

const SECRET = 'x'.repeat(32)
const alice: ActorIdentity = { kind: 'wecom_user', wecomUserId: 'ww-a', tmUserId: 'tm-a' }

test('缺少 Authorization 头返回 401', () => {
  const r = requireAuth(new Request('https://gw/api/v1/meetings'), SECRET, 1000)
  expect(r.ok).toBe(false)
  expect(r.ok === false && r.response.status).toBe(401)
})

test('有效令牌通过并返回身份', () => {
  const t = signAccessToken(alice, SECRET, 1000)
  const req = new Request('https://gw/api/v1/meetings', { headers: { Authorization: `Bearer ${t}` } })
  const r = requireAuth(req, SECRET, 1100)
  expect(r.ok && r.identity).toEqual(alice)
})

test('过期令牌返回 401 且错误码为 token_expired', async () => {
  const t = signAccessToken(alice, SECRET, 1000)
  const req = new Request('https://gw/x', { headers: { Authorization: `Bearer ${t}` } })
  const r = requireAuth(req, SECRET, 1000 + 901)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.response.status).toBe(401)
    expect((await r.response.json()).error).toBe('token_expired')
  }
})
```

- [ ] **Step 2: 实现中间件与路由**

创建 `src/http/middleware.ts`（`requireAuth` 返回 `{ ok: true; identity } | { ok: false; response }`）。

创建 `src/http/router.ts`，注册 spec §5.2 的全部端点：

```
POST /api/v1/auth/device/code
POST /api/v1/auth/device/token
GET  /auth/wecom/callback
POST /api/v1/auth/refresh
POST /api/v1/auth/service-token
POST /api/v1/auth/logout
GET  /api/v1/meetings
GET  /api/v1/meetings/:meetingId
GET  /api/v1/meetings/:meetingId/assets
POST /api/v1/assets/:assetId/download-url
POST /webhook/tencent-meeting
GET  /healthz
```

- [ ] **Step 3: 写端点行为测试**

创建 `tests/http/meetings.test.ts`，覆盖：

```ts
test('列表按策略过滤，被拒的会议不出现')
test('download-url 对无权资产返回 403 且写审计')
test('download-url 对越权构造的 assetId 返回 403（不是 404）')
test('未传 from/to 时默认最近 31 天')
test('meeting_code 命中多场时返回数组而非单个对象')
test('范围外未命中返回 404 且 error 为 meeting_not_found_in_range')
test('STS-Token 不可用时 ai_* 资产标记 unavailable，video 仍可下载')
```

- [ ] **Step 4: 写 webhook 端点测试**

创建 `tests/http/webhook.test.ts`：

```ts
test('验签失败返回 401 且不改变 token 状态')
test('验签通过后 token 落库')
test('重复投递同一 req_id 幂等')
```

- [ ] **Step 5: 实现入口**

创建 `src/index.ts`：加载配置、建连接池、跑 migration、组装全部模块、启动 `Bun.serve`，并注册 STS 续期定时器（每 5 分钟调用 `ensureFresh`）。

- [ ] **Step 6: 运行全部测试**

Run: `bun test && bun run typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/http src/index.ts tests/http
git commit -m "feat: HTTP 路由层与服务入口"
```

---

## Task 15: 端到端测试

**Files:**
- Create: `tests/fake-tencent/server.ts`, `tests/e2e/flow.test.ts`

**Interfaces:**
- Consumes: `createApp` (T14)
- Produces: 无（测试专用）

- [ ] **Step 1: 实现假腾讯服务**

创建 `tests/fake-tencent/server.ts`：一个 `Bun.serve` 实例，实现 `/v1/records`、`/v1/addresses`、`/v1/addresses/:id`、`/v1/app/sts-token` 四个端点，返回固定 fixture，并**校验请求签名**（用同一算法重算，不匹配则返回 `9042`）——这样端到端测试能真正覆盖签名正确性。

- [ ] **Step 2: 写端到端流程测试**

创建 `tests/e2e/flow.test.ts`：

```ts
test('完整流程：设备登录 → 列会议 → 取资产 → 换下载地址', ...)
test('策略拒绝时整条链路在 download-url 处被拦截', ...)
test('STS-Token 未就位时，video 可下载而 ai_minutes 返回 unavailable', ...)
test('会议号命中多场时列出候选', ...)
test('身份映射失败时登录被拒，错误码为 account_not_provisioned', ...)
```

- [ ] **Step 3: 运行并提交**

Run: `bun test tests/e2e/`
Expected: PASS

```bash
git add tests/e2e tests/fake-tencent
git commit -m "test: 端到端流程测试与假腾讯服务"
```

---

## Task 16: 打包与部署自检

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `scripts/preflight.ts`, `docs/deploy.md`

**Interfaces:**
- Consumes: `loadConfig` (T1)；`createTencentClient` (T6)；`createIdentityMapper` (T11)
- Produces: `bun scripts/preflight.ts` 可执行自检命令

- [ ] **Step 1: 写 Dockerfile**

```dockerfile
FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

FROM base AS release
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY migrations ./migrations
COPY package.json ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "src/index.ts"]
```

- [ ] **Step 2: 实现 preflight 自检脚本**

创建 `scripts/preflight.ts`，依次检查并逐项打印通过/失败：

```
1. 配置完整性         loadConfig 不抛错
2. 数据库连通性       SELECT 1
3. 腾讯凭证与签名     调 /v1/records 取最近 1 天，成功即证明签名与权限正确
                     失败时按 error_code 给出具体指引：
                       9042   → 检查 SecretId/SecretKey 与应用权限
                       500014 → 检查 operator 账号权限
                       190301 → 检查服务器时钟（与标准时间偏差须 < 5 分钟）
4. 账号版本           上一步成功即证明版本满足（免费版/专业版会失败）
5. 企微凭证           调 gettoken 成功
6. 身份映射策略       用 --sample-user 参数传入真实企微 userid，
                     实测能否解析出腾讯会议 userid
7. STS-Token 可达性   发起一次申请，30 秒内是否收到 Webhook 回调
```

对应用户故事 US-1.1 与 US-1.4。每项失败都给出具体的修复指引，而非仅报错。

- [ ] **Step 3: 写部署文档**

创建 `docs/deploy.md`，含：阿里云部署步骤、腾讯会议企管后台配置清单（应用创建、事件订阅 URL/Token/EncodingAESKey、勾选「STS Token 生成」事件、operator 权限）、企微自建应用配置、环境变量说明、preflight 使用方法、常见错误码对照表。

- [ ] **Step 4: 验证镜像可构建并运行自检**

Run: `docker build -t meeting-export-gateway:dev . && docker run --rm --env-file .env meeting-export-gateway:dev bun scripts/preflight.ts`
Expected: 各检查项逐条输出结果

- [ ] **Step 5: 提交**

```bash
git add Dockerfile .dockerignore scripts docs/deploy.md
git commit -m "chore: Docker 打包、部署自检脚本与部署文档"
```

---

## Self-Review

**1. Spec 覆盖检查**

| spec 章节 | 对应任务 |
| --- | --- |
| §3.4 接入环境与账号版本 | T16（preflight 检查项 3、4） |
| §3.5 操作者标识 | T9（每次请求带 operator_id） |
| §3.6 签名算法与四个易错点 | T2 |
| §3.7 STS-Token 流程 | T10 |
| §3.8 Webhook 安全 | T7、T10 |
| §4.2 控制/数据平面分离 | T12（返回地址，不代理字节） |
| §5.2 API 契约与定点查询约束 | T9、T14 |
| §5.3 STS-Token 生命周期 | T10 |
| §5.4 业务用户认证（含设备流程、身份映射、令牌） | T5、T11 |
| §5.5 策略引擎（默认 deny、三执行点） | T8、T14 |
| §5.6 限流 | T6 |
| §5.7 审计 | T13 |
| §5.8 数据模型 | T4 |
| §5.9 错误处理（分类依据 error_code） | T3、T6 |
| §5.10 测试策略 | 各任务的 TDD 步骤 + T15 |
| §6 部署检查项 | T16 |

无遗漏。

**2. 占位符扫描**

已检查：无 TBD / TODO / "similar to Task N" / "add appropriate error handling"。自审中发现 T4 Step 6 的 SQL 有一处笔误，已直接修正（而非留注释说明）。

**3. 类型一致性**

- `ActorIdentity` 在 T1 定义，T5/T8/T11/T13/T14 一致使用 `kind` / `wecomUserId` / `tmUserId`
- `Meeting` 的 `hostUserId` 在 T1 定义，T8 的 `FIELD_ACCESSORS` 与 T9 的构造一致
- `AssetType` 八个值在 T1 的 `ASSET_TYPES` 定义，T12 的 `ARRAY_FIELDS` 覆盖其中六个数组型 + 两个标量型
- `TencentClient` 接口在 T6 定义，T9/T10/T12 的 stub 均实现 `get` / `post` / `currentQps` 三个方法
- `PolicyStore.listEnabledRules` 在 T4 定义，T8 消费签名一致
- `StsStore` 四方法在 T4 定义，T10 的 `memStore` 实现完全一致
