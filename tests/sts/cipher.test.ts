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

    /**
     * 篡改必须落在**字节**上，不能去翻转 base64 字符串里的某个字符。
     *
     * 这条用例原先写的是「翻转倒数第二个 base64 字符（'A'↔'B'）」，那是错的，
     * 而且是**概率性**地错：payload 是 `iv(12) + tag(16) + 密文(13)` = 41 字节，
     * 41 % 3 == 2，所以 base64 最后一组只有 2 个字节、编成 3 个字符 + 一个 `=`，
     * 其中第 3 个字符的**低 2 位是填充位，不承载任何数据**。它的取值因此永远是
     * 4 的倍数（A/E/I/M/…），永远不会是 'B'——于是当它恰好是 'A' 时，
     * 原写法把它换成 'B' 只动了那 2 个填充位，解码回来是**一模一样的字节串**，
     * 篡改根本没发生，decrypt 正常返回原文，断言假红。
     * 概率是 1/16：实测 20000 次跑出 1268 次（6.34%）。
     * —— 这就是 task-7-report 开头记的那次「未能复现的 453 pass / 1 fail」。
     *
     * 顺带把覆盖面补齐：iv / tag / 密文三段各改一个字节都必须被察觉。
     * 每次先断言字节串真的变了，这条守卫正是上面那个坑的反面。
     */
    const positions: Array<[string, number]> = [
      ['iv', 0],
      ['tag', 12],
      ['密文', 28],
    ]
    for (const [what, offset] of positions) {
      const raw = Buffer.from(cipherText, 'base64')
      raw[offset]! ^= 0xff
      expect(raw.equals(Buffer.from(cipherText, 'base64'))).toBe(false) // 篡改真的发生了
      const tampered = raw.toString('base64')
      // 把 what 带进断言值里：三段共用一行断言，红了要一眼看出是哪一段没被察觉、
      // 以及 decrypt 究竟吐回了什么（返回垃圾明文比抛错更危险）
      let outcome = 'threw'
      try {
        outcome = createTokenCipher(KEY).decrypt(tampered)
      } catch {
        /* 期望路径 */
      }
      expect({ what, outcome }).toEqual({ what, outcome: 'threw' })
    }
  })
})
