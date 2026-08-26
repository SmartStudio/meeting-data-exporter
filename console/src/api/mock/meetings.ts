import type { Meeting } from '../types'

/**
 * mock 里的"今天"固定为 2026-08-23（与原型一致），页面从它取时间基准。
 * 固定而不是取 `new Date()`，否则 `daysLeft` 会随真实日期漂移，
 * 截图和测试都对不上。
 */
export const MOCK_NOW = ts(2026, 8, 23, 15, 0)

/** 本地时区的 unix 秒。会议开始时间、历史事件时间都用它构造。 */
function ts(y: number, m: number, d: number, h = 0, mi = 0): number {
  return Math.floor(new Date(y, m - 1, d, h, mi).getTime() / 1000)
}

/**
 * 归档保留窗口的到期时间：从归档成功那一刻起，按日历日加 `keepDays * (1 + extended)`
 * 天——每延长一次多一个完整窗口。用 `Date` 的月末溢出自动进位（而不是原始 unix
 * 秒 + N*86400），避免夏令时环境下的整点漂移。
 */
function expiresAfter(archivedAtSec: number, extended: number, keepDays = 30): number {
  const d = new Date(archivedAtSec * 1000)
  return Math.floor(
    new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + keepDays * (1 + extended),
      d.getHours(),
      d.getMinutes(),
    ).getTime() / 1000,
  )
}

/**
 * 一场"资产全部拿到"的会议的资产分布：AI 纪要 / 完整转写 / 发言人纪要 /
 * 话题纪要 / AI 转写 / 会议摘要各出 txt·docx·pdf 三种格式（3 个文件），
 * 录像 1 个文件——合计 19，对应原型里那批 `assets:19, total:19` 的会议。
 * 音频（`audio`）这批会议没有单独导出，属于"该类不适用"，键直接不出现。
 */
const FULL_ASSETS: Meeting['assets'] = {
  video: { got: 1, total: 1 },
  transcript: { got: 3, total: 3 },
  ai_transcript: { got: 3, total: 3 },
  ai_minutes: { got: 3, total: 3 },
  ai_topic_minutes: { got: 3, total: 3 },
  ai_speaker_minutes: { got: 3, total: 3 },
  ai_ds_minutes: { got: 3, total: 3 },
}

/** 应有同 `FULL_ASSETS`，但一个都还没拿到——拉取被人工挡住 / 规则不执行。 */
const PENDING_ASSETS: Meeting['assets'] = {
  video: { got: 0, total: 1 },
  transcript: { got: 0, total: 3 },
  ai_transcript: { got: 0, total: 3 },
  ai_minutes: { got: 0, total: 3 },
  ai_topic_minutes: { got: 0, total: 3 },
  ai_speaker_minutes: { got: 0, total: 3 },
  ai_ds_minutes: { got: 0, total: 3 },
}

const m1ArchivedAt = ts(2026, 8, 21, 16, 31)
const m2ArchivedAt = ts(2026, 8, 20, 11, 20)
const m7ArchivedAt = ts(2026, 7, 31, 18, 2)
const m9ArchivedAt = ts(2026, 7, 20, 11, 50)
const m6ArchivedAt = ts(2026, 8, 22, 15, 10)
const m8ArchivedAt = ts(2026, 7, 14, 11, 40)

/**
 * 9 场手写会议，迁自 `docs/console/prototype/gate-console.html` 的
 * `MEETINGS`（只取手写的那 9 条，跳过后面为分页量凑数的 15 条生成记录——
 * F1 阶段不需要分页）。展示串已换算成 API 形状：`when`→`startAt`
 * （unix 秒）、`dur`→`durationSec`（秒）、`size`→`sizeBytes`（字节）、
 * `keep.archivedOn`/`expiresOn`→`keep.archivedAt`/`expiresAt`（unix 秒，
 * `expiresAt` 由 `expiresAfter` 算出而非手抄）、`daysLeft` 整个字段删掉——
 * 改由 `lib/format.ts` 的 `daysLeft(expiresAt, now)` 现算。
 * `grants` 从原型里的采集程序中文名换成 `consumers.ts` 里对应的 id。
 */
export const MEETINGS: Meeting[] = [
  {
    id: 'm1',
    title: '产品周会',
    code: '881-123-40',
    startAt: ts(2026, 8, 21, 14, 0),
    durationSec: 6720, // 1:52
    host: '邹研发',
    assets: FULL_ASSETS,
    fetch: 'done',
    archive: 'done',
    allow: 'allow',
    grants: ['kb-indexer', 'daily-digest'],
    hand: [],
    keep: { archivedAt: m1ArchivedAt, expiresAt: expiresAfter(m1ArchivedAt, 0), extended: 0, filesGone: false },
    nasPath: '/nas/meetings/2026/08/88112340-产品周会/',
    sizeBytes: 23907140, // 22.8 MB
    why: {
      fetch: { by: 'rule', text: '拉取规则 #100「录制结束在近 90 天内 → 拉取全部八类资产」' },
      archive: { by: 'rule', text: '归档规则 #210，已成功写入 NAS 并校验哈希' },
      allow: { by: 'rule', text: '权限规则 #300「标题含「周会」且已归档 → 准许采集」' },
    },
    history: [
      { at: ts(2026, 8, 23, 14, 2), text: '知识库索引器 取用了 AI 纪要' },
      { at: ts(2026, 8, 21, 16, 31), text: '归档成功，19 个文件，22.8 MB' },
      { at: ts(2026, 8, 21, 16, 12), text: '拉取完成，19/19' },
    ],
  },
  {
    id: 'm2',
    title: '技术评审 · 网关升级',
    code: '881-130-05',
    startAt: ts(2026, 8, 20, 10, 0),
    durationSec: 2820, // 0:47
    host: '邹研发',
    assets: FULL_ASSETS,
    fetch: 'done',
    archive: 'done',
    allow: 'allow',
    grants: [],
    hand: [],
    keep: { archivedAt: m2ArchivedAt, expiresAt: expiresAfter(m2ArchivedAt, 0), extended: 0, filesGone: false },
    nasPath: '/nas/meetings/2026/08/88113005-技术评审/',
    sizeBytes: 11953766, // 11.4 MB
    why: {
      fetch: { by: 'rule', text: '拉取规则 #100' },
      archive: { by: 'rule', text: '归档规则 #210，已成功写入 NAS' },
      allow: { by: 'rule', text: '权限规则允许采集，但还没有授权给任何程序——外部现在取不到。' },
    },
    history: [
      { at: ts(2026, 8, 22, 9, 15), text: '知识库索引器 尝试取用完整转写，被拒绝：未授权' },
      { at: ts(2026, 8, 20, 11, 20), text: '归档成功，11.4 MB' },
    ],
  },
  {
    id: 'm7',
    title: '全员大会 · Q3 复盘',
    code: '881-099-22',
    startAt: ts(2026, 7, 31, 16, 0),
    durationSec: 5460, // 1:31
    host: '王总',
    assets: FULL_ASSETS,
    fetch: 'done',
    archive: 'done',
    allow: 'allow',
    grants: ['daily-digest'],
    hand: [],
    keep: { archivedAt: m7ArchivedAt, expiresAt: expiresAfter(m7ArchivedAt, 0), extended: 0, filesGone: false },
    nasPath: '/nas/meetings/2026/07/88109922-全员大会/',
    sizeBytes: 32715571, // 31.2 MB
    why: {
      fetch: { by: 'rule', text: '拉取规则 #100' },
      archive: { by: 'rule', text: '归档规则 #210，已成功写入 NAS' },
      allow: { by: 'rule', text: '权限规则 #310「标题含「大会」且已归档 → 准许采集」' },
    },
    history: [
      { at: ts(2026, 8, 23, 13, 44), text: '简报机器人 取用了 AI 纪要' },
      { at: ts(2026, 7, 31, 18, 2), text: '归档成功，31.2 MB' },
    ],
  },
  {
    id: 'm9',
    title: '上季度经营复盘',
    code: '881-077-14',
    startAt: ts(2026, 7, 20, 9, 30),
    durationSec: 7440, // 2:04
    host: '王总',
    assets: FULL_ASSETS,
    fetch: 'done',
    archive: 'done',
    allow: 'allow',
    grants: ['dw-sync'],
    hand: [],
    // 被延长过一次（extended:1）：到期时间是从归档时刻起的两个完整保留窗口。
    keep: { archivedAt: m9ArchivedAt, expiresAt: expiresAfter(m9ArchivedAt, 1), extended: 1, filesGone: false },
    nasPath: '/nas/meetings/2026/07/88107714-上季度经营复盘/',
    sizeBytes: 42677043, // 40.7 MB
    why: {
      fetch: { by: 'rule', text: '拉取规则 #100' },
      archive: { by: 'rule', text: '归档规则 #210，已成功写入 NAS' },
      allow: { by: 'rule', text: '权限规则 #320 准许采集' },
    },
    history: [
      { at: ts(2026, 8, 23, 11, 20), text: '陈运维 延长保留 30 天，到期日改为 9 月 18 日' },
      { at: ts(2026, 8, 18, 9, 4), text: '到期前 7 天提醒：数据仓库同步 尚未取走' },
      { at: ts(2026, 7, 20, 11, 50), text: '归档成功，40.7 MB' },
    ],
  },
  {
    id: 'm6',
    title: '招聘面试 · 后端 P7',
    code: '881-161-19',
    startAt: ts(2026, 8, 22, 14, 0),
    durationSec: 3480, // 0:58
    host: '周HR',
    assets: FULL_ASSETS,
    fetch: 'done',
    archive: 'done',
    allow: 'deny',
    grants: [],
    hand: [],
    keep: { archivedAt: m6ArchivedAt, expiresAt: expiresAfter(m6ArchivedAt, 0), extended: 0, filesGone: false },
    nasPath: '/nas/meetings-hr/2026/08/88116119-招聘面试/',
    sizeBytes: 16043213, // 15.3 MB
    why: {
      fetch: { by: 'rule', text: '拉取规则 #100' },
      archive: { by: 'rule', text: '归档规则 #205，已成功写入 NAS（人事目录）' },
      allow: {
        by: 'deny',
        text: '权限规则 #350「标题含「面试」「薪酬」「绩效」→ 禁止采集」。已归档进 NAS，但任何程序都取不到。',
      },
    },
    history: [
      { at: ts(2026, 8, 22, 15, 10), text: '归档成功，15.3 MB' },
      { at: ts(2026, 8, 22, 15, 2), text: '拉取完成，19/19' },
      { at: ts(2026, 8, 22, 15, 2), text: '权限规则 #350 判定：禁止采集' },
    ],
  },
  {
    id: 'm3',
    title: '客户沟通 · 华东区',
    code: '881-140-88',
    startAt: ts(2026, 8, 23, 9, 30),
    durationSec: 7980, // 2:13
    host: '李销售',
    // 7/19：录像、完整转写、AI 转写已拿到，四类"纪要"衍生品仍在生成中。
    assets: {
      video: { got: 1, total: 1 },
      transcript: { got: 3, total: 3 },
      ai_transcript: { got: 3, total: 3 },
      ai_minutes: { got: 0, total: 3 },
      ai_topic_minutes: { got: 0, total: 3 },
      ai_speaker_minutes: { got: 0, total: 3 },
      ai_ds_minutes: { got: 0, total: 3 },
    },
    fetch: 'running',
    archive: 'failed',
    allow: 'allow',
    grants: [],
    hand: [],
    keep: { archivedAt: null, expiresAt: null, extended: 0, filesGone: false },
    nasPath: null,
    sizeBytes: null,
    why: {
      fetch: { by: 'rule', text: '拉取规则 #100 命中。进行中：7/19 完成，AI 纪要仍在腾讯会议侧生成。' },
      archive: {
        by: 'fail',
        text: '归档失败：NAS 写入超时（30 秒）。已重试 2/5 次，15:00 自动重试。归档不成功，本地到期后这场会议就永久没有了。',
      },
      allow: { by: 'wait', text: '尚未归档，保留期还没开始计时。' },
    },
    history: [
      { at: ts(2026, 8, 23, 14, 4), text: '归档失败：NAS 写入超时' },
      { at: ts(2026, 8, 23, 12, 4), text: '拉取进行中，7/19' },
      { at: ts(2026, 8, 23, 11, 58), text: '检测到转码完成，已入队' },
    ],
  },
  {
    id: 'm8',
    title: '财务复盘 · 7 月',
    code: '881-108-71',
    startAt: ts(2026, 7, 14, 10, 0),
    durationSec: 4320, // 1:12
    host: '赵财务',
    assets: FULL_ASSETS,
    fetch: 'done',
    archive: 'done',
    allow: 'allow',
    // 授权行还在（它的历史里那次「被拒绝：本地已到期」正是这条授权发起的），
    // 只是本地文件没了所以取不到——采集清单页那条「已授权但现在取不到」就是它。
    grants: ['dw-sync'],
    hand: [],
    // 已过期：archivedAt/expiresAt 仍保留（历史事实不清零），filesGone 为真。
    keep: { archivedAt: m8ArchivedAt, expiresAt: expiresAfter(m8ArchivedAt, 0), extended: 0, filesGone: true },
    nasPath: '/nas/meetings-finance/2026/88110871-财务复盘/',
    sizeBytes: 19818086, // 18.9 MB
    why: {
      fetch: { by: 'rule', text: '拉取规则 #100' },
      archive: { by: 'rule', text: '归档规则 #200「主持人属于「财务部」→ 归档到财务独立目录」' },
      allow: {
        by: 'expired',
        text: '保留期已于 8 月 13 日结束，本地文件已在 8 月 23 日凌晨清理。授权自动失效，请到 NAS 取。',
      },
    },
    history: [
      { at: ts(2026, 8, 23, 13, 41), text: '数据仓库同步 尝试取用录制视频，被拒绝：本地已到期' },
      { at: ts(2026, 8, 23, 3, 0), text: '到期清理：本地文件已删除，记录保留' },
      { at: ts(2026, 7, 14, 11, 40), text: '归档成功，18.9 MB' },
    ],
  },
  {
    id: 'm4',
    title: '董事会闭门会',
    code: '881-100-01',
    startAt: ts(2026, 8, 19, 15, 0),
    durationSec: 3900, // 1:05
    host: '王总',
    assets: PENDING_ASSETS,
    fetch: 'blocked',
    archive: 'blocked',
    allow: 'deny',
    grants: [],
    hand: ['fetch'],
    keep: { archivedAt: null, expiresAt: null, extended: 0, filesGone: false },
    nasPath: null,
    sizeBytes: null,
    why: {
      fetch: { by: 'hand', text: '陈运维 于 8 月 19 日手动设为「永不拉取」。理由：董事会决议，录制不出腾讯会议侧。' },
      archive: { by: 'wait', text: '未拉取，无从归档。' },
      allow: { by: 'wait', text: '未拉取，无从授权。' },
    },
    history: [
      { at: ts(2026, 8, 19, 16, 40), text: '陈运维 手动设为「永不拉取」' },
      { at: ts(2026, 8, 19, 16, 38), text: '人工改写「永不拉取」生效，未进入队列' },
    ],
  },
  {
    id: 'm5',
    title: '销售晨会',
    code: '881-155-72',
    startAt: ts(2026, 8, 23, 9, 0),
    durationSec: 720, // 0:12
    host: '李销售',
    // 没有产生录制，八类资产都不适用——空对象。
    assets: {},
    fetch: 'none',
    // 没有录制、无从归档，用 'none'——跟 'off'（归档规则不执行，是规则做出的决定）
    // 含义不同，不能互相顶替：这场会议压根没有规则参与判断。原型确实有
    // archive:'none' 这个取值（gate-console.html 的 STAGE_LABEL.none = '无录制'，
    // 该 map 是 fetch/archive 两阶段共用的），是 spec.md §6.1 的类型声明漏收了它。
    archive: 'none',
    allow: 'deny',
    grants: [],
    hand: [],
    keep: { archivedAt: null, expiresAt: null, extended: 0, filesGone: false },
    nasPath: null,
    sizeBytes: null,
    why: {
      fetch: { by: 'na', text: '这场会议没有开启录制，没有任何资产可拉取。' },
      archive: { by: 'na', text: '没有资产。' },
      allow: { by: 'na', text: '没有资产。' },
    },
    history: [{ at: ts(2026, 8, 23, 9, 14), text: '会议结束，未产生录制' }],
  },
]
