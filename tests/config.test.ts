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
  DATABASE_URL: 'mysql://user:pass@localhost:3306/gw?charset=utf8mb4',
  JWT_SECRET: 'c'.repeat(32),
  STS_ENC_KEY: 'd'.repeat(32),
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

test('TRUSTED_PROXY_HOPS 缺省时默认 1', () => {
  expect(loadConfig(validEnv).trustedProxyHops).toBe(1)
})

test('TRUSTED_PROXY_HOPS 接受合法正整数', () => {
  expect(loadConfig({ ...validEnv, TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops).toBe(2)
})

test('TRUSTED_PROXY_HOPS 为 0 时启动期拒绝', () => {
  expect(() => loadConfig({ ...validEnv, TRUSTED_PROXY_HOPS: '0' }))
    .toThrow('TRUSTED_PROXY_HOPS')
})

test('TRUSTED_PROXY_HOPS 为负数时启动期拒绝', () => {
  expect(() => loadConfig({ ...validEnv, TRUSTED_PROXY_HOPS: '-1' }))
    .toThrow('TRUSTED_PROXY_HOPS')
})

test('TRUSTED_PROXY_HOPS 非数字时启动期拒绝', () => {
  expect(() => loadConfig({ ...validEnv, TRUSTED_PROXY_HOPS: 'abc' }))
    .toThrow('TRUSTED_PROXY_HOPS')
})

test('TRUSTED_PROXY_HOPS 非整数时启动期拒绝', () => {
  expect(() => loadConfig({ ...validEnv, TRUSTED_PROXY_HOPS: '1.5' }))
    .toThrow('TRUSTED_PROXY_HOPS')
})

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
