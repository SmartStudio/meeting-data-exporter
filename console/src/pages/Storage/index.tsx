import { PageShell } from '@/ui/PageShell'

/**
 * 归档存储页（spec.md §4.9）。空壳——F5b 往里填。
 *
 * 这一页是 `nas-down` 的来源，也是系统状态条上「暂停到期清理」那个动作的归宿：
 * 状态条现在把人带到这里（`POST /api/v1/admin/storage/cleanup-pause` 归 F5b），
 * 所以 F5b 要把这个动作做出来，否则那条链就断在这一页。
 *
 * 另外两件写死的事：`nas.failedMeetings` 这一轮恒为 null（A8 才接上
 * `job_failures`），照 `failedMeetingsNote` 显示"暂不可得"，不要编一个数；
 * 页面底部那段"到期只删本地文件、数据库记录永久保留"必须留着。
 */
export default function StoragePage() {
  return (
    <PageShell
      title="归档存储"
      description="NAS 归档与本地保留窗口：到期只删本地文件，数据库记录永久保留。本页的数据接线在 F5b。"
    />
  )
}
