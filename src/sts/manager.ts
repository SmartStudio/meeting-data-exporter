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
