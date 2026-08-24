/** 单独成类，好让调用方**按类型**而不是按错误话里的子串区分超时与真实的 fs 错误 */
export class FsTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms — a hung network mount blocks fs calls instead of failing them`)
    this.name = 'FsTimeoutError'
  }
}

export function withFsTimeout<T>(p: Promise<T>, what: string, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // p 若在输掉竞速之后才拒绝，那次拒绝已经被 Promise.race 自己接住了
  // （race 给两边都挂了 handler），不会变成 unhandled rejection。
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FsTimeoutError(what, ms)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
