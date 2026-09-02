/**
 * 四个定时任务的文案只能有一份。
 *
 * ## 这份测试为什么值得存在
 *
 * 同一批字此前躺在**三个**地方，而且真的各写各的：
 *
 * - `src/store/jobs.ts` 的 `JOB_CATALOG` —— 界面上真正显示的那一份
 * - `docs/console/spec.md` §4.8 的表格 —— 那张表本来就是这一列的出处
 * - `console/src/api/mock/jobs.ts` —— 原型模式（`?proto=1`）显示的那一份
 *
 * 漂移的后果不是"两处措辞不一样"这种小事：
 *
 * 1. **原型那份比生产长一倍**（「问腾讯会议要新的录制，把八类资产下载到本地。」
 *    21 字 vs 生产 11 字）。而 `scripts/vqa.ts` 与 `console/scripts/a11y-check.ts`
 *    量的都是原型模式的页面——也就是说，这一页所有的视觉验收、所有的截图，
 *    量的都是一页**生产上并不存在**的文字。谁照着原型调版式，调的就是错的字长。
 * 2. **原型把任务四的频率写成「每 30 分钟」**，真值是 5 分钟。一个看原型的人
 *    会带走一个错的运维常识。
 *
 * 这类错没有任何东西会变红：三份都是合法的字符串，页面照常渲染，只是**说的不是
 * 同一件事**。只有人去逐字比对时才发现——而没有人会去逐字比对。
 *
 * 所以这里把三处钉在一起。要改文案，改 `JOB_CATALOG`，另两处跟着改，
 * 这条测试会告诉你漏了哪一处。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JOB_CATALOG, describeSchedule } from '../../src/store/jobs'

const ROOT = resolve(import.meta.dir, '../..')
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf-8')

const MOCK = 'console/src/api/mock/jobs.ts'
const SPEC = 'docs/console/spec.md'

/** 从原型那份里把某个任务的四个字段抠出来。 */
function protoJob(src: string, name: string): Record<string, string> {
  const start = src.indexOf(`name: '${name}',`)
  expect(start, `${MOCK} 里找不到任务 ${name}`).toBeGreaterThan(-1)
  // 到下一个 `name: '` 为止（最后一个到数组收尾），不跨块取字段
  const rest = src.slice(start + 1)
  const nextIdx = rest.indexOf("name: '")
  const block = nextIdx === -1 ? rest : rest.slice(0, nextIdx)
  const out: Record<string, string> = {}
  for (const key of ['label', 'what', 'schedule', 'impact']) {
    const m = new RegExp(`${key}: '([^']*)'`).exec(block)
    expect(m, `${MOCK} 的 ${name} 缺字段 ${key}`).not.toBeNull()
    out[key] = m![1]!
  }
  return out
}

test('原型模式的四个任务逐字等于 JOB_CATALOG —— 截图与视觉验收量的必须是生产上真有的字', () => {
  const src = read(MOCK)
  for (const spec of JOB_CATALOG) {
    const p = protoJob(src, spec.name)
    expect(p.label, `${spec.name} 的 label`).toBe(spec.label)
    expect(p.what, `${spec.name} 的 what`).toBe(spec.what)
    expect(p.impact, `${spec.name} 的 impact`).toBe(spec.impact)
    // 频率也要对：原型曾把任务四写成「每 30 分钟」，真值 5 分钟
    expect(p.schedule, `${spec.name} 的 schedule`).toBe(describeSchedule(spec.schedule))
  }
})

test('spec §4.8 那张表的「干什么」一列逐字等于 JOB_CATALOG', () => {
  const md = read(SPEC)
  const ordinals = ['一', '二', '三', '四']
  JOB_CATALOG.forEach((spec, i) => {
    const row = new RegExp(`^\\| ${ordinals[i]}、${spec.label} \\|([^|]*)\\|([^|]*)\\|`, 'm').exec(md)
    expect(row, `${SPEC} §4.8 里找不到「${ordinals[i]}、${spec.label}」那一行`).not.toBeNull()
    const cadence = row![1]!.trim()
    // 表格里那一格允许有 markdown 加粗（**记录保留**），比对前去掉标记
    const what = row![2]!.trim().replaceAll('**', '')
    expect(cadence, `${spec.name} 在 spec 里的频率`).toBe(describeSchedule(spec.schedule))
    expect(what, `${spec.name} 在 spec 里的「干什么」`).toBe(spec.what)
  })
})

test('没有一句文案把 spec 的章节号漏到界面上', () => {
  // 「§4.5 的数字与巡检看不到它」曾经真的显示在卡片上。看见它的人无从查起：
  // 界面上没有任何东西叫 §4.5，那是写这句话的人手边那份文档的章节号。
  for (const spec of JOB_CATALOG) {
    for (const [field, text] of [
      ['what', spec.what],
      ['impact', spec.impact],
    ] as const) {
      expect(text, `${spec.name} 的 ${field} 里有 spec 章节号`).not.toMatch(/§\d/)
    }
  }
})

test('文案短到能在一张卡片上一眼看完', () => {
  // 不是审美：这四段字挤在 1440 宽下 298px 的卡片里，四张并排。
  // 上限比现有最长的那条宽出一点余量，改文案时不至于一个字就红，
  // 但写出一段 30 字的说明会当场被挡下——那正是这一轮要收掉的东西。
  for (const spec of JOB_CATALOG) {
    expect(spec.what.length, `${spec.name} 的 what 太长`).toBeLessThanOrEqual(22)
    expect(spec.impact.length, `${spec.name} 的 impact 太长`).toBeLessThanOrEqual(22)
  }
})
