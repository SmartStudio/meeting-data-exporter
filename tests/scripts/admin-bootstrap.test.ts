import { expect, test } from 'bun:test'
import { parseArgs } from '../../scripts/admin-bootstrap'

test('parseArgs parses both --username and --password correctly', () => {
  const result = parseArgs(['--username', 'admin', '--password', 'mypassword123'])
  expect(result).toEqual({ username: 'admin', password: 'mypassword123' })
})

test('parseArgs throws when --username is missing', () => {
  expect(() => parseArgs(['--password', 'mypassword123'])).toThrow(
    'usage: bun scripts/admin-bootstrap.ts --username <name> --password <password>',
  )
})

test('parseArgs throws when --password is missing', () => {
  expect(() => parseArgs(['--username', 'admin'])).toThrow(
    'usage: bun scripts/admin-bootstrap.ts --username <name> --password <password>',
  )
})

test('parseArgs throws when both arguments are missing', () => {
  expect(() => parseArgs([])).toThrow(
    'usage: bun scripts/admin-bootstrap.ts --username <name> --password <password>',
  )
})

test('parseArgs throws when password is shorter than 8 characters', () => {
  expect(() => parseArgs(['--username', 'admin', '--password', 'short'])).toThrow(
    'password must be at least 8 characters',
  )
})

test('parseArgs accepts password with exactly 8 characters', () => {
  const result = parseArgs(['--username', 'admin', '--password', '12345678'])
  expect(result).toEqual({ username: 'admin', password: '12345678' })
})

test('parseArgs ignores extra arguments', () => {
  const result = parseArgs(['--username', 'admin', '--password', 'mypassword123', '--extra', 'ignored'])
  expect(result).toEqual({ username: 'admin', password: 'mypassword123' })
})
