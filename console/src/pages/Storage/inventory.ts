import { daysLeft, fmtBytes, fmtDateTime } from '@/lib/format'
import type { FetchableList, FetchableMeeting } from '@/api/admin/storage'

/**
 * 「导出可采集清单」的成文与落盘（spec §4.9 的第二个动作）。
 *
 * 原型里这个按钮只弹一句 toast（`gate-console.html:4059`）。真做出来要回答
 * 三个问题：**导出的是什么口径**（保留期内 + 判定可采集）、**清单里有什么**
 * （会议号、到期日、已授权程序、NAS 路径——原型那句 toast 自己列了）、
 * 以及**清单完不完整**（没扫全时文件名里带「部分」，见下）。
 */

/** CSV 的表头。顺序即列序，改了要同时改下面那行取值。 */
const COLUMNS = [
  '会议号',
  '标题',
  '主持人',
  '开始时间',
  '到期日',
  '剩余天数',
  '已授权程序',
  'NAS 路径',
  '本地大小',
  '判定理由',
  '元数据缺失',
] as const

/**
 * 一个字段的 CSV 转义。
 *
 * 会议标题里出现逗号、引号、换行都是常事（"周会（Q3）, 复盘"），不转义的话
 * 一场会议会在表格软件里裂成两列，而裂开之后每一行都错位——**看起来仍然是
 * 一份完整的清单**，这是最坏的一种坏。
 */
function cell(v: string): string {
  const s = v.replace(/\r\n/g, '\n')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function rowOf(m: FetchableMeeting, now: Date): string[] {
  return [
    m.code,
    m.title,
    m.host,
    m.startAt === 0 ? '' : fmtDateTime(m.startAt, now),
    m.expiresAt === null ? '未开始计时' : fmtDateTime(m.expiresAt, now),
    m.expiresAt === null ? '' : String(daysLeft(m.expiresAt, now)),
    m.grants.join(' / '),
    m.nasPath ?? '',
    m.sizeBytes === null ? '' : fmtBytes(m.sizeBytes),
    m.allowWhy,
    m.missing.join(' / '),
  ]
}

/**
 * 生成 CSV 正文。
 *
 * 开头那个 BOM 不是装饰：Excel 打开不带 BOM 的 UTF-8 CSV 会把中文认成 GBK，
 * 整张表变成乱码，而拿到这份清单的人多半就是用 Excel 打开它。
 */
export function buildInventoryCsv(rows: FetchableMeeting[], now: Date = new Date()): string {
  const lines = [COLUMNS.join(','), ...rows.map((m) => rowOf(m, now).map(cell).join(','))]
  return `﻿${lines.join('\r\n')}\r\n`
}

/** 文件名里带日期；**没扫全时带上「部分」**——警告要跟着文件走，光在 toast 里说，
 *  文件转手给别人之后那句话就没了。 */
export function inventoryFileName(list: FetchableList, now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  return `可采集清单${list.truncated ? '-部分' : ''}-${stamp}.csv`
}

/**
 * 把一段文本交给浏览器下载。
 *
 * 用 `Blob` + `createObjectURL` 而不是 `data:` URL：中文清单几百 KB 很正常，
 * 而 `data:` URL 在部分浏览器上有长度上限，超了会静默失败——一个点了没反应
 * 的导出按钮。用完就 revoke，否则这个 URL 会一直占着那份 Blob。
 */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}
