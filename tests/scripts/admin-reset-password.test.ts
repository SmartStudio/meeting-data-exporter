import { expect, test } from 'bun:test'
import { parseArgs } from '../../scripts/admin-reset-password'

const USAGE = 'usage: bun scripts/admin-reset-password.ts --username <name> --password <新密码>'

test('parseArgs 同时取到 --username 与 --password', () => {
  expect(parseArgs(['--username', 'admin', '--password', 'mypassword123'])).toEqual({
    username: 'admin',
    password: 'mypassword123',
  })
})

test('缺 --username 报用法', () => {
  expect(() => parseArgs(['--password', 'mypassword123'])).toThrow(USAGE)
})

test('缺 --password 报用法', () => {
  expect(() => parseArgs(['--username', 'admin'])).toThrow(USAGE)
})

test('两个都缺报用法', () => {
  expect(() => parseArgs([])).toThrow(USAGE)
})

test('密码门槛与建号那条路径同一个判定：短于 8 位拒绝', () => {
  // 门槛来自 src/auth/admin.ts 的 isAdminPasswordAcceptable，不在脚本里另写一份。
  // 这条测试的意义是钉住「重置这条路不许比建号那条路松」——一条能绕过长度
  // 要求的恢复通道，等于长度要求不存在。
  expect(() => parseArgs(['--username', 'admin', '--password', 'short'])).toThrow(
    'password must be at least 8 characters',
  )
})

test('刚好 8 位接受', () => {
  expect(parseArgs(['--username', 'admin', '--password', '12345678'])).toEqual({
    username: 'admin',
    password: '12345678',
  })
})

test('多余参数忽略', () => {
  expect(
    parseArgs(['--username', 'admin', '--password', 'mypassword123', '--extra', 'ignored']),
  ).toEqual({ username: 'admin', password: 'mypassword123' })
})
