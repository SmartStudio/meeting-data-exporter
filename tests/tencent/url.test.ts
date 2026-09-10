import { expect, test } from 'bun:test'
import { buildUrl } from '../../src/tencent/url'

test('buildUrl 产出的 url 与 uriForSigning 查询串完全一致', () => {
  const b = buildUrl('https://api.meeting.qq.com', '/v1/corp/records', {
    start_time: 1602950400,
    end_time: 1603123200,
    operator_id: 'KM4Ss4Th09ogUw1JiK',
  })
  const qs = b.url.slice(b.url.indexOf('?'))
  const signQs = b.uriForSigning.slice(b.uriForSigning.indexOf('?'))
  expect(qs).toBe(signQs)
})

test('uriForSigning 不含 host，以 / 开头', () => {
  const b = buildUrl('https://api.meeting.qq.com', '/v1/corp/records', { page: 1 })
  expect(b.uriForSigning).toBe('/v1/corp/records?page=1')
  expect(b.url).toBe('https://api.meeting.qq.com/v1/corp/records?page=1')
})

test('特殊字符被 urlencode（+ 必须编码为 %2B）', () => {
  const b = buildUrl('https://api.meeting.qq.com', '/v1/meetings', {
    userid: '123+123',
  })
  expect(b.uriForSigning).toBe('/v1/meetings?userid=123%2B123')
  expect(b.url).toContain('userid=123%2B123')
})

test('undefined 值的参数被剔除', () => {
  const b = buildUrl('https://api.meeting.qq.com', '/v1/corp/records', {
    page: 1,
    meeting_code: undefined,
  })
  expect(b.uriForSigning).toBe('/v1/corp/records?page=1')
})

test('参数按字典序排列，保证同一组参数产出稳定字符串', () => {
  const a = buildUrl('https://x', '/v1/r', { b: 2, a: 1 })
  const c = buildUrl('https://x', '/v1/r', { a: 1, b: 2 })
  expect(a.uriForSigning).toBe(c.uriForSigning)
  expect(a.uriForSigning).toBe('/v1/r?a=1&b=2')
})

test('无查询参数时不产生问号', () => {
  const b = buildUrl('https://x', '/v1/smart/chapters', {})
  expect(b.uriForSigning).toBe('/v1/smart/chapters')
  expect(b.url).toBe('https://x/v1/smart/chapters')
})
