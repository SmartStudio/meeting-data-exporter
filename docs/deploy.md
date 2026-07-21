# 部署指南

本文档面向负责把「腾讯会议导出网关」部署到生产环境的运维/管理员。目标读者不需要
读懂 TypeScript 源码，但需要能操作阿里云控制台、腾讯会议企业管理后台、企业微信
管理后台。

阅读顺序建议：先看「前置条件」确认自己具备条件，再按「部署步骤」走一遍，最后用
「preflight 自检脚本」验证配置是否正确，确认无误后再切流量。

---

## 目录

1. [前置条件](#1-前置条件)
2. [MySQL 准备](#2-mysql-准备)
3. [腾讯会议企业管理后台配置清单](#3-腾讯会议企业管理后台配置清单)
4. [企业微信自建应用配置](#4-企业微信自建应用配置)
5. [环境变量说明](#5-环境变量说明)
6. [身份映射策略选择（direct / email / table）](#6-身份映射策略选择direct--email--table)
7. [默认导出权限：只有管理员，还是员工也能自助导出](#7-默认导出权限只有管理员还是员工也能自助导出)
8. [阿里云部署步骤](#8-阿里云部署步骤)
9. [preflight 自检脚本使用方法](#9-preflight-自检脚本使用方法)
10. [常见错误码对照表](#10-常见错误码对照表)
11. [上线前必须确认（已知技术债）](#11-上线前必须确认已知技术债)

---

## 1. 前置条件

在开始部署前，先确认以下几件事，缺一不可：

- **腾讯会议账号版本必须是商业版 / 企业版 / 教育版之一**。免费版与专业版不支持
  调用任何 REST API，这是阻断性前提——如果目标企业只有免费版/专业版，本项目
  在技术上无法成立，不要继续往下部署。preflight 脚本第 3/4 项会用真实调用验证
  这一点，但越早人工确认越好。
- 有一台可以运行 Docker 容器、且能出公网访问 `api.meeting.qq.com` 与
  `qyapi.weixin.qq.com` 的服务器（阿里云 ECS / 容器服务均可）。
- 有一个公网可访问、配有 HTTPS 证书的域名，作为 `GATEWAY_BASE_URL`。腾讯会议的
  Webhook 回调与企业微信的登录跳转都要求 HTTPS，自签名证书不可用。
- 有一个 MySQL 实例（自建或阿里云 RDS），版本 ≥ 5.7（推荐 8.0+）。
- 有腾讯会议企业管理后台的管理员权限，能创建企业自建应用。
- 有企业微信管理后台的管理员权限，能创建自建应用。

---

## 2. MySQL 准备

### 2.1 版本

要求 MySQL ≥ 5.7，推荐 8.0 及以上。网关依赖 JSON 列类型（`policy_rules` 表的
`resource_expr` / `asset_types` 字段）与部分 5.7+ 才稳定的行为。

### 2.2 建库时必须显式指定 utf8mb4

MySQL 的历史默认字符集 `utf8` 只有 3 字节，无法容纳会议主题里常见的 emoji（4
字节字符），会在插入真实数据时报错——用 ASCII 测试数据跑通不代表生产环境不会
炸。建库时必须显式指定：

```sql
CREATE DATABASE meeting_gateway
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 网关连接数据库时使用的账号，按最小权限原则只授予这一个库
CREATE USER 'gateway'@'%' IDENTIFIED BY '<强密码>';
GRANT ALL PRIVILEGES ON meeting_gateway.* TO 'gateway'@'%';
FLUSH PRIVILEGES;
```

网关启动时（`src/index.ts` 的 `main()`）会自动执行 `migrations/001_init.sql`
建表，因此这个数据库账号需要有 `CREATE TABLE` 权限，不能只给 DML 权限。

### 2.3 阿里云 RDS 额外要确认的参数

如果用阿里云 RDS MySQL，除了上面的建库语句，还要在 RDS 控制台的「参数设置」里
确认实例级参数：

```
character_set_server = utf8mb4
```

这个参数是新建连接/新建库在未显式指定字符集时的兜底默认值。即使建库语句已经
显式指定了 `utf8mb4`，仍建议把这个参数也改成 `utf8mb4`，避免后续有人手滑建了
一个没有显式指定字符集的库、或某个连接池配置遗漏了 `charset` 参数。

### 2.4 连接串格式

```
DATABASE_URL=mysql://gateway:<强密码>@<host>:3306/meeting_gateway?charset=utf8mb4
```

`mysql2` 驱动即使 URL 里不带 `?charset=utf8mb4`，代码里（`src/store/db.ts`）也
已经在连接选项里显式设置了 `charset: 'utf8mb4'`，双重保险。真正决定「表里到底
能不能存 4 字节字符」的是**数据库本身的字符集**（2.2 节的建库语句），不是连接
参数——这也是为什么 preflight 脚本第 2b 项要直接查 `@@character_set_database`
而不是只检查连接配置。

---

## 3. 腾讯会议企业管理后台配置清单

登录腾讯会议企业管理后台（企业版/教育版管理员账号）：

1. **应用管理 -> 创建企业自建应用**，创建后记录下四个凭证：
   - App ID → `TM_APP_ID`
   - SDK ID → `TM_SDK_ID`（如未分配 SdkId，见下方错误码 190303 的说明）
   - Secret ID → `TM_SECRET_ID`
   - Secret Key → `TM_SECRET_KEY`
2. **回调配置 -> 事件订阅**：
   - URL 填 `https://<GATEWAY_BASE_URL 的域名>/webhook/tencent-meeting`
   - Token：固定 25 位字符串，自行生成一个随机值 → `TM_WEBHOOK_TOKEN`
   - EncodingAESKey：固定 43 位字符串，自行生成一个随机值 →
     `TM_WEBHOOK_AES_KEY`
   - **勾选「STS Token 生成」事件**——这是 AI 分钟数（转写/纪要）功能依赖的
     STS-Token 异步下发通道，不勾选的话 preflight 第 7 项会一直等不到回调。
3. **成员管理 -> 选定一个 operator 账号**，作为网关调用 API 时固定使用的
   `operator_id`（`TM_OPERATOR_ID`）：
   - 该账号需要是超级管理员/管理员，或至少具备「管理企业录制」「查看企业录制」
     权限。
   - **强烈建议使用专设的服务账号，而不是某位在职管理员的个人账号**——一旦这
     个账号离职或被删除，网关的全部导出能力会立即中断，且故障现象会是一堆
     `500014`（账号无权限）错误，排查成本很高。

关于事件订阅的具体线路格式（Token/签名/密文在 query 还是 body 里、字段名是否
与本网关的实现完全一致），本仓库的实现是参照企业微信回调的通行做法自行设计的
约定，**未经过腾讯会议官方文档逐字核实**，属于上线前必须确认的技术债，详见
第 11 节。

---

## 4. 企业微信自建应用配置

登录企业微信管理后台：

1. **应用管理 -> 自建 -> 创建应用**，记录：
   - 企业 ID（企业信息页可查看）→ `WECOM_CORP_ID`
   - AgentId → `WECOM_AGENT_ID`
   - Secret → `WECOM_SECRET`
2. **网页授权及 JS-SDK -> 设置可信域名**：填 `GATEWAY_BASE_URL` 的域名（不含
   协议头与路径），否则用户扫码登录后跳转会被拒绝。
3. **可见范围**：把需要使用本网关的员工/部门加入应用可见范围，否则对应用户
   在企业微信侧根本看不到这个自建应用，无法发起登录。

---

## 5. 环境变量说明

完整清单见仓库根目录的 `.env.example`（每个变量上方都有一行注释说明来源页面），
这里只补充几个容易出错的点：

| 变量 | 易错点 |
| --- | --- |
| `TM_WEBHOOK_TOKEN` | 代码里做了强校验，**必须恰好 25 个字符**，多一位少一位 `loadConfig` 会直接拒绝启动。 |
| `TM_WEBHOOK_AES_KEY` | 企微/腾讯的惯例是 43 位，但 `loadConfig` 本身没有做长度校验（只要求非空），填错长度不会在启动时报错，而是会在真正收到 Webhook 回调、解密失败时才暴露——建议部署前手动核对长度。 |
| `DATABASE_URL` | 格式 `mysql://user:pass@host:3306/db?charset=utf8mb4`；密码含 `@` `:` `!` 等特殊字符时必须做 URL 编码，否则会被解析成错误的 host/path。 |
| `JWT_SECRET` | 建议 ≥ 32 位随机字符串（例如 `openssl rand -base64 32`），这是签发用户会话 JWT 与派生 STS-Token 落库加密密钥（见第 11 节技术债）共用的根密钥，不要用弱口令。 |
| `GATEWAY_BASE_URL` | 必须是公网可达的 HTTPS 域名，Webhook 回调地址、企微登录跳转都由它拼出来；本地联调可以先用内网穿透工具（如 `ngrok`）临时获得一个公网 HTTPS 地址。 |
| `IDENTITY_STRATEGY` | 见第 6 节，选错会导致所有用户登录后都拿不到正确的腾讯会议身份。 |
| `TM_QPS` | 默认 5，多个客户端共用同一个网关时不要盲目调高——腾讯侧限流触发 `190310` 后网关会自动收敛速率，但仍会拖慢所有客户端的响应。 |
| `TRUSTED_PROXY_HOPS` | 可选，默认 1。登录端点限流按客户端 IP 分桶，取值必须精确等于网关前方会追加 X-Forwarded-For 的可信代理层数——配错会导致限流按错误的 IP 生效（填多了会取到客户端可伪造的 XFF 前缀段，限流可被绕过，是安全问题；填少了会把共享同一出口 IP 的不同客户端误伤合并进同一个桶，是可用性问题）。不确定时宁可偏小，不要偏大。 |

**任何一个必填变量缺失，网关都不会启动**（`loadConfig` 在 `src/index.ts` 的
`main()` 一开始就会抛错），错误信息会明确指出缺的是哪个字段。

---

## 6. 身份映射策略选择（direct / email / table）

这是部署前**必须由项目方结合企业实际情况确认**的问题：贵司的腾讯会议账号体系，
是通过企业微信 SSO 打通创建的，还是独立创建、与企业微信账号体系无关？

网关支持三种策略（`src/auth/identity.ts`），选错的后果是**所有用户登录后台都拿
不到正确的腾讯会议身份**，进而导致策略引擎（默认 deny）判定为无权限——现象上
看起来像「权限配置错了」，但根因其实是身份映射选错了策略，两者必须分开排查
（这也是 `IdentityMappingError` 的报错文案特意强调"这是配置问题，不是权限判定
结果"的原因）。

### direct —— 两侧 userid 完全一致

**适用场景**：企业的腾讯会议账号是通过企业微信 SSO 打通创建的（即腾讯会议后台
显示的成员 userid，与企业微信通讯录里的 userid，本来就是同一个命名空间下的同一
批 ID）。

**配置成本**：零。`IDENTITY_STRATEGY=direct` 时，网关直接把用户登录企业微信拿到
的 `wecomUserId` 原样当作腾讯会议的 `tmUserId` 使用，不需要任何额外的表或映射
维护。

**如何确认是否适用**：在腾讯会议企业管理后台的成员列表里随便挑几个真实同事，
对照企业微信通讯录管理后台的对应成员，看 userid 字符串是否完全一致。**不要凭
猜测选这个策略**——用 preflight 脚本的 `--sample-user` 参数拿几个真实企微
userid 实测，解析出来的"腾讯会议 userid"如果在腾讯会议后台根本查无此人，说明
选错了。

### table —— 独立创建，人工/批量维护对照表

**适用场景**：腾讯会议账号是独立创建的（不同的 userid 命名空间），且管理员能拿
到一份精确的「企微 userid ↔ 腾讯会议 userid」对照表（比如两边账号都是同一批
IT/HR 系统按同一套花名册开通的，只是系统内部生成的 ID 不同）。

**配置成本**：需要维护 `identity_map` 表，按企微 userid 为键：

```sql
INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at)
VALUES ('zhangsan', 'zhangsan_tm_001', 'zhangsan@company.com', UNIX_TIMESTAMP())
ON DUPLICATE KEY UPDATE tm_userid = VALUES(tm_userid), updated_at = VALUES(updated_at);
```

`email` 列在 `table` 策略下是可选的（可以传 `NULL`），只有 `email` 策略会用到它。

### email —— 独立创建，只有邮箱能作为两侧的桥梁

**适用场景**：腾讯会议账号是独立创建的，管理员**没有**精确的 userid 对照表，但
两侧账号的邮箱是一致的（例如都用公司邮箱开通）。

**配置成本**：同样需要维护 `identity_map` 表，但登录时网关是**按邮箱查找**这张
表（`WHERE email = ?`），而不是按 `wecom_userid` 查找：

```sql
INSERT INTO identity_map (wecom_userid, tm_userid, email, updated_at)
VALUES ('zhangsan', 'zhangsan_tm_001', 'zhangsan@company.com', UNIX_TIMESTAMP())
ON DUPLICATE KEY UPDATE tm_userid = VALUES(tm_userid), email = VALUES(email), updated_at = VALUES(updated_at);
```

注意：`wecom_userid` 仍然是这张表的主键，必须填正确的值（不能留空/占位），只是
`email` 策略在**查找**时用的是 `email` 列，不是主键列。另外 `email` 列在数据库
里只有普通索引、没有唯一约束，如果同一个邮箱出现多行，网关会按 `updated_at`
降序取最新一条（`src/store/auth.ts` 的 `lookupIdentityByEmail`），业务上应避免
出现邮箱重复的脏数据（例如离职员工邮箱被回收后重新分配、身份同步任务竞态写入）。

此外，`email` 策略依赖企业微信「通讯录同步」接口能查到用户的邮箱
（`auth/getuserinfo` 本身不返回邮箱，网关会再调一次 `user/get`）——如果通讯录里
没有维护邮箱字段，或应用没有被授予读取邮箱的权限范围，这一步会静默返回
`null`，进而导致登录失败并明确报 `account_not_provisioned`。

### 如何验证选择是否正确

**不要凭假设选择，必须用真实账号实测**——这正是 preflight 脚本第 6 项存在的
原因：

```bash
bun scripts/preflight.ts --sample-user <一个真实的企微 userid> \
  [--sample-email <该用户的邮箱>]   # 仅 IDENTITY_STRATEGY=email 时需要
```

三种策略都支持通过这种方式实测；哪种策略下都应该拿几个不同部门/不同入职批次的
真实账号多测几个，避免"凑巧第一个人两侧 ID 一样，其余人不一样"这种以偏概全。

---

## 7. 默认导出权限：只有管理员，还是员工也能自助导出

这也是部署前**必须由项目方确认**的业务问题：普通员工能否自助导出自己参与/主持
的会议录制，还是所有导出请求都必须经由管理员操作？

`migrations/001_init.sql` 建的 `policy_rules` 表**初始是空表**——策略引擎
（`src/policy/engine.ts`）的默认行为是**默认拒绝**（无任何匹配规则时 `deny`），
这是刻意的安全默认值：一个能访问全公司会议录音的归档工具，安全默认值优先于
可用默认值。这意味着**如果不手动插入至少一条规则，部署后没有任何人能导出任何
东西**（包括管理员自己）。

### 最小安全模板（推荐的初始配置）

只放行管理员，员工默认不能导出，符合默认 deny 的安全基线：

```sql
INSERT INTO policy_rules
  (priority, subject_type, subject_value, resource_expr, asset_types,
   effect, enabled, created_at, updated_at)
VALUES
  (100, 'user', '<管理员的腾讯会议 userid>',
   JSON_OBJECT(),           -- 空条件 = 匹配全部会议，不做任何范围限制
   JSON_ARRAY('*'),         -- 匹配全部八类资产
   'allow', 1, UNIX_TIMESTAMP(), UNIX_TIMESTAMP());
```

`subject_value` 填的是管理员的**腾讯会议 userid**（不是企微 userid；如果两者
不同，注意别填错——参考第 6 节）。可以插入多条这样的规则，给多个管理员分别
放行。

### 如果后续要放开员工自助导出

在最小安全模板基础上追加规则即可，不需要改动已有规则。例如「员工只能导出自己
主持的会议的录制视频/音频/文字摘要，AI 类纪要仍保留给管理员」：

```sql
INSERT INTO policy_rules
  (priority, subject_type, subject_value, resource_expr, asset_types,
   effect, enabled, created_at, updated_at)
VALUES
  (200, 'user', '<该员工的腾讯会议 userid>',
   JSON_OBJECT('host_userid', '<该员工的腾讯会议 userid>'),  -- 仅本人主持的会议
   JSON_ARRAY('video', 'audio', 'meeting_summary'),
   'allow', 1, UNIX_TIMESTAMP(), UNIX_TIMESTAMP());
```

`resource_expr` 支持的字段与写法见 `src/policy/expr.ts`：`host_userid` /
`meeting_code` / `meeting_id` / `subject` / `start_time` / `end_time`，取值可以
是字面量（等值）、数组（集合包含）、或 `{ "gte": ..., "lte": ..., "not_in": [...] }`
形式的区间/排除条件。同一优先级下 `deny` 优先于 `allow`，数字越小优先级越高。

**当前实现的重要限制**：`subject_type` 只支持 `user`（按单个腾讯会议 userid
精确匹配），`department` / `role` 两种维度**已经在表结构里预留了字段，但引擎
判定逻辑目前恒定返回不匹配**（见 `src/policy/engine.ts` 的 `subjectMatches`
注释），也就是说**不存在"整个部门"或"某个角色"这种批量授权方式**——如果要让
全体员工都能自助导出，目前只能对每个员工的腾讯会议 userid 各插入一条规则（可以
写脚本从 HR 花名册批量生成 INSERT 语句），直到组织架构数据接入、`department` /
`role` 匹配逻辑被实现为止。这是一处已知的能力缺口，见第 11 节。

---

## 8. 阿里云部署步骤

以最常见的「ECS + 自建 Docker + RDS」组合为例（容器服务 ACK / Serverless
应用引擎 SAE 思路类似，主要区别在于容器编排层，环境变量与镜像构建方式不变）：

1. **准备 RDS MySQL 实例**：按第 2 节建库、建账号、确认 `character_set_server`
   参数；记录连接地址、端口、账号密码；在 RDS 控制台的白名单里放行 ECS 的
   内网/公网 IP。

2. **构建镜像**：

   ```bash
   docker build -t meeting-export-gateway:<version> .
   ```

   本仓库的 `Dockerfile` 是多阶段构建：`deps` 阶段用
   `bun install --frozen-lockfile --production` 保证依赖版本与 `bun.lock`
   完全一致（不会因为依赖漂移导致「本地能跑、生产跑不起来」）；`release`
   阶段只拷贝 `src` / `scripts` / `migrations` / `package.json` 与生产依赖，
   不含测试代码、文档、`.env`，镜像体积更小、攻击面更小。

3. **推送到阿里云容器镜像服务（ACR）**：

   ```bash
   docker tag meeting-export-gateway:<version> registry.cn-<region>.aliyuncs.com/<namespace>/meeting-export-gateway:<version>
   docker push registry.cn-<region>.aliyuncs.com/<namespace>/meeting-export-gateway:<version>
   ```

4. **在 ECS 上运行容器**，通过环境变量或 `--env-file` 注入配置（**不要**把
   `.env` 打进镜像，也不要把它提交进代码仓库——`.gitignore` 已经排除了
   `.env` / `.env.*`，只保留 `.env.example` 作为模板）：

   ```bash
   docker run -d \
     --name meeting-export-gateway \
     --restart unless-stopped \
     -p 3000:3000 \
     --env-file /etc/meeting-export-gateway/.env \
     registry.cn-<region>.aliyuncs.com/<namespace>/meeting-export-gateway:<version>
   ```

   建议把真实的 `.env` 文件放在服务器上一个权限收紧的目录（如
   `/etc/meeting-export-gateway/.env`，`chmod 600`），不要放在代码仓库的
   checkout 目录里，避免被后续的 `git clean` / 误操作删掉或被其他人无意间读到。

5. **配置反向代理 + HTTPS**：网关本身只监听 HTTP（默认 3000 端口），需要在
   前面挂一层 Nginx / 阿里云 SLB / ALB 做 TLS 终止，把 `GATEWAY_BASE_URL`
   对应的域名解析到这一层。腾讯会议 Webhook 回调、企业微信登录跳转都要求
   HTTPS，直接暴露 HTTP 端口无法满足这两者。

   网关登录端点的限流（`/api/v1/auth/*`）依赖 X-Forwarded-For 判断客户端 IP，
   因此**这一层反向代理必须追加或覆盖 X-Forwarded-For**（Nginx 默认行为即是
   追加），且 `TRUSTED_PROXY_HOPS` 必须精确等于网关到公网之间会追加 XFF 的可信
   代理层数——填多了（大于实际层数）会取到客户端可伪造的 XFF 前缀段，限流可被
   绕过，是**安全问题**；填少了（小于实际层数）会把共享同一出口 IP 的不同客户端
   误伤合并进同一个桶，是**可用性问题**。不确定时宁可偏小，不要偏大。

6. **首次启动会自动建表**：`src/index.ts` 的 `main()` 里会在监听端口之前先跑
   `migrations/001_init.sql`（`runMigrations`），因此第一次启动稍慢属正常现象；
   之后每次重启都会重新执行一遍（建表语句是 `CREATE TABLE IF NOT EXISTS`，
   幂等，不会重复建表报错）。

7. **上线前跑一遍 preflight**（见第 9 节），全部转绿再切正式流量；上线后按
   第 7 节插入至少一条策略规则，否则没有人能真正导出任何文件。

8. **安全组**：ECS 安全组需要放行反向代理层到网关容器的端口（如果反向代理
   与网关同机部署，仅需放行本机回环即可，不需要对公网暴露 3000 端口本身）；
   出方向需要放行到 `api.meeting.qq.com`（443）、`qyapi.weixin.qq.com`
   （443）、以及 RDS 实例地址（3306）的访问。

---

## 9. preflight 自检脚本使用方法

```bash
# 最简单的用法：只跑到能跑的部分（配置 + 数据库 + 腾讯/企微凭证）
bun scripts/preflight.ts
# 或
bun run preflight

# 完整用法：连身份映射策略与 STS-Token Webhook 可达性也一起验证
bun scripts/preflight.ts \
  --sample-user <一个真实的企微 userid> \
  --sample-email <该用户的邮箱>   # 仅 IDENTITY_STRATEGY=email 时需要

# 容器内运行（部署到服务器后，验证服务器上的真实网络与凭证是否可用）：
docker run --rm --env-file /etc/meeting-export-gateway/.env \
  meeting-export-gateway:<version> bun scripts/preflight.ts --sample-user <真实企微 userid>
```

其他参数：

- `--skip-webhook-check`：跳过第 7 项（该项会向腾讯会议发起一次**真实的**
  STS-Token 生成请求，不是空跑；重复测试时如果不想反复触发真实请求可以加这个
  参数）。
- `--webhook-timeout-ms <毫秒数>`：第 7 项等待 Webhook 回调的超时时间，默认
  30000（即 30 秒）。

脚本会依次打印 9 个检查项（1、2、2b、2c、3、4、5、6、7）的结果，每项标注
`[PASS]` / `[FAIL]` / `[SKIP]`：

- `PASS`：已被真实验证为符合要求。
- `FAIL`：已经联系到目标系统（数据库/腾讯会议/企业微信），但收到的是一个明确
  的错误，脚本会给出具体的修复指引，照着改。
- `SKIP`：受限于当前运行环境（没有出网权限、缺少必要参数、或依赖的前置步骤未
  通过）而**无法**完成验证——不等于"已确认没问题"，只是这一次没条件测。最典型
  的场景是在没有公网出口的本地开发机上跑这个脚本，第 3/5/7 项会因为连不上
  `api.meeting.qq.com` / `qyapi.weixin.qq.com` 而被跳过；这种情况下必须在真正
  的部署环境里重新跑一遍，把这些项也确认为 `PASS`，才能认为已经完成校验。

脚本结尾会打印汇总（几项通过/失败/跳过）并给出总体判断；只要有 `FAIL`，退出码
为 1（可以直接接入 CI/CD 的部署前置检查步骤，`FAIL` 时阻断发布）。

---

## 10. 常见错误码对照表

### 腾讯会议 API（`error_info.error_code`）

分类依据是响应体里的 `error_code`，**不是 HTTP 状态码**——HTTP 状态码只有 400
（请求错误）和 500（服务错误）两种取值，承载不了下面的区分。

| error_code | 含义 | 处理方式 |
| --- | --- | --- |
| 9042 | 权限受限或鉴权失败 | 立即失败，不重试。检查 `TM_SECRET_ID` / `TM_SECRET_KEY` 是否正确，以及应用是否被授予相应权限。 |
| 500014 | 账号无权限 | 立即失败，不重试。检查 `TM_OPERATOR_ID` 对应账号在企管后台是否具备「管理企业录制」/「查看企业录制」权限。 |
| 190004 | 参数非法 | 立即失败，不重试。属于网关自身的实现问题，上报开发者。 |
| 200001 | 请求头缺失必填字段 | 立即失败，不重试。属于网关自身的实现问题，上报开发者。 |
| 190301 | 请求重放（nonce/timestamp 校验失败） | 瞬时错误，指数退避后重新生成 nonce/timestamp 重试。**若持续出现**，检查服务器系统时钟，与标准时间的偏差必须 < 5 分钟。 |
| 190303 | 鉴权失败（AppId / X-TC-Key 相关） | 检查 `TM_APP_ID` 与 `TM_SECRET_ID` 是否正确、是否互相匹配；若应用未分配 SdkId 则不要携带 `TM_SDK_ID` 对应的签名头。（本表的实测发现，非设计文档原有清单项，供参考。） |
| 190310 | 调用超限 | 瞬时错误，指数退避重试，且额外收敛令牌桶速率（`TM_QPS`）。 |
| 4051 | 录制文件已删除 | 资产级永久错误，跳过该资产，不影响其他资产/会议。 |
| 4049 | 记录不存在 | 资产级永久错误，跳过该资产，不影响其他资产/会议。 |

完整错误码列表以腾讯会议开放平台官方文档为准：
<https://cloud.tencent.com/document/product/1095>。

### 企业微信 API（`errcode`）

| errcode | 含义 | 处理方式 |
| --- | --- | --- |
| 0 | 成功 | — |
| 40001 / 40125 | secret 不正确或已过期 | 检查 `WECOM_SECRET`；管理员在后台重置过 Secret 后旧值会立即失效。 |
| 40013 | corpid 不正确 | 检查 `WECOM_CORP_ID` 是否与「我的企业」页面显示的企业 ID 一致。 |
| 40014 | access_token 不正确 | 通常是缓存的 token 已失效，网关内部会自动重新获取（`src/auth/wecom.ts` 有 5 分钟提前过期的缓冲），持续出现需排查系统时钟。 |
| 42001 | access_token 已过期 | 同上。 |

完整错误码列表以企业微信官方文档为准：
<https://developer.work.weixin.qq.com/document/path/90313>。

### 网关自身返回给客户端的错误

| HTTP 状态 | `error` 字段 | 含义 |
| --- | --- | --- |
| 400 | `authorization_pending` / `slow_down` / `expired_token` / `invalid_request` | 设备授权流程（RFC 8628）标准错误码。 |
| 401 | `invalid_refresh_token` / `refresh_token_reused` / `refresh_token_expired` / `invalid_credentials` / `verification_failed` | 认证失败；`refresh_token_reused` 表示检测到令牌复用，已连坐吊销整条轮换链，需要用户重新登录。 |
| 403 | `account_not_provisioned` | 身份映射失败（见第 6 节）——企微账号在腾讯会议侧没有对应账号，是配置问题，不是权限判定结果，需联系管理员补齐映射。 |
| 404 | `meeting_not_found_in_range` / `not_found` | 查询范围外未命中，或路由不存在；出于「不暴露是否存在」的考虑，无权限时也复用这个响应形状，不单独返回 403。 |
| 500 | `internal_error` | 网关自身异常，查服务日志。 |

---

## 11. 上线前必须确认（已知技术债）

以下几点是前序任务在实现过程中留下的、**明确记录在案、尚未解决**的简化/假设，
不是隐藏的坑——但如果不在上线前逐条确认，可能会在生产环境里变成真正的问题。
按风险从高到低排列：

1. **Webhook 回调的线路格式未经腾讯官方文档核实**
   （`src/http/handlers/webhook.ts`，`src/sts/manager.ts`）。当前实现约定为
   `POST /webhook/tencent-meeting?timestamp=&nonce=&signature=`，密文放在请求体
   `{ "encrypt": "..." }` 里——这是参照企业微信回调的通行做法自行设计的约定，
   **未对照腾讯会议官方《事件回调》文档逐字核实字段名与位置**。上线前必须找到
   官方文档或用腾讯会议企管后台的"测试回调"功能实际验证一次，确认字段名/位置
   完全吻合，否则 Webhook 会一直收不到回调，表现为 preflight 第 7 项持续超时。

2. **事件加解密算法（`decryptEvent`）细节是通用企业回调惯例，非腾讯官方文档
   确认**（`src/sts/crypto.ts`）。当前实现用的是 sha1 字典序拼接签名、
   AES-256-CBC（key 的前 16 字节兼作 IV）——这是企业微信等平台的通行加密方案，
   代码注释里明确标注为"先建立可替换单元、后续对照官方文档调整"。需要对照
   《事件加解密文档》（<https://cloud.tencent.com/document/product/1095/54658>）
   核实是否与腾讯会议官方实现完全一致。

3. **STS-Token 落库前的加密不是真正的 KMS 托管**（`src/index.ts` 的
   `createTokenCipher`）。当前用 `AES-256-GCM`，密钥由 `SHA-256(JWT_SECRET)`
   派生，是一个明确标注的"最小可用实现"。设计文档要求"使用阿里云 KMS 托管或
   等效的密文存储"——生产部署前应替换为真正的 KMS 密钥托管，而不是从
   `JWT_SECRET` 派生一个静态密钥（一旦 `JWT_SECRET` 泄露，STS-Token 密文也会
   一并失守）。

4. **登录端点限流已实现，但为进程内内存桶**（`src/http/ratelimit.ts`、
   `src/http/router.ts`、`src/http/handlers/auth.ts`）。写型登录端点
   （`device/code`、`device/token`、`service-token`、`refresh`）已按 IP 维度限流，
   `service-token`/`device/token` 另加 `client_id`/`device_code` 账号维度限流；
   服务账号校验为恒定时间比较（消除账号枚举的时序旁路）。**遗留特性**：限流桶是
   进程内内存、不跨实例共享——N 个实例后方聚合放行速率为单实例的 N 倍（仍有界）。
   分布式暴力的外层防线仍建议由反向代理层（Nginx/SLB/WAF）承担；若需强一致的
   跨实例限流，可把 `createRateLimiter` 换成基于 Redis/DB 的实现，`allow(key, now)`
   接口不变。另见 `TRUSTED_PROXY_HOPS`（第 5 节）——限流按 X-Forwarded-For 判 IP，
   该值必须与实际可信代理层数一致。

5. **`meeting_cache` 表没有 TTL/清理策略**（`migrations/001_init.sql`）。这张
   表用于支持 download-url 端点重建会议元数据（详见表定义上方的注释），写入
   是 `ON DUPLICATE KEY UPDATE`，只会更新不会清理陈旧记录。当前判断数据量级
   可接受（会议元数据本身很小，系统也不会有海量历史会议持续访问），但没有做
   过容量增长评估，长期运行后建议定期评估表大小。

6. **`policy_rules` 的 `subject_type` 目前只实现了 `user`**
   （`src/policy/engine.ts`）。`department` / `role` 两个维度已经在表结构里
   预留，但判定逻辑恒定返回不匹配——见第 7 节的详细说明，批量授权（按部门/
   角色放行）目前不可用，只能逐用户配置。

7. **`Asset` 不含 `meetingRecordId`，`download-url` 对 video/audio/
   meeting_summary 类型依赖进程内索引**（`src/catalog/index.ts`）。这些资产
   类型解析下载地址时，要求同一个 `Catalog` 实例此前对该会议调用过
   `listAssets`（用于建立 `recordFileId -> meetingRecordId` 的内存索引）。
   在网关多实例部署、且没有粘性会话（sticky session）的情况下，如果"列会议"
   与"取下载地址"两次请求被负载均衡到不同实例，取下载地址会失败并抛出
   `AssetNotIndexedError`。当前网关是无状态水平扩展设计，这个限制与该设计目标
   存在张力，建议上线前评估实际流量下命中该问题的概率，或在后续迭代给
   `Meeting`/`Asset` 补上 `meetingRecordId` 字段以彻底解决。

8. **`GET /v1/addresses`（错误码前缀 51174 相关接口）的响应字段名是推断得出，
   未逐字对照官方文档核实**（`src/tencent/addresses.ts`）。推断依据是
   `/v1/records` 已确认的响应命名风格与既有 fixture，但没有拿到官方文档原文
   逐字核对，建议用真实响应验证一次。

9. **`/device` 验证页面不存在，登录全流程有一段"断档"**
   （`src/auth/device.ts` 返回的 `verification_uri` 指向 `${baseUrl}/device`，
   但网关的路由表——`src/http/router.ts`——里没有这个端点）。设计上完整的登录
   流程需要一个页面把 `user_code` 解析回 `state` 再跳转到企微授权页，这个页面
   目前既不在网关也不在任何已知的客户端项目里实现。上线前需要明确谁来提供这个
   页面（网关补一个端点，还是由桌面端/CLI 客户端承担），否则设备授权登录流程
   走不通。

10. **`download-url` 成功响应目前只有 `{ url, expires_at }`**，缺少设计文档
    提到的 `file_type` / `bytes_expected` 字段（`catalog.resolveDownloadUrl`
    本身的返回值就没有这两个字段）。如果下游客户端依赖这两个字段做进度展示或
    文件类型判断，需要先补齐。

以上各项在对应任务的报告（`.superpowers/sdd/task-*-report.md` 的"疑虑"章节）
里有更详细的背景说明，本节只做面向部署决策的摘要。这份清单本身不追求穷尽——
如果发现清单外的问题，同样应该在上线前评估风险后再决定是否阻断发布。
