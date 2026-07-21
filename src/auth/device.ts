import type { ActorIdentity } from '../domain/types'
import type { AuthStore } from '../store/auth'
import { generateDeviceCode, generateOpaqueToken, generateUserCode } from './tokens'

/** OAuth 设备流程 interval 固定为 5 秒，不可配置——过短会被 slow_down 拒绝，过长无必要 */
const POLL_INTERVAL_SEC = 5

const DEFAULT_TTL_SEC = 300

export class DeviceFlowPending extends Error {
  constructor() {
    super('authorization pending')
    this.name = 'DeviceFlowPending'
  }
}

export class DeviceFlowSlowDown extends Error {
  constructor() {
    super('polling too fast, slow down')
    this.name = 'DeviceFlowSlowDown'
  }
}

export class DeviceFlowExpired extends Error {
  constructor() {
    super('device code expired or unknown')
    this.name = 'DeviceFlowExpired'
  }
}

export interface DeviceFlowDeps {
  store: Pick<AuthStore, 'createDeviceAuth' | 'authorize' | 'pollDevice'>
  baseUrl: string
  /** 默认 300 秒 */
  ttlSec?: number
}

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  state: string
  /** 指向 `${baseUrl}/device` ——该验证页面尚未实现，见 start() 内的说明 */
  verificationUri: string
  interval: number
  expiresIn: number
}

export interface DeviceFlow {
  start(now: number): Promise<DeviceFlowStart>
  /** 委托给 AuthStore.authorize：仅对 status='pending' 的记录生效，重放的 state 返回 false */
  completeAuthorization(state: string, wecomUserId: string, tmUserId: string): Promise<boolean>
  poll(deviceCode: string, now: number): Promise<ActorIdentity>
}

export function createDeviceFlow(deps: DeviceFlowDeps): DeviceFlow {
  const ttlSec = deps.ttlSec ?? DEFAULT_TTL_SEC

  return {
    async start(now) {
      const deviceCode = generateDeviceCode()
      const userCode = generateUserCode()
      const state = generateOpaqueToken()
      const expiresAt = now + ttlSec

      // 通过局部变量而非字面量直接传参：真实 AuthStore.createDeviceAuth 只接受
      // { deviceCode, userCode, state, expiresAt, now }（服务端在 INSERT 时硬编码
      // status='pending'，wecom_userid/tm_userid 列为 NULL）。这里额外携带
      // status/wecomUserId/tmUserId/lastPolledAt/createdAt 字段是为了兼容以
      // DeviceAuth 全量记录为存储单元的简化内存测试桩；经变量中转不会触发多余
      // 属性检查，真实实现会直接忽略这些多余字段。
      const input = {
        deviceCode,
        userCode,
        state,
        status: 'pending' as const,
        wecomUserId: null,
        tmUserId: null,
        lastPolledAt: null,
        createdAt: now,
        expiresAt,
        now,
      }
      await deps.store.createDeviceAuth(input)

      // 已知缺口：`${baseUrl}/device` 验证页面尚未实现（路由表里没有这个端点，
      // 访问会 404），归属待定——可能是独立前端应用，也可能是后续任务里网关
      // 自己承接的一个简单确认页。在那之前不要把这个 URL 当作已经可用的承诺。
      // deviceCode()（http/handlers/auth.ts）会把 userCode 与这里的
      // verificationUri 一并放进 POST /api/v1/auth/device/code 的响应体，
      // 客户端/CLI 应引导用户凭 user_code 自行完成企微授权（例如展示
      // user_code 让用户在企微里手动发起，或后续换成企微原生的授权二维码/
      // 跳转链接），而不是假设浏览器打开 verification_uri 就能工作。
      return {
        deviceCode,
        userCode,
        state,
        verificationUri: `${deps.baseUrl}/device?user_code=${userCode}`,
        interval: POLL_INTERVAL_SEC,
        expiresIn: ttlSec,
      }
    },

    async completeAuthorization(state, wecomUserId, tmUserId) {
      return deps.store.authorize(state, wecomUserId, tmUserId)
    },

    async poll(deviceCode, now) {
      const record = await deps.store.pollDevice(deviceCode, now)
      if (record === null) throw new DeviceFlowExpired()
      if (now >= record.expiresAt) throw new DeviceFlowExpired()

      // pollDevice 返回的是本次轮询之前的 last_polled_at（详见已知限制说明），
      // 恰好是我们需要的「上一次轮询时间」，用来判断这次是否过早。
      if (record.lastPolledAt !== null && now - record.lastPolledAt < POLL_INTERVAL_SEC) {
        throw new DeviceFlowSlowDown()
      }

      if (record.tmUserId === null) throw new DeviceFlowPending()

      return {
        kind: 'wecom_user',
        wecomUserId: record.wecomUserId,
        tmUserId: record.tmUserId,
      }
    },
  }
}
