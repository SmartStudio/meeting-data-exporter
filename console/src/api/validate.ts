/**
 * 响应形状的运行时校验。
 *
 * `res.json()` 回来是 `any`——字段名写错一个字母，TypeScript 一个字都不会说，
 * 界面上得到的是 `undefined` 渲染成的空白，而空白看起来像"这场会议本来就没有
 * 归档时间"，不像"我把 `archivedAt` 敲成了 `archiveAt`"。
 *
 * 所以每个域的 api 文件都要在返回前过一遍这里的检查（计划 §1 全局约束第 7 条）。
 * 检查失败抛 `ApiShapeError`，**带端点名与字段路径**——页面把 `error.message`
 * 显示出来就能直接定位，不需要再打开 devtools 对一遍 JSON。
 *
 * 校验的口径是「必填字段存在且类型对」，不是「把响应重新建模一遍」：
 * 后端加了新字段不该让前端红，前端漏掉一个必填字段必须红。
 */

import { ApiError } from './client'

/**
 * 响应体与契约对不上。
 *
 * 继承 `ApiError` 而不是自成一支：页面的错误出口一律 `catch (e: ApiError)`，
 * 多一个平行的类型就多一个漏接的分支。`status` 用真实的 200——这次 HTTP 请求
 * 本身是成功的，坏的是内容，把它记成 0 或 500 都是在编造一次没发生的事。
 */
export class ApiShapeError extends ApiError {
  constructor(endpoint: string, detail: string, raw: unknown) {
    super(200, endpoint, `${endpoint} 的响应与契约对不上：${detail}`, raw)
    this.name = 'ApiShapeError'
  }
}

export interface FieldReader {
  object(raw: unknown, where: string): Record<string, unknown>
  array(raw: unknown, where: string): unknown[]
  str(o: Record<string, unknown>, key: string, where: string): string
  num(o: Record<string, unknown>, key: string, where: string): number
  bool(o: Record<string, unknown>, key: string, where: string): boolean
  numOrNull(o: Record<string, unknown>, key: string, where: string): number | null
  strOrNull(o: Record<string, unknown>, key: string, where: string): string | null
  strList(o: Record<string, unknown>, key: string, where: string): string[]
  strListOrNull(o: Record<string, unknown>, key: string, where: string): string[] | null
  objOrNull(o: Record<string, unknown>, key: string, where: string): Record<string, unknown> | null
  objList(o: Record<string, unknown>, key: string, where: string): Record<string, unknown>[]
  fail(detail: string, raw: unknown): never
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/**
 * 给一个端点建一组校验器。`where` 是字段在响应里的路径前缀（`'nas'` /
 * `'jobs[0]'`），报错时拼成 `nas.reachable`——只报"缺字段"而不报是哪一个，
 * 等于把定位的活推给读日志的人。
 */
export function reader(endpoint: string): FieldReader {
  // 显式的类型注解不是装饰：TS 只有在 callee 是「声明式函数」或「带显式类型
  // 注解的 const」时，才把返回 never 的调用当成控制流终点。少了它，
  // `if (!Array.isArray(raw)) fail(...)` 之后 raw 仍然是 unknown。
  const fail: (detail: string, raw: unknown) => never = (detail, raw) => {
    throw new ApiShapeError(endpoint, detail, raw)
  }
  const at = (where: string, key: string): string => (where === '' ? key : `${where}.${key}`)

  const object = (raw: unknown, where: string): Record<string, unknown> => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(`${where === '' ? '响应' : where} 应该是对象，实际是 ${typeName(raw)}`, raw)
    }
    return raw as Record<string, unknown>
  }

  const array = (raw: unknown, where: string): unknown[] => {
    if (!Array.isArray(raw)) {
      fail(`${where === '' ? '响应' : where} 应该是数组，实际是 ${typeName(raw)}`, raw)
    }
    return raw
  }

  const str = (o: Record<string, unknown>, key: string, where: string): string => {
    const v = o[key]
    if (typeof v !== 'string') fail(`${at(where, key)} 应该是 string，实际是 ${typeName(v)}`, o)
    return v as string
  }

  const num = (o: Record<string, unknown>, key: string, where: string): number => {
    const v = o[key]
    if (typeof v !== 'number' || Number.isNaN(v)) {
      fail(`${at(where, key)} 应该是 number，实际是 ${typeName(v)}`, o)
    }
    return v as number
  }

  const bool = (o: Record<string, unknown>, key: string, where: string): boolean => {
    const v = o[key]
    if (typeof v !== 'boolean') fail(`${at(where, key)} 应该是 boolean，实际是 ${typeName(v)}`, o)
    return v as boolean
  }

  const numOrNull = (o: Record<string, unknown>, key: string, where: string): number | null => {
    const v = o[key]
    if (v === null) return null
    if (typeof v !== 'number' || Number.isNaN(v)) {
      fail(`${at(where, key)} 应该是 number | null，实际是 ${typeName(v)}`, o)
    }
    return v as number
  }

  const strOrNull = (o: Record<string, unknown>, key: string, where: string): string | null => {
    const v = o[key]
    if (v === null) return null
    if (typeof v !== 'string') {
      fail(`${at(where, key)} 应该是 string | null，实际是 ${typeName(v)}`, o)
    }
    return v as string
  }

  const strList = (o: Record<string, unknown>, key: string, where: string): string[] => {
    const v = array(o[key], at(where, key))
    for (const [i, item] of v.entries()) {
      if (typeof item !== 'string') {
        fail(`${at(where, key)}[${i}] 应该是 string，实际是 ${typeName(item)}`, o)
      }
    }
    return v as string[]
  }

  const strListOrNull = (o: Record<string, unknown>, key: string, where: string): string[] | null => {
    if (o[key] === null) return null
    return strList(o, key, where)
  }

  const objOrNull = (
    o: Record<string, unknown>,
    key: string,
    where: string,
  ): Record<string, unknown> | null => {
    if (o[key] === null) return null
    return object(o[key], at(where, key))
  }

  const objList = (
    o: Record<string, unknown>,
    key: string,
    where: string,
  ): Record<string, unknown>[] => {
    const v = array(o[key], at(where, key))
    return v.map((item, i) => object(item, `${at(where, key)}[${i}]`))
  }

  return {
    object,
    array,
    str,
    num,
    bool,
    numOrNull,
    strOrNull,
    strList,
    strListOrNull,
    objOrNull,
    objList,
    fail,
  }
}
