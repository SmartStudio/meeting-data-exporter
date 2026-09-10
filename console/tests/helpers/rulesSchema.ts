/**
 * `GET /api/v1/admin/rules/schema` 的**真实响应**，逐字取自后端。
 *
 * 生成方式（阶段 5 · F9）：把 `src/policy/conds.ts` 的 `CONDITION_FIELDS` /
 * `OP_LABELS` / `COND_VALUE_TYPE` / `KEYWORD_SEPARATOR_SOURCE`、
 * `src/policy/stacks.ts` 的 `STACK_SCHEMA`、`src/domain/asset-labels.ts` 的
 * `ASSET_LABEL` 按 `handlers/console/rules.ts` 的 `rulesSchema` 拼一遍，
 * 打印出来贴在这里。**不是手抄的**。
 *
 * 放在 helpers 里是为了只有一份：三个测试文件（api 层、呈现层、页面）
 * 各贴一份的话，它们就是三份会各自漂的镜像——而这个任务干的正是删镜像的活。
 *
 * ⚠️ 它是**测试夹具**，不是运行时数据。`src/` 下任何一处出现这份清单的拷贝
 * 都是缺陷；这里出现是因为测试必须有一个假后端可以答话。
 */
import type { RulesSchema } from '../../src/api/admin/rules'

export const RULES_SCHEMA_BODY = {
  fields: [
    {
      f: 'title',
      label: '会议标题',
      available: true,
      unavailableReason: null,
      ops: [
        { op: 'has', label: '包含任一', unitSuffix: null },
        { op: 'nothas', label: '不包含', unitSuffix: null },
      ],
      value: {
        kind: 'keywords',
        type: 'string',
        multiple: true,
        options: null,
        unit: null,
        placeholder: '关键词，逗号分隔',
        splitPattern: '[,\\uFF0C\\s]+',
      },
    },
    {
      f: 'dept',
      label: '主持人部门',
      available: false,
      unavailableReason:
        '需要企业微信通讯录，尚未接入（企微自建应用没有真建，R0 已定为不做，见 spec §5.3）',
      ops: [
        { op: 'in', label: '属于', unitSuffix: null },
        { op: 'notin', label: '不属于', unitSuffix: null },
      ],
      value: {
        kind: 'strings',
        type: 'string',
        multiple: true,
        options: null,
        unit: null,
        placeholder: null,
        splitPattern: null,
      },
    },
    {
      f: 'host',
      label: '主持人',
      available: true,
      unavailableReason: null,
      ops: [
        { op: 'is', label: '是', unitSuffix: null },
        { op: 'isnot', label: '不是', unitSuffix: null },
      ],
      value: {
        kind: 'string',
        type: 'string',
        multiple: false,
        options: null,
        unit: null,
        placeholder: '用户 id',
        splitPattern: null,
      },
    },
    {
      f: 'dur',
      label: '会议时长',
      available: true,
      unavailableReason: null,
      ops: [
        { op: 'gt', label: '大于', unitSuffix: null },
        { op: 'lt', label: '小于', unitSuffix: null },
      ],
      value: {
        kind: 'number',
        type: 'number',
        multiple: false,
        options: null,
        unit: '分钟',
        placeholder: null,
        splitPattern: null,
      },
    },
    {
      f: 'age',
      label: '录制结束',
      available: true,
      unavailableReason: null,
      ops: [
        { op: 'within', label: '在最近', unitSuffix: '内' },
        { op: 'before', label: '早于', unitSuffix: null },
      ],
      value: {
        kind: 'number',
        type: 'number',
        multiple: false,
        options: null,
        unit: '天',
        placeholder: null,
        splitPattern: null,
      },
    },
    {
      f: 'arch',
      label: '归档状态',
      available: true,
      unavailableReason: null,
      ops: [
        { op: 'isarch', label: '已写入 NAS', unitSuffix: null },
        { op: 'notarch', label: '未归档', unitSuffix: null },
      ],
      value: {
        kind: 'none',
        type: 'none',
        multiple: false,
        options: null,
        unit: null,
        placeholder: null,
        splitPattern: null,
      },
    },
  ],
  joins: [
    { value: 'and', label: '全部满足' },
    { value: 'or', label: '任一满足' },
  ],
  stacks: [
    {
      kind: 'fetch',
      label: '拉取规则',
      effects: [
        {
          value: 'all',
          label: '拉取',
          hint: '把这场会议的资产拉回本系统。具体拉哪几类由资产类型决定',
          withAssetTypes: true,
        },
        {
          value: 'skip',
          label: '不拉取',
          hint: '本系统不持有副本。腾讯会议侧的保留期一到，这场会议就没有了',
          withAssetTypes: false,
        },
      ],
      freeform: null,
      fallback: { value: 'skip', label: '默认不拉取' },
      subjectType: null,
    },
    {
      kind: 'archive',
      label: '归档规则',
      effects: [
        {
          value: 'skip',
          label: '不归档',
          hint: '拉回来的副本只留在本地，不写进 NAS',
          withAssetTypes: false,
        },
      ],
      freeform:
        '除 skip 外，归档规则的 effect 是一段**归档目录模板**（例如 /nas/meetings/{yyyy}/{mm}），' +
        '不是一组固定取值。改目录不会搬迁已经归档过的文件——历史文件留在原路径，' +
        '只有之后新归档的会写到新目录。',
      fallback: { value: 'skip', label: '默认不归档' },
      subjectType: null,
    },
    {
      kind: 'allow',
      label: '采集权限规则',
      effects: [
        {
          value: 'allow',
          label: '准许采集',
          hint: '仍需在会议列表里授权给具体程序才真的能取走，两者是「与」的关系',
          withAssetTypes: true,
        },
        {
          value: 'deny',
          label: '禁止采集',
          hint: '照常拉取、照常归档进 NAS，但任何外部程序都取不到',
          withAssetTypes: false,
        },
      ],
      freeform: null,
      fallback: { value: 'deny', label: '默认拒绝' },
      subjectType: 'program',
    },
  ],
  assetTypes: [
    { value: 'video', label: '录像' },
    { value: 'audio', label: '音频' },
    { value: 'transcript', label: '逐字稿' },
    { value: 'ai_minutes', label: '纪要' },
    { value: 'chapters', label: '时间轴' },
  ],
  assetAll: '*',
}

/**
 * 同一份东西的**已解析形状**（`fetchRulesSchema()` 的产物）。
 * 呈现层的测试不发请求，直接吃这一个。
 */
export const RULES_SCHEMA = RULES_SCHEMA_BODY as unknown as RulesSchema
