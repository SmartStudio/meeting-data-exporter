# 周期会议按录制记录拆场次 · 上线 runbook（2026-09-09）

依据：`docs/superpowers/specs/2026-09-09-recurring-meetings-by-record-design.md` §2.5。
本机实测基数：86 场「会议」装着 232 条录制记录，销售日会 6 个场次挤在一行里。

**这份 runbook 的顺序不是建议，是硬约束**：拆分脚本必须跑在新代码的**第一轮
`fetch_recordings` 之前**（见第 1、2 节与第 7 节「混合状态」）。

## 0. 上线前必须知道的三件事

### 0.1 顺序：脚本要抢在调度器第一轮之前

新代码的 `fetch_recordings` 会按场次（`sub_meeting_id = meeting_record_id`）**新建**
`meetings` 行。一旦某场会议下已经有了这样一行，库里就同时存在「一条老的 `''` 行」和
「若干条新的场次行」——拆分脚本管这叫**混合状态**，整场判 `undecidable` 原地不动，
输出里是这一句：

```
⚠ <meeting_id> undecidable：会议 <id> 已有按场次的行（N 条），拆分脚本必须在新代码
  首轮拉取之前跑；请按 runbook 先停服务，删掉这些场次行及其下载文件后重跑
```

它不猜，是因为两套目录序号（老 `''` 行算一套、新场次行算另一套）在这种状态下会打架，
猜错的代价是把已经装着文件的目录改名。**收拾办法见第 7.1 节。**

所以：**部署代码 → 跑脚本 → 才起调度器**。网关可以先起（它只跑迁移、不建场次行），
但更省事的做法是两个都等脚本跑完再起。

### 0.2 audit_log 的已知损失

`audit_log` **没有** sub 列，延长保留期那条审计把场次编在 `asset_id` 里
（`sub:<subMeetingId>`，见 `src/store/audit.ts` 的 `auditSubMeetingAssetId`）。拆分
**不动这张表**，于是拆分之前记下的那些延长记录仍然挂在 `sub:` 上——控制台抽屉里
「延长过 N 次」这一行，对拆分**之前**的延长记录，每个场次都显示不到。

**这是有意接受的损失，不是 bug**：给 audit_log 补一列 sub 要重写一张只增不减的审计表，
而它换来的只是几条历史记录的归属。`meeting_archives.extended_days` 那一列（真正决定
保留窗口的那个数）**是**按场次复制过去的，到期时间不受影响。

### 0.3 有归档行、却一条归档资产都没有的会议，保留期字段会丢

脚本判「这个场次要不要复制 `meeting_archives` 行」看的是「它有没有搬得动的 NAS 归档
资产」。于是一种边角情况：某场会议 `meeting_archives` 有行、`archived_assets` 一条都
没有——那一行会被**删掉而不复制给任何场次**，它的 `retention_days` 与人工延长的
`extended_days` 一起丢。这种会议在 NAS 上本来就什么都没有（归档是先写
`archived_assets` 再写 `meeting_archives`），本机与生产上都没见过。上线前查一眼：

```sql
SELECT a.meeting_id, a.sub_meeting_id, a.retention_days, a.extended_days
  FROM meeting_archives a
  LEFT JOIN archived_assets b USING (meeting_id, sub_meeting_id)
 WHERE a.sub_meeting_id = '' AND b.meeting_id IS NULL;
```

有命中就把这几行的 `retention_days` / `extended_days` 抄下来，拆完之后手工补回去。

## 1. 停

生产服务端在 `/home/ubuntu/mde/app`，**没有 systemd unit**，网关与调度器是 ubuntu
用户下两个直跑的 bun 进程。**两个都要停**——搬文件期间任何一个还在写那些目录，
结果就是一半文件落进旧目录。

```bash
ssh ubuntu@<server>
ps -ef | grep -e 'bun src/index.ts' -e 'bun src/worker/scheduler.ts' | grep -v grep
pkill -f 'bun src/worker/scheduler.ts'     # 调度器：它才是会新建场次行的那个
pkill -f 'bun src/index.ts'                # 网关
ps -ef | grep bun | grep -v grep           # 确认真的没了再往下走
```

**本机（Mac）如果开着调度器也一起停**，理由有两条，缺一不可：

- 它同样会往归档目录里写，与脚本抢文件；
- **STS token 全局单例**——本机与服务器同时跑，后申请的那个会把先申请的打成「非法」，
  回调只到其中一台（见 memory `sts-single-active-token-per-app`）。所以第 4 节起服务器
  的调度器**之前**，必须先确认本机的已经停了。

**本机（Mac）库里同样有存量的 `''` 行。** 它和生产是两套库，脚本跑生产不会动本机。
所以本机只有两条路，二选一：

- 也按第 3 节对本机库跑一遍脚本（`DATABASE_URL` 指本机、`MDE_ARCHIVE_ROOT` 指本机归档区）；
- 或者**本机调度器保持停用**，直到本机库也拆过。

否则本机首轮 `fetch_recordings` 会在那些 `''` 行旁边新建按场次的行，本机库当场进入
混合状态（§0.1），再想拆就得先按 §7.1 收拾。**跑脚本之前本机这三个进程都要停**：
网关（`:3100`）、调度器、以及控制台的 vite dev server。

```bash
lsof -ti :3100 | xargs -r kill              # 本机网关
pkill -f 'bun src/worker/scheduler.ts'      # 本机调度器
pkill -f 'vite'                             # console 的 dev server
```

顺手备份：

```bash
mysqldump <db> meetings meeting_assets archived_assets meeting_archives \
  meeting_grants meeting_overrides asset_contents meeting_asset_probes \
  job_failures meeting_cache \
  > backup-2026-09-09.sql
```

## 2. 部署新代码（**先别起服务**）

```bash
cd /home/ubuntu/mde/app && git pull && bun install && bun run typecheck
cd console && bun run build && cd ..
```

迁移**不必手工跑**：拆分脚本自己会先 `runMigrations`（幂等），网关启动时也会跑一遍。
本次相关的是 `migrations/013_meeting_cache_sub_meeting_id.sql`——把
`meeting_cache.sub_meeting_id` 回填成主键上那个 `meeting_record_id`。

## 3. 拆存量数据

```bash
export DATABASE_URL='mysql://…/mde'
export MDE_ARCHIVE_ROOT=/data/mde-archive        # 本地归档区根目录
# NAS 基准目录不用给：脚本从 meeting_archives.nas_dir / archived_assets.nas_path 自己反推

bun scripts/split-recurring-meetings.ts 2>&1 | tee split-dry-$(date +%s).log
```

**先看 dry-run 的输出**，逐条确认：

- 每场会议列出的场次数与你在控制台上看到的日会次数对得上；
- `undecidable` 的那几场，逐条看理由（脚本会把理由整句打出来）：会议已有按场次的行
  = 混合状态（见 7.1）/ NAS 基准目录讲不清（`nas_dir` 与从 `nas_path` 反推的对不上）/
  有 `archived_assets` 行却反推不出 NAS 基准目录（没有 `meeting_archives` 行，
  `nas_path` 又短到砍不出前四段）/ `archived_assets` 行对不上任何 `meeting_assets` 行 /
  `asset_id` 是空的 / `asset_type` 不在引擎的资产词汇表里 / `archived_assets.local_path`
  与 `meeting_assets.target_path` 不一致 / record id 在 `meeting_cache` 里查不到 /
  `meeting_cache` 里没有这个 `meeting_id` 的任何场次（资产也反推不出 record id）/
  两个场次算出同一个目录 / 两个资产算出同一个新路径。
  **不要绕过它们**——退出码 2 就是让你停下来看这个的。
  其中两条「归档行对不上」的理由（反推不出 NAS 基准目录、对不上任何 `meeting_assets`
  行）指向同一件事：拆了会把那些 `archived_assets` 行留在空 `sub_meeting_id` 上，
  挂在一个**已经不存在的会议**下（`meetings` 的 `''` 行同一个事务里就删了），
  之后谁也扫不出来。
- 输出里有 `‼ NAS 基准目录不存在：…` 的话，是 NAS 没挂上。dry-run 只警告不中止，
  `--apply` 会直接退出码 2、一场都不动。挂好再来。

`dry-run` 的最后一行长这样，**它遇到 undecidable 同样返回退出码 2**（计划本身有问题，
不该让 `&&` 串起来的下一条命令当成「计划没问题」接着往下走）：

```
dry-run：N 场会议待拆（其中 M 场说不清），加 --apply 执行
```

确认无误后：

```bash
bun scripts/split-recurring-meetings.ts --apply 2>&1 | tee split-$(date +%s).log
```

退出码：

| 码 | 含义 | 该做什么 |
| --- | --- | --- |
| 0 | 全部处理完，没有要人看的，**而且最后一行的「剩余未拆的会议」是 0** | 翻一遍日志找 `left_over`（见下），没有就起服务 |
| 1 | 有会议跑炸了（`failed=N`）而库里已经一行不剩；那几场**已经逐场回滚干净** | 看日志里的 `failed：…`，修掉原因后重跑（脚本幂等、可重复跑） |
| 2 | 有 `conflict` / `undecidable` / `finish_failed`；**或者跑完还剩 `sub_meeting_id = ''` 的行**；或者环境不对（缺 `DATABASE_URL` / `MDE_ARCHIVE_ROOT`、`MDE_ARCHIVE_ROOT` 不存在、NAS 没挂上） | **先别起服务**，按日志逐条人工确认 |

**退出码 0 的含义是「没有要人看的**并且**一行没拆的都不剩」。** 脚本最后一行就是这个数：

```
剩余未拆的会议：N（起服务前必须为 0）
```

`N > 0` 时 `--apply` 一律返回 2——这一条把 `not_found`（本地文件被到期清理删过，
它自己不进退出码）、`conflict`、`undecidable`、`failed` 留下的行**一网打尽**：
只要还有 `''` 行，起服务之后首轮拉取就会在它旁边新建按场次的行，库当场进混合状态
（§0.1），再想拆得先按 §7.1 收拾。dry-run 也打这一行，但不改它的退出码。

> 因此实践中**退出码 1 几乎见不到**：跑炸的那场会议 `''` 行还在，剩余数不为 0，
> 退出码会是 2。日志里的 `failed=N` 仍然分得清是哪一档。

汇总行：

```
renamed=… already_done=… not_found=… conflict=… undecidable=… finish_failed=… failed=… left_over=…
```

**`left_over` 不进退出码**。它是「旧目录搬空了，但里面还有不认识的东西，所以目录被
保留了」的条数，只打在 stderr 上：

```
⚠ 旧目录里还有不认识的文件，已保留：<路径>
```

**退出码 0 不代表没有 `left_over`——必须把日志翻一遍。** 逐个去看那些目录里剩下的是
什么，确认可以删了再手工删（脚本绝不删非空目录）。

每场一段的输出：

```
<meeting_id>
  <旧目录>
  → <record id>→<新目录>（N 个资产）
  → …
  ok（renamed）                        # 或 ok（already_done）：盘上早就是那个样子，这一次只补库
  conflict：目标已被别的东西占着，未动     # 这一场原地没动，库一列没改
  not_found：新旧位置都找不到这些文件      # 这一场原地没动
```

## 4. 起

**起之前的硬门槛**（脚本最后一行说的就是它，这里再自己查一遍）：

```sql
SELECT COUNT(*) FROM meetings WHERE sub_meeting_id = '';   -- 必须是 0
```

不为 0 就**别起**：首轮 `fetch_recordings` 会在那些行旁边新建场次行，库进混合状态。
先回第 3 节把剩下的拆完（或按 §7 逐条收拾）。

**本机同理**：本机库要么也拆过、要么本机调度器保持停用（见第 1 节末尾那一段）。
起服务器调度器之前再确认一次本机的调度器已经停了（STS token 全局单例）。

先起网关，再起调度器。

```bash
cd /home/ubuntu/mde/app
nohup bun src/index.ts            >> logs/gateway.log   2>&1 &
nohup bun src/worker/scheduler.ts >> logs/scheduler.log 2>&1 &
ps -ef | grep bun | grep -v grep
```

首轮 `fetch_recordings` 会按场次重建探测行与本地清单（`_manifest.json` / `meeting.json`）。
盯一轮日志：不该出现 `InvalidAssetIdError`，也不该出现整轮失败。

## 5. 验收

```sql
-- ① 周期会议已经拆开：这条要有行
SELECT meeting_id, COUNT(*) FROM meetings GROUP BY 1 HAVING COUNT(*) > 1;
-- ② 一行空 sub 都不许剩
SELECT COUNT(*) FROM meetings WHERE sub_meeting_id = '';
-- ③ 没有资产孤儿（资产指向的会议行必须在）
SELECT COUNT(*) FROM meeting_assets a
  LEFT JOIN meetings m USING (meeting_id, sub_meeting_id) WHERE m.meeting_id IS NULL;
```

①有行、②为 0、③为 0。

界面上：控制台会议列表里「销售日会」按日期一场次一行，每行资产计数 6；失败项、
清理清单、程序库存这些地方会开始显示「· 场次 \<一串纯数字\>」——那串数字就是腾讯的
`meeting_record_id`，是对的。

盘上：

- 每个场次目录里 `transcript.txt` / `minutes.md` / `chapters.json` **不带 `_2` 后缀**
  （除非同一场次真有多个录制文件——那是文件名序号，与下面的目录序号是两回事）；
- **目录名**末尾的 `_2` / `_3` 是另一回事，它是**同一场会议、同一起始分钟的第二条
  录制记录**（腾讯常给的「转写\_」孪生记录；本机库 294 场会议里有 84 组、168 条记录
  落在同一 `(meeting_id, 起始分钟)`）。序号按**首次发现时间** `meetings.created_at`
  升序钉住，同一批发现的再按 record id 升序——**先到的那条保住无后缀的原名**，
  后来者才拿 `_2`。看到 `…_1430_881` 与 `…_1430_881_2` 并排，是预期结果，不是重复目录。

抽一场孪生记录的会议对一下：

```sql
SELECT sub_meeting_id, created_at, subject FROM meetings
 WHERE meeting_id = '<某场周期会议>' ORDER BY created_at, sub_meeting_id;
```

## 6. 回滚

**没有自动回滚**。脚本是逐场会议的事务 + 文件搬运，一场一场地成，中途停下来的
后果是「一部分会议拆了、一部分没拆」——这两种状态新代码都认（`sub_meeting_id = ''`
在读路径上仍然被容忍）。所以真出事时的动作是**停下来查**，不是往回退。

要退代码的话：旧代码读拆完的库同样能跑（它只是把每个场次当成一场独立会议），
唯一失去的是「按 sub 点名查」那个新 query 参数。库不必回滚。

## 7. 出事了怎么办

### 7.1 混合状态（`undecidable：… 已有按场次的行`）

调度器抢在脚本前面跑过一轮 `fetch_recordings` 了。**新建的那些行与它们下载下来的
文件必须先清掉**，脚本才有干净的起点：

1. 确认网关与调度器都停了（第 1 节）。
2. 列出这场会议下的行，分清哪些是脚本要拆的老行（`sub_meeting_id = ''`）、
   哪些是引擎新建的场次行：

   ```sql
   SELECT sub_meeting_id, created_at FROM meetings
    WHERE meeting_id = '<mid>' ORDER BY created_at;
   SELECT sub_meeting_id, asset_type, status, target_path FROM meeting_assets
    WHERE meeting_id = '<mid>' AND sub_meeting_id <> '';
   ```

3. 把 `target_path` 指到的那些文件删掉（引擎重跑会重新下），再按
   `(meeting_id, sub_meeting_id)` 删掉这些**新建场次**的行：`meeting_assets`、
   `meeting_asset_probes`、`asset_contents`、`archived_assets`、`meeting_archives`、
   `meeting_grants`、`meeting_overrides`，最后删 `meetings`。
   **只删 `created_at` 明显晚于那条 `''` 行的新场次行**，`''` 那一行留着——它正是
   脚本要拆的对象。
4. 重跑脚本（先 dry-run）。这场会议应当从 `undecidable` 变成正常的待拆项。

### 7.2 `*.mde-split-tmp` 残留

脚本搬文件分两阶段：先把全部源文件就地改名成 `<原路径>.mde-split-tmp`，再从 `.tmp`
各就各位（拆场次天然有「A 的目标就是 B 的源」这种交换，一阶段直排解不了环）。
两阶段之间进程被杀（`kill -9`、断电）时，文件会停在 `.mde-split-tmp` 上。

**重跑会把这一整场判成 `conflict` 并原地不动**（退出码 2），日志里是这一句：

```
⚠ <mid> conflict：<路径>.mde-split-tmp 已经存在——上一次跑多半在两阶段搬运之间被
  杀掉了，文件还停在这个暂存名上。先手工去掉 .mde-split-tmp 后缀把它改回去，再重跑本脚本
```

这道闸排在「新旧位置都不在 → `not_found`」**之前**，所以源路径已经空掉的那种残留
（第一阶段之后被杀）也拦得住——不然这一场会被判成 `not_found` 悄悄溜过去，
下一轮 worker 照着库里的旧路径重新下载，而那份唯一的副本永远晾在 `.tmp` 上。

收拾（把它改回原名，再重跑；脚本会正常拆这一场）：

```bash
find "$MDE_ARCHIVE_ROOT" <nas_dir> -name '*.mde-split-tmp'
# 逐个去掉 .mde-split-tmp 后缀改回原名（就是日志里那一场的旧路径），再重跑脚本
```

正常结束（包括事务失败、`conflict`）的路径上不会留下 `.tmp`：脚本自己会把文件搬回原位。

### 7.3 `conflict`

两种来源，日志里分得清：

- `conflict：目标已被别的东西占着，未动`——新目录里已经有一个不是这场会议搬过去的
  文件。手工看两个目录，确认怎么合并之后再重跑。
- `⚠ <mid> conflict：改 sub_meeting_id 撞上唯一键（…），已回滚、文件搬回原位`——
  目标自然键上已经有别人的行（`meeting_assets.uk_asset` / `archived_assets` /
  `asset_contents` 的主键）。**不要重跑指望它自愈**，重跑会撞同一行；先去看那一行
  是谁写的（多半又是混合状态的残留，见 7.1）。

两种情况下这一场都是原地没动：文件在原位、库一列没改。

### 7.4 `failed=N`

那几场已经逐场回滚干净（事务回滚 + 文件搬回原位），别的会议照常拆完了。修掉日志里
写的原因，直接重跑——脚本只处理 `sub_meeting_id = ''` 的行，自消耗、可重复跑。

例外一，这一行：`‼ <mid> 事务回滚失败：…`。回滚本身也失败了，库可能停在中间态，
**这一场必须人工核对**（对着备份看 `meetings` / `meeting_assets` 那几张表），
不要盲目重跑。

例外二，`已提交，收尾失败：…（不会重跑，按日志手工收尾）`（汇总行里的
`finish_failed=N`，退出码 2）。这一场**库已经提交、文件也已经搬好**，只是收尾那两步
（重写 NAS 侧车 / 清掉搬空的旧目录）里有一步炸了。**重跑修不了它**——这一场的 `''` 行
已经没了，脚本再跑一遍一步都走不到它。人工要做的只有两件：

- 清掉日志里那个搬空了的旧目录（先看一眼里面剩下什么，脚本绝不删非空目录）；
- NAS 侧车（`<nas_dir>/_manifest.json` 与 `meeting.json`）不用手写，**下一轮归档会自己
  按新场次重写**，等一轮即可。
