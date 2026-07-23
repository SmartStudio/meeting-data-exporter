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
  /** 目标卷剩余空间是否 ≥ bytes（下载前预检） */
  ensureFreeSpace(bytes: number): Promise<boolean>
}
