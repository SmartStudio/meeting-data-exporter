/**
 * 任务之间的接续关系只能有一份。
 *
 * 后端的 `JOB_CHAINS`（`src/worker/scheduler.ts`）是真正在起作用的那一份：某个任务
 * 一轮成功收尾、摘要满足条件，就往队里排一轮下游。控制台的定时任务页要把这层关系
 * **画出来**（哪几个串成一条链、箭头指向谁），但 `GET /admin/jobs` 眼下不下发它，
 * 所以 `console/src/pages/Jobs/view.ts` 的 `CHAIN_AFTER` 抄了一份。
 *
 * 两份一旦漂移，页面上画的箭头就指向一条并不存在的因果——而没有任何东西会变红。
 * 这里把它们钉在一起：改 `JOB_CHAINS` 就得改 `CHAIN_AFTER`，反之亦然。
 * 后端哪天把关系放进契约，删掉 `CHAIN_AFTER` 连同这条测试。
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JOB_CHAINS } from '../../src/worker/scheduler'

const ROOT = resolve(import.meta.dir, '../..')
const VIEW = 'console/src/pages/Jobs/view.ts'

/** 从源码里把 `CHAIN_AFTER = { 下游: ['上游', …], … }` 那一块抠成对象。 */
function frontChains(src: string): Record<string, string[]> {
  const block = /export const CHAIN_AFTER[^=]*=\s*\{([\s\S]*?)\n\}/.exec(src)
  expect(block, `${VIEW} 里找不到 CHAIN_AFTER`).not.toBeNull()
  const out: Record<string, string[]> = {}
  for (const line of block![1]!.split('\n')) {
    const row = /^\s*(\w+):\s*\[([^\]]*)\]/.exec(line)
    if (row === null) continue
    out[row[1]!] = row[2]!
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter((s) => s !== '')
  }
  return out
}

test('控制台的 CHAIN_AFTER 逐条等于后端的 JOB_CHAINS（下游 → 上游列表）', () => {
  const front = frontChains(readFileSync(resolve(ROOT, VIEW), 'utf-8'))
  const back: Record<string, string[]> = {}
  for (const c of JOB_CHAINS) {
    ;(back[c.run] ??= []).push(c.after)
  }
  expect(front).toEqual(back)
})
