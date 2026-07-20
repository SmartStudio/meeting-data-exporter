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
