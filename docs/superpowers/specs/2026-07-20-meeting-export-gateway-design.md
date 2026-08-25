# 会议导出网关设计（meeting-data-exporter 子项目 1）

- 日期：2026-07-20
- 状态：待评审
- 所属：yaowu-ai / meeting-data-exporter
- 范围：本文档只定义**子项目 1（导出网关服务端）**。其余子项目的设计以附录形式记录，供后续各自展开。

---

## 1. 背景与目标

把腾讯会议企业版的会议资产（录制视频、音频、逐字稿、AI 纪要）完整、可重复、可管控地导出到企业自有存储。

最终产品形态为**桌面应用 + CLI 双前端**，由企业统一部署的网关服务提供数据与管控能力。

### 1.1 核心需求（来自需求澄清）

| 需求 | 说明 |
| --- | --- |
| 导出会议录制视频 | 主资产 |
| 导出 AI 智能纪要 | 腾讯会议纪要总结 |
| 导出逐字稿 | 录制转写 |
| 管理员管控 | 由企业管理员控制哪些数据可被导出，需支持策略与规则 |
| 任务与进度记录 | 本地数据库记录导出数据与任务进度 |
| 解决重复导出 | 幂等，已导出的不重复拉取 |
| 可配置导出目标 | 阿里云 OSS、公司本地 NAS<sup>[1]</sup> |
| Bun 运行时内嵌 | 桌面应用无需用户单独安装 Bun 及依赖 |
| 双平台安装包 | macOS 与 Windows |

### 1.2 明确排除（YAGNI）

- **时间轴资产**：需求澄清中确认去掉。腾讯会议 API 无对应资产类型。
- **多会议平台支持**：只做腾讯会议企业版，不做飞书 / Zoom / 钉钉抽象层。
- **OAuth2 第三方应用模式**：只做企业自建应用（AK/SK）。两种模式并非「多传一个 header」的差别——依 [第三方应用鉴权](https://cloud.tencent.com/document/product/1095/51257)，OAuth 的公共参数是 `AccessToken` + `OpenId`，**完全没有 `X-TC-Signature`**，即不做签名；操作者标识也从 `userid` 变为 `open_id`（以应用为维度隔离，与企业 `userid` 不互通）。将来若要支持双模式，需要的是两套凭证提供者与两套身份映射，而非条件分支。
- **`查询录制转写详情`(65111) 与 `转写段落信息`(65115)**：不接入，因此不提供带时间戳的结构化逐字稿。

---

## 2. 子项目分解

需求包含多个可独立交付的子系统，拆分如下。每个子项目各自走 spec → plan → 实现循环。

```
子项目 1  导出网关服务端            ← 本文档
          AK/SK 签名 · STS-Token 生命周期 · 策略引擎
          · 客户端认证 · 限流 · 审计

子项目 2  核心导出引擎（客户端）
          经网关取清单 · 断点续传下载 · SQLite 任务库 · 去重 · 最小 CLI
          （设计已完成，见附录 A）

子项目 3  存储目标扩展
          阿里云 OSS · NAS（SMB）适配器

子项目 4  桌面应用
          Bun 运行时内嵌 · Mac / Windows 安装包
```

**顺序理由**：STS-Token 只能通过 Webhook 回调下发到公网 URL（见 §3.3），本地客户端无法独立获取，因此网关是所有 AI 纪要能力的前置条件。同时 AK/SK 不能下发到客户端（见 §4.1），网关也是安全模型的前置条件。

---

## 3. 平台契约（已核实）

以下均来自腾讯云官方文档，非推测。实现时以文档为准。

### 3.1 涉及的接口

| 接口 | 路径 | STS-Token | 用途 |
| --- | --- | --- | --- |
| [查询会议录制列表](https://cloud.tencent.com/document/product/1095/51189) | `GET /v1/records` | 不需要 | 发现会议与录制 |
| [查询会议录制地址](https://cloud.tencent.com/document/product/1095/51174) | `GET /v1/addresses` | 不需要 | 取视频/音频/原始转写地址 |
| [查询单个录制详情](https://cloud.tencent.com/document/product/1095/51180) | `GET /v1/addresses/{record_file_id}` | **强制要求** | 取全部 AI 纪要 |
| [STS Token 生成](https://cloud.tencent.com/document/product/1095/127650) | `POST /v1/app/sts-token` | 不需要 | 触发 Token 生成 |

### 3.2 资产类型（八类）

来自 `GET /v1/addresses/{record_file_id}` 响应：

| 字段 | 内容 | 格式 | 免 STS-Token 可得 |
| --- | --- | --- | --- |
| `download_address` | 录制视频 | mp4 | 是（经 51174） |
| `audio_address` | 录制音频 | m4a | 是（经 51174） |
| `meeting_summary` | 录制转写（原始，即逐字稿） | txt / pdf / docx | 是（经 51174） |
| `ai_meeting_transcripts` | 录制转写（智能优化版） | txt / pdf / docx | 否 |
| `ai_minutes` | 混元 — 章节纪要 | txt / pdf / docx | 否 |
| `ai_topic_minutes` | 混元 — 主题纪要 | htm | 否 |
| `ai_speaker_minutes` | 混元 — 发言人纪要 | htm | 否 |
| `ai_ds_minutes` | DeepSeek — 纪要 | htm | 否 |

`asset_type` 在实现中**从响应字段名派生**，不硬编码为封闭联合类型。腾讯随时可能新增纪要引擎（现已有混元与 DeepSeek 两套），字段名驱动可让新增引擎无需改代码。

### 3.3 关键约束

| 约束 | 事实 | 影响 |
| --- | --- | --- |
| 下载链接时效 | `/v1/addresses` 默认 **6 小时**；`/v1/addresses/{id}` 仅 **5 分钟** | 换链续传是主干流程，非边界优化 |
| 查询时间窗口 | `/v1/records` 区间**不得超过 31 天** | 必须切分窗口循环查询 |
| 分页大小 | `/v1/records` 默认 10、**最大 20**；`/v1/addresses` 默认/最大 50 | API 调用量大，限流器必需 |
| 转码状态 | `RecordMeeting.state`：1 录制中 / 2 转码中 / **3 转码完成**。仅 state=3 返回录制文件列表 | 用状态驱动等待，替代盲目探测 |
| 下载许可 | `RecordFile.allow_download=false` 时，全部 `ai_*` 字段返回空 | 可即时判定，无需超时等待 |
| 时间戳单位 | 查询参数为**秒**；`media_start_time` / `record_*_time` 为**毫秒**；`record_info.start_time` 为字符串型毫秒，时区 UTC+8 | 网关出口统一为秒 + 显式时区 |
| 签名时效 | `X-TC-Timestamp` 与服务器相差 >5 分钟即签名过期 | 需监控时钟偏移 |
| Nonce 重放 | `X-TC-Nonce` 五分钟内不可重复 | 重试必须重新签名 |

### 3.4 接入环境

| 项 | 值 |
| --- | --- |
| Host | `api.meeting.qq.com` |
| 协议 | HTTPS |
| 基础路径 | `/v1` |
| Content-Type | `application/json`（请求与响应） |
| 网关版本 | 2.4.2 |

**账号版本是硬前提**。依 [前提条件](https://cloud.tencent.com/document/product/1095/42407) 的能力梯度表：

| 账号版本 | REST API 调用能力 |
| --- | --- |
| 免费版（个人 / 组织） | **不支持调用** |
| 专业版（个人 / 组织） | **不支持调用** |
| 商业版 | 支持（同账号能力） |
| 企业版 / 教育版 / 教育加强版 | 支持（同账号能力） |

购买商业版、教育版或企业版会**自动开通企业自建应用的接入能力**。本项目按企业版设计。若目标企业为免费版或专业版，项目在技术上无法成立——这一点须在启动实现前确认。

### 3.5 操作者标识

所有录制相关接口均要求 `operator_id` + `operator_id_type` 配对传入。

[基本概念](https://cloud.tencent.com/document/product/1095/79796) 定义了 5 种类型，但**录制接口（51189 / 51174 / 51180）仅支持前 3 种**：

| 值 | 类型 | 录制接口支持 |
| --- | --- | --- |
| 1 | `userid` | 支持 ← **本项目使用** |
| 2 | `open_id` | 支持（OAuth 场景） |
| 3 | `rooms_id` | 支持 |
| 4 | `ms_open_id` | 不支持 |
| 5 | `meeting_room_id` | 不支持 |

`userid` 为企业内用户唯一 ID，以企业为维度隔离，来源为企业 SSO 的员工唯一标识，或调用创建用户接口时传入的 `userid`。

网关使用固定的 operator 账号（见 §6），该账号须为超级管理员/管理员，或具备企业录制管理权限。

### 3.6 AK/SK 签名算法

```
headerString = "X-TC-Key=" + secretId
             + "&X-TC-Nonce=" + nonce
             + "&X-TC-Timestamp=" + timestamp

stringToSign = HTTPMethod   + "\n"      // GET / POST
             + headerString + "\n"
             + requestUri   + "\n"      // 含完整查询串
             + requestBody              // GET 传空串 ""

signature    = Base64( lowerHex( HmacSHA256(secretKey, stringToSign) ) )
```

必需请求头：

| Header | 值 |
| --- | --- |
| `Content-Type` | `application/json`（GET 也必须携带） |
| `X-TC-Key` | SecretId |
| `X-TC-Timestamp` | 秒级时间戳 |
| `X-TC-Nonce` | 随机正整数 |
| `X-TC-Signature` | 上述签名 |
| `AppId` | 企业 ID |
| `SdkId` | 应用 ID（后台已分配则必填） |
| `X-TC-Registered` | 固定 `"1"` |
| `STS-Token` | 仅数据敏感接口 |

**四个易错点**（实现时须显式覆盖测试）：

1. **双重编码**：HMAC-SHA256 结果先转**小写十六进制字符串**，再对该字符串做 Base64。不是 `base64(hmacBytes)`。
2. **URI 逐字节一致**：参与签名的 URI 含完整查询串，必须与实际请求 URL 完全一致。查询串拼接与签名须由同一段代码产出，不可各拼一次。
3. **URL 编码先于签名**：query 参数中的特殊字符（`?` `+` `=` 等）必须先 urlencode，**再**参与签名计算。例如 `userid=123+123` 须编码为 `userid=123%2B123`，签名与实际请求都用编码后的形式。顺序反了会导致签名恒不匹配，且错误信息（`190301` / `9042`）不会指向真正原因。
4. **重试必须重新签名**：时间戳与 nonce 均需重新生成，否则触发 `190301`。

实现约束：请求 URL 的构造必须**只有一个出口函数**，返回 `{ url, uriForSigning }` 两个值且保证二者的查询串部分完全相同。签名器只接受该函数的输出，不接受手工拼接的字符串。

### 3.7 STS-Token 流程

```
POST /v1/app/sts-token { operator_id, operator_id_type: 1, valid_time: 6|12|24 }
        ↓ 返回 { req_id }（不含 token）
   Token 内容经 Webhook 推送至企管后台配置的公网 URL
```

回调载荷（[事件 `common.sts-token`](https://cloud.tencent.com/document/product/1095/127651)）：

```json
{
  "event": "common.sts-token",
  "trace_id": "e7aa65dd-f7e6-4b62-912c-2035173b34a9",
  "payload": [{
    "operate_time": 1609313201465,
    "operator": { "userid": "tester", "user_name": "tester_name" },
    "token_info": { "req_id": "11122233", "sts_token": "1123344", "expire_ts": 111111 }
  }]
}
```

`req_id` 是异步流程的关联键，用于将回调与发起请求配对。

### 3.8 Webhook 安全

依据[配置事件订阅](https://cloud.tencent.com/document/product/1095/51605)，两层保护均需启用：

- **Token 验签**（25 位英文数字）：腾讯用它对消息算签名，网关用同算法重算比对。签名不一致即拒绝。回调 URL 公开可达，**不验签等于允许任何人投递伪造 STS-Token**。
- **EncodingAESKey 加密**：文档标注「建议配置」，对本项目为**必须**——STS-Token 是高敏凭证，不接受明文过公网。

具体加解密算法见[事件加解密](https://cloud.tencent.com/document/product/1095/54658)，实现时按该文档落地。

---

## 4. 架构

### 4.1 为什么是网关而非 Token 分发器

AK/SK **不能下发到客户端**。文档明确 AK/SK 应用「可访问您账户内的腾讯会议所有 API 接口」，包含删除用户、**删除会议录制**。分发到数十上百台员工终端的凭证，只要泄露一次即可删光全公司录制。客户端持有的密钥终究可被提取，混淆与加密存储只提高成本，不改变性质。

同时，**策略管控只有在客户端够不到原始 API 时才成立**。若客户端可直连腾讯 API，任何人都能绕过策略引擎。

### 4.2 控制平面与数据平面分离

```
┌────────────────┐        ┌──────────────────────────┐       ┌──────────────┐
│  CLI / 桌面端   │        │   导出网关（阿里云部署）    │       │  腾讯会议 API  │
│                │        │                          │       │              │
│  · 无 SecretKey │ ─────► │  · 持有 AK/SK，负责签名    │ ────► │  /v1/records │
│  · 任务队列     │  内部   │  · STS-Token 自动续期     │       │  /v1/addresses│
│  · 断点续传     │  凭证   │  · 策略引擎（强制执行）    │       │              │
│  · 落盘/NAS/OSS │        │  · 限流收敛 + 审计日志     │       └──────────────┘
└───────┬────────┘        └──────────────────────────┘
        │                              │
        │      返回临时下载地址          │
        │◄─────────────────────────────┘
        │
        └──────────► 对象存储直连下载（大文件不经过网关）
```

控制平面（鉴权、策略、清单）低流量走网关；数据平面（字节搬运）高流量客户端直连对象存储。网关因此可以是一台小规格机器，不会成为带宽瓶颈或单点。

### 4.3 网关模块边界

依赖只允许自上而下：

```
              ┌──────────────────────┐
              │      http (路由层)    │  客户端 API + Webhook 端点
              └──────────┬───────────┘
        ┌────────────────┼────────────────┐
        │                │                │
  ┌─────┴─────┐   ┌──────┴──────┐   ┌─────┴──────┐
  │   auth    │   │   catalog   │   │   policy   │
  │ 企微/服务号 │   │ 会议与资产清单 │   │  策略判定   │
  └─────┬─────┘   └──────┬──────┘   └─────┬──────┘
        │                │                │
        │        ┌───────┴────────┐       │
        │        │  tencent-api   │       │  签名 · 分页 · 31天切分
        │        │                │       │  限流 · 重试 · 单位归一
        │        └───────┬────────┘       │
        │                │                │
        │        ┌───────┴────────┐       │
        │        │  sts-token     │       │  申请 · 回调配对 · 续期
        │        └───────┬────────┘       │
        │                │                │
   ┌────┴────────────────┴────────────────┴────┐
   │                  store                    │  持久化
   └────────────────────┬──────────────────────┘
                        │
   ┌────────────────────┴──────────────────────┐
   │                  domain                   │  纯类型，零依赖
   └───────────────────────────────────────────┘
```

`domain` 不 import 任何东西，可被客户端项目复用。`tencent-api` 吸收全部平台细节，对上只暴露领域对象。

---

## 5. 网关详细设计

### 5.1 技术栈

- 运行时：Bun + TypeScript（与子项目 4 的 Bun 内嵌要求一致，且组织现有 TS 栈统一）
- 数据库：**MySQL ≥ 5.7**（推荐 8.0，阿里云 RDS），驱动 `mysql2/promise`。网关是多实例可扩展的服务端组件，需要网络数据库；客户端侧才用 SQLite。
  - 字符集强制 `utf8mb4` + `utf8mb4_unicode_ci`。会议主题含中文与 emoji，3 字节 utf8 会插入失败。
  - 不使用 8.0 独有语法（CTE、窗口函数、`RETURNING`），保持 5.7 兼容。
- 部署：阿里云，Docker 镜像

### 5.2 对客户端的 API 契约

这是本子项目最重要的产出，子项目 2 完全依赖它。

```
POST /api/v1/auth/device/code           发起登录，返回 user_code 与验证地址
POST /api/v1/auth/device/token          轮询换取访问令牌（授权完成前返回 pending）
GET  /auth/wecom/callback               企微授权回调（浏览器访问，非客户端调用）
POST /api/v1/auth/refresh               刷新令牌换新的访问令牌
POST /api/v1/auth/service-token         服务账号凭证换取访问令牌
POST /api/v1/auth/logout                主动登出，吊销刷新令牌

GET  /api/v1/meetings                   列出可导出会议（已过策略过滤）
     ?from=<unix秒>&to=<unix秒>          时间范围，缺省为最近 31 天
     &meeting_code=<会议号>              可选，按会议号过滤（非唯一，可能多条）
     &meeting_id=<会议ID>                可选，按会议 ID 过滤
     &cursor=<游标>&limit=<1..100>

GET  /api/v1/meetings/{meeting_id}      单场会议详情（含资产清单）
     ?from=&to=                          可选，缺省最近 31 天，见下方约束

GET  /api/v1/meetings/{meeting_id}/assets
                                        列出该会议资产清单（已过策略过滤）

POST /api/v1/assets/{asset_id}/download-url
                                        换取临时下载地址（策略强制校验 + 审计）
```

设计要点：

- **网关吸收全部平台细节**：31 天切分、`page_size≤20` 分页、限流、时间戳单位归一、AK/SK 签名、STS-Token 注入，客户端一概不可见。
- **对外统一游标分页**，不暴露腾讯的 page/page_size 语义。
- **时间一律 Unix 秒 + UTC**，不传毫秒，不传本地时间。
- `download-url` 响应包含 `url`、`expires_at`、`file_type`、`bytes_expected`（若平台提供）。

#### 定点查询的约束

平台侧 `GET /v1/records` 的 `start_time` / `end_time` 为**必填**，`meeting_id` / `meeting_code` 仅为补充过滤条件。而 51174 需要 `meeting_record_id`、51180 需要 `record_file_id`，二者均只能从列表接口取得。

**因此不存在「仅凭会议 ID 直接查询」的路径**，时间窗口无法绕过。网关据此约定：

| 情况 | 网关行为 |
| --- | --- |
| 客户端未传 `from` / `to` | 默认取**最近 31 天**（正好是单次查询上限，不触发切分） |
| 客户端传了范围 | 按传入范围查，超过 31 天时自动切分 |
| 指定 ID 但在范围内未找到 | 返回明确错误：`meeting_not_found_in_range`，提示可扩大时间范围重试 |

最后一条尤其重要：会议不在默认窗口内是**最常见的失败场景**（用户想导三个月前的会议）。错误信息必须指出真实原因与解法，而不是笼统的「未找到」——否则用户会以为会议不存在或自己没权限。

#### 会议号非唯一

`meeting_code` 是会议的呼入号码，平台文档明确标注其为**非唯一标识**：周期性会议的各次实例、以及号码复用都会造成一个 code 对应多场会议。

按 `meeting_code` 查询时，网关**返回全部匹配项**而非猜测其一，由客户端展示给用户选择。响应中附带主题、起止时间、主持人，使用户足以辨认。

### 5.3 STS-Token 生命周期

回调是异步的，**不能等到过期才申请**——需要凭证的那一刻无法同步取得它。

```
定时检查（剩余有效期 < 1/3 时触发）
   → POST /v1/app/sts-token { valid_time: 24 }
   → 得到 req_id，写入 sts_token_requests 状态 pending
   → 等待 Webhook：验签 → 解密 → 按 req_id 配对
   → 新 Token 落库，原子切换为当前生效
   → 旧 Token 在其自身过期前仍可用（双 Token 并存）
```

失败处理：若在旧 Token 过期前未收到回调，重新发起申请并告警。所有依赖 STS-Token 的请求在无有效 Token 时返回明确错误码，而非静默失败。

### 5.4 业务用户认证

两条轨道：

| 轨道 | 用途 | 身份来源 |
| --- | --- | --- |
| **设备授权流程 + 企微扫码** | 真人使用桌面端 / CLI | 企业微信 |
| **服务账号令牌** | 无人值守定时归档 | 管理员在网关签发 |

#### 5.4.1 为什么桌面端与 CLI 统一走设备授权流程

CLI 没有浏览器，无法承接 OAuth 的重定向回调——这是必须先解决的实际问题。可选方案有三：

| 方案 | 问题 |
| --- | --- |
| CLI 起本地回调服务器（`localhost:PORT`） | 端口占用、企业防火墙拦截、无头服务器上无浏览器可跳转 |
| 自定义 URL scheme 回调 | 企业终端管理常禁用；CLI 场景不适用 |
| **设备授权流程（RFC 8628）** | 客户端只需能发 HTTP 请求与显示文本 |

选**设备授权流程**，且桌面端与 CLI 共用同一套。桌面端本可以内嵌 webview 做授权码流程，但那意味着两条认证路径、两套测试、两处可能出错。统一之后，桌面端只是在界面上把 `user_code` 和二维码画得好看一些，协议完全相同。

#### 5.4.2 登录流程

```
①  客户端 ──► POST /api/v1/auth/device/code
                ◄── { device_code, user_code, verification_uri, expires_in: 300, interval: 5 }

②  客户端显示：
       CLI    在终端渲染二维码（Unicode 块字符）+ 打印 verification_uri 与 user_code
       桌面端  界面内显示二维码，并可点击按钮调起系统浏览器

③  用户扫码 ──► 企微授权页 ──► 重定向至 GET /auth/wecom/callback?code=...&state=...
                                        │
                                        ├─ 校验 state（防 CSRF）
                                        ├─ 用 code 调企微换取 userid
                                        ├─ 身份映射（见 5.4.4）
                                        └─ 将 device_code 标记为已授权
                                        
④  客户端轮询 ──► POST /api/v1/auth/device/token { device_code }
                ◄── 授权前：{ error: "authorization_pending" }   客户端按 interval 继续轮询
                ◄── 完成后：{ access_token, refresh_token, expires_in }
```

轮询约束：客户端必须遵守 `interval`；网关对过快轮询返回 `slow_down` 并要求退避。`device_code` 有效期 300 秒，过期需重新发起。

#### 5.4.3 企微对接契约

依 [Web 登录组件](https://developer.work.weixin.qq.com/document/path/98171) 与 [获取登录用户身份](https://developer.work.weixin.qq.com/document/path/98179)：

```
扫码授权页
  https://login.work.weixin.qq.com/wwlogin/sso/login
      ?login_type=CorpApp
      &appid={corpid}
      &agentid={agentid}
      &redirect_uri={urlencoded 回调地址}
      &state={一次性随机串}

授权后重定向
  {redirect_uri}?code=CODE&state=STATE

code 换身份
  GET https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo
      ?access_token={企微 access_token}&code={CODE}
  → { corpid, userid, open_userid, ... }
```

`state` 由网关生成并与 `device_code` 绑定，一次性使用。**回调中必须校验 `state`**——否则攻击者可诱导他人扫码，把自己的会话绑定到他人身份上。

企微 `access_token` 由网关自行缓存与刷新（企微侧有效期 7200 秒），不与本项目的用户令牌混淆。

#### 5.4.4 身份映射（对应用户故事 Q1）

企微返回的是**企微 userid**，而策略判定依赖的会议属性（`host_user_id`）是**腾讯会议 userid**。两者不必然相同，必须显式映射：

```
企微 (corpid, userid) ──► IdentityMapper ──► 腾讯会议 userid
```

映射策略可配置，三选一：

| 策略 | 适用场景 | 代价 |
| --- | --- | --- |
| `direct` | 企微 userid 与腾讯会议企业 userid 同源 | 零维护；须事先验证确实一致 |
| `email` | 两侧均有可靠邮箱，以邮箱为关联键 | 依赖邮箱唯一且已填写 |
| `table` | 显式映射表，管理员导入或定期同步 | 需维护；人员变动时须同步 |

**本项目选定 `direct`（`IDENTITY_STRATEGY=direct`）。** 依据项目方确认（2026-07-21）：企业无独立账号体系、未使用 SSO，用户直接使用企业微信创建的账号——不存在会改写 userid 的 SSO 中间层，登录身份即企微身份。

**但仍须一次 preflight 实测确认，不能凭账号来源假设 `direct` 直接可用。** 「企微 userid 是否逐字节等于腾讯会议企业 userid」是腾讯生态的同步实现细节：企业通过企微开通腾讯会议时，腾讯会议侧的企业 userid 可能与企微 userid 一致，也可能经过转换或加前缀。用 `preflight --sample-user <真实企微userid>` 验证。

- 一致 → `direct` 直接可用。
- 不一致 → 切 `table`，用企微通讯录同步一张 `identity_map`。仅改配置与一次性数据导入，不改代码。

**映射失败必须拒绝登录并明确报错，不得降级为「无权限」。** 二者性质不同：无权限是策略的正常结论，映射失败是配置缺陷。若混为一谈，管理员会看到用户抱怨"没权限"，却在策略表里找不到任何问题。

部署时需完成一次性验证：取若干真实账号，确认所选策略能正确解析出腾讯会议 userid。该验证应作为 §6 部署检查的一部分。

#### 5.4.5 令牌生命周期

| 令牌 | 形式 | 有效期 | 存储 |
| --- | --- | --- | --- |
| `access_token` | JWT（含企微 userid、腾讯会议 userid、令牌类型） | 15 分钟 | 不落库，无状态校验 |
| `refresh_token` | 不透明随机串 | 7 天 | 落库存 hash，可吊销 |

- **刷新即轮换**：每次刷新签发新的 `refresh_token` 并作废旧的。若检测到已作废的 refresh_token 被再次使用，判定为泄露，吊销该用户全部会话。
- **登出**吊销 refresh_token；未过期的 access_token 最多再存活 15 分钟。
- **JWT 中不缓存策略判定结果**。策略必须在每次 `download-url` 请求时实时评估——否则管理员收紧策略后，持旧令牌者仍可继续导出，管控出现最长 15 分钟的空窗。

#### 5.4.6 服务账号

```
POST /api/v1/auth/service-token
     { client_id, client_secret }
  → { access_token, expires_in }        无 refresh_token，到期重新换取
```

- `client_secret` 以 argon2id 存 hash，明文仅在签发时展示一次
- 支持设置绝对过期时间与即时吊销
- **服务账号同样受策略约束**，不享有绕过特权。其身份为一个显式的腾讯会议 userid，由管理员在创建时指定

#### 5.4.7 安全约束

| 约束 | 原因 |
| --- | --- |
| 全链路 HTTPS，拒绝明文 | 令牌与下载地址均为敏感数据 |
| `state` 一次性且与 `device_code` 绑定 | 防 CSRF 与会话绑定攻击 |
| `device_code` 与 `user_code` 熵值充足，`user_code` 至少 8 位 | `user_code` 会被用户读出，短码可被暴力猜测 |
| 登录接口按 IP 与账号双维度限流 | 防止轮询接口被用于探测 |
| 审计记录登录成功与失败 | 与 §5.7 的导出审计合并为同一条链路 |

### 5.5 策略引擎

**三个执行点**，第三个才是安全边界：

```
列会议    → 过滤（不展示）      ← UI 便利
列资产    → 过滤（不展示）      ← UI 便利
换下载地址 → 强制校验（不允许）  ← 真正的授权检查
```

只做前两者的系统，攻击者遍历 ID 即可越权——过滤发生在展示层而非授权层。**隐藏不是安全机制。**

规则模型：

```
subject   谁      用户 / 部门 / 角色
resource  什么    会议属性：主持人、所属部门、时间范围
action    动作    导出哪类资产（八类之一或全部）
effect    结果    allow | deny
```

**默认 deny**，初始配置模板附一条「管理员 allow 全部」规则。归档工具面对的是全公司会议录音，安全默认值优于可用默认值。

**组织策略已确认（2026-07-21）：仅管理员可导出。** 上述最小模板即为本项目的最终策略配置——`policy_rules` 无种子数据（默认 deny），只配「管理员 allow 全部」，普通员工登录后一律判 deny。这是**策略配置**而非代码限制：策略引擎在能力上支持任意粒度授权，将来若放开员工自助导出，新增规则即可，无需改代码。此决定还使桌面端（子项目 4）定位为**管理员工具**而非全员产品。

判定顺序：按 `priority` 升序取第一条匹配规则的 `effect`；无任何匹配则 deny。同优先级下 deny 优先于 allow。

`resource_expr` 为字段匹配对象，键为会议属性，值为匹配条件。仅支持等值、集合包含与时间区间三种操作，不支持嵌套逻辑表达式——策略需要能被管理员读懂并审计，可编程性不是目标：

```json
{ "host_department": ["研发中心", "产品中心"],
  "host_userid": { "not_in": ["ceo_uid"] },
  "start_time": { "gte": 1767225600 } }
```

同一对象内多个键之间为 AND 关系。缺省的键不参与匹配。

### 5.6 限流

网关是唯一的 API 出口，限流集中于此。若由 N 个客户端各自直连，`190310`（每分钟调用超限）会成为常态。

- 令牌桶，保守起步（默认 5 QPS），遇 `190310` 自动收敛
- 限流作用于对腾讯的调用，与客户端请求速率解耦
- 客户端侧另有独立配额，防止单个客户端占满全局

### 5.7 审计

每次签发下载地址写一条不可变审计记录：操作者、时间、会议 ID、资产 ID、资产类型、策略判定结果、客户端类型。这是「管理员管控」需求的可验证性基础——管控若无法事后核查，等于没有管控。

### 5.8 数据模型

MySQL 8.0.19+ / InnoDB / utf8mb4。下为设计意图的示意结构，**完整建表语句以实现计划 T4 为准**。

三条 MySQL 特有约束贯穿全表：主键与唯一索引字段必须为 `VARCHAR(n)`（TEXT 不可索引）；数组语义由 `JSON` 列承载（MySQL 无数组类型）；字符集必须 `utf8mb4`——会议主题含中文与 emoji，3 字节 utf8 会插入失败。

```sql
-- STS-Token 申请与回调配对
CREATE TABLE sts_token_requests (
  req_id       VARCHAR(128) NOT NULL,
  state        VARCHAR(16)  NOT NULL,   -- pending | fulfilled | expired | failed
  requested_at BIGINT       NOT NULL,
  fulfilled_at BIGINT       NULL,
  expire_ts    BIGINT       NULL,
  token_cipher TEXT         NULL,       -- 密文，明文不入库
  PRIMARY KEY (req_id),
  KEY idx_sts_state (state, expire_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 策略规则
CREATE TABLE policy_rules (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  priority      INT          NOT NULL,
  subject_type  VARCHAR(16)  NOT NULL,  -- user | department | role
  subject_value VARCHAR(128) NOT NULL,
  resource_expr JSON         NOT NULL,  -- 会议属性匹配表达式
  asset_types   JSON         NOT NULL,  -- 八类之一或 ["*"]
  effect        VARCHAR(8)   NOT NULL,  -- allow | deny
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    BIGINT       NOT NULL,
  updated_at    BIGINT       NOT NULL,
  PRIMARY KEY (id),
  KEY idx_policy_lookup (enabled, priority, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 审计
CREATE TABLE audit_log (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  occurred_at  BIGINT       NOT NULL,
  actor_type   VARCHAR(32)  NOT NULL,   -- wecom_user | service_account
  actor_id     VARCHAR(128) NOT NULL,
  action       VARCHAR(32)  NOT NULL,   -- issue_download_url | login | list_meetings
  meeting_id   VARCHAR(64)  NULL,
  asset_id     VARCHAR(255) NULL,
  asset_type   VARCHAR(64)  NULL,
  decision     VARCHAR(8)   NOT NULL,   -- allow | deny
  matched_rule BIGINT       NULL,
  client_kind  VARCHAR(32)  NULL,
  PRIMARY KEY (id),
  KEY idx_audit_time (occurred_at DESC),
  KEY idx_audit_actor (actor_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 设备授权流程的待授权请求
CREATE TABLE device_authorizations (
  device_code    VARCHAR(64)  NOT NULL,
  user_code      VARCHAR(16)  NOT NULL,
  state          VARCHAR(64)  NOT NULL,  -- 与企微回调的 state 绑定
  status         VARCHAR(16)  NOT NULL,  -- pending | authorized | denied | expired
  wecom_userid   VARCHAR(128) NULL,      -- 授权完成后写入
  tm_userid      VARCHAR(128) NULL,      -- 身份映射结果
  expires_at     BIGINT       NOT NULL,
  last_polled_at BIGINT       NULL,      -- 用于 slow_down 判定
  created_at     BIGINT       NOT NULL,
  PRIMARY KEY (device_code),
  UNIQUE KEY uk_user_code (user_code),
  UNIQUE KEY uk_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 刷新令牌（存 hash，支持吊销与重放检测）
CREATE TABLE refresh_tokens (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  token_hash   VARCHAR(64)  NOT NULL,   -- sha256 hex
  wecom_userid VARCHAR(128) NOT NULL,
  tm_userid    VARCHAR(128) NOT NULL,
  family_id    VARCHAR(64)  NOT NULL,   -- 轮换链标识，检测到重放时按此吊销整条链
  revoked      TINYINT(1)   NOT NULL DEFAULT 0,
  expires_at   BIGINT       NOT NULL,
  created_at   BIGINT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_token_hash (token_hash),
  KEY idx_refresh_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 身份映射表（IdentityMapper 策略为 table 时使用）
CREATE TABLE identity_map (
  wecom_userid VARCHAR(128) NOT NULL,
  tm_userid    VARCHAR(128) NOT NULL,
  email        VARCHAR(255) NULL,
  updated_at   BIGINT       NOT NULL,
  PRIMARY KEY (wecom_userid),
  KEY idx_identity_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 服务账号
CREATE TABLE service_accounts (
  id          VARCHAR(64)  NOT NULL,
  name        VARCHAR(128) NOT NULL,
  secret_hash VARCHAR(255) NOT NULL,   -- argon2id
  tm_userid   VARCHAR(128) NOT NULL,   -- 该服务账号对应的腾讯会议身份
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  expires_at  BIGINT       NULL,
  created_at  BIGINT       NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

SecretKey、STS-Token 明文均不入库，使用阿里云 KMS 托管或等效的密文存储，库中只存密文或引用。

**无 `RETURNING` 的影响**：MySQL 不支持 `UPDATE ... RETURNING`，需要判断记录是否存在时用 `affectedRows`。例如 STS 回调配对时，`UPDATE ... WHERE req_id = ?` 影响 0 行即表示回调无法配对，属异常而非静默忽略。
### 5.9 错误处理

#### 响应结构

依 [返回结果](https://cloud.tencent.com/document/product/1095/42699)，成功返回 HTTP 200（部分操作响应体为空）。失败时：

```
服务错误      → HTTP 500
API 请求错误  → HTTP 400
```

```json
{ "error_info": { "error_code": 9003, "message": "MEETING NOT EXIST" } }
```

**HTTP 状态码不可用于错误分类**——它只有 400 和 500 两种取值，承载不了下面的三层区分。所有分类判断必须读**响应体中的 `error_info.error_code`**。

这一点必须在 `tencent-api` 层的响应解析器里落实：先解析 `error_info`，再据 `error_code` 分类；HTTP 状态码仅用于判断「是否为错误响应」。若实现时按 status code 分支，三层分类会整体失效——所有服务错误都会被归为同一类。

#### 分类

腾讯侧错误分三层——常见的「可重试 / 不可重试」二分法不足，因为不可重试里混着两种性质不同的错误：

```
致命（配置/权限问题）→ 立即失败并明确告知，不重试
   9042   权限受限或鉴权失败
   500014 账号无权限
   190004 参数非法（我方 bug）
   200001 请求头缺失必填字段（我方 bug）

瞬时 → 指数退避重试
   960000 网络错误    41 网络超时    28 服务错误
   190310 调用超限   → 额外收敛令牌桶速率
   190301 请求重放   → 重新生成 nonce + timestamp 后重试

资产级永久错误 → 跳过该资产，其他继续
   4051 录制文件已删除
   4049 记录不存在
```

价值在于：配置错误时用户在数秒内看到「鉴权失败，请检查 SecretKey」，而非等待数百个任务全部失败。

网关对客户端的错误响应需保留这个分类语义，使客户端能据此决定重试或放弃。

### 5.10 测试策略

```
domain/       纯函数 → 单元测试（时间戳换算、退避计算、策略表达式求值）
tencent-api/  真实响应存 fixture → mock fetch 回放，永不联网
store/        真实 MySQL（独立 database 隔离）→ 跑真实 SQL
policy/       表驱动测试，覆盖 allow/deny 优先级与默认拒绝
sts-token/    模拟异步回调时序，含超时未回调分支
http/         端到端：假腾讯 API + 真网关
```

`store` 与 `policy` 层坚持真依赖测试：前者的价值几乎全在 SQL 语义里，后者的价值全在判定正确性上，mock 掉等于没测。

必须存在的用例：

```
✓ 签名正确性      用官方文档示例值验证，含双重编码
✓ URI 一致性      带查询串的请求，签名与实际 URL 逐字节一致
✓ URL 编码        参数含 + ? = 等特殊字符 → 编码后再签名，二者一致
✓ 重试重签名      190301 后 nonce/timestamp 均已更新
✓ 错误码解析      两个 HTTP 500 但 error_code 不同（190310 / 4051）
                  → 分别归入「瞬时」与「资产级永久」，不因同为 500 而混同
✓ 31 天切分       传入 90 天 → 切成 3 个窗口，无重叠无遗漏
✓ Webhook 验签    篡改消息体 → 拒绝；错误 Token → 拒绝
✓ Webhook 解密    加密载荷正确解出 sts_token
✓ Token 续期      剩余 1/3 时触发；回调超时时告警且不中断服务
✓ 策略默认拒绝    无匹配规则时 deny
✓ 越权取地址      构造他人 asset_id → 拒绝并留审计
✓ 致命错误快速失败 mock 9042 → 立即返回，不重试

✓ 设备流程正常路径  发码 → 授权 → 轮询取得令牌
✓ 轮询过快        早于 interval 轮询 → slow_down
✓ device_code 过期 超过 300 秒 → 拒绝并要求重新发起
✓ state 校验      回调携带错误/重放的 state → 拒绝，不建立会话
✓ 身份映射失败     映射不出腾讯会议 userid → 登录失败且错误明确区别于「无权限」
✓ 刷新令牌轮换     旧 refresh_token 再次使用 → 判定泄露，吊销整条 family
✓ 策略实时生效     持有效 access_token 时收紧策略 → 下一次 download-url 即被拒

✓ 默认时间窗口     未传 from/to → 取最近 31 天，不触发切分
✓ 会议号多结果     一个 meeting_code 命中多场 → 全部返回，不擅自择一
✓ 范围外未命中     指定 ID 但不在窗口内 → meeting_not_found_in_range，
                  错误信息区别于「不存在」与「无权限」
```

「错误码解析」那条是回归测试的关键：它锁定了「分类依据是 `error_code` 而非 HTTP status」这个约束。若日后有人把解析器改回按 status 分支，该用例会立刻失败。

---

## 6. 实现前必须确认的事项

以下为需在编码前落实的外部依赖，均已有明确的确认路径，不属于设计未决项。

**第 1 项为阻断性前提**——不满足则项目无法成立，须最先确认。

1. **账号版本**（阻断性）：确认目标企业的腾讯会议账号为**商业版 / 企业版 / 教育版**之一。免费版与专业版不支持调用任何 REST API（见 §3.4），本项目在这两种版本下无技术实现路径。
2. **事件加解密算法细节**：按[事件加解密文档](https://cloud.tencent.com/document/product/1095/54658)实现 EncodingAESKey 的解密流程。
3. **企管后台配置**：需管理员在腾讯会议企管后台完成——创建企业自建应用取得 AppId / SdkId / SecretId / SecretKey；配置事件订阅 URL（支持四级域名）、Token、EncodingAESKey；勾选公共事件「STS Token 生成」；为 operator 账号授予「管理企业录制」「查看企业录制」权限。
4. **operator_id 归属**：确定网关使用哪个账号作为固定 operator（`operator_id_type=1`，即 userid）。该账号须为超级管理员/管理员，或具备企业录制管理权限。**注意该账号一旦离职或被删除，全部导出能力立即中断**，建议使用专设的服务账号而非某位在职管理员的个人账号。
5. **企微应用**：需创建企业微信自建应用用于扫码登录，取得 CorpId / AgentId / Secret，并在企微后台配置授权回调域名。
6. **身份映射策略**（阻断性 · ✅ 已选定 `direct`）：项目方确认企业用企微账号、无独立体系、无 SSO，故选 `direct`（见 §5.4.4）。**仍须用 `preflight --sample-user <真实企微userid>` 实测**确认企微 userid 与腾讯会议企业 userid 逐字节一致——这是腾讯同步实现细节，不能凭账号来源假设。不一致则切 `table`。若无法可靠对应，策略引擎无法按人判权限，US-2.1 不成立。
7. **组织策略**（✅ 已确认）：项目方确认**仅管理员可导出**。当前最小模板（默认 deny + 一条「管理员 allow 全部」）即最终配置，无需改代码。此决定使桌面端定位为管理员工具（见 §5.5）。

---

## 附录 A：核心导出引擎设计（子项目 2）

以下设计在需求澄清过程中已完成论证，随架构调整为「对接网关」而非「直连腾讯 API」，其余部分保持有效。子项目 2 展开时以此为起点。

### A.1 执行模型：数据库即任务队列

Discovery 与 Executor 两阶段解耦，SQLite 为唯一事实源。断点续传、进度查询、去重、崩溃恢复四件事出自同一机制，且桌面端 GUI 可直接复用同一数据库，无需进程间通信。

```
Discovery ─→ 取清单 ─→ UPSERT 为 pending 任务
                            ↓
                       [ SQLite ]  ← GUI / CLI 随时查询进度
                            ↓
Executor  ─→ 领取 pending ─→ 下载（断点续传）─→ 更新状态
```

### A.2 数据模型

```sql
PRAGMA journal_mode = WAL;      -- CLI 与 GUI 并发读写
PRAGMA busy_timeout = 5000;

CREATE TABLE meetings (
  meeting_id     TEXT NOT NULL,
  sub_meeting_id TEXT NOT NULL DEFAULT '',
  meeting_code   TEXT,
  subject        TEXT,
  host_userid    TEXT,
  start_time     INTEGER,
  end_time       INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, sub_meeting_id)
);

CREATE TABLE assets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id       TEXT NOT NULL,
  sub_meeting_id   TEXT NOT NULL DEFAULT '',
  asset_type       TEXT NOT NULL,   -- 取值见 §3.2，由 API 响应字段名派生
  remote_id        TEXT NOT NULL,   -- record_file_id；文本类资产用 <record_file_id>:<字段名>:<索引>
  status           TEXT NOT NULL,   -- pending|running|completed|failed|skipped|dead
  storage_target   TEXT NOT NULL DEFAULT 'local',
  target_path      TEXT,            -- 相对路径，不含存储根
  file_type        TEXT,
  bytes_expected   INTEGER,
  bytes_written    INTEGER NOT NULL DEFAULT 0,
  content_hash     TEXT,
  download_url     TEXT,            -- 仅缓存，非稳定标识
  download_url_expires_at INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  last_error       TEXT,
  completed_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (meeting_id, sub_meeting_id, asset_type, remote_id)
);

CREATE INDEX idx_assets_claimable ON assets (status, lease_expires_at);

-- 每类资产独立探测状态，互不牵连
CREATE TABLE asset_probes (
  meeting_id     TEXT NOT NULL,
  sub_meeting_id TEXT NOT NULL DEFAULT '',
  asset_type     TEXT NOT NULL,
  state          TEXT NOT NULL,          -- probing | resolved | abandoned
  attempts       INTEGER NOT NULL DEFAULT 0,
  probe_after    INTEGER NOT NULL DEFAULT 0,
  deadline_at    INTEGER NOT NULL,       -- = 会议结束时间 + 等待上限
  last_reason    TEXT,
  PRIMARY KEY (meeting_id, sub_meeting_id, asset_type)
);

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  mode        TEXT NOT NULL,
  window_from INTEGER,
  window_to   INTEGER,
  summary     TEXT
);
```

`UNIQUE` 约束配合 `INSERT ... ON CONFLICT DO UPDATE` 即为去重的全部实现，无需应用层判重，也就不存在查-插之间的竞态。

### A.3 状态机

```
  (Discovery 写入)          租约超时
        ──→ pending ──→ running ────┐
              ▲            │        │
  attempts<上限│            ├──→ completed
              └── failed ←─┤
                    │      │
            attempts≥上限   │
                    ▼      │
                  dead     │
        ──→ skipped ←──────┘
              (策略拒绝 / 平台确认无此资产)
```

领取任务为单条原子 UPDATE，无需事务或锁：

```sql
UPDATE assets SET status='running',
                  lease_expires_at = ?,
                  attempts = attempts + 1
WHERE id = (SELECT id FROM assets
            WHERE status='pending'
               OR (status='running' AND lease_expires_at < ?)
            ORDER BY id LIMIT 1)
RETURNING *;
```

租约（而非锁）使崩溃自愈：进程崩溃后 `running` 任务的租约到期即可被重新领取，无需人工清理。

### A.4 资产就绪判定

| 情况 | 判定 | 依据 |
| --- | --- | --- |
| `state` = 1 或 2 | 继续等待 | 平台明示录制中 / 转码中 |
| `state` = 3 | 资产就绪 | 平台明示转码完成 |
| `allow_download` = false | 立即 `skipped(download_not_allowed)` | 平台明示 AI 纪要不可得，无需等待 |
| 超过 `deadline_at` | `skipped(upstream_timeout)` | 安全网 |

等待上限（可配置）：

| 资产类型 | 上限 | 依据 |
| --- | --- | --- |
| 视频 / 音频 | 6 小时 | 转码为确定性流程 |
| 逐字稿与各类 AI 纪要 | 48 小时 | AI 生成不保证时效 |

`deadline_at` 使用**绝对时间**（会议结束时间 + 上限）而非重试次数上限。用次数会使「等多久」取决于用户运行了几次命令，语义不稳定。

放弃时显式写入一行 `skipped` 记录，而非留空。归档系统中「确认缺失」与「不知有无」是两种不同状态，前者无歧义。

### A.5 存储布局

```
<storage_root>/
└── 2026/07/
    └── 2026-07-15_1430_季度产品评审_88123456/
        ├── meeting.json                       会议元数据
        ├── recording_<record_file_id>.mp4     录制视频
        ├── recording_<record_file_id>.m4a     录制音频
        ├── transcript.<ext>                   原始转写（逐字稿）
        ├── ai_transcript.<ext>                转写（智能优化版）
        ├── ai_minutes.<ext>                   混元章节纪要
        ├── ai_topic_minutes.<ext>             混元主题纪要
        ├── ai_speaker_minutes.<ext>           混元发言人纪要
        ├── ai_ds_minutes.<ext>                DeepSeek 纪要
        └── _manifest.json                     资产清单 + 校验信息
```

八个文件名对应 §3.2 的八类资产，一一映射。**文件扩展名不写死**——由 API 返回的 `file_type` 决定（文本类可能是 `txt` / `pdf` / `docx` / `htm`），存入 `assets.file_type` 后据此拼接。同一资产类型在不同会议上可能有不同格式，写死扩展名会与实际内容不符。

目录名规则：`<日期>_<时分>_<清洗后主题>_<会议号>`。主题清洗必需——Windows 拒绝含 `\ / : * ? " < > |` 的目录名，而中文会议主题包含 `：` 与 `/` 极常见。规则：非法字符替换为 `-`，按**字素簇**截断 60 字符（避免切断 emoji 或组合字符），追加会议号保证唯一。

`target_path` 存**相对路径**。存储根是配置项，可能从本地迁至 NAS 再迁至 OSS 前缀；相对路径使数据库与物理位置解耦。

`_manifest.json` 使导出结果**脱离数据库自解释**——归档场景下，数年后在 NAS 上翻到该目录，无需本工具即可知道内容、完整性与原始 ID。

### A.6 断点续传

写入一律先落 `<name>.part`，校验后原子 `rename` 为正式名。因此**正式文件名存在即内容完整**。

推论：续传时的真实字节数以 `.part` 文件实际大小为准，**不信数据库中的 `bytes_written`**。崩溃时数据可能已落盘而数据库未更新，文件系统是此处的事实源，数据库值仅供界面展示。

```
size := storage.writtenSize(relPath)

size > 0 ─→ Range: bytes=<size>-
              ├─ 206 → 正常续传
              ├─ 200 → 服务端不支持 Range，丢弃 .part 重下
              └─ 416 → 本地比远端大，说明远端文件已变更，删除重下

下载中 ─→ 403 / 410 → 链接过期，向网关换新地址，从当前 size 继续
       ─→ 5xx / 中断 → failed，指数退避后回 pending，.part 保留
       ─→ 每 8 MB   → 更新 bytes_written 并续租

完成 ─→ 校验 bytes_expected → 计算 sha256 → finalize() → completed
```

每 8 MB 更新一次数据库是取舍：逐 chunk 写库会使 SQLite 成为瓶颈（WAL 下 GUI 仍在并发读），完全不写则进度停滞且租约会被误抢。该间隔同时承担进度更新与续租两个职责。

416 分支是唯一能识别「远端文件已被替换」的信号。不处理则本地永久卡在过大的 `.part` 上，反复失败且错误信息无指向性。

### A.7 校验策略（有意的不对称）

| 资产 | 策略 | 理由 |
| --- | --- | --- |
| 文本类（转写、纪要） | 拉取后算 `content_hash`，与已完成记录比对；不一致则重置为 pending 重导 | 成本可忽略，可捕捉平台侧内容更新 |
| 视频 / 音频 | 用 `bytes_expected` 与文件实际大小比对 | 算 hash 需读完数 GB，收益仅为确认下载时就该确认的事 |

### A.8 两种使用模式

工具需同时服务两种心智，二者共用同一套任务队列与下载引擎，只是**发现阶段的输入不同**：

| 模式 | 心智 | 典型用户 |
| --- | --- | --- |
| **归档模式** | 「把 7 月的会议全部存档」 | 归档运维、定时任务、桌面端的批量归档 |
| **点选模式** | 「找到上周那场评审会，下载它」 | 业务用户、桌面端主要交互方式 |

为此将 Discovery 的输入从「时间窗口」泛化为**选择器**：

```ts
type MeetingSelector =
  | { kind: 'range';  from: number; to: number }              // 归档模式
  | { kind: 'code';   meetingCode: string; from?: number; to?: number }  // 点选：会议号
  | { kind: 'id';     meetingId: string;   from?: number; to?: number }  // 点选：会议 ID
```

`from` / `to` 在点选模式下可省略，由网关补默认窗口（见 §5.2）。Executor、任务表、去重、断点续传全部不受选择器类型影响——**它们只消费任务队列，不关心任务从何而来**。

### A.9 CLI

```bash
# 归档模式
mde run      --from 2026-07-01 --to 2026-07-31 --out ./meetings
mde discover --from ... --to ...     只发现，不下载

# 点选模式
mde list     --from ... --to ...     查看可导出的会议（人读格式）
mde list     --code 88123456         按会议号查找
mde get      88123456                导出指定会议（会议号或会议 ID 均可）
mde get      88123456 --assets recording,summary    只导指定资产类型
mde get      88123456 --from 2026-04-01             会议较早时扩大搜索范围

# 通用
mde execute                          只消费队列（可反复跑，天然续传）
mde status                           各状态计数与失败明细
mde retry    --failed                failed/dead 重置为 pending
```

所有命令共享同一数据库，因此**中断后重跑 `mde execute` 即为续传**，无需专门的恢复命令。续传不是一个功能，而是架构的副产品——「继续上次」与「重新开始」在代码上是同一条路径。

`mde get` 与 `mde run` 的差别仅在写入队列的选择器，写完之后走的是同一条执行路径。这也意味着两种模式可以混用：先 `mde run` 批量归档整月，再 `mde get` 补一场遗漏的会议，队列会正确合并且不重复下载。

按会议号查到多场会议时，`mde get` 不猜测：列出全部匹配项，要求用户以 `--meeting-id` 精确指定。非交互环境（cron）下直接失败并给出候选列表，避免自动选错导致归档错乱。

CLI 跑完即退出，不会在后台等待 48 小时。等待 AI 纪要依赖工具被反复运行（cron / 计划任务），或子项目 4 的桌面常驻进程。提供 `mde run --watch --interval 30m` 作为便利选项，但默认心智是「可反复运行的幂等命令」。

### A.10 边界情况

| 情况 | 处理 |
| --- | --- |
| 跨 31 天窗口的重复会议 | 窗口按 `[from, from+31d)` 左闭右开切分；即便重复，`UNIQUE` 约束兜底 |
| 磁盘空间不足 | 下载前依 `bytes_expected` 预检；不足则整体暂停并告警，不写到一半失败 |
| 主题含非法字符 / emoji / 超长 | 按 A.5 清洗规则处理 |
| 一个录制含多个文件 | `record_files` 为数组；主键含 `remote_id`，天然支持一对多 |
| 本机时钟偏移 | 网关侧签名受影响；客户端不签名，但仍需在首次异常时提示校时 |
| CLI 与 GUI 并发 | WAL + `busy_timeout` + 租约三者共同保证，无需额外 IPC |

### A.11 测试策略

```
domain/       纯函数 → 单元测试
gateway-api/  网关响应 fixture → mock 回放
store/        bun:sqlite :memory: → 真实 SQL
downloader/   本地 HTTP server → 真实 Range / 403 / 416 / 断连
orchestrator/ 假网关 + 临时目录 → 端到端
```

必须存在的用例：

```
✓ 断点续传   下到一半杀进程 → 重启从断点继续
✓ 链接过期   mock 403 → 换链后从当前字节继续，最终文件完整
✓ 416 分支   本地 .part 大于远端 → 删除重下
✓ 幂等       连跑两次 → 第二次零下载
✓ 崩溃恢复   running 租约过期 → 被重新领取
✓ 31 天切分  传入 90 天 → 恰好 3 个窗口，无重叠无遗漏
```

---

## 附录 B：后续子项目要点

### B.1 子项目 3 — 存储目标扩展

子项目 2 中 `storage` 从第一天即为接口，本子项目只新增实现类，`executor` 不改动：

```ts
interface StorageTarget {
  resolve(meeting: Meeting, asset: Asset): string;   // → 相对路径
  writtenSize(relPath: string): Promise<number>;     // .part 已写字节
  appendStream(relPath: string): Promise<Writable>;
  finalize(relPath: string): Promise<void>;          // 原子 rename
  exists(relPath: string): Promise<boolean>;
}
```

阿里云 OSS 需以分片上传映射 `appendStream` / `finalize` 语义；NAS 走 SMB 挂载，语义接近本地文件系统但需处理网络中断。

> <sup>[1]</sup> **2026-08-25 补注：OSS 已撤，只交付 NAS。** 立项时列的两个导出目标里，
> 阿里云 OSS 至今没有需求方，M4 因此收敛为只做 NAS（`docs/console/dev-plan.md` §3 阶段 2），
> 已实现为 `packages/engine/src/storage/nas.ts` 并随控制台阶段 2 交付（2026-08-24）。
> `Storage` 接口原样留着——真有 OSS 需求时新增一个实现类即可，`executor` 不用改。

### B.2 子项目 4 — 桌面应用

- Bun 运行时内嵌，用户无需安装任何依赖
- macOS 与 Windows 双安装包
- 直接读取子项目 2 的同一 SQLite 数据库展示进度，无需另建数据通道
- 选用 `bun:sqlite` 而非 native SQLite 驱动，规避跨平台 native 模块编译问题——native 模块是桌面应用跨平台打包最常见的失败点
