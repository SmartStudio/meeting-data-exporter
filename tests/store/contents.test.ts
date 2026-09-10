import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTestDb } from '../helpers/testdb'
import {
  MEDIUMTEXT_MAX_BYTES,
  TEXT_GATEWAY_ASSET_TYPES,
  buildAssetContent,
  createContentsStore,
  type AssetContentRecord,
  type ContentsStore,
} from '../../src/store/contents'
import type { Pool } from '../../src/store/db'
import { backfill, parseArgs, type Args } from '../../scripts/backfill-contents'

/**
 * store 层不 mock 数据库（与 tests/store/archives.test.ts 同一条约定）：这一层的价值
 * 几乎全在 SQL 语义里——MEDIUMTEXT 的往返、utf8mb4 的四字节字符、两条 CHECK 约束、
 * 以及 listPending 那条 LEFT JOIN 的「已归档但还没入库」语义。mock 掉等于没测。
 *
 * buildAssetContent 那几条不需要库（它只读文件），但仍然放在同一个文件里：
 * 它产出的 record 与 store 的 put 是一件事的两半，拆开会让「build 出来的东西存不进去」
 * 这类不一致跑到两个文件之间的缝里。
 */

/** 直接写 archived_assets：这张表不归 ContentsStore 写，listPending 只读它 */
async function seedArchivedAsset(
  pool: Pool,
  input: {
    meetingId: string
    subMeetingId?: string
    assetType?: string
    remoteId?: string
    fileType?: string
    nasPath?: string
    nasHash?: string
  },
): Promise<void> {
  const {
    meetingId,
    subMeetingId = '',
    assetType = 'meeting_summary',
    remoteId = 'r-1',
    fileType = 'txt',
    nasPath = '/nas/2026/08/x.txt',
    nasHash = 'a'.repeat(64),
  } = input
  await pool.execute(
    `INSERT INTO archived_assets
       (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, local_path, nas_path, nas_hash, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000)`,
    [meetingId, subMeetingId, assetType, remoteId, fileType, 'local/x.txt', nasPath, nasHash],
  )
}

function parsedRecord(over: Partial<AssetContentRecord> = {}): AssetContentRecord {
  return {
    meetingId: 'm-1',
    subMeetingId: '',
    assetType: 'meeting_summary',
    remoteId: 'r-1',
    fileType: 'txt',
    status: 'parsed',
    content: '正文',
    contentHash: 'b'.repeat(64),
    bytes: 6,
    reason: null,
    parsedAt: 1700,
    ...over,
  }
}

async function withStore(fn: (rig: { pool: Pool; store: ContentsStore }) => Promise<void>): Promise<void> {
  const { pool, cleanup } = await withTestDb()
  try {
    await fn({ pool, store: createContentsStore(pool) })
  } finally {
    await cleanup()
  }
}

async function withFiles(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mde-contents-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// 入库范围：三类纪要 + 转写，录像与音频不入库
// ---------------------------------------------------------------------------

test('TEXT_GATEWAY_ASSET_TYPES 恰是三类纪要+转写，且是从引擎的 ALL_ASSET_KEYS 派生的（不是抄的短名）', () => {
  // 值是**网关的 asset_type**，不是客户端的 AssetKey——库里 asset_type 列存的是前者，
  // 两者只有 transcript 一项不同名（见引擎的 ASSET_KEY_TO_GATEWAY_TYPE）
  expect([...TEXT_GATEWAY_ASSET_TYPES].sort()).toEqual(
    [
      'meeting_summary',
      'ai_minutes',
      'chapters',
    ].sort(),
  )
  expect(TEXT_GATEWAY_ASSET_TYPES).not.toContain('video')
  expect(TEXT_GATEWAY_ASSET_TYPES).not.toContain('audio')
})

// ---------------------------------------------------------------------------
// put / get 往返
// ---------------------------------------------------------------------------

test('put 之后 get 能原样读回 parsed 行，含四字节字符（utf8mb4 往返）', async () => {
  await withStore(async ({ store }) => {
    const content = '会议纪要\n第一项 🎯 决议\n第二项'
    const rec = parsedRecord({ content, contentHash: sha256(content), bytes: Buffer.byteLength(content) })
    await store.put(rec)

    const got = await store.get(rec)
    expect(got).toEqual(rec)
  })
})

test('get 对不存在的键返回 null', async () => {
  await withStore(async ({ store }) => {
    expect(await store.get({ meetingId: 'nope', subMeetingId: '', assetType: 'ai_minutes', remoteId: 'r', fileType: 'txt' })).toBeNull()
  })
})

test('未解析的行照样落库：content 为 null、reason 说清原因，能读回', async () => {
  await withStore(async ({ store }) => {
    const rec = parsedRecord({
      fileType: 'docx',
      status: 'unsupported_format',
      content: null,
      contentHash: null,
      bytes: 240_000,
      reason: 'file_type=docx 不是纯文本，本版本只解析 txt',
    })
    await store.put(rec)
    expect(await store.get(rec)).toEqual(rec)
  })
})

test('同一场会议的两段转写按 remote_id 各占一行——主键少了 remote_id 就会静默覆盖', async () => {
  await withStore(async ({ store }) => {
    const a = parsedRecord({ remoteId: 'seg-1', content: '第一段', contentHash: sha256('第一段') })
    const b = parsedRecord({ remoteId: 'seg-2', content: '第二段', contentHash: sha256('第二段') })
    await store.put(a)
    await store.put(b)

    expect((await store.get(a))?.content).toBe('第一段')
    expect((await store.get(b))?.content).toBe('第二段')
  })
})

test('put 是 upsert：同键重写把未解析行升级成 parsed（将来接上 docx 解析器时不必另开迁移）', async () => {
  await withStore(async ({ store }) => {
    const key = { meetingId: 'm-9', subMeetingId: '', assetType: 'ai_minutes', remoteId: 'r-1', fileType: 'docx' }
    await store.put({
      ...key,
      status: 'unsupported_format',
      content: null,
      contentHash: null,
      bytes: 100,
      reason: '本版本只解析 txt',
      parsedAt: 1000,
    })
    await store.put({
      ...key,
      status: 'parsed',
      content: '后来解析出来的正文',
      contentHash: sha256('后来解析出来的正文'),
      bytes: 27,
      reason: null,
      parsedAt: 2000,
    })

    const got = await store.get(key)
    expect(got?.status).toBe('parsed')
    expect(got?.content).toBe('后来解析出来的正文')
    expect(got?.reason).toBeNull()
    expect(got?.parsedAt).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// 两条 CHECK 约束：绕开 store 的直接 SQL 也要被拦住
// ---------------------------------------------------------------------------

test('数据库拦住 status=parsed 但 content 为 NULL 的行——那种记录与「正文是空文件」无法区分', async () => {
  await withStore(async ({ pool }) => {
    await expect(
      pool.execute(
        `INSERT INTO asset_contents
           (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, content, content_hash, bytes, reason, parsed_at)
         VALUES ('m', '', 'ai_minutes', 'r', 'txt', 'parsed', NULL, NULL, 0, NULL, 1)`,
      ),
    ).rejects.toThrow()
  })
})

test('数据库拦住「未解析却没写原因」的行——那等于把「不许静默跳过」绕过去了', async () => {
  await withStore(async ({ pool }) => {
    await expect(
      pool.execute(
        `INSERT INTO asset_contents
           (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, content, content_hash, bytes, reason, parsed_at)
         VALUES ('m', '', 'ai_minutes', 'r', 'docx', 'too_large', NULL, NULL, 99, NULL, 1)`,
      ),
    ).rejects.toThrow()
  })
})

test('数据库拦住 status 取值域之外的字符串', async () => {
  await withStore(async ({ pool }) => {
    await expect(
      pool.execute(
        `INSERT INTO asset_contents
           (meeting_id, sub_meeting_id, asset_type, remote_id, file_type, status, content, content_hash, bytes, reason, parsed_at)
         VALUES ('m', '', 'ai_minutes', 'r', 'txt', 'pending', NULL, NULL, 0, '还没轮到', 1)`,
      ),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// listPending：回填脚本的枚举源
// ---------------------------------------------------------------------------

test('listPending 只返回「已归档 + 文本类 + 本表里还没有」的资产，录像音频一概不返回', async () => {
  await withStore(async ({ pool, store }) => {
    await seedArchivedAsset(pool, { meetingId: 'm-1', assetType: 'meeting_summary', remoteId: 'r-1', nasPath: '/nas/a.txt', nasHash: 'c'.repeat(64) })
    await seedArchivedAsset(pool, { meetingId: 'm-1', assetType: 'ai_minutes', remoteId: 'r-2', fileType: 'docx' })
    await seedArchivedAsset(pool, { meetingId: 'm-1', assetType: 'video', remoteId: 'r-3', fileType: 'mp4' })
    await seedArchivedAsset(pool, { meetingId: 'm-1', assetType: 'audio', remoteId: 'r-4', fileType: 'm4a' })

    const pending = await store.listPending(100)
    expect(pending.map((p) => p.assetType).sort()).toEqual(['ai_minutes', 'meeting_summary'])

    const summary = pending.find((p) => p.assetType === 'meeting_summary')
    expect(summary).toEqual({
      meetingId: 'm-1',
      subMeetingId: '',
      assetType: 'meeting_summary',
      remoteId: 'r-1',
      fileType: 'txt',
      nasPath: '/nas/a.txt',
      nasHash: 'c'.repeat(64),
    })
  })
})

test('listPending 可重复跑：入过库的行（含未解析的那种）不再出现', async () => {
  await withStore(async ({ pool, store }) => {
    await seedArchivedAsset(pool, { meetingId: 'm-2', assetType: 'meeting_summary', remoteId: 'r-1' })
    await seedArchivedAsset(pool, { meetingId: 'm-2', assetType: 'ai_minutes', remoteId: 'r-2', fileType: 'docx' })
    expect(await store.listPending(100)).toHaveLength(2)

    await store.put(parsedRecord({ meetingId: 'm-2', assetType: 'meeting_summary', remoteId: 'r-1' }))
    expect((await store.listPending(100)).map((p) => p.assetType)).toEqual(['ai_minutes'])

    // 未解析的行同样算「处理过了」——回填脚本不该每次都回头重试一个永远解析不了的 docx
    await store.put(
      parsedRecord({
        meetingId: 'm-2',
        assetType: 'ai_minutes',
        remoteId: 'r-2',
        fileType: 'docx',
        status: 'unsupported_format',
        content: null,
        contentHash: null,
        reason: '本版本只解析 txt',
      }),
    )
    expect(await store.listPending(100)).toHaveLength(0)
  })
})

test('listPending 按 limit 截断，且顺序稳定（重复跑能一批一批推进）', async () => {
  await withStore(async ({ pool, store }) => {
    for (const remoteId of ['r-3', 'r-1', 'r-2']) {
      await seedArchivedAsset(pool, { meetingId: 'm-3', assetType: 'meeting_summary', remoteId })
    }
    const first = await store.listPending(2)
    expect(first.map((p) => p.remoteId)).toEqual(['r-1', 'r-2'])
    expect((await store.listPending(2)).map((p) => p.remoteId)).toEqual(['r-1', 'r-2'])
  })
})

// ---------------------------------------------------------------------------
// buildAssetContent：从 NAS 上那份副本产出一行
// ---------------------------------------------------------------------------

const KEY = { meetingId: 'm-1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'r-1', fileType: 'txt' }

test('buildAssetContent：txt 且哈希与 NAS 副本一致 → parsed，content_hash 逐字等于 nas_hash', async () => {
  await withFiles(async (dir) => {
    const text = '主持人：开始。\n甲：好的 🎯'
    const path = join(dir, 'transcript.txt')
    await writeFile(path, text)
    const hash = sha256(text)

    const out = await buildAssetContent({ key: KEY, nasPath: path, nasHash: hash, now: 1700 })
    expect(out.kind).toBe('record')
    if (out.kind !== 'record') return
    expect(out.record).toEqual({
      ...KEY,
      status: 'parsed',
      content: text,
      contentHash: hash,
      bytes: Buffer.byteLength(text),
      reason: null,
      parsedAt: 1700,
    })
  })
})

test('buildAssetContent：NAS 上的字节与 archived_assets.nas_hash 对不上 → 不产出行，只报失败（下次可重试）', async () => {
  await withFiles(async (dir) => {
    const path = join(dir, 'transcript.txt')
    await writeFile(path, '被改过的正文')

    const out = await buildAssetContent({ key: KEY, nasPath: path, nasHash: sha256('原始正文'), now: 1700 })
    expect(out.kind).toBe('failed')
    if (out.kind !== 'failed') return
    // 理由要说得出是哈希对不上，不是一句 "error"
    expect(out.reason).toContain('哈希')
  })
})

test('buildAssetContent：docx 不解析，但产出一行 unsupported_format 并说明原因（不是静默跳过）', async () => {
  await withFiles(async (dir) => {
    const path = join(dir, 'ai_minutes.docx')
    await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))

    const out = await buildAssetContent({
      key: { ...KEY, assetType: 'ai_minutes', fileType: 'docx' },
      nasPath: path,
      nasHash: 'ignored'.padEnd(64, '0'),
      now: 1700,
    })
    expect(out.kind).toBe('record')
    if (out.kind !== 'record') return
    expect(out.record.status).toBe('unsupported_format')
    expect(out.record.content).toBeNull()
    expect(out.record.contentHash).toBeNull()
    expect(out.record.bytes).toBe(5)
    expect(out.record.reason).toContain('docx')
  })
})

test('buildAssetContent：pdf 同样是一行 unsupported_format，不是失败', async () => {
  await withFiles(async (dir) => {
    const path = join(dir, 'ai_minutes.pdf')
    await writeFile(path, '%PDF-1.4')
    const out = await buildAssetContent({
      key: { ...KEY, assetType: 'ai_minutes', fileType: 'pdf' },
      nasPath: path,
      nasHash: 'x'.repeat(64),
      now: 1700,
    })
    expect(out.kind === 'record' && out.record.status).toBe('unsupported_format')
  })
})

test('buildAssetContent：md 与 json 都是纯文本，按 parsed 入库', async () => {
  await withFiles(async (dir) => {
    for (const [ext, body] of [['md', '## 会议摘要\n\n正文\n'], ['json', '{"schemaVersion":1,"chapters":[]}\n']] as const) {
      const path = join(dir, `x.${ext}`)
      await writeFile(path, body, 'utf8')
      const hash = sha256(body)
      const out = await buildAssetContent({
        key: { ...KEY, assetType: ext === 'md' ? 'ai_minutes' : 'chapters', fileType: ext },
        nasPath: path,
        nasHash: hash,
        now: 1000,
      })
      expect(out.kind).toBe('record')
      if (out.kind === 'record') {
        expect(out.record.status).toBe('parsed')
        expect(out.record.content).toBe(body)
      }
    }
  })
})

test('buildAssetContent：装不下就明确拒绝（too_large），绝不截断', async () => {
  await withFiles(async (dir) => {
    const text = 'x'.repeat(4096)
    const path = join(dir, 'transcript.txt')
    await writeFile(path, text)

    // maxBytes 可注入的理由与 archive.ts 的 nasWriteTimeoutMs 一样：真造一个 16MB 的
    // 文件只是为了验一条分支，代价与信息量不成比例
    const out = await buildAssetContent({ key: KEY, nasPath: path, nasHash: sha256(text), now: 1700 }, { maxBytes: 1024 })
    expect(out.kind).toBe('record')
    if (out.kind !== 'record') return
    expect(out.record.status).toBe('too_large')
    expect(out.record.content).toBeNull()
    expect(out.record.bytes).toBe(4096)
    expect(out.record.reason).toContain('1024')
  })
})

test('MEDIUMTEXT 的默认上限就是 16MB —— 注入的小值只用于测试，默认值不能跟着漂', () => {
  expect(MEDIUMTEXT_MAX_BYTES).toBe(16 * 1024 * 1024 - 1)
})

test('buildAssetContent：文件不是合法 UTF-8（例如 GBK 的 txt）→ unsupported_format，不入一份解码走样的正文', async () => {
  await withFiles(async (dir) => {
    // GBK 编码的「会议」，按 UTF-8 解码会变成替换字符——存进去就是一份查不出出处的正文
    const bytes = Buffer.from([0xbb, 0xe1, 0xd2, 0xe9])
    const path = join(dir, 'transcript.txt')
    await writeFile(path, bytes)

    const out = await buildAssetContent({ key: KEY, nasPath: path, nasHash: sha256(bytes), now: 1700 })
    expect(out.kind).toBe('record')
    if (out.kind !== 'record') return
    expect(out.record.status).toBe('unsupported_format')
    expect(out.record.reason).toContain('UTF-8')
  })
})

test('buildAssetContent：NAS 上的文件不见了 → 失败，不产出行（下次可重试）', async () => {
  await withFiles(async (dir) => {
    const out = await buildAssetContent({ key: KEY, nasPath: join(dir, 'nope.txt'), nasHash: 'x'.repeat(64), now: 1700 })
    expect(out.kind).toBe('failed')
  })
})

test('buildAssetContent：录像/音频进来一律拒绝产出行——入库范围只有三类纪要+转写', async () => {
  await withFiles(async (dir) => {
    const path = join(dir, 'recording.txt')
    await writeFile(path, 'not really a video')
    const out = await buildAssetContent(
      { key: { ...KEY, assetType: 'video' }, nasPath: path, nasHash: sha256('not really a video'), now: 1700 },
      {},
    )
    expect(out.kind).toBe('not_text')
  })
})

test('buildAssetContent 产出的 record 一定存得进库（build 与 put 是一件事的两半）', async () => {
  await withStore(async ({ store }) => {
    await withFiles(async (dir) => {
      const text = '一二三'
      const path = join(dir, 'transcript.txt')
      await writeFile(path, text)
      const out = await buildAssetContent({ key: KEY, nasPath: path, nasHash: sha256(text), now: 1700 })
      if (out.kind !== 'record') throw new Error('expected record')
      await store.put(out.record)
      expect((await store.get(KEY))?.content).toBe(text)
    })
  })
})

// ---------------------------------------------------------------------------
// 回填脚本（scripts/backfill-contents.ts）
//
// 它住在 scripts/ 而测试在 tests/store/ 下，是因为它测的东西与本文件其余部分是同一件:
// 「哪些资产还没入库、从 NAS 上把它们补回来会发生什么」。给一个一次性脚本单开一个
// 测试目录，只会让 T4 验收判据 4（只处理没有的行、可重复跑）没人盯着。
// ---------------------------------------------------------------------------

/** 造一份真实的 NAS 副本，并把对应的 archived_assets 行写好（哈希取真值） */
async function seedNasAsset(
  pool: Pool,
  dir: string,
  input: { meetingId: string; assetType?: string; remoteId?: string; fileType?: string; fileName: string; body?: string | Buffer },
): Promise<string> {
  const { meetingId, assetType = 'meeting_summary', remoteId = 'r-1', fileType = 'txt', fileName, body = '正文' } = input
  const nasPath = join(dir, fileName)
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  await writeFile(nasPath, bytes)
  await seedArchivedAsset(pool, { meetingId, assetType, remoteId, fileType, nasPath, nasHash: sha256(bytes) })
  return nasPath
}

const BACKFILL_ARGS: Args = { limit: 0, batch: 100, dryRun: false }

test('回填只补 asset_contents 里没有的行，且第二次跑什么都不做（T4 验收判据 4）', async () => {
  await withStore(async ({ pool, store }) => {
    await withFiles(async (dir) => {
      await seedNasAsset(pool, dir, { meetingId: 'b-1', remoteId: 'r-1', fileName: 't1.txt', body: '第一份' })
      await seedNasAsset(pool, dir, { meetingId: 'b-1', remoteId: 'r-2', fileName: 't2.txt', body: '第二份' })
      await seedNasAsset(pool, dir, { meetingId: 'b-1', assetType: 'ai_minutes', remoteId: 'r-3', fileType: 'docx', fileName: 'm.docx', body: 'PKfake' })
      // 录像不在回填范围内
      await seedNasAsset(pool, dir, { meetingId: 'b-1', assetType: 'video', remoteId: 'r-4', fileType: 'mp4', fileName: 'v.mp4', body: 'binary' })
      // 已经入过库的那一份不该被再碰一次
      await store.put(parsedRecord({ meetingId: 'b-1', remoteId: 'r-1', content: '早就入过了', contentHash: sha256('早就入过了'), parsedAt: 111 }))

      const first = await backfill(store, BACKFILL_ARGS, () => {})
      expect(first).toEqual({ ingested: 1, unparsed: 1, failed: 0 })
      // 早就入过的那一份原样没动
      expect((await store.get({ meetingId: 'b-1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'r-1', fileType: 'txt' }))?.parsedAt).toBe(111)
      expect((await store.get({ meetingId: 'b-1', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'r-2', fileType: 'txt' }))?.content).toBe('第二份')

      // 可重复跑：第二次一件事都没有
      expect(await backfill(store, BACKFILL_ARGS, () => {})).toEqual({ ingested: 0, unparsed: 0, failed: 0 })
    })
  })
})

test('回填失败的行不写进库——NAS 挂好之后重跑一次就补上了', async () => {
  await withStore(async ({ pool, store }) => {
    await withFiles(async (dir) => {
      const nasPath = join(dir, 'gone.txt')
      await seedArchivedAsset(pool, { meetingId: 'b-2', nasPath, nasHash: sha256('还没写出来') })

      expect(await backfill(store, BACKFILL_ARGS, () => {})).toEqual({ ingested: 0, unparsed: 0, failed: 1 })
      expect(await store.listPending(10)).toHaveLength(1)

      await writeFile(nasPath, '还没写出来')
      expect(await backfill(store, BACKFILL_ARGS, () => {})).toEqual({ ingested: 1, unparsed: 0, failed: 0 })
      expect(await store.listPending(10)).toHaveLength(0)
    })
  })
})

test('一整批都失败时也会往后推进，不在头几行原地打转', async () => {
  await withStore(async ({ pool, store }) => {
    await withFiles(async (dir) => {
      // 前两行读不到（没有对应文件），第三行是好的。batch=2 时若不推进窗口，
      // 第三行永远轮不到——而脚本会宣布「跑完了」
      await seedArchivedAsset(pool, { meetingId: 'b-3', remoteId: 'r-1', nasPath: join(dir, 'no1.txt') })
      await seedArchivedAsset(pool, { meetingId: 'b-3', remoteId: 'r-2', nasPath: join(dir, 'no2.txt') })
      await seedNasAsset(pool, dir, { meetingId: 'b-3', remoteId: 'r-3', fileName: 'ok.txt', body: '好的' })

      expect(await backfill(store, { ...BACKFILL_ARGS, batch: 2 }, () => {})).toEqual({ ingested: 1, unparsed: 0, failed: 2 })
      expect((await store.get({ meetingId: 'b-3', subMeetingId: '', assetType: 'meeting_summary', remoteId: 'r-3', fileType: 'txt' }))?.content).toBe('好的')
    })
  })
})

test('--limit 到了就停，剩下的留给下一次跑', async () => {
  await withStore(async ({ pool, store }) => {
    await withFiles(async (dir) => {
      for (const remoteId of ['r-1', 'r-2', 'r-3']) {
        await seedNasAsset(pool, dir, { meetingId: 'b-4', remoteId, fileName: `${remoteId}.txt`, body: remoteId })
      }
      expect(await backfill(store, { ...BACKFILL_ARGS, limit: 2 }, () => {})).toEqual({ ingested: 2, unparsed: 0, failed: 0 })
      expect(await store.listPending(10)).toHaveLength(1)
      expect(await backfill(store, BACKFILL_ARGS, () => {})).toEqual({ ingested: 1, unparsed: 0, failed: 0 })
    })
  })
})

test('--dry-run 只报告不写库', async () => {
  await withStore(async ({ pool, store }) => {
    await withFiles(async (dir) => {
      await seedNasAsset(pool, dir, { meetingId: 'b-5', fileName: 'a.txt', body: '正文' })
      const lines: string[] = []
      expect(await backfill(store, { ...BACKFILL_ARGS, dryRun: true }, (l) => lines.push(l))).toEqual({ ingested: 1, unparsed: 0, failed: 0 })
      expect(lines.join(' ')).toContain('b-5')
      // 报告说会入库，但库里一行都没有
      expect(await store.listPending(10)).toHaveLength(1)
    })
  })
})

test('parseArgs 拒绝非正整数，不把 --limit abc 当成 0（不限）悄悄跑全表', () => {
  expect(() => parseArgs(['--limit', 'abc'])).toThrow()
  expect(() => parseArgs(['--batch', '0'])).toThrow()
  expect(() => parseArgs(['--limit'])).toThrow()
  expect(parseArgs(['--limit', '5', '--dry-run'])).toEqual({ limit: 5, batch: 200, dryRun: true })
})
