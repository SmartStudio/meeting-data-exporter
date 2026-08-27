/**
 * `audit_log.action` 的动作登记表（阶段 5 · A9）。
 *
 * ## 这份测试为什么值得存在
 *
 * 审计页存在的全部理由是「给人读」。而在这张表补齐之前，24 个动作里有 21 个
 * 在界面上显示成 snake_case 英文原值——不会有任何测试变红、不会有任何门槛变红，
 * 界面也不坏，只是**一大半记录读不懂**。一个只在人去读的时候才发现的缺陷。
 *
 * 所以这里钉三件事：
 *
 * 1. **仓库里每一个真的会被写进 `audit_log.action` 的动作名都登记了标签**
 *    （下面那张 `WRITTEN_ACTIONS` 是显式清单，新增动作时必须同时改两处）；
 * 2. **标签是中文，且不是 snake_case 直译**——`rule_toggle → 'rule toggle'`
 *    这种「补了等于没补」的行会被挡下；
 * 3. **认不出的动作回 null，不回原值**。回原值等于假装登记过：前端再也分不出
 *    「这个动作叫这个名字」与「这个动作没人登记过」，于是漏登记永远不会被发现。
 *
 * 另有一条源码扫描当绊线：新加的写操作若直接写 `action: 'xxx'` 字面量而没进
 * 登记表，扫描会点名它。靠人在评审时数一遍是数不住的——F5c 那份 grep 就漏了
 * `extend_retention`（它是常量，不是字面量）。
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUDIT_ACTION,
  AUDIT_ACTION_LABELS,
  UNLABELED_ACTION_HINT,
  auditActionLabel,
  unlabeledActions,
} from '../../src/audit/actions'

/**
 * 仓库里**真的会被写进 `audit_log.action`** 的动作名，逐个列出。
 *
 * 这份清单是测试的一部分而不是从实现里读出来的：从 `AUDIT_ACTION_LABELS` 自己
 * 推一遍等于什么都没测。删掉实现里的一行，这里会红。
 *
 * 出处（截至阶段 5 · A9）：
 * - `src/audit/recorder.ts`：网关侧三个
 * - `src/http/handlers/console/auth.ts`：账号四个（三个来自阶段 5 · A8，
 *   `change_admin_role` 是补上「角色只能建号时定」那个洞时加的）
 * - `src/http/handlers/console/grants.ts`：程序与授权八个（后三个 A8 新加）
 * - `src/http/handlers/console/rules.ts`：规则四个
 * - `src/http/handlers/console/storage.ts`：存储六个（含 `extend_retention`）
 * - `src/http/handlers/console/jobs.ts`：`run_job`
 * - `src/http/handlers/console/content.ts`：查看内容两个
 */
const WRITTEN_ACTIONS = [
  // 网关侧
  'issue_download_url',
  'login',
  'list_meetings',
  // 管理员账号
  'create_admin_account',
  'delete_admin_account',
  'change_admin_password',
  'change_admin_role',
  // 采集程序
  'create_program',
  'enable_program',
  'disable_program',
  'rotate_program_secret',
  // 逐会议授权与人工改写
  'grant_meeting',
  'revoke_grant',
  'put_override',
  'revoke_override',
  // 自动规则
  'rule_create',
  'rule_update',
  'rule_toggle',
  'rule_delete',
  // 归档存储与保留窗口
  'set_retention_days',
  'set_cleanup_paused',
  'cleanup_now',
  'purge_local',
  'purge_blocked',
  'purge_failed',
  'extend_retention',
  // 定时任务
  'run_job',
  // 内容查看
  'view_content',
  'view_restricted_content',
] as const

test('每一个会被写进 audit_log 的动作都登记了标签（一个不少）', () => {
  const missing = WRITTEN_ACTIONS.filter((a) => !(a in AUDIT_ACTION_LABELS))
  // 一次报全部，而不是在第一个上就断掉——漏掉的往往不止一个
  expect(missing).toEqual([])
})

test('登记表里没有多余的行（登记了一个没人写的动作，说明动作名改过而这里没跟上）', () => {
  const known = new Set<string>(WRITTEN_ACTIONS)
  expect(Object.keys(AUDIT_ACTION_LABELS).filter((a) => !known.has(a))).toEqual([])
})

test('每个标签都是中文，且不是 snake_case 直译', () => {
  const bad: string[] = []
  for (const [action, label] of Object.entries(AUDIT_ACTION_LABELS)) {
    // 「补了等于没补」的三种写法：空的、与原值一样的、把下划线换成空格的
    if (label.trim() === '') bad.push(`${action}：标签是空的`)
    else if (label === action) bad.push(`${action}：标签就是原值`)
    else if (label === action.replace(/_/g, ' ')) bad.push(`${action}：只是把下划线换成了空格`)
    else if (!/[一-龥]/.test(label)) bad.push(`${action}：标签里一个汉字都没有（${label}）`)
  }
  expect(bad).toEqual([])
})

test('认不出的动作回 null，不回原值（回原值就等于假装登记过）', () => {
  expect(auditActionLabel('issue_download_url')).toBe('签发下载链接')
  expect(auditActionLabel('frobnicate')).toBeNull()
  // 空串与 __proto__ 这类键也走同一条路，不能因为原型链摸到一个函数
  expect(auditActionLabel('')).toBeNull()
  expect(auditActionLabel('__proto__')).toBeNull()
  expect(auditActionLabel('toString')).toBeNull()
})

test('AUDIT_ACTION 里的每个常量都指向一个登记过的动作', () => {
  const bad = Object.entries(AUDIT_ACTION).filter(([, v]) => !(v in AUDIT_ACTION_LABELS))
  expect(bad).toEqual([])
  // 常量的个数与登记表一致：少一个就意味着某个动作只能写字面量
  expect(Object.keys(AUDIT_ACTION).length).toBe(Object.keys(AUDIT_ACTION_LABELS).length)
})

test('unlabeledActions 把这一页里没登记的动作点名报出来（含条数与一句人话）', () => {
  const out = unlabeledActions(['login', 'frobnicate', 'frobnicate', 'run_job', 'zzz'])
  expect(out).toEqual([
    { action: 'frobnicate', count: 2, hint: UNLABELED_ACTION_HINT },
    { action: 'zzz', count: 1, hint: UNLABELED_ACTION_HINT },
  ])
  // 全都登记过时是空数组，而不是 null——前端不必区分「没有」与「没算」
  expect(unlabeledActions(['login', 'run_job'])).toEqual([])
})

test('那句人话说得出「没有登记标签」，而不是一句泛泛的「未知」', () => {
  expect(UNLABELED_ACTION_HINT).toContain('没有登记')
  expect(UNLABELED_ACTION_HINT).toContain('原值')
})

// ── 绊线：新加的写操作不许绕过登记表 ────────────────────────────────────

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) tsFiles(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

test('src/ 里没有一个绕过登记表的 action 字面量', () => {
  const strays: string[] = []
  for (const file of tsFiles(join(import.meta.dir, '../../src'))) {
    const text = readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      // 只看真的在给 action 赋值的那几种写法：`action: 'x'`、`action = 'x'`、
      // 以及 content.ts 那种 `const action = cond ? 'a' : 'b'`。
      // 注释里出现的动作名不算——它们进不了库。
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
      if (!/\baction\s*[:=]/.test(line)) return
      for (const m of line.matchAll(/'([a-z][a-z0-9_]*)'/g)) {
        const value = m[1]!
        if (value in AUDIT_ACTION_LABELS) continue
        strays.push(`${file.replace(/.*\/src\//, 'src/')}:${i + 1} → '${value}'`)
      }
    })
  }
  // 报全部：一次新增动作往往会同时留下好几处
  expect(strays).toEqual([])
})
