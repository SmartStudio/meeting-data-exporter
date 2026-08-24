import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface TokenCipher {
  encrypt: (plain: string) => string
  decrypt: (cipher: string) => string
}

/**
 * STS-Token 落库前的对称加密。设计文档 §5.8 建议用阿里云 KMS 托管或等效的
 * 密文存储——本实现用一把【独立于 JWT_SECRET】的密钥（STS_ENC_KEY）派生
 * AES-256-GCM 密钥，使会话签名域与 STS 加密域互不牵连：任一密钥泄露不会同时
 * 危及另一域。生产部署前仍建议替换为真正的 KMS 密钥托管。
 *
 * 单独成文件而不是留在 src/index.ts 里，是因为归档 worker（src/worker/index.ts）
 * 也要用它**解密**同一张表里的 STS-Token：两个宿主必须共用同一份实现，各写一份
 * 等于埋一个「某天两边派生出不同密钥、密文互相读不出来」的坑。而 src/index.ts
 * 是有副作用的进程入口（导入即启动 HTTP 服务），不能被 import。
 */
export function createTokenCipher(secret: string): TokenCipher {
  const key = createHash('sha256').update(secret).digest()

  return {
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([iv, tag, encrypted]).toString('base64')
    },
    decrypt(cipherText) {
      const buf = Buffer.from(cipherText, 'base64')
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(12, 28)
      const encrypted = buf.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    },
  }
}
