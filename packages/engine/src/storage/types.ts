export interface Storage {
  /** 返回 <relPath>.part 的实际字节数（不存在则 0）——续传的事实源 */
  writtenSize(relPath: string): Promise<number>
  /** 读回 <relPath>.part 全量内容（文本类算 content_hash 用） */
  readPart(relPath: string): Promise<ArrayBuffer>
  /** 从 offset 处向 <relPath>.part 追加；返回追加后总字节数 */
  appendChunk(relPath: string, offset: number, chunk: Uint8Array): Promise<number>
  /** 原子 rename <relPath>.part → <relPath>（内容完整的标志） */
  finalize(relPath: string): Promise<void>
  /** 删除 <relPath>.part（416/200 时重下） */
  discardPart(relPath: string): Promise<void>
  /** 写元数据文件（meeting.json / _manifest.json），直接落正式名 */
  writeMeta(relPath: string, data: unknown): Promise<void>
  /**
   * 读回 `writeMeta` 写下的元数据文件；**文件不存在返回 `null`**。
   *
   * 三种结局必须分得清：读到了 / 确实没有（null）/ 读不了（抛）。第三种绝不许
   * 伪装成第二种——「读不了」被当成「没有」的话，一份内容已经不对的清单会被无声
   * 覆盖，或者反过来，一个读不动的目录永远没人知道。调用方据此决定要不要重写
   * （见 manifest/index.ts 的 alreadyOnDisk）。
   */
  readMeta(relPath: string): Promise<unknown>
  /** 目标卷剩余空间是否 ≥ bytes（下载前预检） */
  ensureFreeSpace(bytes: number): Promise<boolean>
}
