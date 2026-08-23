# 控制台设计系统

- 日期：2026-08-23
- 令牌文件（权威）：`console/src/styles/tokens.css`（94 个令牌，F1 Task 1 迁入并成为权威来源）
- 令牌文件（快照，不再跟着改）：[`prototype/tokens.css`](prototype/tokens.css)
- 原型（行为仍以此为准）：[`prototype/gate-console.html`](prototype/gate-console.html)

自 F1 Task 1 起，令牌的权威转移到 `console/src/styles/tokens.css`；
`prototype/tokens.css` 与原型 HTML 里的内联令牌块降级为历史快照，只用于回看，
不再跟着改。**行为规格仍以原型为唯一权威**（`docs/console/spec.md` §0），
只有令牌这一项转移了权威。

---

## 1. 三条硬规矩

1. **组件里不许出现裸的 px / hex / rgba。** 缺什么值就来令牌文件里加一个具名令牌，
   而不是在组件里写死。原型重构前有 105 个互不相同的 padding 取值，改一处间距要
   在里面翻半天。
2. **`--ink-4` 是图形专用**（描边 / 分隔 / 填充）。它在白底上只有 3.72:1，
   用于文字必然不达 AA。**文字梯度到 `--ink-3` 为止。**
3. **颜色只在令牌文件里定义**，组件永远只引用令牌名。不要把颜色写进 `@media` 或
   `[data-theme]` 块——那样的颜色在「跟随系统」状态下不会生效。

---

## 2. 颜色

### 2.1 品牌与中性

取自 Logo：`#0066FF` / `#000000` / `#FFFFFF`。

中性色**不是灰**，是把品牌蓝抽掉饱和度得到的冷灰（色相 222）——从品牌里长出来，
不是随便找的灰。

| 令牌 | 浅色 | 用途 |
| --- | --- | --- |
| `--ground` | `#F1F4F9` | 页面底 |
| `--surface` | `#FFFFFF` | 卡片 / 表格底 |
| `--surface-2` | `#F7F9FC` | 表头 / 次级面 |
| `--rail` | `#E9EDF4` | 左栏（比内容区暗一档，导航本就该退后） |
| `--line` / `--line-soft` | | 分隔线两档 |
| `--ink` / `--ink-2` / `--ink-3` | | 文字三档 |
| `--ink-4` | `#7C8595` | **图形专用**，禁止用于文字 |

### 2.2 三个语义色，各自只有一个含义

| 色 | 含义 |
| --- | --- |
| **蓝** | 数据可被取走 / 主交互 |
| **琥珀** | 有人手动改写了规则，或保留期快到了 |
| **红** | 失败 —— **归档失败意味着一个月后永久丢失，是本系统最严重的状态** |

不要为了「好看」把琥珀用在别处。这三个色的含义是产品语义的一部分。

### 2.3 成对的 on- 色

压在实底上的字必须用成对令牌，**不能写死白色**：

| 令牌 | 压在 | 为什么不能写死 |
| --- | --- | --- |
| `--on-brand` | `--brand` | 深色模式下 `--brand` 变浅，白字只有 3.47:1 |
| `--on-fail` | `--fail` | 深色模式下 `--fail` 变浅红，白字只有 2.52:1 |
| `--accent-invert` | 反相表面（toast / batch / tip） | 那块底跟主题**反向**：浅色模式下是近黑要亮蓝，深色模式下是近白要深蓝 |

### 2.4 内容表面（不跟随主题）

播放器和代码块刻意不跟随主题——它们是「内容本身」的底，不是界面的底。
但那也是一组具名令牌（`--video-*` / `--code-*`），不是散落的 `rgba(255,255,255,.72)`。

---

## 3. 排版

### 3.1 字体

```css
--sans: "Archivo", "Noto Sans SC", -apple-system, ..., sans-serif;
--mono: "IBM Plex Mono", ui-monospace, ..., monospace;
```

**顺序不能反。** Archivo 零 CJK 覆盖，只吃拉丁字母和数字；中文由紧随其后的
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

Noto Sans SC 走**变体字重区间 `400..700`**，不要展开成四个静态字重——中文按
unicode-range 切成上百个分片，静态字重会让请求数翻四倍。

**实测成本**：首屏 Noto Sans SC 拉了 15 个分片、818 KB（总字体 912 KB）。
强缓存后只有首访付这个钱。要压下来的路子是**自托管 + 两层子集**：界面文案固定
（约 800 字）可子集化到 30–50 KB 立即加载，会议标题那层懒加载。这是部署决策。

### 3.2 中文排版规矩

- **不用 uppercase，不用宽字距**。那是拉丁字母的排版手法，套在方块字上会让字散开
- **不用负字距**。负字距是给拉丁 display 字挤紧的，压在方块字上只会挤成一团。
  唯一例外是**等宽数字**（`--mono` 的大号数字），那里 `-.02em` 是对的
- 等宽字体只用于数字、路径、标识符

### 3.3 字号标尺（八级，全整数）

| 令牌 | 值 | 典型用途 |
| --- | --- | --- |
| `--t-2xs` | 11px | 元信息、辅助说明。**中文可读下限** |
| `--t-xs` | 12px | 次级标签 |
| `--t-sm` | 13px | 按钮、表单 |
| `--t-md` | 14px | **正文** |
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

低端保留 2px 和 6px 两个半档——密集型控制台的 chrome 确实需要，硬凑纯 4 的倍数
只会让边框和文字贴死。

### 4.2 圆角

`--r-xs` 2px · `--r-sm` 6px · `--r` 8px · `--r-lg` 12px · `--r-xl` 16px · `--r-pill` 999px

**条状元素用 `--r-pill`**（进度条、容量条、骨架条），语义是「半高」，不是某个像素值。

### 4.3 骨架尺寸

```
--rail-w  196px    左栏宽
--gbar-h   48px    顶栏高（sysbar 的 sticky top 依赖它）
--pad-x    24px    主区左右留白（toast 的左偏移依赖它）
```

这三个各自被多处引用，**不要在组件里重新写死**。原型重构前栏宽硬编码在四处，
其中两处是心算值（`calc(50% + 98px)`、`left: 222px`）。

---

## 5. 无障碍基线

以下是**已实测通过的**，改动后必须保持：

| 项 | 标准 | 实测 |
| --- | --- | --- |
| 文字对比度 | WCAG AA（正文 4.5:1，大字 3:1） | 浅色 / 深色全页**零失败** |
| 焦点环 | `:focus-visible` 可见、≥3:1、**不做出现动画** | ✅ |
| 隐藏浮层 | 必须退出 Tab 序列与无障碍树 | Tab 泄漏 **0** |
| 横向溢出 | 1440 / 1050 / 375 均无 | ✅ |
| 触控目标 | 输入类 ≥44px | ✅ |
| 减少动效 | `prefers-reduced-motion` 生效 | ✅ |

### 5.1 隐藏浮层必须 inert —— 这条最容易漏

`opacity: 0` 和 `transform: translateX(100%)` **都不会**把元素移出 Tab 序列或
无障碍树。原型修复前，页面 200 个可聚焦元素里有 44 个是看不见的，其中包括登录
之后仍然能 Tab 到、仍然会被读屏念出来的「账号 / 密码 / 登录」。

实现方式是一个 `MutationObserver` 盯 `data-show`，自动同步 `inert`：

```js
const sync = el => { if (!el.classList.contains('tip')) el.inert = el.getAttribute('data-show') !== 'true'; };
new MutationObserver(ms => ms.forEach(m => sync(m.target)))
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-show'], subtree: true });
document.querySelectorAll('[data-show]').forEach(sync);
```

选 `inert` 而不是 `hidden`：它只切交互和无障碍树，**不影响绘制**，退场动画照常
播完。用观察器而不是改每个调用点：将来任何新浮层只要挂上 `data-show` 就自动受管。

### 5.2 SMIL 不受 reduced-motion 管

CSS 的 `prefers-reduced-motion` 对 SVG SMIL `<animate>` **无效**。所有循环动画
必须用 CSS 动画写，并在 reduced-motion 下显式 `animation: none !important`。

---

## 6. 动效

- 只动 `transform` 和 `opacity`，不动布局属性
- 三个具名缓动：`--ease-out` / `--ease-in` / `--ease-in-out`。**不用浏览器默认的 `ease`**
- 三档时长：`--dur-1` 120ms（微交互）· `--dur-2` 200ms（浮层）· `--dur-3` 260ms（抽屉）
- 按下反馈统一是 `transform: translateY(1px)`，且**不加过渡**（按下应当是即时的）

---

## 7. 三态主题

```css
:root { /* 完整浅色调色板 */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* 只重定义令牌 */ }
}
:root[data-theme="dark"] { /* 同上，让切换器在两个方向都能赢 */ }
```

三种状态：显式浅色 / 显式深色 / **未标记（跟随系统）**。最后一种是默认，
也是最容易被忘掉的——只写 `[data-theme]` 块的颜色，在跟随系统状态下不会生效。

---

## 8. 踩过的坑（改动时别再踩一遍）

| 坑 | 后果 |
| --- | --- |
| `[hidden]` 的 UA `display:none` 会被任何 class 级 `display` 盖掉 | 需要全局 `[hidden] { display: none !important; }` |
| `<button>` 不继承页面文字色 | 漏写 `color` 在深色模式下就是黑字压深底（实测 1.07:1） |
| `grid-template-columns` 里嵌套 `minmax()` 是非法值 | **整条声明被丢弃且不报错**，两栏一起塌成全宽 |
| `translateY(150%)` 藏不住矮的固定条 | 150% 只是自身高度的 1.5 倍，需要同时 `opacity: 0; pointer-events: none` |
| 动 `background-position` 做骨架屏 | 非合成属性，每帧触发 paint。改用 `::after` + `transform` |
| `html, body { overflow-x: hidden }` | 会让 `position: sticky` 失效，用 `clip` |
