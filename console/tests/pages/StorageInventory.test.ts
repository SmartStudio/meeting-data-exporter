import { describe, expect, test } from 'vitest'
import { buildInventoryCsv, inventoryFileName } from '../../src/pages/Storage/inventory'
import type { FetchableMeeting } from '../../src/api/admin/storage'

/**
 * 「导出可采集清单」的成文部分。
 *
 * 这里要盯的是 CSV 里最容易出错、又最难被发现的那件事：**转义**。
 * 会议标题里出现逗号、引号、换行都是常事，不转义的话一场会议在表格软件里
 * 裂成两列，之后每一行都错位——而它看起来仍然是一份完整的清单。
 */

const NOW = new Date(2026, 7, 26, 10, 0, 0)

function row(over: Partial<FetchableMeeting> = {}): FetchableMeeting {
  return {
    meetingId: 'm-1',
    subMeetingId: '',
    title: '产品周会',
    code: '123-456-789',
    host: 'zouyanjian',
    startAt: Math.floor(new Date(2026, 7, 20, 14, 0, 0).getTime() / 1000),
    missing: [],
    expiresAt: Math.floor(new Date(2026, 8, 20, 14, 0, 0).getTime() / 1000),
    grants: ['kb-indexer', 'brief-bot'],
    nasPath: '/nas/meetings/2026/08/产品周会/',
    sizeBytes: 120000000,
    allowWhy: '标题含「周会」，规则 #100',
    ...over,
  }
}

describe('buildInventoryCsv', () => {
  test('表头逐列，取值按同一顺序', () => {
    const csv = buildInventoryCsv([row()], NOW)
    const [header, first] = csv.replace(/^﻿/, '').split('\r\n')
    expect(header).toBe('会议号,标题,主持人,开始时间,到期日,剩余天数,已授权程序,NAS 路径,本地大小,判定理由,元数据缺失')
    expect(first?.startsWith('123-456-789,产品周会,zouyanjian,')).toBe(true)
    expect(first).toContain('kb-indexer / brief-bot')
    expect(first).toContain('/nas/meetings/2026/08/产品周会/')
  })

  test('标题里的逗号 / 引号 / 换行都转义，行数不会因此变多', () => {
    const csv = buildInventoryCsv([row({ title: '复盘, "Q3", 第二场\n（续）' })], NOW)
    const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n')
    // 一场会议仍然是一条记录：带引号的字段里那个换行不是记录分隔符
    expect(lines).toHaveLength(2)
    expect(csv).toContain('"复盘, ""Q3"", 第二场\n（续）"')
  })

  test('拿不到的值留空，不填 0 也不填「未知」', () => {
    // 空单元格在表格里就是"这一格没有值"，填一个 0 会被当成一次读数。
    const csv = buildInventoryCsv([row({ expiresAt: null, sizeBytes: null, startAt: 0, grants: [] })], NOW)
    const line = csv.replace(/^﻿/, '').split('\r\n')[1]!
    expect(line).toContain('未开始计时')
    expect(line).not.toContain('0 B')
    expect(line.split(',')).toHaveLength(11)
  })

  test('剩余天数用 lib/format 的自然日口径，不自己算', () => {
    const csv = buildInventoryCsv([row()], NOW)
    // 2026-08-26 到 2026-09-20 是 25 天
    expect(csv).toContain(',25,')
  })

  test('开头有 BOM —— 没有它，Excel 打开中文清单是一片乱码', () => {
    expect(buildInventoryCsv([], NOW).startsWith('﻿')).toBe(true)
  })
})

describe('inventoryFileName', () => {
  test('带日期', () => {
    expect(inventoryFileName({ rows: [], total: 0, scanned: 0, truncated: false }, NOW)).toBe(
      '可采集清单-20260826.csv',
    )
  })

  test('没扫全时文件名里标「部分」——警告要跟着文件走', () => {
    // 只在 toast 里说的话，文件转手给别人之后那句话就没了，
    // 而一份半截的"可采集清单"会被当成"这些就是全部"。
    expect(inventoryFileName({ rows: [], total: 900, scanned: 500, truncated: true }, NOW)).toContain(
      '部分',
    )
  })
})
