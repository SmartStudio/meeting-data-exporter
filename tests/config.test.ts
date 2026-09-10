import { expect, test } from 'bun:test'
import { loadConfig } from '../src/config'

const validEnv = {
  TM_APP_ID: 'corp-1',
  TM_SDK_ID: 'sdk-1',
  TM_SECRET_ID: 'AKIDxxx',
  TM_SECRET_KEY: 'secret',
  TM_OPERATOR_ID: 'admin-uid',
  WECOM_CORP_ID: 'ww-corp',
  WECOM_AGENT_ID: '1000002',
  WECOM_SECRET: 'wecom-secret',
  DATABASE_URL: 'mysql://user:pass@localhost:3306/gw?charset=utf8mb4',
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

test('loadConfig 拒绝过短的 JWT_SECRET（< 32）', () => {
  expect(() => loadConfig({ ...validEnv, JWT_SECRET: 'short' })).toThrow('JWT_SECRET')
})

// ---------------------------------------------------------------------------
// 可选项的「空串 == 未设置」
// .env.example 里这些变量写作 `TM_QPS=`（留空表示用默认值），而 Bun 会把它读成
// 空字符串。若沿用 `??` 判定，空串会一路穿到 Number('') = 0——qps=0 会让令牌桶
// 永远补不满，所有腾讯 API 调用静默卡死。这几条用例锁住修复后的语义。
// ---------------------------------------------------------------------------

test('TM_QPS 为空串时回落到默认值 5，而不是 0', () => {
  expect(loadConfig({ ...validEnv, TM_QPS: '' }).tencent.qps).toBe(5)
})

test('TM_BASE_URL 为空串时回落到默认域名，而不是空字符串', () => {
  expect(loadConfig({ ...validEnv, TM_BASE_URL: '' }).tencent.baseUrl)
    .toBe('https://api.meeting.qq.com')
})

test('TM_QPS 显式设置时生效', () => {
  expect(loadConfig({ ...validEnv, TM_QPS: '12' }).tencent.qps).toBe(12)
})

test('TM_QPS 为 0 时启动期报错，不允许一个永不放行的令牌桶进入运行期', () => {
  expect(() => loadConfig({ ...validEnv, TM_QPS: '0' })).toThrow('TM_QPS')
})

test('TM_QPS 非数字时启动期报错', () => {
  expect(() => loadConfig({ ...validEnv, TM_QPS: 'fast' })).toThrow('TM_QPS')
})

test('TRUSTED_PROXY_HOPS 为空串时回落到默认值 1', () => {
  expect(loadConfig({ ...validEnv, TRUSTED_PROXY_HOPS: '' }).trustedProxyHops).toBe(1)
})

// ---------------------------------------------------------------------------
// 企微为可选：未配置是一种合法部署形态，不是配置缺失
// ---------------------------------------------------------------------------

const envWithoutWecom = (() => {
  const { WECOM_CORP_ID, WECOM_AGENT_ID, WECOM_SECRET, ...rest } = validEnv
  return rest
})()

test('三项企微配置全部缺失时 wecom 为 null，而非报错', () => {
  const cfg = loadConfig(envWithoutWecom)
  expect(cfg.wecom).toBeNull()
})

test('三项企微配置齐全时正常装配', () => {
  expect(loadConfig(validEnv).wecom).toEqual({
    corpId: 'ww-corp',
    agentId: '1000002',
    secret: 'wecom-secret',
  })
})

/**
 * 「只配了一半」几乎一定是打错变量名或漏配，而不是「想停用企微」。若静默按未启用
 * 处理，管理员会得到一个扫码登录莫名不可用、却毫无提示的系统——所以必须报错，
 * 并且要点名缺的是哪几个。
 */
test('企微配置只给一部分时报错并点名缺失项', () => {
  expect(() => loadConfig({ ...envWithoutWecom, WECOM_CORP_ID: 'ww-corp' }))
    .toThrow('WECOM_AGENT_ID')
})

test('企微配置只缺一项时同样报错', () => {
  const { WECOM_SECRET, ...partial } = validEnv
  expect(() => loadConfig(partial)).toThrow('WECOM_SECRET')
})

test('企微项为空串等同于未设置（与 TM_QPS 同一套语义）', () => {
  const cfg = loadConfig({
    ...validEnv,
    WECOM_CORP_ID: '',
    WECOM_AGENT_ID: '',
    WECOM_SECRET: '',
  })
  expect(cfg.wecom).toBeNull()
})
