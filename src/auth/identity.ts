import type { IdentityStrategy } from '../config'

/**
 * 映射失败必须区别于「无权限」：前者是配置缺陷，后者是策略的正常结论。
 * 混为一谈会让管理员看到用户抱怨没权限，却在策略表里找不到任何问题。
 */
export class IdentityMappingError extends Error {
  constructor(wecomUserId: string, strategy: IdentityStrategy) {
    super(
      `account not provisioned: WeCom user "${wecomUserId}" has no corresponding ` +
        `Tencent Meeting account under strategy "${strategy}". ` +
        'This is a configuration issue, not an authorization decision.',
    )
    this.name = 'IdentityMappingError'
  }
}

export interface IdentityMapperDeps {
  lookupTable: (wecomUserId: string) => Promise<string | null>
  lookupByEmail: (email: string) => Promise<string | null>
}

export interface IdentityMapper {
  toTmUserId(wecomUserId: string, email: string | null): Promise<string>
}

export function createIdentityMapper(
  strategy: IdentityStrategy,
  deps: IdentityMapperDeps,
): IdentityMapper {
  return {
    async toTmUserId(wecomUserId, email) {
      if (strategy === 'direct') return wecomUserId

      if (strategy === 'table') {
        const found = await deps.lookupTable(wecomUserId)
        if (found === null) throw new IdentityMappingError(wecomUserId, strategy)
        return found
      }

      if (email === null || email === '') throw new IdentityMappingError(wecomUserId, strategy)
      const byEmail = await deps.lookupByEmail(email)
      if (byEmail === null) throw new IdentityMappingError(wecomUserId, strategy)
      return byEmail
    },
  }
}
