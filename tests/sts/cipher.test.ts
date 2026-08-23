import { describe, expect, test } from 'bun:test'
import { createTokenCipher } from '../../src/sts/cipher'

/**
 * `createTokenCipher` 此前是 src/index.ts 里的模块私有函数，**没有任何测试覆盖**
 * ——sts/manager 与 http/testApp 用的都是 `enc(...)` 那种桩。Task 7 把它挪进
 * src/sts/cipher.ts 供 worker 共用之后它才可被 import，顺手补上往返用例：
 * 网关加密、worker 解密的是同一张表里的同一份密文，这条往返一旦错了，表现是
 * worker 拿不到 STS-Token、AI 纪要类资产全部失败。
 */
describe('createTokenCipher', () => {
  const KEY = 'sts-enc-key-that-is-long-enough-111111'

  test('同一把密钥能把密文还原回原文，含多字节字符', () => {
    const c = createTokenCipher(KEY)
    for (const plain of ['sts-token-abc', '中文与 emoji 🔐', '']) {
      expect(c.decrypt(c.encrypt(plain))).toBe(plain)
    }
  })

  test('每次加密的密文都不同（IV 随机），但都能解回同一个原文', () => {
    const c = createTokenCipher(KEY)
    const a = c.encrypt('same-token')
    const b = c.encrypt('same-token')
    expect(a).not.toBe(b)
    expect(c.decrypt(a)).toBe('same-token')
    expect(c.decrypt(b)).toBe('same-token')
  })

  test('换一把密钥解不出来，密文被改过也解不出来（GCM 认证标签生效）', () => {
    const cipherText = createTokenCipher(KEY).encrypt('sts-token-abc')
    expect(() =>
      createTokenCipher('another-key-that-is-long-enough-2222').decrypt(cipherText),
    ).toThrow()

    // 翻转密文倒数第二个 base64 字符：GCM 必须察觉篡改，而不是返回一段垃圾明文
    const tampered =
      cipherText.slice(0, -2) + (cipherText.at(-2) === 'A' ? 'B' : 'A') + cipherText.at(-1)
    expect(() => createTokenCipher(KEY).decrypt(tampered)).toThrow()
  })
})
