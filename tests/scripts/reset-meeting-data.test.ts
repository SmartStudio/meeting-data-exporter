import { expect, test } from 'bun:test'
import { parseArgs, isLocalDatabase, KEPT_TABLES } from '../../scripts/reset-meeting-data'

test('没有 --confirm 就报用法 —— 不可逆删除不接受省略', () => {
  expect(() => parseArgs([])).toThrow('--confirm')
  expect(() => parseArgs(['--keep-job-runs'])).toThrow('--confirm')
})

test('--confirm 之后其余是开关', () => {
  expect(parseArgs(['--confirm'])).toEqual({
    confirm: true,
    keepJobRuns: false,
    allowRemote: false,
  })
  expect(parseArgs(['--confirm', '--keep-job-runs', '--allow-remote'])).toEqual({
    confirm: true,
    keepJobRuns: true,
    allowRemote: true,
  })
})

// ── 本机判据是白名单 ──────────────────────────────────────────────
//
// 反过来写（「不含生产域名就算本地」）的失效方式是静默的：换一个没见过的
// 域名就放行了，而放行的后果是一个生产库被清空。

test('本机的几种写法都认', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    expect(isLocalDatabase(`mysql://u:p@${host}:3306/mde`), host).toBe(true)
  }
})

test('远端一律不认', () => {
  for (const host of ['db.prod.internal', '10.0.1.9', 'mde-db.example.com', 'localhost.evil.com']) {
    expect(isLocalDatabase(`mysql://u:p@${host}:3306/mde`), host).toBe(false)
  }
})

test('解析不出来的连接串当远端 —— 拿不准就落到拒绝那一侧', () => {
  expect(isLocalDatabase('not a url')).toBe(false)
  expect(isLocalDatabase('')).toBe(false)
})

// ── 保留名单 ────────────────────────────────────────────────────
//
// 清库脚本最容易犯的错不是漏删，是多删。这几张表各自都有一个"删了就回不来"
// 的后果，逐个钉住。

test('账号、规则、设置绝不在清空名单里', () => {
  const kept = new Set(KEPT_TABLES.map((t) => t.table))
  // 清了就登不进去，而 bootstrap 只在空表时可用 —— 一个没有产品路径能退出的状态
  expect(kept).toContain('admin_accounts')
  // 清了就没有任何拉取规则：重跑一轮什么都不会下，而界面上看不出是为什么
  expect(kept).toContain('policy_rules')
  // 保留天数、清理暂停开关
  expect(kept).toContain('system_settings')
  // 采集端凭据
  expect(kept).toContain('service_accounts')
  // 审计记的是真的发生过的事，清库不该把它一起抹掉
  expect(kept).toContain('audit_log')
})

test('每一张保留的表都写得出理由 —— 名单不许有没解释的行', () => {
  for (const t of KEPT_TABLES) {
    expect(t.why.length, `${t.table} 没写理由`).toBeGreaterThan(8)
  }
})
