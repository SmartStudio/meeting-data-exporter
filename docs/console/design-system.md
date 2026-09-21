# 控制台设计系统

- 令牌文件（权威）：`console/src/styles/tokens.css`
  > 这里原先写着「94 个令牌」。这个数字已经错过三次，所以不再写死。
  > 要准确数目就数 `console/src/styles/tokens.css` 里的 `--` 声明，
  > 文档里的数字会随代码腐烂，腐烂时没人知道。
- 令牌文件（快照，不再跟着改）：[`prototype/tokens.css`](prototype/tokens.css)
- 原型（行为仍以此为准）：[`prototype/gate-console.html`](prototype/gate-console.html)
- 组件实现：`console/src/ui/`（基元）、`console/src/app/`（外壳）、`console/src/pages/`（页面）
- 门槛脚本：`cd console && npm run a11y`。其余脚本见 `console/package.json`：
  `dev` · `build` · `preview` · `test` · `typecheck` · `a11y` · `vqa`

令牌的权威在 `console/src/styles/tokens.css`。`prototype/tokens.css` 与原型 HTML 里的
内联令牌块是历史快照，只用于回看，不再跟着改。行为规格仍以原型为权威
（`docs/console/spec.md` §0），只有令牌这一项转移了权威。

---

## 1. 三条硬规矩

1. **组件里不许出现裸的 px / hex / rgba。** 缺什么值就来令牌文件里加一个具名令牌，
   不在组件里写死。原型重构前有 105 个互不相同的 padding 取值，改一处间距要在里面
   翻半天。
2. **`--ink-4` 是图形专用**（描边 / 分隔 / 填充）。它在白底上只有 3.72:1，
   用于文字必然不达 AA。文字梯度到 `--ink-3` 为止。
3. **颜色只在令牌文件里定义**，组件永远只引用令牌名。不要把颜色写进 `@media` 或
   `[data-theme]` 块，那样的颜色在「跟随系统」状态下不会生效。

---

## 2. 颜色

### 2.1 品牌与中性

取自 Logo：`#0066FF` / `#000000` / `#FFFFFF`。

中性色是把品牌蓝抽掉饱和度得到的冷灰（色相 222），从品牌里长出来。
`npm run a11y` 的语义色守卫按这条判：中性令牌的通道极差超过 40 就判失败，
极差 ≥6 时色相必须落在 190-262° 区间内。

| 令牌 | 浅色 | 用途 |
| --- | --- | --- |
| `--ground` | `#F2F3F5` | 页面底 |
| `--surface` | `#FFFFFF` | 卡片 / 表格底 |
| `--surface-2` | `#F8F9FA` | 表头 / 次级面 |
| `--rail` | `#E9EDF4` | 骨架屏与审计页的填充块 |
| `--line` / `--line-soft` | | 分隔线两档 |
| `--ink` / `--ink-2` / `--ink-3` | | 文字三档 |
| `--ink-4` | `#7C8595` | 图形专用，禁止用于文字 |

左栏是一条暗带，单独一组令牌，不参与上面的中性梯度：`--nav` / `--nav-2` /
`--nav-line` 是面与线，`--nav-ink` / `--nav-ink-2` / `--nav-ink-3` 是压在它上面的
文字三档，`--nav-fail` 是「定时任务」旁那颗红点（`--fail` 压在 `--nav` 上只有 2.98:1，
不到图形 3:1 的下限，所以另给一个值）。导航压暗之后，内容区是整屏唯一的亮面。

早前的表格把 `--rail` 写成左栏底色。改暗带之后 `--rail` 只用于填充块，左栏底色是
`--nav`。

深色模式下这条暗带与主区的关系不能用对比度去量：两块近黑的面之间对比度恒在 1.0
附近。看的是明度台阶，深色那一组按 L* = 3.3 / 7.6 / 11.7 / 15.0 排开
（`--nav` / `--ground` / `--surface` / `--surface-2`），每档约 4 个 L*。

### 2.2 三个语义色，各自只有一个含义

| 色 | 含义 |
| --- | --- |
| 蓝 | 数据可被取走 / 主交互 |
| 琥珀 | 有人手动改写了规则，或保留期快到了 |
| 红 | 失败。归档失败意味着一个月后永久丢失，是本系统最严重的状态 |

这三个色的含义是产品语义的一部分，不要为了好看把琥珀用在别处。
`npm run a11y` 按色相带、饱和度下限、以及三色两两色相差 ≥25° 守着它们。

**`deny`（规则明确拒绝采集）用中性，不用琥珀。**（2026-08-24 裁定，原型的着色作废）
琥珀的两个含义都意味着「这需要你看一眼」，而一条 deny 规则命中说明规则系统在正确
地干活。原型里的实例是「标题含面试/薪酬/绩效 → 禁止采集」，那是刻意配置的隐私规则，
绝大多数被拒的会议是故意且永久被拒的。把它画成琥珀，一个配了这类规则的组织就会有
一大片行永久琥珀，真正该被看见的琥珀（有人绕过了规则、还剩三天到期）会淹没在里面。

「允许」与「拒绝」的区分由明确的文字承担（「规则禁止采集」对「未归档」），
在有 `AllowState` 圆点的页面上再加一层圆点。理由文字本身不着色。

> 订正（2026-08-24）：本节原先只说「是 `AllowState` 圆点的职责」，但会议记录页
> 每行只有 fetch / archive 两颗圆点，没有 allow 圆点。deny 改中性之后，那一页
> 全靠文字区分两者。这是可接受的（不依赖颜色单独承载语义，对无障碍反而更好），
> 但原来那句话描述的不是实际形态，会让人以为有一颗并不存在的圆点在兜底。

### 2.3 成对的 on- 色

压在实底上的字必须用成对令牌，不能写死白色：

| 令牌 | 压在 | 为什么不能写死 |
| --- | --- | --- |
| `--on-brand` | `--brand` | 深色模式下 `--brand` 变浅，白字只有 3.47:1 |
| `--on-fail` | `--fail` | 深色模式下 `--fail` 变浅红，白字只有 2.52:1 |
| `--accent-invert` | 反相表面（toast / batch / tip） | 那块底跟主题反向：浅色模式下是近黑要亮蓝，深色模式下是近白要深蓝 |

`npm run a11y` 的 `PAIRS` 一条条量这些组合，含焦点环压在卡片底、页面底、填充块底
与左栏暗带底上的 3:1。

### 2.4 内容表面（不跟随主题）

播放器和代码块刻意不跟随主题，它们是「内容本身」的底，不是界面的底。
那也是一组具名令牌（`--video-*` / `--code-*`），不是散落的 `rgba(255,255,255,.72)`。

---

## 3. 排版

### 3.1 字体

```css
--sans: "Archivo", "Noto Sans SC", -apple-system, ..., sans-serif;
--mono: "IBM Plex Mono", ui-monospace, ..., monospace;
```

**顺序不能反。** Archivo 零 CJK 覆盖，只吃拉丁字母和数字，中文由紧随其后的
Noto Sans SC 接管。反了拉丁字也会落到 Noto 的西文上，那套西文和 Archivo 不是
一个骨架。

加载：

```
fonts.googleapis.com/css2
  ?family=Archivo:wght@400;500;600;700
  &family=IBM+Plex+Mono:wght@400;500;600
  &family=Noto+Sans+SC:wght@400..700
  &display=swap
```

Noto Sans SC 走变体字重区间 `400..700`，不要展开成四个静态字重。中文按
unicode-range 切成上百个分片，静态字重会让请求数翻四倍。

实测成本：首屏 Noto Sans SC 拉了 15 个分片、818 KB（总字体 912 KB）。
强缓存后只有首访付这个钱。要压下来的路子是自托管加两层子集：界面文案固定
（约 800 字）可子集化到 30-50 KB 立即加载，会议标题那层懒加载。这是部署决策。

### 3.2 中文排版规矩

- 不用 uppercase，不用宽字距。那是拉丁字母的排版手法，套在方块字上会让字散开
- 不用负字距。负字距是给拉丁 display 字挤紧的，压在方块字上只会挤成一团。
  唯一例外是等宽数字（`--mono` 的大号数字），那里 `-.02em` 是对的
- 等宽字体只用于数字、路径、标识符
- 行高三档 `--lh-tight` 1.35 / `--lh` 1.55 / `--lh-loose` 1.7；说明段落的行长上限
  走 `--measure` 62ch 与 `--measure-narrow` 46ch，用 ch 不用 px

### 3.3 字号标尺（八级，全整数）

| 令牌 | 值 | 典型用途 |
| --- | --- | --- |
| `--t-2xs` | 11px | 元信息、辅助说明。中文可读下限 |
| `--t-xs` | 12px | 次级标签 |
| `--t-sm` | 13px | 按钮、表单 |
| `--t-md` | 14px | 正文 |
| `--t-lg` | 16px | 卡片标题 |
| `--t-xl` | 18px | 抽屉 / 预览页标题 |
| `--t-2xl` | 21px | 页面标题、分诊大数字 |
| `--t-3xl` | 26px | 影响预览 / 保留天数的大数字 |

**不要引入半像素字号。** 中文字形是实心方块，没有拉丁字母的负空间来吃掉那半个
像素，只会糊。原型重构前有六个半像素档（9.5 / 10.5 / 11.5 / 12.5 / 13.5 / 14.5），
全部并掉了。

---

## 4. 间距与圆角

### 4.1 间距标尺（4pt 基准）

```
--s-px  1px    借位分隔线：网格 gap 露出底色当分割线用，不能并档
--s-0   2px      --s-1   4px      --s-2   6px      --s-3   8px
--s-4  12px      --s-5  16px      --s-6  20px      --s-7  24px
--s-8  32px      --s-9  40px      --s-10 56px      --s-11 72px
```

低端保留 2px 和 6px 两个半档，密集型控制台的 chrome 确实需要，硬凑纯 4 的倍数
只会让边框和文字贴死。

### 4.2 圆角

`--r-xs` 2px · `--r-sm` 6px · `--r` 8px · `--r-lg` 12px · `--r-xl` 16px · `--r-pill` 999px

**条状元素用 `--r-pill`**（进度条、容量条、骨架条），语义是「半高」，不是某个像素值。

### 4.3 骨架尺寸

```
--rail-w   196px   左栏宽（≤70em 时为 56px，见下）
--gbar-h    48px   顶栏高（sysbar 的 sticky top 依赖它）
--pad-x     24px   主区左右留白（toast 的左偏移依赖它），取自 --s-7
--btn-h     32px   按钮高度下限
--btn-h-sm  28px   紧凑按钮（sm）高度下限
--tap-min   44px   输入类触控目标下限（见 §5）
--flag-w     3px   行首告警条宽，三页共用
```

浮层与页面构件的尺寸同在这一节：`--drawer-w`、`--sheet-max-h`、
`--dialog-w-sm` / `--dialog-w` / `--dialog-w-lg`、`--popover-max-w`、`--toast-max-w`、
`--rule-editor-w`、`--meetings-table-w`、`--consumer-card-w`、`--login-card-w`。
这几个各自被多处引用，不要在组件里重新写死。原型重构前栏宽硬编码在四处，
其中两处是心算值（`calc(50% + 98px)`、`left: 222px`）。

`--rail-w` 是唯一一个有条件第二值的骨架令牌：`@media (max-width: 70em)` 下
它变成 56px，左栏收成只剩图标的窄条。断点落在 70em(1120px) 的算法是
`1120 − 56 − 48 = 1016 ≥ 860`（收起侧）与 `1120 − 196 − 48 = 876 ≥ 860`（展开侧），
两侧都装得下 `--meetings-table-w`。这不违反令牌文件的规矩 3：那条规矩管的是
颜色（三态主题下 `@media` 里的颜色在「跟随系统」状态不生效），视口媒体查询里
改尺寸是另一回事。

`--btn-h` / `--btn-h-sm` 存在的理由是解耦。此前 `.btn` 没有 `min-height`，高度是
「字号 × 继承行高 + 内距 + 边框」算出来的副产品，父级行高一变按钮就换一个高度。
它们不借间距令牌：md 恰好等于 `--s-8`(32) 但语义是「紧凑后台按钮的高度下限」，
sm 的 28 在 4pt 标尺上根本没有档。

---

## 5. 无障碍基线

以下是已实测通过的，改动后必须保持。守它的是 `cd console && npm run a11y`，
九项检查（0-8）跑在 `vite build` 的产物加真实 Chromium 上。

订正记录。2026-08-24 建起 `npm run a11y` 门槛后，发现下表原先整列写着「已实测」，其中两行没有任何检查在守，已改掉。2026-09-02 视觉验收时又发现「触控目标」一行同样没有检查在守，当时七项检查里没有一项量触控尺寸，实际违反的有：审计与会议记录两个「每页条数」下拉 51×20 和 44×20（四个视口都违反）、三个原生 checkbox 13×13、登录页「记住我」的 label 只有 20.1px 高。现在由第 8 项守。结论是表里每一行都必须写明由哪项检查守，没有检查守的行不能标为已实测。

| 项 | 标准 | 现状（由 `npm run a11y` 守） |
| --- | --- | --- |
| 文字对比度 | WCAG AA（正文 4.5:1，大字 3:1） | 两种主题各扫一遍。颜色必须过 canvas 解析：现代浏览器返回 `oklab(…)`，正则抠数字当 RGB 会得到假比值（原型阶段实测抠出过 1.06 和 4.15 两个假数） |
| 语义色令牌本身 | 色相带 + 饱和度 + 两两色相差 | 原先整个没在守。`tokenPx()` 只匹配 `\d+px`，从未用于任何颜色型令牌，`--fail` 若被误改成蓝色，所有断言「引用了 `var(--fail)`」的测试依然全绿，而「红＝归档失败＝一个月后永久丢失」是本系统最严重的语义 |
| 焦点环 | `:focus-visible` 可见、≥3:1、不做出现动画 | 真实浏览器 `focus({focusVisible:true})` 探针。注意 `Overlay.module.css` 的 `.root{outline:none}` 与 `base.css` 的 `:focus-visible` 同优先级，谁赢取决于打包注入顺序，所以门槛必须跑在 `vite build` 产物上，不是 dev server |
| 隐藏浮层 | 必须退出 Tab 序列与无障碍树 | Tab 走查 + CDP `Accessibility.getFullAXTree` 取 Chromium 真树。jsdom 不实现 `inert` 的行为语义，`userEvent.tab()` 也不认它 |
| 横向溢出 | 1440 / 1050 均无；375 是已知缺口（见 [`spec.md` §11 #2](spec.md)） | 原写「1440/1050/375 均无」不成立。第一，原来的测量只看 `documentElement.scrollWidth`，而 `base.css` 的 `html, body { overflow-x: clip }` 同时命中两个元素，375px 下 `documentElement.scrollWidth` 等于 `clientWidth` 375，`body.scrollWidth` 却是 781，这条断言在该页面上永远不会失败。隔离实验（375px `/meetings`）：两个元素都 clip 时量到 375，放开任意一个都量到 781。`Table` 组件的 `.wrap` 与 `.scroll` 不影响这个数字，表格的 1020px 在 `.scroll` 这个滚动容器内被吸收，这是设计行为。第二，375px 下实际有 8 类元素超出视口无法触达。所以只量 `scrollWidth` 不够，还要验证元素在视口内可达 |
| 触控目标 | 输入类有效热区 ≥44×44（`--tap-min`） | 第 8 项。量的是有效热区，不是元素自己的盒子：原生 checkbox 恒为 13×13，把方框画大会让它看起来像另一种控件，正确做法是让包着它的 `<label>` 当热区（点 label 就是点它，原生行为），所以扫描会往上取最近的 label 祖先、两个盒子取更大的那个。只管输入类，与本行措辞一致：button / a 由 [`spec.md` §10](spec.md)「移动端只保证能看、不保证能改」那条界线分别处置，混在一起会逼着把密集后台里的写操作按钮也撑到 44。顶栏那个原型专用的「系统状态」下拉按结构豁免（在 `protoGroup` 子树里），不写成类名名单，名单会在改名时静默失效 |
| 减少动效 | `prefers-reduced-motion` 生效 | 真实媒体查询下复测，不是断言样式表文本里「包含」某段声明 |

另有三项不在上表但同属这道门槛：第 0 项核对 `spec.md` §11 那张缺口表与实际一致
（过期的豁免算失败）、第 4 项扫 module.css 里的裸值、第 6 项逐页量内容区第一个
着色像素的位置（见 [`spec.md` §3.2](spec.md)）。

### 5.1 隐藏浮层必须 inert

`opacity: 0` 和 `transform: translateX(100%)` 都不会把元素移出 Tab 序列或
无障碍树。原型修复前，页面 200 个可聚焦元素里有 44 个是看不见的，其中包括登录
之后仍然能 Tab 到、仍然会被读屏念出来的「账号 / 密码 / 登录」。

工程里这件事由 `console/src/ui/Overlay.tsx` 统一做，Drawer / Popover / Sheet / Toast
都套这一层：浮层的开关本来就是 state，React 19 支持把 `inert` 当布尔 prop 渲染，
直接算成 `!open`。浮层始终挂载、用 `data-state` 切换，退场动画因此能播完。

原型是静态 HTML，用一个 `MutationObserver` 盯 `data-show` 同步 `inert`：

```js
const sync = el => { if (!el.classList.contains('tip')) el.inert = el.getAttribute('data-show') !== 'true'; };
new MutationObserver(ms => ms.forEach(m => sync(m.target)))
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-show'], subtree: true });
document.querySelectorAll('[data-show]').forEach(sync);
```

**这段不要照搬进工程**，它是给静态 HTML 打的补丁。选 `inert` 而不选 `hidden` 的理由
两边一样：它只切交互和无障碍树，不影响绘制。

### 5.2 SMIL 不受 reduced-motion 管

CSS 的 `prefers-reduced-motion` 对 SVG SMIL `<animate>` 无效。所有循环动画
必须用 CSS 动画写，并在 reduced-motion 下显式 `animation: none !important`。

---

## 6. 动效

- 不动布局属性（`width` / `height` / `top` / `left` / `margin` / `padding` 等），
  它们每帧触发 reflow。位移与淡入淡出一律用 `transform` 与 `opacity`
- 纯绘制属性（`color` / `background-color` / `border-color`）可以用于 hover、
  focus 这类状态反馈，时长限 `--dur-1`。它们不触发 reflow，和上一条不冲突。
  （原表述是「只动 transform 和 opacity」，与「不动布局属性」并列成了两条规矩，
  实践中被读成禁止一切颜色过渡，那不是本意，F1 Task 4 的评审撞上了这处歧义）
- 三个具名缓动：`--ease-out` / `--ease-in` / `--ease-in-out`。不用浏览器默认的 `ease`
- 三档交互时长：`--dur-1` 120ms（微交互）· `--dur-2` 200ms（浮层）· `--dur-3` 260ms（抽屉）。
  持续循环的环境动画（骨架屏高光、StatusDot 呼吸）另有一档 `--dur-loop` 1.4s
- 按下反馈统一是 `transform: translateY(1px)`，且不加过渡，按下应当是即时的

---

## 7. 三态主题

```css
:root { /* 完整浅色调色板 */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* 只重定义令牌 */ }
}
:root[data-theme="dark"] { /* 同上，让切换器在两个方向都能赢 */ }
```

三种状态：显式浅色 / 显式深色 / 未标记（跟随系统）。最后一种是默认，
也是最容易被忘掉的：只写 `[data-theme]` 块的颜色，在跟随系统状态下不会生效。
两处深色定义必须逐字一致，`npm run a11y` 的第 4 项逐个令牌比对。
切换器实现在 `console/src/theme/useTheme.ts`。

---

## 8. 组件清单

基元在 `console/src/ui/`，每个组件一个 `.tsx` 加同名 `.module.css`：

| 组件 | 用途 |
| --- | --- |
| `Button` · `Input` · `PasswordInput` | 表单控件 |
| `Chip` · `Pill` · `StatusDot` · `ProgressBar` · `Skeleton` | 状态与数据展示 |
| `Table` | 表格，含 `.wrap` / `.scroll` 两层与边缘渐隐 |
| `Overlay` | 浮层基座，下面四个都套它 |
| `Drawer` · `Sheet` · `Popover` · `Toast` | 抽屉 / 对话框 / 弹出层 / 提示条 |
| `PageShell` | 七页共用的页头（见 [`spec.md` §3.1](spec.md)） |

外壳在 `console/src/app/`：`AppShell`（除登录外七条路由的父路由）、`Rail`（左栏）、
`GlobalBar`（顶栏）、`SystemStatus`（系统状态条）、`ShortcutBar`（快捷键条）、
`UserMenu`（用户菜单）。页面级组件在 `console/src/pages/<页面>/`。

---

## 9. 踩过的坑（改动时别再踩一遍）

| 坑 | 后果 |
| --- | --- |
| `[hidden]` 的 UA `display:none` 会被任何 class 级 `display` 盖掉 | 需要全局 `[hidden] { display: none !important; }` |
| `<button>` 不继承页面文字色 | 漏写 `color` 在深色模式下就是黑字压深底（实测 1.07:1） |
| `grid-template-columns` 里嵌套 `minmax()` 是非法值 | 整条声明被丢弃且不报错，两栏一起塌成全宽 |
| `translateY(150%)` 藏不住矮的固定条 | 150% 只是自身高度的 1.5 倍，需要同时 `opacity: 0; pointer-events: none` |
| 动 `background-position` 做骨架屏 | 非合成属性，每帧触发 paint。改用 `::after` + `transform` |
| `html, body { overflow-x: hidden }` | 会让 `position: sticky` 失效，用 `clip` |
