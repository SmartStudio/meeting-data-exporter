/**
 * probeNas 的用例结构与技巧镜像 tests/worker/e2e.test.ts 里 assertArchiveRootUsable
 * 的那一组（同一个"没有读者的 FIFO 会永久阻塞在 open"手法）。唯一的结构差异：
 * probeNas 按设计不抛异常，所以这里断言的是返回值形状（reachable/error），
 * 不是 rejects.toThrow。
 */
import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeNas } from '../../src/worker/nas-probe'

// 固定时钟：证明 checkedAt 真的来自注入的 now()，不是内部偷偷用 Date.now()。
const FIXED_NOW = 1787218200_000
const now = () => FIXED_NOW

describe('probeNas', () => {
  test('健康目录：reachable=true，容量字段为正数，探针清理干净，error 为 null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mde-nas-probe-'))
    try {
      const result = await probeNas(dir, now)
      expect(result.reachable).toBe(true)
      expect(result.error).toBeNull()
      expect(result.checkedAt).toBe(FIXED_NOW)
      expect(result.totalBytes).toBeGreaterThan(0)
      expect(result.availableBytes).toBeGreaterThan(0)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
      // 写探针必须清干净，不能在 NAS 根目录里留垃圾（跟 assertArchiveRootUsable 同一条硬要求）
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('路径不存在：reachable=false，error 提及该路径，容量字段为 null', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'mde-nas-probe-'))
    const missing = join(parent, 'does-not-exist')
    try {
      const result = await probeNas(missing, now)
      expect(result.reachable).toBe(false)
      expect(result.error).not.toBeNull()
      expect(result.error).toContain(missing)
      expect(result.totalBytes).toBeNull()
      expect(result.availableBytes).toBeNull()
      expect(result.checkedAt).toBe(FIXED_NOW)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('路径存在但不是目录：reachable=false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mde-nas-probe-'))
    const file = join(dir, 'not-a-dir')
    try {
      await writeFile(file, 'x')
      const result = await probeNas(file, now)
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('not a directory')
      expect(result.error).toContain(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('只读目录（chmod 0o500）：reachable=false——只看权限位看不出只读挂载，要真写一次', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mde-nas-probe-'))
    try {
      await chmod(dir, 0o500) // r-x：能进能列，不能写
      const result = await probeNas(dir, now)
      expect(result.reachable).toBe(false)
      expect(result.error).not.toBeNull()
    } finally {
      await chmod(dir, 0o700)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('挂死的挂载：写探针超时后返回 reachable=false，error 来自 FsTimeoutError，而不是让测试本身挂起', async () => {
    /**
     * 探针文件名是确定性的（带本进程 pid），测试因此能预先把它做成一个没有
     * 读者的 FIFO——`writeFile` 以 O_WRONLY 打开它会永久阻塞在 open（POSIX
     * 语义），超时必赢，不存在竞速。与 assertArchiveRootUsable 用的是同一手法。
     */
    const dir = await mkdtemp(join(tmpdir(), 'mde-nas-probe-'))
    const probe = join(dir, `.mde-nas-probe-${process.pid}`)
    try {
      const mkfifo = Bun.spawnSync(['mkfifo', probe])
      expect(mkfifo.exitCode).toBe(0) // 造不出 FIFO 就别假装测过了

      const result = await probeNas(dir, now, 50)

      // 四件事一起断言：确实失败了、是超时这一类（错误来自 FsTimeoutError 而不是
      // 被当成别的什么错误）、容量字段没有半真半假地填一部分、latencyMs 反映的是
      // 真实耗时而不是恒为 0。
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timed out after 50ms')
      expect(result.totalBytes).toBeNull()
      expect(result.availableBytes).toBeNull()
      expect(result.latencyMs).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
