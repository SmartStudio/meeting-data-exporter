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
