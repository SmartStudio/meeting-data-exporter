import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../src/api/client'
import { ApiShapeError } from '../../src/api/validate'
import {
  createProgram,
  grantMeeting,
  listPrograms,
  programInventory,
  putOverride,
  revokeGrant,
  revokeOverride,
  rotateProgramSecret,
  setProgramEnabled,
} from '../../src/api/admin/grants'

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[] = []

function install(status: number, body: unknown): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

function sentBody(): unknown {
  return JSON.parse(String(calls[0]!.init.body))
}

afterEach(() => vi.unstubAllGlobals())

const PROGRAM = {
  id: 'kb-indexer',
  name: '知识库索引器',
  tmUserId: 'tm-001',
  enabled: true,
  expiresAt: null,
  createdAt: 1700000000,
}

const GRANT = {
  id: 42,
  meetingId: 'm-1',
  subMeetingId: 's-7',
  programId: 'kb-indexer',
  assetTypes: ['ai_minutes'],
  grantedAt: 1700000000,
  revokedAt: null,
}

const OVERRIDE = {
  id: 5,
  meetingId: 'm-1',
  subMeetingId: '',
  kind: 'allow',
  effect: 'deny',
  assetTypes: null,
  reason: '涉密，单独关闭',
  createdAt: 1700000000,
  revokedAt: null,
}

const INVENTORY = {
  programId: 'kb-indexer',
  now: 1700000000,
  fetchableCount: 1,
  blockedCount: 1,
  expiringSoonCount: 1,
  expiringSoonDays: 7,
  assetTypes: ['transcript', 'ai_minutes'],
  fetchable: [
    {
      meetingId: 'm-1',
      subMeetingId: '',
      assetTypes: ['transcript', 'ai_minutes'],
      expiresAt: 1700400000,
      expiringSoon: true,
      overridden: false,
      decision: {
        effect: 'allow',
        reason: '标题含「周会」，规则 #100',
        ruleId: 100,
        note: null,
        source: 'rule',
      },
      blockers: [],
    },
  ],
  blocked: [
    {
      meetingId: 'm-purged',
      subMeetingId: '',
      assetTypes: [],
      expiresAt: null,
      expiringSoon: false,
      overridden: false,
      decision: null,
      blockers: [{ code: 'local_purged', remedy: 'nas', reason: '本地文件已到期清理' }],
    },
  ],
}

describe('程序（programs）三条', () => {
  test('listPrograms 走 GET /api/v1/admin/programs', async () => {
    install(200, [PROGRAM])
    const got = await listPrograms()
    expect(calls[0]!.url).toBe('/api/v1/admin/programs')
    expect(calls[0]!.init.method).toBe('GET')
    expect(got[0]!.name).toBe('知识库索引器')
    expect(got[0]!.expiresAt).toBeNull()
  })

  test('createProgram 不填 expiresAt 时不把这个键发出去（"永不过期" ≠ expiresAt: undefined）', async () => {
    install(201, { ...PROGRAM, id: 'new-prog', secret: 's3cr3t', secretShownOnce: true, secretNote: '这是唯一一次能看到它的机会。' })
    const got = await createProgram({ id: 'new-prog', name: '新程序', tmUserId: 'tm-9' })
    expect(calls[0]!.init.method).toBe('POST')
    expect(sentBody()).toEqual({ id: 'new-prog', name: '新程序', tmUserId: 'tm-9' })
    expect(got.secret).toBe('s3cr3t')
    expect(got.secretShownOnce).toBe(true)
  })

  test('createProgram 填了 expiresAt 就带上', async () => {
    install(201, { ...PROGRAM, expiresAt: 1800000000, secret: 'x', secretShownOnce: true, secretNote: '只此一次。' })
    await createProgram({ id: 'p', name: 'n', tmUserId: 't', expiresAt: 1800000000 })
    expect(sentBody()).toMatchObject({ expiresAt: 1800000000 })
  })

  test('createProgram 的 409 原样带着后端的错误码抛出来', async () => {
    install(409, { error: 'program_id_taken' })
    const err = (await createProgram({ id: 'p', name: 'n', tmUserId: 't' }).catch(
      (e: unknown) => e,
    )) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(409)
    expect(err.body).toEqual({ error: 'program_id_taken' })
  })

  test('programInventory 的程序 id 走 encodeURIComponent', async () => {
    install(200, INVENTORY)
    const got = await programInventory('a/b c')
    expect(calls[0]!.url).toBe('/api/v1/admin/programs/a%2Fb%20c/inventory')
    expect(got.assetTypes).toEqual(['transcript', 'ai_minutes'])
    expect(got.fetchable[0]!.decision?.ruleId).toBe(100)
    expect(got.blocked[0]!.decision).toBeNull()
    expect(got.blocked[0]!.blockers[0]!.code).toBe('local_purged')
  })

  test('createProgram 读 secretNote——建号与轮换要说同一句话', async () => {
    install(201, {
      ...PROGRAM,
      secret: 's',
      secretShownOnce: true,
      secretNote: '这是唯一一次能看到这个凭据明文的机会。',
    })
    const got = await createProgram({ id: 'p', name: 'n', tmUserId: 't' })
    expect(got.secretNote).toBe('这是唯一一次能看到这个凭据明文的机会。')
  })
})

describe('停用 / 启用（PATCH /programs/:id）', () => {
  test('发的是 PATCH，请求体只有一个真布尔 enabled', async () => {
    install(200, { ...PROGRAM, enabled: false })
    const got = await setProgramEnabled('kb-indexer', false)
    expect(calls[0]!.url).toBe('/api/v1/admin/programs/kb-indexer')
    expect(calls[0]!.init.method).toBe('PATCH')
    expect(sentBody()).toEqual({ enabled: false })
    // 写后重读的完整 ServiceProgram，不是一个 { ok: true }
    expect(got.enabled).toBe(false)
    expect(got.name).toBe('知识库索引器')
  })

  test('程序 id 走 encodeURIComponent', async () => {
    install(200, PROGRAM)
    await setProgramEnabled('a/b c', true)
    expect(calls[0]!.url).toBe('/api/v1/admin/programs/a%2Fb%20c')
  })

  test('404 原样带着后端的错误码抛出来', async () => {
    install(404, { error: 'program_not_found' })
    const err = (await setProgramEnabled('nope', false).catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(404)
    expect(err.body).toEqual({ error: 'program_not_found' })
  })

  test('响应缺 enabled 时抛形状错误，不当成"停用成功"', async () => {
    const { enabled: _drop, ...withoutEnabled } = PROGRAM
    install(200, withoutEnabled)
    await expect(setProgramEnabled('kb-indexer', false)).rejects.toBeInstanceOf(ApiShapeError)
  })
})

describe('轮换凭据（POST /programs/:id/rotate-secret）', () => {
  const ROTATED = {
    id: 'kb-indexer',
    name: '知识库索引器',
    rotatedAt: 1700000000,
    secret: 'new-plaintext',
    secretShownOnce: true,
    secretNote: '这是唯一一次能看到这个凭据明文的机会：服务端只存哈希。',
  }

  test('发的是 POST，且没有请求体', async () => {
    install(200, ROTATED)
    const got = await rotateProgramSecret('kb-indexer')
    expect(calls[0]!.url).toBe('/api/v1/admin/programs/kb-indexer/rotate-secret')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBeUndefined()
    expect(got.secret).toBe('new-plaintext')
    expect(got.secretNote).toContain('唯一一次')
  })

  test('缺 secret 时抛形状错误——绝不给一个空串当凭据', async () => {
    const { secret: _drop, ...withoutSecret } = ROTATED
    install(200, withoutSecret)
    await expect(rotateProgramSecret('kb-indexer')).rejects.toBeInstanceOf(ApiShapeError)
  })

  test('403 只读角色照常抛出来（前端禁用了按钮不代表这条路径不会被走到）', async () => {
    install(403, { error: 'readonly_role', message: '这个账号是只读角色。' })
    const err = (await rotateProgramSecret('kb-indexer').catch((e: unknown) => e)) as ApiError
    expect(err.status).toBe(403)
    expect(err.message).toBe('这个账号是只读角色。')
  })
})

describe('周期性会议的场次：?sub= 封在这一层，调用方只传 { meetingId, subMeetingId }', () => {
  test('给了 subMeetingId 就拼 ?sub=', async () => {
    install(200, GRANT)
    await grantMeeting(
      { meetingId: 'm-1', subMeetingId: 's-7' },
      { programId: 'kb-indexer', assetTypes: ['ai_minutes'] },
    )
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/grants?sub=s-7')
  })

  test('没给 / 给空串都不拼 ?sub=（缺省即主场次，不是 ?sub=）', async () => {
    install(200, { ...GRANT, subMeetingId: '' })
    await grantMeeting({ meetingId: 'm-1' }, { programId: 'kb', assetTypes: null })
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/grants')

    install(200, { ...GRANT, subMeetingId: '' })
    await grantMeeting({ meetingId: 'm-1', subMeetingId: '' }, { programId: 'kb', assetTypes: null })
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/grants')
  })

  test('meetingId 里的逗号要编码（consoleMeetingId 编出来的串带逗号）', async () => {
    install(200, GRANT)
    await grantMeeting({ meetingId: 'm-1,s-7' }, { programId: 'kb', assetTypes: null })
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1%2Cs-7/grants')
  })

  test('sub 里的特殊字符也要编码', async () => {
    install(200, { revoked: true })
    await revokeGrant({ meetingId: 'm 1', subMeetingId: 's&7' }, 'kb/1')
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m%201/grants/kb%2F1?sub=s%267')
    expect(calls[0]!.init.method).toBe('DELETE')
  })

  test('四条支持 sub 的端点都拼得上', async () => {
    const ref = { meetingId: 'm-1', subMeetingId: 's-7' }

    install(200, GRANT)
    await grantMeeting(ref, { programId: 'kb', assetTypes: null })
    expect(calls[0]!.url).toContain('?sub=s-7')

    install(200, { revoked: true })
    await revokeGrant(ref, 'kb')
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/grants/kb?sub=s-7')

    install(200, OVERRIDE)
    await putOverride(ref, { kind: 'allow', effect: 'deny', assetTypes: null, reason: '涉密' })
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/override?sub=s-7')
    expect(calls[0]!.init.method).toBe('PUT')

    install(200, { revoked: true })
    await revokeOverride(ref, 'allow')
    expect(calls[0]!.url).toBe('/api/v1/admin/meetings/m-1/override/allow?sub=s-7')
    expect(calls[0]!.init.method).toBe('DELETE')
  })
})

describe('assetTypes 的三态：null / [] / 白名单，键必须显式发出去', () => {
  test('assetTypes 为 null 时也要发这个键（后端缺键会 400 missing_asset_types）', async () => {
    install(200, { ...GRANT, assetTypes: null })
    await grantMeeting({ meetingId: 'm-1' }, { programId: 'kb', assetTypes: null })
    const body = sentBody() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['assetTypes', 'programId'])
    expect(body.assetTypes).toBeNull()
  })

  test('assetTypes 为空数组是"什么都不授权"，不能被当成"没填"扔掉', async () => {
    install(200, { ...GRANT, assetTypes: [] })
    await grantMeeting({ meetingId: 'm-1' }, { programId: 'kb', assetTypes: [] })
    expect((sentBody() as Record<string, unknown>).assetTypes).toEqual([])
  })

  test('putOverride 的四个字段一个都不少', async () => {
    install(200, OVERRIDE)
    await putOverride(
      { meetingId: 'm-1' },
      { kind: 'allow', effect: 'deny', assetTypes: null, reason: '涉密，单独关闭' },
    )
    expect(sentBody()).toEqual({
      kind: 'allow',
      effect: 'deny',
      assetTypes: null,
      reason: '涉密，单独关闭',
    })
  })

  test('revoked: false 是一次 noop，不是错误', async () => {
    install(200, { revoked: false })
    await expect(revokeGrant({ meetingId: 'm-1' }, 'kb')).resolves.toEqual({ revoked: false })
  })
})

describe('运行时校验：后端少一个字段要炸在这一层，不是渲染成空白', () => {
  test('缺字段时抛的错带端点名与字段路径', async () => {
    install(200, [{ ...PROGRAM, tmUserId: undefined }])
    const err = (await listPrograms().catch((e: unknown) => e)) as ApiShapeError
    expect(err).toBeInstanceOf(ApiShapeError)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toContain('/api/v1/admin/programs')
    expect(err.message).toContain('tmUserId')
  })

  test('类型不对（数字写成字符串）同样炸', async () => {
    install(200, { ...GRANT, grantedAt: '1700000000' })
    const err = (await grantMeeting({ meetingId: 'm-1' }, { programId: 'k', assetTypes: null }).catch(
      (e: unknown) => e,
    )) as ApiShapeError
    expect(err).toBeInstanceOf(ApiShapeError)
    expect(err.message).toContain('grantedAt')
  })

  test('列表端点返回的不是数组时报得出来', async () => {
    install(200, { programs: [] })
    await expect(listPrograms()).rejects.toBeInstanceOf(ApiShapeError)
  })

  test('嵌套结构里的缺字段能定位到下标', async () => {
    const broken = structuredClone(INVENTORY) as Record<string, unknown>
    const fetchable = broken.fetchable as Array<Record<string, unknown>>
    delete fetchable[0]!.expiringSoon
    install(200, broken)
    const err = (await programInventory('kb').catch((e: unknown) => e)) as ApiShapeError
    expect(err.message).toContain('fetchable[0].expiringSoon')
  })
})
