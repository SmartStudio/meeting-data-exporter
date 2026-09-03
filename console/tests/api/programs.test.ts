import { describe, expect, test } from 'vitest'
import { ApiError } from '../../src/api/client'
import type { InventoryItem, ProgramInventory, ServiceProgram } from '../../src/api/admin/grants'
import {
  accessSnippet,
  assetLabel,
  assetsOrDash,
  assetTypesText,
  blockerLabel,
  createErrorText,
  draftToInput,
  PROGRAM_ID_RE,
  programStanding,
  reachLine,
  remedyHint,
  tallyBlockers,
  validateDraft,
  type Draft,
} from '../../src/api/admin/programs'

/**
 * 采集授权页的派生逻辑。这一页的全部价值是那句「现在可取走 N 场会议的 X」——
 * spec §4.5 明说它是**三个「与」求交之后的实际结果，不是配置值**，所以这里
 * 测的重点是：它只从 inventory 来，且每一条"取不到"都说得出理由。
 */

function inv(over: Partial<ProgramInventory> = {}): ProgramInventory {
  return {
    programId: 'kb-indexer',
    now: 1700000000,
    fetchableCount: 0,
    blockedCount: 0,
    expiringSoonCount: 0,
    expiringSoonDays: 7,
    assetTypes: [],
    fetchable: [],
    blocked: [],
    ...over,
  }
}

function item(over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    meetingId: 'm-1',
    subMeetingId: '',
    assetTypes: [],
    expiresAt: null,
    expiringSoon: false,
    overridden: false,
    decision: null,
    blockers: [],
    ...over,
  }
}

function program(over: Partial<ServiceProgram> = {}): ServiceProgram {
  return {
    id: 'kb-indexer',
    name: '知识库索引器',
    tmUserId: 'tm-001',
    enabled: true,
    expiresAt: null,
    createdAt: 1600000000,
    autoGrant: false,
    autoGrantAssetTypes: null,
    ...over,
  }
}

describe('资产类型的中文名', () => {
  test('八类各有名字，与网关那份逐字一致', () => {
    expect(assetLabel('ai_minutes')).toBe('AI 纪要')
    expect(assetLabel('transcript')).toBe('完整转写')
    expect(assetLabel('ai_ds_minutes')).toBe('会议摘要')
  })

  test('后端加了新的资产类型时原样显示，不折成"其他"也不丢掉', () => {
    expect(assetLabel('ai_brand_new')).toBe('ai_brand_new')
  })

  test('连起来就是 spec §4.5 那句话里的资产串', () => {
    expect(assetTypesText(['ai_minutes', 'transcript'])).toBe('AI 纪要 + 完整转写')
  })

  test('空数组给空串——调用方要能把"没有资产类型"与"有一类"分开处理', () => {
    expect(assetTypesText([])).toBe('')
  })

  test('逐场那一行空数组说"无"，不留白（留白看起来像没渲染出来）', () => {
    expect(assetsOrDash([])).toBe('无')
    expect(assetsOrDash(['video'])).toBe('录像')
  })
})

describe('卡片正中间那句话（求交之后的实际结果）', () => {
  test('可取走时给出场次数与资产串，两者都来自 inventory', () => {
    const line = reachLine(inv({ fetchableCount: 4, assetTypes: ['ai_minutes', 'transcript'] }))
    expect(line).toEqual({
      kind: 'reachable',
      count: 4,
      assetsText: 'AI 纪要 + 完整转写',
      expiringSoon: 0,
      expiringSoonDays: 7,
    })
  })

  test('快到期的场次数与阈值都跟着响应走，不在前端抄一个 7', () => {
    const line = reachLine(
      inv({ fetchableCount: 4, assetTypes: ['ai_minutes'], expiringSoonCount: 1, expiringSoonDays: 14 }),
    )
    expect(line).toMatchObject({ kind: 'reachable', expiringSoon: 1, expiringSoonDays: 14 })
  })

  test('一场都取不到时是另一句话，不是"可取走 0 场"', () => {
    expect(reachLine(inv({ fetchableCount: 0, blockedCount: 3 }))).toEqual({
      kind: 'none',
      blockedCount: 3,
    })
  })

  test('能取走却没列出任何资产类型 = 自相矛盾，单独成一档而不是印一句半截话', () => {
    expect(reachLine(inv({ fetchableCount: 2, assetTypes: [] }))).toEqual({
      kind: 'reachable-no-assets',
      count: 2,
    })
  })
})

describe('取不到的理由（§1.3：界面必须随时能回答"为什么取不到"）', () => {
  const blocked = [
    item({
      meetingId: 'm-purged',
      blockers: [{ code: 'local_purged', remedy: 'nas', reason: '本地文件已到期清理（/nas/2026/05/m-purged）' }],
    }),
    item({
      meetingId: 'm-2',
      blockers: [{ code: 'local_purged', remedy: 'nas', reason: '本地文件已到期清理（/nas/2026/05/m-2）' }],
    }),
    item({
      meetingId: 'm-3',
      blockers: [{ code: 'rule_denied', remedy: 'rules', reason: '采集权限规则 #7 拒绝' }],
    }),
  ]

  test('按 code 归并、带上条数，多的排前面', () => {
    const tally = tallyBlockers(blocked)
    expect(tally.map((t) => [t.code, t.count])).toEqual([
      ['local_purged', 2],
      ['rule_denied', 1],
    ])
  })

  test('每一类留一条后端原话做样例——理由的文本一律来自后端，前端不自己编', () => {
    expect(tallyBlockers(blocked)[0]?.sample).toBe('本地文件已到期清理（/nas/2026/05/m-purged）')
  })

  test('一场会议带多条 blocker 时每条各计一次', () => {
    const tally = tallyBlockers([
      item({
        blockers: [
          { code: 'no_local_files', remedy: 'pipeline', reason: '还没拉下来' },
          { code: 'meeting_unknown', remedy: 'pipeline', reason: '授权行指着一场不存在的会议' },
        ],
      }),
    ])
    expect(tally).toHaveLength(2)
  })

  test('六个已知 code 各有中文名', () => {
    expect(blockerLabel('not_granted')).toBe('未授权')
    expect(blockerLabel('local_purged')).toBe('本地文件已清理')
    expect(blockerLabel('no_local_files')).toBe('本地没有文件')
    expect(blockerLabel('rule_denied')).toBe('规则拒绝')
    expect(blockerLabel('meeting_unknown')).toBe('会议不存在')
    expect(blockerLabel('grant_scope_empty')).toBe('授权范围为空')
  })

  test('后端加了新 code 时原样显示，不冒充成已知的某一类', () => {
    expect(blockerLabel('brand_new_reason')).toBe('brand_new_reason')
  })

  test('已知的 remedy 说得出该去哪一页；未知的返回 null，不编一句"去某处处理"', () => {
    expect(remedyHint('rules')).toContain('自动规则')
    expect(remedyHint('grants')).toContain('会议记录')
    expect(remedyHint('nas')).toContain('归档存储')
    expect(remedyHint('pipeline')).toContain('定时任务')
    expect(remedyHint('teleport')).toBeNull()
  })
})

describe('程序自身的状态（与"能取到几场"是两回事）', () => {
  const now = 1700000000

  test('正常', () => {
    expect(programStanding(program(), now)).toBe('active')
  })

  test('凭据已过期', () => {
    expect(programStanding(program({ expiresAt: now - 1 }), now)).toBe('expired')
  })

  test('到期时刻当秒仍然算有效——过期是"过了"，不是"到了"', () => {
    expect(programStanding(program({ expiresAt: now }), now)).toBe('active')
  })

  test('被停用时先说停用：那是有人做过的一个动作，比"过期"更需要先看到', () => {
    expect(programStanding(program({ enabled: false, expiresAt: now - 1 }), now)).toBe('disabled')
  })
})

describe('接入向导第一步的校验（照 POST /programs 的契约）', () => {
  const now = 1700000000
  const ok: Draft = { id: 'kb-indexer', name: '知识库索引器', tmUserId: 'tm-001', expiresAt: '' }
  const fields = (d: Draft): string[] => validateDraft(d, now).map((e) => e.field)

  test('契约里那条正则原样搬过来', () => {
    expect(PROGRAM_ID_RE.test('kb-indexer')).toBe(true)
    expect(PROGRAM_ID_RE.test('_kb')).toBe(false)
    expect(PROGRAM_ID_RE.test('kb indexer')).toBe(false)
    expect(PROGRAM_ID_RE.test('a'.repeat(64))).toBe(true)
    expect(PROGRAM_ID_RE.test('a'.repeat(65))).toBe(false)
  })

  test('填齐了就没有错', () => {
    expect(validateDraft(ok, now)).toEqual([])
  })

  test('三个必填项各自报各自的错', () => {
    expect(fields({ ...ok, id: '' })).toEqual(['id'])
    expect(fields({ ...ok, name: '  ' })).toEqual(['name'])
    expect(fields({ ...ok, tmUserId: '' })).toEqual(['tmUserId'])
  })

  test('id 不合法时说清哪里不合法，不是一句"格式错误"', () => {
    const err = validateDraft({ ...ok, id: '中文 id' }, now)[0]
    expect(err?.field).toBe('id')
    expect(err?.message).toMatch(/字母或数字/)
  })

  test('长度上限与后端一致（128）', () => {
    expect(fields({ ...ok, name: 'x'.repeat(129) })).toEqual(['name'])
    expect(fields({ ...ok, name: 'x'.repeat(128) })).toEqual([])
    expect(fields({ ...ok, tmUserId: 'x'.repeat(129) })).toEqual(['tmUserId'])
  })

  test('到期日不填 = 永不过期，不是错', () => {
    expect(fields({ ...ok, expiresAt: '' })).toEqual([])
  })

  test('到期日填在过去 = 错（后端也会拒，但没必要为此往返一次）', () => {
    expect(fields({ ...ok, expiresAt: '2000-01-01' })).toEqual(['expiresAt'])
  })

  test('到期日填不成日期时报错，不是悄悄当成永不过期', () => {
    expect(fields({ ...ok, expiresAt: '不是日期' })).toEqual(['expiresAt'])
  })

  test('转成请求体：不填到期日时这个键不出现（后端把 null 当成一次非法取值）', () => {
    expect(draftToInput({ ...ok, id: ' kb-indexer ', name: ' 知识库索引器 ' })).toEqual({
      id: 'kb-indexer',
      name: '知识库索引器',
      tmUserId: 'tm-001',
    })
  })

  test('填了到期日就给整数秒，且落在那一天的末尾（当天仍然可用）', () => {
    const input = draftToInput({ ...ok, expiresAt: '2030-06-01' })
    expect(Number.isInteger(input.expiresAt)).toBe(true)
    const d = new Date((input.expiresAt as number) * 1000)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2030, 6, 1])
    expect(d.getHours()).toBe(23)
  })
})

describe('后端拒绝时的说法', () => {
  test('已知错误码翻成人话', () => {
    const taken = new ApiError(409, 'POST /api/v1/admin/programs', 'x', { error: 'program_id_taken' })
    expect(createErrorText(taken)).toContain('已经被占用')
    const badId = new ApiError(400, 'POST /api/v1/admin/programs', 'x', { error: 'invalid_program_id' })
    expect(createErrorText(badId)).toContain('程序 id')
  })

  test('没见过的错误码退回 client 那句（里面带着端点名与状态码），不吞掉', () => {
    const weird = new ApiError(500, 'POST /api/v1/admin/programs', 'POST /api/v1/admin/programs 返回 500', {
      error: 'boom',
    })
    expect(createErrorText(weird)).toBe('POST /api/v1/admin/programs 返回 500')
  })

  test('压根不是 ApiError 时也要说点什么，不返回空串', () => {
    expect(createErrorText(new Error('炸了'))).toBe('炸了')
    expect(createErrorText('炸了')).not.toBe('')
  })
})

describe('接入方式那一段（给对方抄的两条命令）', () => {
  const snippet = accessSnippet('https://yao-data.internal', 'kb-indexer')

  test('端点与请求体照后端的真实形状写', () => {
    expect(snippet).toContain('https://yao-data.internal/api/v1/auth/service-token')
    expect(snippet).toContain('"client_id":"kb-indexer"')
    expect(snippet).toContain('https://yao-data.internal/api/v1/meetings')
    expect(snippet).toContain('Authorization: Bearer')
  })

  test('不写死令牌有效期——那个数在后端（900 秒），抄一份就会有第二处真相', () => {
    expect(snippet).not.toMatch(/1 小时|3600/)
    expect(snippet).toContain('expires_in')
  })
})
