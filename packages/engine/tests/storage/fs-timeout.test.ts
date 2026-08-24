import { expect, spyOn, test } from 'bun:test'
import { withFsTimeout, FsTimeoutError } from '../../src/storage/fs-timeout'
import { mkdtemp, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 挂死的网络挂载在本地造不出来，但没有读者的 FIFO 可以：`open` 以 `O_WRONLY`
 * 打开一个无读者的 FIFO 会**永久阻塞在 open**（POSIX 语义），超时必赢，
 * 不存在竞速。与 tests/worker/e2e.test.ts 里验证 assertArchiveRootUsable 用的
 * 是同一个技巧。
 */
async function makeHangingFifo(): Promise<{ dir: string; fifo: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mde-fifo-'))
  const fifo = join(dir, 'hang')
  const mkfifo = Bun.spawnSync(['mkfifo', fifo])
  if (mkfifo.exitCode !== 0) throw new Error('mkfifo failed — cannot simulate a hung mount')
  return { dir, fifo }
}

test('正常 promise 在超时前 resolve → 返回其结果，FsTimeoutError 不抛出', async () => {
  const result = await withFsTimeout(Promise.resolve(42), 'thing', 1000)
  expect(result).toBe(42)
})

test('正常 promise 在超时前 reject → 原始错误原样抛出（不是 FsTimeoutError）', async () => {
  const boom = new Error('boom')
  const err = await withFsTimeout(Promise.reject(boom), 'thing', 1000).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBe(boom)
  expect(err).not.toBeInstanceOf(FsTimeoutError)
})

test('promise 挂住不返回 → 在 ms 后抛出 FsTimeoutError，错误信息包含 what', async () => {
  const { dir, fifo } = await makeHangingFifo()
  try {
    const err = await withFsTimeout(open(fifo, 'w'), 'write fifo probe', 50).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(FsTimeoutError)
    expect((err as Error).name).toBe('FsTimeoutError')
    expect((err as Error).message).toContain('write fifo probe')
    expect((err as Error).message).toContain('timed out after 50ms')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('无论 resolve 还是超时，finally 里的 clearTimeout 都会跑，不留残留定时器', async () => {
  const spy = spyOn(globalThis, 'clearTimeout')
  try {
    await withFsTimeout(Promise.resolve(1), 'resolved-case', 1000)
    expect(spy).toHaveBeenCalledTimes(1)

    const { dir, fifo } = await makeHangingFifo()
    try {
      await withFsTimeout(open(fifo, 'w'), 'hung-case', 30).then(
        () => null,
        () => null,
      )
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } finally {
    spy.mockRestore()
  }
})
