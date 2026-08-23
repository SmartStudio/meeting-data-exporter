import { loadConfig } from '../../config'
import { createGatewayClient } from '../../gateway/client'
import { splitWindow } from '@yaowu/mde-engine'
import type { ParsedCommand } from '../index'
import type { MeetingSelector } from '@yaowu/mde-engine'

/** list = 只调 gw.listMeetings 并打印，不写队列（预览用途，接受 range 或 code/id/target 任一） */
export async function cmdList(cmd: ParsedCommand, env: Record<string, string | undefined>): Promise<number> {
  const cfg = loadConfig(env, {}, { out: cmd.out })
  const now = () => Math.floor(Date.now() / 1000)
  const gw = createGatewayClient(cfg, { fetch, now })

  const sel = buildSelector(cmd)
  const windows = sel.kind === 'range' ? splitWindow(sel.from, sel.to) : [null]
  let total = 0
  for (const w of windows) {
    const s: MeetingSelector = w ? { kind: 'range', from: w.from, to: w.to } : sel
    let cursor: string | undefined
    do {
      const page = await gw.listMeetings(s, cursor)
      for (const m of page.meetings) {
        console.log(`${m.meetingId}\t${m.meetingCode ?? '-'}\t${m.subject ?? '-'}\tstart=${m.startTime ?? '-'}\tend=${m.endTime ?? '-'}`)
        total++
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }
  console.log(`total=${total}`)
  return 0
}

function buildSelector(cmd: ParsedCommand): MeetingSelector {
  if (cmd.code) return { kind: 'code', meetingCode: cmd.code, from: cmd.from, to: cmd.to }
  if (cmd.meetingId) return { kind: 'id', meetingId: cmd.meetingId, from: cmd.from, to: cmd.to }
  if (cmd.target) {
    // 纯数字视为会议号，否则视为会议 ID（与 get 的启发式一致）
    return /^\d+$/.test(cmd.target)
      ? { kind: 'code', meetingCode: cmd.target, from: cmd.from, to: cmd.to }
      : { kind: 'id', meetingId: cmd.target, from: cmd.from, to: cmd.to }
  }
  if (cmd.from !== undefined && cmd.to !== undefined) return { kind: 'range', from: cmd.from, to: cmd.to }
  throw new Error('list requires --from/--to, --code/--meeting-id, or a positional meeting code/id')
}
