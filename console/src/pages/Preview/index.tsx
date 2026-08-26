import { PageShell } from '@/ui/PageShell'

/**
 * 内容预览页（spec.md §4.4 · §2）。空壳——F6 往里填。
 *
 * 它不占左栏导航（spec §3），入口是会议记录页上的会议标题，所以路由带 `:id`。
 *
 * 两条已经定死的事：**章节数据这一轮拿不到**（阶段 4 的 T16 裁定
 * `content/chapters` 恒返回空 chapters + `source: 'none'`），时间轴 tab 的形态
 * 是"按转写时间戳切分"而不是"按章节"，界面上要说清，不要拿 cues 冒充章节；
 * 以及**管理员查看会议内容会留痕**，不要为了省一次请求把内容缓存起来复用——
 * 那会让留痕少一条，而留痕的价值恰恰在于完整。
 */
export default function PreviewPage() {
  return (
    <PageShell
      title="内容预览"
      description="纪要 / 时间轴 / 转写文字。管理员查看会议内容会留痕（spec §2）。本页的数据接线在 F6。"
    />
  )
}
