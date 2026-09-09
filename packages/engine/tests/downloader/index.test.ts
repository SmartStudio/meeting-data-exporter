import { afterEach, expect, test } from 'bun:test'
import { createLocalStorage } from '../../src/storage/local'
import { downloadAsset } from '../../src/downloader'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BODY = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256))

/** 支持 Range 的本地文件服务；可注入「首链 403、换链后成功」等行为 */
function serve(opts: { failFirstUrl?: boolean } = {}) {
  let served = 0
  const server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url)
    if (opts.failFirstUrl && url.searchParams.get('v') === '1') return new Response('expired', { status: 403 })
    served++
    const range = req.headers.get('range')
    if (range) { const start = Number(range.replace('bytes=', '').split('-')[0]); return new Response(BODY.slice(start), { status: 206, headers: { 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` } }) }
    return new Response(BODY, { status: 200 })
  } })
  return { server, base: `http://localhost:${server.port}`, servedCount: () => served }
}

async function tmp() { return mkdtemp(join(tmpdir(), 'mde-dl-')) }

test('完整下载 → finalize，字节数与 bytes_expected 一致', async () => {
  const s = serve(); const root = await tmp(); const storage = createLocalStorage(root)
  const gw = { getDownloadUrl: async () => ({ url: `${s.base}/f?v=2`, expiresAt: 9e9, fileType: 'mp4', bytesExpected: BODY.length }) } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'd/f.mp4', bytesExpected: BODY.length, isText: false }, () => 1)
  expect(r.status).toBe('completed')
  expect(await Bun.file(join(root, 'd/f.mp4')).exists()).toBe(true)
  s.server.stop(); await rm(root, { recursive: true, force: true })
})

test('链接过期（403）→ 向网关换新链，从当前字节续传，最终完整', async () => {
  const s = serve({ failFirstUrl: true }); const root = await tmp(); const storage = createLocalStorage(root)
  let v = 0
  const gw = { getDownloadUrl: async () => { v++; return ({ url: `${s.base}/f?v=${v}`, expiresAt: 9e9, fileType: 'mp4', bytesExpected: BODY.length }) } } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'f.mp4', bytesExpected: BODY.length, isText: false }, () => 1)
  expect(r.status).toBe('completed')
  expect((await Bun.file(join(root, 'f.mp4')).arrayBuffer()).byteLength).toBe(BODY.length)
  s.server.stop(); await rm(root, { recursive: true, force: true })
})

test('本地 .part 大于远端（416）→ 删除重下', async () => {
  const root = await tmp(); const storage = createLocalStorage(root)
  await storage.appendChunk('f.bin', 0, new Uint8Array(BODY.length + 500))   // .part 比远端大
  const server = Bun.serve({ port: 0, fetch(req) { if (req.headers.get('range')) return new Response('range not satisfiable', { status: 416 }); return new Response(BODY, { status: 200 }) } })
  const gw = { getDownloadUrl: async () => ({ url: `http://localhost:${server.port}/f`, expiresAt: 9e9, fileType: null, bytesExpected: BODY.length }) } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'f.bin', bytesExpected: BODY.length, isText: false }, () => 1)
  expect(r.status).toBe('completed')
  expect(await storage.writtenSize('f.bin')).toBe(0)   // .part 已 finalize 掉
  expect((await Bun.file(join(root, 'f.bin')).arrayBuffer()).byteLength).toBe(BODY.length)
  server.stop(); await rm(root, { recursive: true, force: true })
})

test('文本类：完成后返回 content_hash', async () => {
  const s = serve(); const root = await tmp(); const storage = createLocalStorage(root)
  const gw = { getDownloadUrl: async () => ({ url: `${s.base}/t?v=2`, expiresAt: 9e9, fileType: 'txt', bytesExpected: BODY.length }) } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 't.txt', bytesExpected: BODY.length, isText: true }, () => 1)
  expect(r.status).toBe('completed')
  if (r.status === 'completed') expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/)
  s.server.stop(); await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 真实环境的形态：腾讯对这批资产**不返回 bytes_expected**（2026-08-26 联调实测，
// 见 docs/m3.5-stage8-9-plan.md §0.1 的第 2 条）。于是「文件多大」这个事实，
// 全流程里只有下载器完成那一刻的累加值知道——它必须被带出去，
// 否则 downloadAsset 一返回就永久丢了，清单里的 bytes 只能是 null。
// ---------------------------------------------------------------------------

test('平台不给 bytes_expected 时，completed 仍带回磁盘上的真实字节数', async () => {
  const s = serve(); const root = await tmp(); const storage = createLocalStorage(root)
  const gw = { getDownloadUrl: async () => ({ url: `${s.base}/f?v=2`, expiresAt: 9e9, fileType: 'mp4', bytesExpected: null }) } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'd/f.mp4', bytesExpected: null, isText: false }, () => 1)
  expect(r.status).toBe('completed')
  // 与**盘上那个文件**比，不是与 BODY.length 比：要钉住的是「返回值 = 落盘字节数」
  const onDisk = (await Bun.file(join(root, 'd/f.mp4')).arrayBuffer()).byteLength
  if (r.status === 'completed') expect(r.bytesWritten).toBe(onDisk)
  s.server.stop(); await rm(root, { recursive: true, force: true })
})

test('续传完成时带回的是文件总长，不是本轮追加的那一段', async () => {
  const root = await tmp(); const storage = createLocalStorage(root)
  await storage.appendChunk('f.bin', 0, BODY.slice(0, 400))    // 上一轮下到 400 字节就断了
  const s = serve()
  const gw = { getDownloadUrl: async () => ({ url: `${s.base}/f?v=2`, expiresAt: 9e9, fileType: null, bytesExpected: null }) } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'f.bin', bytesExpected: null, isText: false }, () => 1)
  expect(r.status).toBe('completed')
  if (r.status === 'completed') expect(r.bytesWritten).toBe(BODY.length)   // 1000，不是本轮追加的 600
  s.server.stop(); await rm(root, { recursive: true, force: true })
})

// 2026-09-09 本机回填实测：腾讯对「转写_」录制的逐字稿 txt 回 HTTP 200、content-length 0。
// 空正文一个 chunk 都不来，.part 从未建出来，文本类接着去读 .part 算 hash 就是
// ENOENT——每次重试同样结果，5 次后 dead。空文件是平台给的事实，落一个 0 字节文件。
test('空正文（200、0 字节）：落 0 字节文件并 completed，不因 .part 不存在而失败', async () => {
  const root = await tmp(); const storage = createLocalStorage(root)
  const server = Bun.serve({ port: 0, fetch() { return new Response(new Uint8Array(0), { status: 200 }) } })
  const gw = { getDownloadUrl: async () => ({ url: `http://localhost:${server.port}/t`, expiresAt: 9e9, fileType: 'txt', bytesExpected: null }) } as any
  const r = await downloadAsset({ storage, gw }, { assetId: 'a', relPath: 'd/t.txt', bytesExpected: null, isText: true }, () => 1)
  expect(r.status).toBe('completed')
  if (r.status === 'completed') { expect(r.bytesWritten).toBe(0); expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/) }
  expect((await Bun.file(join(root, 'd/t.txt')).arrayBuffer()).byteLength).toBe(0)
  expect(await storage.writtenSize('d/t.txt')).toBe(0)
  server.stop(); await rm(root, { recursive: true, force: true })
})
