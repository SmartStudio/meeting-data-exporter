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
