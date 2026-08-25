/**
 * M3.5 Stage 8/9 的核验工具。
 *
 * ## 为什么要有它
 *
 * 幂等 · 断点续传 · 崩溃恢复 · AI 纪要延迟探测这四条机制至今**零真实证据**
 * （`docs/m3.5-stage8-9-plan.md`）。上一轮联调跑到 Stage 7 就停了，而 Stage 8/9
 * 的清单是二十来个要人肉判读的勾选框——「第二遍没有产生下载流量」的判据写的是
 * 「看耗时，或用文件 mtime 判断」。这种判据的问题不是不准，是**跑完不会有人记**。
 *
 * 本工具把其中能机器判的那部分变成确定的 PASS / FAIL，并输出一段可以直接贴回
 * 文档的记录。**它不替代真实环境**——恰恰相反，它只能在真实环境里跑。
 *
 * ## 用法
 *
 * ```
 * # §4.1 对象存储支不支持 Range（这是 §4.3 断点续传的前提，先跑这条）
 * bun scripts/verify-m35.ts range --meeting <会议号> [--type video]
 *
 * # §4.2 幂等：跑第一遍 → snapshot → 再跑第二遍 → compare
 * bun scripts/verify-m35.ts snapshot --out ./m3-联调产物
 * bun scripts/verify-m35.ts compare  --out ./m3-联调产物
 *
 * # 任何时候看队列里各状态的分布（§4.4 崩溃恢复 / §4.5 AI 探测都看它）
 * bun scripts/verify-m35.ts queue --out ./m3-联调产物
 * ```
 *
 * 需要的环境变量与 `mde` CLI 完全一致（`MDE_GATEWAY_URL` / `MDE_CLIENT_ID` /
 * `MDE_CLIENT_SECRET`），因为它复用同一个 `loadConfig` 与网关客户端——
 * **不另写一份认证**，另写的那份迟早与真的那份不一致，而不一致的方向是
 * 「工具说通过，真实链路不通」。
 */
import { readdir, stat, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { loadConfig } from '../client/src/config'
import { createGatewayClient } from '../client/src/gateway/client'

const now = () => Math.floor(Date.now() / 1000)

// ── 参数 ────────────────────────────────────────────────────────────────

interface Args { cmd: string; out?: string; meeting?: string; type?: string; hashCap: number }

function parseArgs(argv: string[]): Args {
  const [cmd = '', ...rest] = argv
  const a: Args = { cmd, hashCap: 64 * 1024 * 1024 }
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]
    const v = rest[i + 1]
    if (v === undefined) throw new Error(`flag ${k} 缺少值`)
    if (k === '--out') a.out = v
    else if (k === '--meeting') a.meeting = v
    else if (k === '--type') a.type = v
    else if (k === '--hash-cap-mb') a.hashCap = Number(v) * 1024 * 1024
    else throw new Error(`不认识的 flag：${k}`)
  }
  return a
}

// ── 输出 ────────────────────────────────────────────────────────────────

let failures = 0

function pass(label: string, detail = ''): void {
  console.log(`  ✅ ${label}${detail ? ` —— ${detail}` : ''}`)
}
function fail(label: string, detail = ''): void {
  failures += 1
  console.log(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`)
}
/** 既不是通过也不是失败，而是一个**必须被记下来**的事实 */
function fact(label: string, detail: string): void {
  console.log(`  📌 ${label}：${detail}`)
}

// ── §4.1 Range ──────────────────────────────────────────────────────────

/**
 * 对象存储支不支持 Range 请求。
 *
 * **这是本次最有价值的一个事实**：引擎 spec §10 描述的断点续传完全建立在它之上，
 * 而它至今没有任何真实证据。无论结论是 206 还是 200 都要写进 roadmap——
 * 200（不支持）不是失败，是一条必须被知道的限制：客户端有 `discardPart` 重下的
 * 分支所以不会坏，但几个 GB 的录制中断就得从头来。
 */
async function cmdRange(a: Args): Promise<void> {
  if (!a.meeting) throw new Error('range 需要 --meeting <会议号>')
  const wantType = a.type ?? 'video'

  const cfg = loadConfig(process.env, {}, { out: '.' })
  const gw = createGatewayClient(cfg, { fetch, now })

  console.log(`\n§4.1 Range 支持（会议 ${a.meeting}，资产类型 ${wantType}）`)

  const assets = await gw.listAssets(a.meeting)
  if (assets.length === 0) {
    fail('取到资产清单', '这场会议一个资产都没有，换一场有录制的')
    return
  }
  const asset = assets.find((x) => x.assetType === wantType) ?? assets[0]!
  if (asset.assetType !== wantType) {
    fact('没有找到该类型，改用', `${asset.assetType}（Range 是存储层的行为，与类型无关）`)
  }

  const dl = await gw.getDownloadUrl(asset.assetId)
  // 实测 TTL——runbook Stage 7 那一栏一直空着
  fact('下载地址实际 TTL', `${dl.expiresAt - now()} 秒`)
  if (dl.bytesExpected !== null) fact('平台声明字节数', String(dl.bytesExpected))

  const res = await fetch(dl.url, { headers: { Range: 'bytes=0-1023' } })
  // 无论走哪条分支都要把响应体丢掉，否则连接悬着
  await res.arrayBuffer().catch(() => undefined)

  const contentRange = res.headers.get('content-range')
  const contentLength = res.headers.get('content-length')
  fact('HTTP 状态', String(res.status))
  if (contentRange) fact('Content-Range', contentRange)
  if (contentLength) fact('Content-Length', contentLength)

  if (res.status === 206 && contentRange) {
    pass('对象存储支持 Range', '断点续传成立，可以继续 §4.3')
  } else if (res.status === 200) {
    fail(
      '对象存储忽略 Range',
      '**断点续传实际失效**。客户端有 discardPart 重下的分支所以不会坏，' +
        '但大文件中断要从头来。这是必须写进 roadmap 的结论，不是可以糊过去的',
    )
  } else if (res.status === 403) {
    fail('链接已过期或签名不被接受', `HTTP 403。重新签发后再跑一次`)
  } else {
    fail('意料之外的响应', `HTTP ${res.status}`)
  }
}

// ── §4.2 幂等：快照与比对 ────────────────────────────────────────────────

interface FileFacts { size: number; mtimeMs: number; sha256: string | null }
type Snapshot = Record<string, FileFacts>

/**
 * `.mde/` 整个排除：队列 SQLite 每次跑都会变（租约、进度、时间戳），
 * 它变**是对的**，拿它当「文件被改写」的证据会把每一次幂等检查都判成失败。
 */
function ignored(rel: string): boolean {
  return rel.startsWith('.mde/') || rel === '.mde'
}

/**
 * `meeting.json` / `_manifest.json` **每一轮都会被重写**（它们带 `generatedAt`），
 * 这是 `writeMeetingManifests` 的设计，不是幂等破了——幂等说的是**不重新下载资产**。
 *
 * 单独分类而不是直接忽略：清单里的 `assets[]` 如果变了，那是真问题
 * （某个资产从清单里消失，或多出一条），只是「整个文件的哈希变了」这件事本身
 * 不构成证据。**把它报成失败的后果是每一轮都红，几次之后没人再看这份输出。**
 */
function isSidecar(rel: string): boolean {
  const base = rel.split('/').pop() ?? ''
  return base === 'meeting.json' || base === '_manifest.json'
}

async function walk(root: string, hashCap: number): Promise<Snapshot> {
  const out: Snapshot = {}
  async function rec(dir: string): Promise<void> {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name)
      const rel = relative(root, abs)
      if (ignored(rel)) continue
      if (ent.isDirectory()) { await rec(abs); continue }
      if (!ent.isFile()) continue
      const st = await stat(abs)
      // 超过上限的只记大小与 mtime：几个 GB 的录制整读一遍要几分钟，
      // 而「大小和 mtime 都没变」对幂等这个问题已经是足够强的证据
      const sha = st.size <= hashCap
        ? createHash('sha256').update(await readFile(abs)).digest('hex')
        : null
      out[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha }
    }
  }
  await rec(root)
  return out
}

function snapPath(out: string): string {
  return join(out, '.mde', 'verify-m35-snapshot.json')
}

async function cmdSnapshot(a: Args): Promise<void> {
  if (!a.out) throw new Error('snapshot 需要 --out <目录>')
  const snap = await walk(a.out, a.hashCap)
  await writeFile(snapPath(a.out), JSON.stringify(snap, null, 2))
  const hashed = Object.values(snap).filter((f) => f.sha256 !== null).length
  console.log(`\n快照已写入 ${snapPath(a.out)}`)
  console.log(`  文件 ${Object.keys(snap).length} 个，其中 ${hashed} 个算了 sha256`)
  const parts = Object.keys(snap).filter((k) => k.endsWith('.part'))
  if (parts.length > 0) {
    console.log(`  ⚠️  存在 ${parts.length} 个 .part：有任务没跑完，先把这一轮跑干净再做幂等检查`)
    for (const p of parts) console.log(`      ${p}（${snap[p]!.size} 字节）`)
  }
}

async function cmdCompare(a: Args): Promise<void> {
  if (!a.out) throw new Error('compare 需要 --out <目录>')
  const before: Snapshot = JSON.parse(await readFile(snapPath(a.out), 'utf8'))
  const after = await walk(a.out, a.hashCap)

  console.log('\n§4.2 幂等（重复跑不重下）')

  const added = Object.keys(after).filter((k) => !(k in before))
  const removed = Object.keys(before).filter((k) => !(k in after))
  const rewritten: string[] = []
  const touched: string[] = []

  const sidecarsChanged: string[] = []

  for (const [rel, b] of Object.entries(before)) {
    const c = after[rel]
    if (!c) continue
    if (isSidecar(rel)) {
      if (c.sha256 !== b.sha256) sidecarsChanged.push(rel)
      continue
    }
    // 内容变了才算重下。只有 mtime 变而大小与哈希不变，说明文件被重写成了
    // 同样的内容——**那也是重下**，只是结果恰好相同，所以单独报出来
    const contentChanged = c.size !== b.size
      || (b.sha256 !== null && c.sha256 !== null && b.sha256 !== c.sha256)
    if (contentChanged) rewritten.push(rel)
    else if (c.mtimeMs !== b.mtimeMs) touched.push(rel)
  }

  if (sidecarsChanged.length > 0) {
    fact(
      `${sidecarsChanged.length} 份 sidecar 重写了`,
      'meeting.json / _manifest.json 每轮都会重写（带 generatedAt），是设计如此。' +
        '要确认的是清单里的 assets[] 条数没变，那个本工具不判，用眼睛看一次',
    )
  }

  if (rewritten.length === 0) pass('没有任何已完成的资产被改写')
  else fail(`${rewritten.length} 个文件内容变了`, rewritten.slice(0, 10).join(', '))

  if (touched.length === 0) pass('没有任何已完成的资产被重写（mtime 都没动）')
  else {
    fail(
      `${touched.length} 个文件 mtime 变了但内容没变`,
      `${touched.slice(0, 10).join(', ')} —— 内容相同不等于没重下，` +
        '幂等要求的是「不重新下载」，不是「下载结果一样」',
    )
  }

  if (removed.length > 0) fail(`${removed.length} 个文件消失了`, removed.slice(0, 10).join(', '))

  const newParts = added.filter((k) => k.endsWith('.part'))
  if (newParts.length > 0) {
    fail(`第二遍产生了 ${newParts.length} 个新的 .part`, '说明它确实重新开始下载了')
  }
  const newFiles = added.filter((k) => !k.endsWith('.part'))
  if (newFiles.length > 0) {
    // 新文件未必是坏事：AI 纪要延迟探测就绪后被补下载，正是设计如此（§4.5）
    fact(
      `第二遍新增了 ${newFiles.length} 个文件`,
      `${newFiles.slice(0, 10).join(', ')} —— 若是 AI 纪要类，那是延迟探测补下载（§4.5），是对的；` +
        '若是本该第一遍就下完的类型，那就是幂等破了',
    )
  }
}

// ── 队列状态 ────────────────────────────────────────────────────────────

/**
 * 直接读 SQLite，不走 `Store` 接口。
 *
 * 这是本仓库其它地方明令禁止的（CLI 曾因绕过 Store 长出三份重复的 loadMeetings），
 * 这里破例是因为：核验工具要看的恰恰是 `Store` **刻意不暴露**的东西——
 * 租约到期时刻、probes 表里还没到期的探测。用 Store 看不到它们，
 * 而为了核验去给生产接口加方法，是让工具反过来塑造被测对象。
 */
async function cmdQueue(a: Args): Promise<void> {
  if (!a.out) throw new Error('queue 需要 --out <目录>')
  const { Database } = await import('bun:sqlite')
  const db = new Database(join(a.out, '.mde', 'queue.sqlite'), { readonly: true })

  console.log('\n队列状态')

  const rows = db.query<{ status: string; n: number }, []>(
    'SELECT status, COUNT(*) AS n FROM assets GROUP BY status ORDER BY status',
  ).all()
  for (const r of rows) console.log(`  ${r.status.padEnd(10)} ${r.n}`)

  const t = now()
  const running = db.query<{ n: number; expired: number }, [number]>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN lease_expires_at < ? THEN 1 ELSE 0 END) AS expired
       FROM assets WHERE status = 'running'`,
  ).get(t)
  if (running && running.n > 0) {
    fact('running 任务', `${running.n} 个，其中租约已过期 ${running.expired ?? 0} 个`)
    if ((running.expired ?? 0) > 0) {
      console.log('      租约已过期的应当在下一次 execute 时被重新领取（§4.4 崩溃恢复）')
    }
  }

  // §4.5 的第一条判据直接就是 asset_probes.state：刚结束的会议的 AI 纪要
  // 应当是 'probing'，**不是 failed**。不加 try/catch 兜住——表名或列名对不上
  // 是真问题，静默跳过会让这条判据看起来「查过了」，而实际上什么都没验
  const probes = db.query<
    { state: string; n: number; due: number; overdue: number },
    [number, number]
  >(
    `SELECT state, COUNT(*) AS n,
            SUM(CASE WHEN probe_after <= ? THEN 1 ELSE 0 END) AS due,
            SUM(CASE WHEN deadline_at  <  ? THEN 1 ELSE 0 END) AS overdue
       FROM asset_probes GROUP BY state ORDER BY state`,
  ).all(t, t)

  if (probes.length === 0) {
    fact('AI 纪要延迟探测（§4.5）', 'asset_probes 一条都没有')
  } else {
    for (const p of probes) {
      fact(
        `探测 state=${p.state}`,
        `${p.n} 条，已到探测时刻 ${p.due ?? 0} 条，已过放弃期限 ${p.overdue ?? 0} 条`,
      )
    }
    // 「刚结束的会议的 AI 纪要进 probing 而不是 failed」是 §4.5 的第一条判据。
    // 反过来，probing 的条目全部超过 deadline_at 却还挂在那儿，是探测循环没在跑
    const stuck = probes.find((p) => p.state === 'probing' && (p.overdue ?? 0) > 0)
    if (stuck) {
      fail(
        `${stuck.overdue} 条探测已过放弃期限却仍是 probing`,
        '探测循环没有在跑，或者放弃分支没被走到——两种都要查',
      )
    }
  }

  const probeRows = db.query<
    { meeting_id: string; asset_type: string; state: string; attempts: number; last_reason: string | null },
    []
  >(
    `SELECT meeting_id, asset_type, state, attempts, last_reason
       FROM asset_probes ORDER BY meeting_id, asset_type LIMIT 20`,
  ).all()
  for (const r of probeRows) {
    console.log(
      `      [${r.state}] ${r.meeting_id} ${r.asset_type} 试了 ${r.attempts} 次` +
        `${r.last_reason ? `: ${r.last_reason}` : ''}`,
    )
  }

  const failed = db.query<{ meeting_id: string; asset_type: string; status: string; last_error: string | null }, []>(
    `SELECT meeting_id, asset_type, status, last_error FROM assets
      WHERE status IN ('failed', 'dead') ORDER BY meeting_id LIMIT 20`,
  ).all()
  if (failed.length > 0) {
    console.log(`  失败项 ${failed.length} 条（最多列 20）：`)
    for (const f of failed) {
      console.log(`      [${f.status}] ${f.meeting_id} ${f.asset_type}: ${f.last_error ?? ''}`)
    }
  }
  db.close()
}

// ── 入口 ────────────────────────────────────────────────────────────────

const USAGE = `用法：
  bun scripts/verify-m35.ts range    --meeting <会议号> [--type video]
  bun scripts/verify-m35.ts snapshot --out <目录>
  bun scripts/verify-m35.ts compare  --out <目录>
  bun scripts/verify-m35.ts queue    --out <目录>`

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2))
  switch (a.cmd) {
    case 'range': await cmdRange(a); break
    case 'snapshot': await cmdSnapshot(a); break
    case 'compare': await cmdCompare(a); break
    case 'queue': await cmdQueue(a); break
    default:
      console.log(USAGE)
      return 2
  }
  if (failures > 0) {
    console.log(`\n${failures} 项未通过。`)
    if (a.cmd === 'range') {
      console.log('**未通过不等于要修代码**：§4.1 判 200 是对象存储的限制，')
      console.log('如实记进 roadmap 就是本次最有价值的产出。')
    }
    return 1
  }
  console.log('\n全部通过。')
  return 0
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(`\n出错：${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
})
