import type { TencentClient } from '../tencent/client'
import type { StsStore } from '../store/sts'
import { parseStsEvent, WebhookVerificationError } from './crypto'

/** 平台枚举值：6 / 12 / 24 小时 */
const VALID_TIME_HOURS = 24
const RENEW_THRESHOLD_RATIO = 1 / 3

export class StsTokenUnavailableError extends Error {
  constructor() {
    super(
      'no valid STS-Token available; the optimised transcript (ai_meeting_transcripts) ' +
        'is temporarily unavailable. Recording, audio, transcript, minutes and chapters ' +
        'are unaffected.',
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

/**
 * 一个 `check_str` 候选：**参与签名的形态**与**拿去解密的形态**可以不同。
 *
 * 官方只说「参数值需要进行 Urldecode 处理」，没说签名是对解码前还是解码后的值
 * 计算的。两者未必一致——腾讯完全可能对线路上的编码形态签名，而密文是解码后的
 * base64。把它们绑成同一个值会出现「验签通过但解密失败」，故拆成一对。
 */
export interface UrlChallengeCandidate {
  /** 参与签名计算的形态 */
  signed: string
  /** 实际做 base64 解码 + AES 解密的形态 */
  payload: string
}

/**
 * GET URL 校验请求。`candidates` 是同一个 `check_str` 的若干种（签名形态, 载荷
 * 形态）组合——base64 里的 `+` 在 query string 中又有「空格」与「加号」两种解读，
 * 与其赌一种，不如把候选都交给验签去裁决：签名由 token 参与计算，试错不构成
 * 安全风险，且能在日志里明确记录真实环境到底用的是哪一种。
 */
export interface UrlChallengeRequest {
  timestamp: string
  nonce: string
  signature: string
  candidates: UrlChallengeCandidate[]
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
  decryptCheckStr: (aesKey: string, checkStr: string) => string
}

export interface StsManager {
  ensureFresh(now: number): Promise<void>
  pruneStale(now: number): Promise<number>
  getToken(now: number): Promise<string>
  handleWebhook(req: WebhookRequest, now: number): Promise<void>
  /**
   * 事件订阅配置时的 URL 有效性校验：找出既能通过验签、又能解密成功的候选，
   * 返回应回显的明文与命中的候选下标。全部候选失败时抛 `WebhookVerificationError`。
   * token 与 aesKey 保留在本模块闭包内，不外泄给路由层。
   */
  verifyUrlChallenge(req: UrlChallengeRequest): { plain: string; candidate: number }
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

    verifyUrlChallenge(req) {
      let anySignatureMatched = false

      for (const [index, candidate] of req.candidates.entries()) {
        if (candidate.signed === '' || candidate.payload === '') continue
        if (
          !deps.verify(deps.webhookToken, req.timestamp, req.nonce, candidate.signed, req.signature)
        ) {
          continue
        }
        anySignatureMatched = true
        try {
          return { plain: deps.decryptCheckStr(deps.aesKey, candidate.payload), candidate: index }
        } catch {
          // 验签命中但解密失败：说明这一对的「载荷形态」猜错了，换下一个候选继续。
          // 继续尝试不放宽任何安全约束——每个候选都必须先通过验签才会走到这里。
          continue
        }
      }

      throw new WebhookVerificationError(
        anySignatureMatched
          ? 'check_str decryption failed for every signature-matching candidate'
          : 'signature mismatch',
      )
    },
  }
}
