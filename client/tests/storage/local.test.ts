import { afterEach, expect, test } from 'bun:test'
import { createLocalStorage } from '../../src/storage/local'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function tmp() { return mkdtemp(join(tmpdir(), 'mde-')) }

test('appendChunk 落 .part，finalize 原子 rename 为正式名', async () => {
  const root = await tmp(); const s = createLocalStorage(root)
  await s.appendChunk('a/b/f.mp4', 0, new Uint8Array([1, 2, 3]))
  expect(await s.writtenSize('a/b/f.mp4')).toBe(3)          // .part 大小
  expect(await Bun.file(join(root, 'a/b/f.mp4')).exists()).toBe(false)  // 正式名尚不存在
  await s.finalize('a/b/f.mp4')
  expect(await Bun.file(join(root, 'a/b/f.mp4')).exists()).toBe(true)   // rename 后存在
  await rm(root, { recursive: true, force: true })
})
test('续传：从 offset 追加，writtenSize 递增', async () => {
  const root = await tmp(); const s = createLocalStorage(root)
  await s.appendChunk('f.bin', 0, new Uint8Array([1, 2]))
  await s.appendChunk('f.bin', 2, new Uint8Array([3, 4, 5]))
  expect(await s.writtenSize('f.bin')).toBe(5)
  await rm(root, { recursive: true, force: true })
})
test('discardPart 删除 .part（416/200 时重下）', async () => {
  const root = await tmp(); const s = createLocalStorage(root)
  await s.appendChunk('f.bin', 0, new Uint8Array([9]))
  await s.discardPart('f.bin')
  expect(await s.writtenSize('f.bin')).toBe(0)
  await rm(root, { recursive: true, force: true })
})
