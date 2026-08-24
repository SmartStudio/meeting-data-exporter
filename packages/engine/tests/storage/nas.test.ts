import { expect, test } from 'bun:test'
import { createNasStorage } from '../../src/storage/nas'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function tmp() { return mkdtemp(join(tmpdir(), 'mde-nas-')) }

// ---------------------------------------------------------------------------
// 契约等价用例：与 local.test.ts 对同一份 Storage 接口跑一遍，用临时目录当"NAS 根"。
// nas.ts 与 local.ts 语义完全一致（唯一区别是包了 withFsTimeout），所以正常路径下
// 结果必须与 local 版本一样。
// ---------------------------------------------------------------------------

test('appendChunk 落 .part，finalize 原子 rename 为正式名', async () => {
  const root = await tmp(); const s = createNasStorage(root)
  await s.appendChunk('a/b/f.mp4', 0, new Uint8Array([1, 2, 3]))
  expect(await s.writtenSize('a/b/f.mp4')).toBe(3)
  expect(await Bun.file(join(root, 'a/b/f.mp4')).exists()).toBe(false)
  await s.finalize('a/b/f.mp4')
  expect(await Bun.file(join(root, 'a/b/f.mp4')).exists()).toBe(true)
  await rm(root, { recursive: true, force: true })
})

test('续传：从 offset 追加，writtenSize 递增', async () => {
  const root = await tmp(); const s = createNasStorage(root)
  await s.appendChunk('f.bin', 0, new Uint8Array([1, 2]))
  await s.appendChunk('f.bin', 2, new Uint8Array([3, 4, 5]))
  expect(await s.writtenSize('f.bin')).toBe(5)
  await rm(root, { recursive: true, force: true })
})

test('discardPart 删除 .part（416/200 时重下）', async () => {
  const root = await tmp(); const s = createNasStorage(root)
  await s.appendChunk('f.bin', 0, new Uint8Array([9]))
  await s.discardPart('f.bin')
  expect(await s.writtenSize('f.bin')).toBe(0)
  await rm(root, { recursive: true, force: true })
})

test('readPart 读回 .part 全量内容', async () => {
  const root = await tmp(); const s = createNasStorage(root)
  await s.appendChunk('f.bin', 0, new Uint8Array([1, 2, 3, 4]))
  const buf = new Uint8Array(await s.readPart('f.bin'))
  expect([...buf]).toEqual([1, 2, 3, 4])
  await rm(root, { recursive: true, force: true })
})

test('writeMeta 写元数据文件，直接落正式名（不经过 .part）', async () => {
  const root = await tmp(); const s = createNasStorage(root)
  await s.writeMeta('meeting.json', { subject: 'x' })
  expect(await Bun.file(join(root, 'meeting.json')).json()).toEqual({ subject: 'x' })
  expect(await Bun.file(join(root, 'meeting.json.part')).exists()).toBe(false)
  await rm(root, { recursive: true, force: true })
})

test('ensureFreeSpace 对真实可用空间返回 true', async () => {
  const root = await tmp(); const s = createNasStorage(root)
  expect(await s.ensureFreeSpace(1)).toBe(true)
  await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 兜底分支的"对照组"：普通 fs 错误（不是超时）必须仍然吞掉、返回兜底值——
// 这条不能因为加了超时判别就被误伤。
// ---------------------------------------------------------------------------

test('writtenSize 对着从未创建过的文件，返回兜底值 0（不是挂起，也不是 FsTimeoutError）', async () => {
  const root = await tmp(); const s = createNasStorage(root)
  expect(await s.writtenSize('never-created.bin')).toBe(0)
  await rm(root, { recursive: true, force: true })
})

test('ensureFreeSpace 对着不存在的 root 目录（真实 statfs 失败），返回兜底值 true（不是挂起，也不是 FsTimeoutError）', async () => {
  const parent = await tmp()
  const missingRoot = join(parent, 'does-not-exist')
  const s = createNasStorage(missingRoot)
  expect(await s.ensureFreeSpace(1)).toBe(true)
  await rm(parent, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// NAS 特有场景：挂起的挂载。
//
// 用无读者的 FIFO 在本地确定性地模拟"挂起"，已用脚本逐一实测过每个会被
// wrap() 包住的 fs 调用在 FIFO 上到底是"挂住"还是"瞬间返回/瞬间报错"：
//   - node:fs/promises 的 open()：挂住（POSIX 语义，O_WRONLY 打开无读者的 FIFO
//     阻塞在 open）——appendChunk 的第二个 wrap 调用踩的正是这一条。
//   - node:fs/promises 的 stat()/mkdir()/rename()：全部瞬间返回（<1ms），不会
//     被 FIFO 挂住——它们不需要为 I/O 打开目标，只是目录项/元数据操作。
//   - Bun.write()：对无读者的 FIFO 走的是非阻塞 open，瞬间返回 ENXIO 这个
//     真实错误，同样不会挂住。
//
// 结论：appendChunk 是这份实现里唯一能用本地 FIFO 真正触发"挂起→超时"分支的
// 调用点；finalize（mkdir/rename）与 writtenSize/ensureFreeSpace（stat/statfs）
// 没法用这个技巧在本地复现挂起，只能证明它们的判别式/wrap() 对一个真实的
// FsTimeoutError（分别来自 appendChunk 这条真挂起，或来自 fs-timeout.test.ts
// 对 withFsTimeout 本身的证明）不会误吞、也不会把一个真实的普通错误误判成
// 超时——这两条分别由上面"对照组"与下面 writeMeta 的 ENXIO 用例覆盖。
// ---------------------------------------------------------------------------

test('appendChunk 遇到挂起的挂载（FIFO 模拟无读者管道）在超时后抛出 FsTimeoutError，而不是永久挂起', async () => {
  const root = await tmp()
  try {
    const fifo = join(root, 'f.mp4.part') // 与 appendChunk 内部 part(rel) 算出的路径完全一致
    const mkfifo = Bun.spawnSync(['mkfifo', fifo])
    expect(mkfifo.exitCode).toBe(0) // 造不出 FIFO 就别假装测过了

    const s = createNasStorage(root, 50)
    const err = await s.appendChunk('f.mp4', 0, new Uint8Array([1, 2, 3])).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('FsTimeoutError')
    expect((err as Error).message).toContain('timed out after 50ms')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writeMeta 遇到无读者管道时的真实 ENXIO 错误按普通错误原样抛出（不挂起，也不会被误判成 FsTimeoutError）', async () => {
  const root = await tmp()
  try {
    const fifo = join(root, 'meeting.json') // 与 writeMeta 内部 abs(rel) 算出的路径完全一致
    const mkfifo = Bun.spawnSync(['mkfifo', fifo])
    expect(mkfifo.exitCode).toBe(0)

    const s = createNasStorage(root, 5_000) // 给足超时，确保不是靠超时分支蒙混过关
    const err = await s.writeMeta('meeting.json', { a: 1 }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).not.toBe('FsTimeoutError')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
