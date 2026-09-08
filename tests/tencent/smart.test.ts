import { expect, test } from 'bun:test'
import { createSmartApi, serializeChapters, SMART_MINUTES_QUOTA_KEY } from '../../src/tencent/smart'
import { TencentApiError } from '../../src/tencent/errors'
import type { QueryParams } from '../../src/tencent/url'
import type { RequestOptions, TencentClient } from '../../src/tencent/client'

interface Call { path: string; query: QueryParams; opts?: RequestOptions }

function stubClient(handler: (path: string, query: QueryParams) => unknown): { client: TencentClient; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    client: {
      get: async <T,>(path: string, query: QueryParams, opts?: RequestOptions) => {
        calls.push({ path, query, opts })
        return handler(path, query) as T
      },
      post: async <T,>() => ({}) as T,
      currentQps: () => 5,
    },
  }
}

test('getMinutes：路径带 record_file_id，text_type=2，配额键是常量', async () => {
  const { client, calls } = stubClient(() => ({ meeting_minute: { minute: '## 会议摘要\n\n正文', todo: '' } }))
  const api = createSmartApi(client, 'op-1')
  const md = await api.getMinutes('rf-1')
  expect(md).toBe('## 会议摘要\n\n正文\n')
  expect(calls[0]).toEqual({
    path: '/v1/smart/minutes/rf-1',
    query: { operator_id: 'op-1', operator_id_type: 1, text_type: 2 },
    opts: { quotaKey: SMART_MINUTES_QUOTA_KEY },
  })
})

test('getMinutes：todo 非空时拼成「## 待办」段', async () => {
  const { client } = stubClient(() => ({ meeting_minute: { minute: '正文', todo: '- 甲：周五前交方案' } }))
  const md = await createSmartApi(client, 'op-1').getMinutes('rf-1')
  expect(md).toBe('正文\n\n## 待办\n\n- 甲：周五前交方案\n')
})

test('getMinutes：正文为空视为没有（null）', async () => {
  const { client } = stubClient(() => ({ meeting_minute: { minute: '   ', todo: '' } }))
  expect(await createSmartApi(client, 'op-1').getMinutes('rf-1')).toBeNull()
})

test('getMinutes：资产级永久错误（500182）返回 null，不抛', async () => {
  const { client } = stubClient(() => { throw new TencentApiError(500182, 400, '该文件未打开智能录制开关') })
  expect(await createSmartApi(client, 'op-1').getMinutes('rf-1')).toBeNull()
})

test('getMinutes：transient 错误原样抛出', async () => {
  const { client } = stubClient(() => { throw new TencentApiError(190310, 400, '超限') })
  await expect(createSmartApi(client, 'op-1').getMinutes('rf-1')).rejects.toBeInstanceOf(TencentApiError)
})

test('getChapters：query 带 record_file_id，章节名 base64 解码，start_time 转数字', async () => {
  const name = Buffer.from('广告系统数据流转', 'utf8').toString('base64')
  const { client, calls } = stubClient(() => ({
    chapter_list: [
      { chapter_id: 'C1', chapter_name: name, pic_url: 'https://img?sign=x&t=1', start_time: '7837' },
      { chapter_id: 'C2', chapter_name: '', start_time: 'abc' },
    ],
  }))
  const ch = await createSmartApi(client, 'op-1').getChapters('rf-1')
  expect(calls[0]!.path).toBe('/v1/smart/chapters')
  expect(calls[0]!.query).toEqual({ operator_id: 'op-1', operator_id_type: 1, record_file_id: 'rf-1' })
  expect(ch).toEqual([
    { chapterId: 'C1', name: '广告系统数据流转', startMs: 7837 },
    { chapterId: 'C2', name: '', startMs: 0 },
  ])
})

test('getChapters：空列表与 500182 都是 null', async () => {
  const empty = stubClient(() => ({ chapter_list: [] }))
  expect(await createSmartApi(empty.client, 'op-1').getChapters('rf-1')).toBeNull()
  const off = stubClient(() => { throw new TencentApiError(500182, 400, '未打开') })
  expect(await createSmartApi(off.client, 'op-1').getChapters('rf-1')).toBeNull()
})

test('serializeChapters：稳定字段、两空格缩进、末尾换行、不含 pic_url', () => {
  const s = serializeChapters('rf-1', [{ chapterId: 'C1', name: '开场', startMs: 7837 }])
  expect(s).toBe(JSON.stringify({ schemaVersion: 1, recordFileId: 'rf-1', chapters: [{ chapterId: 'C1', name: '开场', startMs: 7837 }] }, null, 2) + '\n')
  expect(s).not.toContain('pic_url')
})
