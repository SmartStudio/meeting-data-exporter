/* 注入到被测页面里的探针库。**本文件不参与 tsc**（它是 addInitScript 的 content，
 * 以纯 JS 字符串注入），所以这里写的是浏览器端 JS，不是 TS。
 *
 * 为什么单独一个文件而不是内联在 a11y-check.ts 里：page.evaluate 传函数会被
 * 序列化成源码、丢掉闭包，于是每个探针都得把 toRgba / contrast / describe 再抄
 * 一遍。集中成一个 addInitScript 注入的 window.__a11y，探针之间才能共用。
 *
 * 颜色一律过 canvas 解析。**不许**正则抠 getComputedStyle().backgroundColor——
 * 现代 Chromium 会返回 `oklab(0.972361 …)` 这类字符串，正则抠出来的数字当成
 * RGB 0–255 会得到完全错误的比值（原型阶段实测抠出过 1.06 和 4.15 两个假数）。
 */
;(() => {
  const TOKEN_NAMES = window.__A11Y_TOKEN_NAMES__ || []

  const FOCUSABLE = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'summary',
    'iframe',
    'audio[controls]',
    'video[controls]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex^="-"])',
  ].join(',')

  /* 布局属性：放进 transition/animation 就是每帧 reflow（design-system.md §6）。 */
  const LAYOUT_PROPS = [
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'top', 'right', 'bottom', 'left', 'inset', 'inset-block', 'inset-inline',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'font-size', 'line-height', 'letter-spacing', 'gap', 'row-gap', 'column-gap',
    'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'border-width', 'grid-template-columns',
  ]

  const cvs = document.createElement('canvas')
  cvs.width = 1
  cvs.height = 1
  const cx = cvs.getContext('2d', { willReadFrequently: true })

  /* 压白底 / 压黑底各采一次，反解出 alpha 与原色。单次 getImageData 会因为
     预乘 alpha 取整，在半透明色（--scrim、color-mix(... transparent)）上丢精度。 */
  function sampleOn(base, css) {
    cx.fillStyle = base
    cx.fillRect(0, 0, 1, 1)
    cx.fillStyle = '#000' // 非法值会保留上一次的 #000（brief 指定的行为）
    cx.fillStyle = css
    cx.fillRect(0, 0, 1, 1)
    const d = cx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }

  function toRgba(css) {
    const w = sampleOn('#fff', css)
    const b = sampleOn('#000', css)
    let a = ((1 - (w[0] - b[0]) / 255) + (1 - (w[1] - b[1]) / 255) + (1 - (w[2] - b[2]) / 255)) / 3
    if (a < 0) a = 0
    if (a > 1) a = 1
    const rgb = a <= 0.0015
      ? [0, 0, 0]
      : [0, 1, 2].map((i) => Math.min(255, Math.max(0, b[i] / a)))
    return { rgb, a }
  }

  function hex(rgb) {
    return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
  }

  function mix(fg, alpha, bg) {
    return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha))
  }

  function relLum(rgb) {
    const f = (c) => {
      const x = c / 255
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
  }

  function contrast(a, b) {
    const la = relLum(a)
    const lb = relLum(b)
    const hi = Math.max(la, lb)
    const lo = Math.min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
  }

  function hsl(rgb) {
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const l = (max + min) / 2
    const d = max - min
    if (d < 1e-6) return { h: 0, s: 0, l }
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    let h
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
    return { h, s, l }
  }

  /* ── 令牌反查：把实测出的 RGB 说回令牌名，报告才能"指名道姓" ────────── */
  function tokenTable() {
    const cs = getComputedStyle(document.documentElement)
    const byName = {}
    const byHex = {}
    for (const name of TOKEN_NAMES) {
      const raw = cs.getPropertyValue(name).trim()
      if (!raw || !CSS.supports('color', raw)) continue
      const c = toRgba(raw)
      const h = hex(c.rgb)
      byName[name] = { raw, hex: h, rgb: c.rgb, a: c.a, hsl: hsl(c.rgb) }
      if (c.a > 0.99) (byHex[h] = byHex[h] || []).push(name)
    }
    return { byName, byHex }
  }

  let TOKENS = null
  function tokens() {
    if (!TOKENS) TOKENS = tokenTable()
    return TOKENS
  }
  function nameOf(h) {
    const t = tokens().byHex[h]
    if (!t || !t.length) return ''
    return t.length > 2 ? t.slice(0, 2).join('/') + ' 等 ' + t.length + ' 个' : t.join('/')
  }
  function paint(h) {
    const n = nameOf(h)
    return n ? h + '(' + n + ')' : h
  }

  /* ── 元素定位串。CSS Module 类名在本次构建里是 [name]__[local]，可读。 ── */
  function describe(el) {
    const bits = []
    let n = el
    let depth = 0
    while (n && depth < 3 && n !== document.body) {
      let s = n.tagName.toLowerCase()
      const cls = (n.getAttribute('class') || '').trim()
      if (cls) s += '.' + cls.split(/\s+/).slice(0, 3).join('.')
      const tid = n.getAttribute('data-testid')
      if (tid) s += '[data-testid="' + tid + '"]'
      if (depth === 0) {
        const al = n.getAttribute('aria-label')
        if (al) s += '[aria-label="' + al.slice(0, 28) + '"]'
        for (const a of ['data-state', 'data-soon', 'data-fail', 'data-show']) {
          const v = n.getAttribute(a)
          if (v !== null) s += '[' + a + '="' + v + '"]'
        }
      }
      bits.unshift(s)
      n = n.parentElement
      depth++
    }
    return bits.join(' > ')
  }

  function accName(el) {
    const al = el.getAttribute('aria-label')
    if (al) return al.trim()
    const lb = el.getAttribute('aria-labelledby')
    if (lb) {
      const t = lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim()
      if (t) return t
    }
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  }

  function isRendered(el) {
    if (!el || !el.isConnected) return false
    if (el.closest('[inert]')) return false
    if (el.closest('[aria-hidden="true"]')) return false
    const r = el.getBoundingClientRect()
    if (r.width < 0.5 || r.height < 0.5) return false
    let n = el
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none') return false
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false
      if (parseFloat(cs.opacity) === 0) return false
      if (cs.contentVisibility === 'hidden') return false
      n = n.parentElement
    }
    return true
  }

  /* 最近的有实底的祖先。半透明层逐层压下去，兜底是画布白。
     途中遇到 background-image 就标记出来——那种底自动判不了，报成"待人判"。 */
  function bgOf(el) {
    const layers = []
    let n = el
    let imageAt = null
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n)
      if (imageAt === null && cs.backgroundImage !== 'none') imageAt = describe(n)
      const c = toRgba(cs.backgroundColor)
      if (c.a > 0.001) {
        layers.push({ node: n, rgb: c.rgb, a: c.a })
        if (c.a > 0.999) break
      }
      n = n.parentElement
    }
    let acc = [255, 255, 255]
    for (let i = layers.length - 1; i >= 0; i--) acc = mix(layers[i].rgb, layers[i].a, acc)
    const last = layers[layers.length - 1]
    return {
      rgb: acc,
      hex: hex(acc),
      opaqueNode: last && last.a > 0.999 ? last.node : null,
      imageAt,
    }
  }

  function chainOpacity(el, stopAt) {
    let o = 1
    let n = el
    while (n && n.nodeType === 1 && n !== stopAt) {
      const v = parseFloat(getComputedStyle(n).opacity)
      if (!Number.isNaN(v)) o *= v
      n = n.parentElement
    }
    return o
  }

  function textCarriers() {
    const out = []
    const seen = new Set()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim()
      if (!t) continue
      const el = n.parentElement
      if (!el || seen.has(el)) continue
      if (el.tagName === 'OPTION' || el.tagName === 'OPTGROUP' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue
      seen.add(el)
      out.push({ el, text: t })
    }
    /* <select> 的可见文字由选中的 <option> 承担，但收起态的 option 没有盒子，
       上面的遍历取不到——把 select 本身补进来，用选中项的文本。 */
    for (const s of document.querySelectorAll('select')) {
      if (seen.has(s)) continue
      const o = s.selectedOptions[0]
      if (!o) continue
      seen.add(s)
      out.push({ el: s, text: (o.textContent || '').replace(/\s+/g, ' ').trim() })
    }
    return out
  }

  const api = {}

  api.tokens = function () {
    TOKENS = null
    const t = tokens()
    const out = {}
    for (const k of Object.keys(t.byName)) {
      const v = t.byName[k]
      out[k] = { raw: v.raw, hex: v.hex, rgb: v.rgb, a: v.a, h: v.hsl.h, s: v.hsl.s, l: v.hsl.l }
    }
    return { values: out, dataTheme: document.documentElement.getAttribute('data-theme') }
  }

  api.contrastRatio = function (fgCss, bgCss) {
    const f = toRgba(fgCss)
    const b = toRgba(bgCss)
    return contrast(mix(f.rgb, f.a, b.rgb), b.rgb)
  }

  /* ── 检查一：全页对比度 ────────────────────────────────────────── */
  api.scanContrast = function () {
    TOKENS = null
    const t = tokens()
    const inkFour = t.byName['--ink-4'] ? t.byName['--ink-4'].hex : null
    const fails = []
    const unresolved = []
    const largeExempt = []
    const inkFourText = []
    let checked = 0

    for (const item of textCarriers()) {
      const el = item.el
      if (!isRendered(el)) continue
      const cs = getComputedStyle(el)
      const bg = bgOf(el)
      const fg = toRgba(cs.color)
      const op = chainOpacity(el, bg.opaqueNode)
      const eff = mix(fg.rgb, fg.a * op, bg.rgb)
      const ratio = contrast(eff, bg.rgb)
      const size = parseFloat(cs.fontSize) || 0
      const weight = parseInt(cs.fontWeight, 10) || 400
      const large = size >= 18.66 || (size >= 14 && weight >= 700)
      const need = large ? 3 : 4.5
      checked++

      const row = {
        desc: describe(el),
        text: item.text.slice(0, 26),
        fg: paint(hex(fg.rgb)),
        fgEff: hex(eff),
        bg: paint(bg.hex),
        opacity: Math.round(op * 100) / 100,
        size, weight, large,
        ratio: Math.round(ratio * 100) / 100,
        need,
      }

      if (inkFour && hex(fg.rgb) === inkFour) inkFourText.push(row)
      if (bg.imageAt) { unresolved.push(Object.assign({ imageAt: bg.imageAt }, row)); continue }
      if (ratio + 0.005 < need) fails.push(row)
      else if (large && ratio < 4.5) largeExempt.push(row)
    }
    return { checked, fails, unresolved, largeExempt, inkFourText }
  }

  /* ── 检查二：Tab 泄漏 / 焦点环 ─────────────────────────────────── */
  let probeSeq = 0
  api.activeInfo = function () {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return null
    if (!el.getAttribute('data-a11yprobe')) el.setAttribute('data-a11yprobe', String(++probeSeq))
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const oc = toRgba(cs.outlineColor)
    const around = bgOf(el.parentElement || el)
    return {
      key: el.getAttribute('data-a11yprobe'),
      desc: describe(el),
      name: accName(el),
      rendered: isRendered(el),
      focusVisible: el.matches(':focus-visible'),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      outlineStyle: cs.outlineStyle,
      outlineWidth: parseFloat(cs.outlineWidth) || 0,
      outlineColor: paint(hex(oc.rgb)),
      outlineRatio: Math.round(contrast(mix(oc.rgb, oc.a, around.rgb), around.rgb) * 100) / 100,
      aroundBg: paint(around.hex),
      inClosedOverlay: !!el.closest('[data-state="closed"]'),
      inert: !!el.closest('[inert]'),
    }
  }

  api.clearProbes = function () {
    for (const el of document.querySelectorAll('[data-a11yprobe]')) el.removeAttribute('data-a11yprobe')
    probeSeq = 0
  }

  /* 只 blur() 不够：Chromium 会记住「顺序聚焦导航起点」，下一次 Tab 从上次
     的位置继续，而不是从文档开头。把起点显式挪回 body。 */
  api.blurAll = function () {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
    document.body.setAttribute('tabindex', '-1')
    document.body.focus()
    document.body.removeAttribute('tabindex')
  }

  /* 静态口径：可聚焦但不可见的元素（brief Step 2 的判据）。
     **必须在 Tab 走查之前调用**：`.extendBtn` / `.detailBtn` 这类「聚焦即浮出」
     的按钮在走查过程中会被逐个点亮，走完之后再量就全是可见的，这条静态口径
     会变成一个恒等于 0 的假绿灯。这里顺带给每个可聚焦元素编号，好让走查
     结果能和静态清单对上号。 */
  api.staticFocusables = function () {
    const all = Array.from(document.querySelectorAll(FOCUSABLE))
    const invisible = []
    for (const el of all) {
      if (!el.getAttribute('data-a11yprobe')) el.setAttribute('data-a11yprobe', String(++probeSeq))
      if (el.closest('[inert]')) continue
      if (isRendered(el)) continue
      invisible.push({ desc: describe(el), name: accName(el), key: el.getAttribute('data-a11yprobe') })
    }
    return { total: all.length, invisible }
  }

  /* 关闭态浮层：必须 inert，且里面的控件名不该出现在无障碍树里。 */
  /* 真正看得见的可聚焦控件的可访问名。用 isRendered（认 opacity:0）而不是
     `rect.width > 0`——关闭态浮层里的控件盒子仍然有宽度，用宽度判可见会把
     它们当成"页面上本来就有这个名字"，无障碍树泄漏那条检查就永远抓不到东西。 */
  api.visibleFocusableNames = function () {
    return Array.from(document.querySelectorAll(FOCUSABLE))
      .filter(isRendered)
      .map(accName)
      .filter(Boolean)
  }

  const PANEL_ROLES = ['dialog', 'alertdialog', 'menu', 'listbox', 'status', 'region']
  api.closedOverlays = function () {
    return Array.from(document.querySelectorAll('[data-state="closed"]')).map((el) => ({
      desc: describe(el),
      inert: el.hasAttribute('inert'),
      isPanel: PANEL_ROLES.indexOf(el.getAttribute('role') || '') >= 0,
      controls: Array.from(el.querySelectorAll(FOCUSABLE)).map((c) => ({ desc: describe(c), name: accName(c) })),
      texts: Array.from(el.querySelectorAll('*'))
        .map((c) => (c.childNodes[0] && c.childNodes[0].nodeType === 3 ? (c.childNodes[0].nodeValue || '').trim() : ''))
        .filter((s) => s.length >= 3),
    }))
  }

  /* Overlay 基座本身拿到焦点时，焦点环还在不在。
     `.root{outline:none}` 与 base.css 的 `:focus-visible` 同优先级，
     谁赢取决于打包注入顺序——所以这条只有在**构建产物**上跑才算数。 */
  api.probeOverlayFocusRing = function (classAttr) {
    const el = document.createElement('div')
    el.setAttribute('class', classAttr)
    el.setAttribute('tabindex', '-1')
    el.setAttribute('role', 'dialog')
    el.setAttribute('data-state', 'open')
    el.style.position = 'fixed'
    el.style.left = '24px'
    el.style.top = '24px'
    el.style.width = '160px'
    el.style.height = '64px'
    document.body.appendChild(el)
    el.focus({ focusVisible: true })
    const cs = getComputedStyle(el)
    const oc = toRgba(cs.outlineColor)
    const around = bgOf(document.body)
    const res = {
      classAttr,
      focused: document.activeElement === el,
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: cs.outlineStyle,
      outlineWidth: parseFloat(cs.outlineWidth) || 0,
      outlineColor: paint(hex(oc.rgb)),
      outlineRatio: Math.round(contrast(mix(oc.rgb, oc.a, around.rgb), around.rgb) * 100) / 100,
      aroundBg: paint(around.hex),
    }
    el.remove()
    return res
  }

  api.overlayRootClass = function () {
    const p = document.querySelector('[role="dialog"],[role="menu"],[role="status"],[role="listbox"],[role="alertdialog"]')
    return p ? p.getAttribute('class') : null
  }

  /* ── 检查三：横向溢出 + 视口内可达 ─────────────────────────────── */
  function scrollableXAncestor(el) {
    let n = el.parentElement
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n)
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1) return n
      n = n.parentElement
    }
    return null
  }

  api.scanLayout = function () {
    const de = document.documentElement
    const vw = window.innerWidth
    const page = {
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      innerWidth: vw,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
    }
    const outOfViewport = []
    const occluded = []
    const targets = Array.from(document.querySelectorAll(FOCUSABLE + ',[role="progressbar"]'))
    for (const el of targets) {
      if (!isRendered(el)) continue
      if (scrollableXAncestor(el)) continue
      const r = el.getBoundingClientRect()
      if (r.right > vw + 1 || r.left < -1) {
        outOfViewport.push({
          desc: describe(el), name: accName(el),
          left: Math.round(r.left), right: Math.round(r.right),
          width: Math.round(r.width), viewport: vw,
          over: Math.round(Math.max(r.right - vw, -r.left)),
        })
        continue
      }
      const cxp = r.left + r.width / 2
      const cyp = r.top + r.height / 2
      if (cyp < 0 || cyp > window.innerHeight) continue
      const hit = document.elementFromPoint(cxp, cyp)
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        /* 被固定/粘性条盖住的多半是「滚一下就露出来」，不是够不着。
           只报真正被普通流元素压住的。 */
        let n = hit
        let pinned = false
        while (n && n.nodeType === 1) {
          const pos = getComputedStyle(n).position
          if (pos === 'fixed' || pos === 'sticky') { pinned = true; break }
          n = n.parentElement
        }
        if (!pinned) occluded.push({ desc: describe(el), name: accName(el), hitBy: describe(hit) })
      }
    }
    return { page, outOfViewport, occluded, squeezed: squeezeScan() }
  }

  /* 只看 scrollWidth 会漏，只看「有没有跑出视口」也会漏第三类：
     position: fixed 的浮动条，它的可用宽度是「视口宽 − 用掉的 left」。
     窄屏下 left 一大，可用宽度就小于这条的 min-content——于是它挤到不能再挤，
     溢出自己的包含块，缩成一根竖着的窄柱。页面不横滚（overflow-x: clip
     切掉的是别的东西），元素的左右边也都还在视口里，前两条都放行。
     `left: calc(50% + var(--rail-w)/2)` 这种"心算居中"正是这个形状：它把
     可用宽度砍成了 视口宽 − 半个视口 − 半个左栏。

     不需要区分是不是显式给了 right：右锚定的浮层（Drawer 的 right: 0）用掉的
     left 恰好等于「视口宽 − 自身宽」，渲染宽 == 可用宽，天然不触发；
     铺满内容列的条（ShortcutBar 的 left/right 都给了）同理。只有真正超出
     自己那格的才会被抓出来。 */
  function squeezeScan() {
    const out = []
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed') continue
      if (!isRendered(el)) continue
      const left = parseFloat(cs.left)
      if (!(left > 0)) continue
      const avail = window.innerWidth - left
      const r = el.getBoundingClientRect()
      if (r.width <= avail + 1) continue
      const prevW = el.style.width
      const prevMW = el.style.maxWidth
      el.style.width = 'max-content'
      el.style.maxWidth = 'none'
      const nat = el.getBoundingClientRect().width
      el.style.width = prevW
      el.style.maxWidth = prevMW
      out.push({
        desc: describe(el),
        left: Math.round(left * 10) / 10,
        avail: Math.round(avail * 10) / 10,
        natural: Math.round(nat),
        rendered: Math.round(r.width),
        centerPct: Math.round(((r.left + r.width / 2) / window.innerWidth) * 100),
        viewport: window.innerWidth,
      })
    }
    return out
  }

  api.scanBars = function () {
    const problems = []
    const seen = []
    for (const track of document.querySelectorAll('[role="progressbar"]')) {
      if (!isRendered(track)) continue
      const tcs = getComputedStyle(track)
      const tr = track.getBoundingClientRect()
      const fill = track.firstElementChild
      const radius = parseFloat(tcs.borderTopLeftRadius) || 0
      const clipped = ['hidden', 'clip', 'auto', 'scroll'].indexOf(tcs.overflowX) >= 0
      const want = Number(track.getAttribute('aria-valuenow'))
      const max = Number(track.getAttribute('aria-valuemax')) || 100
      const rec = {
        desc: describe(track), h: Math.round(tr.height * 100) / 100,
        w: Math.round(tr.width * 100) / 100, radius, overflowX: tcs.overflowX,
        valuenow: want, valuemax: max,
      }
      if (tr.height < 2) problems.push(Object.assign({ why: '轨道渲染高度 < 2px，条本身看不见' }, rec))
      if (radius + 0.5 < tr.height / 2) problems.push(Object.assign({ why: '轨道圆角 ' + radius + 'px 不足半高 ' + (tr.height / 2) + 'px，--r-pill 语义（半高胶囊）没生效' }, rec))
      if (!clipped) problems.push(Object.assign({ why: '轨道 overflow-x=' + tcs.overflowX + '，fill 的方头会露在胶囊外' }, rec))
      if (fill) {
        const fcs = getComputedStyle(fill)
        const fr = fill.getBoundingClientRect()
        const frad = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
          .map((k) => parseFloat(fcs[k]) || 0)
        const maxRad = Math.max.apply(null, frad)
        const sx = new DOMMatrixReadOnly(fcs.transform).a
        rec.fill = { w: Math.round(fr.width * 100) / 100, h: Math.round(fr.height * 100) / 100, radius: maxRad, scaleX: Math.round(sx * 1000) / 1000 }
        if (maxRad > 0 && sx < 0.999) {
          problems.push(Object.assign({ why: 'fill 同时有 border-radius ' + maxRad + 'px 和 scaleX(' + sx + ')：端帽被水平压成椭圆' }, rec))
        }
        const expect = tr.width * (max > 0 ? want / max : 0)
        if (Math.abs(fr.width - expect) > 1.5) {
          problems.push(Object.assign({ why: 'fill 渲染宽 ' + Math.round(fr.width) + 'px 与 aria-valuenow ' + want + '/' + max + ' 应得的 ' + Math.round(expect) + 'px 对不上' }, rec))
        }
        if (Math.abs(fr.height - tr.height) > 0.6) {
          problems.push(Object.assign({ why: 'fill 高 ' + fr.height + 'px 与轨道高 ' + tr.height + 'px 不齐' }, rec))
        }
      } else {
        problems.push(Object.assign({ why: '没有 fill 子元素' }, rec))
      }
      seen.push(rec)
    }
    for (const sk of document.querySelectorAll('[class*="Skeleton__skel"]')) {
      if (!isRendered(sk)) continue
      const cs = getComputedStyle(sk)
      const r = sk.getBoundingClientRect()
      const rec = { desc: describe(sk), h: Math.round(r.height * 100) / 100, w: Math.round(r.width * 100) / 100, radius: parseFloat(cs.borderTopLeftRadius) || 0 }
      if (r.height < 2) problems.push(Object.assign({ why: '骨架条渲染高度 < 2px' }, rec))
      if (r.width < 8) problems.push(Object.assign({ why: '骨架条渲染宽度 < 8px' }, rec))
      seen.push(rec)
    }
    return { problems, seen }
  }

  /* ── 检查五：动效与主题的媒体查询在真实浏览器下是否生效 ────────── */
  api.scanMotion = function () {
    const anims = []
    const trans = []
    for (const el of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        let cs
        try { cs = getComputedStyle(el, pseudo) } catch (e) { continue }
        if (!cs) continue
        if (cs.animationName && cs.animationName !== 'none') {
          anims.push({
            desc: describe(el) + (pseudo || ''),
            name: cs.animationName,
            duration: cs.animationDuration,
            ms: cs.animationDuration.split(',').map((s) => parseDur(s)),
            iterations: cs.animationIterationCount,
          })
        }
        const props = (cs.transitionProperty || '').split(',').map((s) => s.trim()).filter(Boolean)
        const durs = (cs.transitionDuration || '').split(',').map((s) => parseDur(s))
        if (props.length && props.join() !== 'all' && durs.some((d) => d > 0)) {
          const layout = props.filter((p) => LAYOUT_PROPS.indexOf(p) >= 0)
          trans.push({
            desc: describe(el) + (pseudo || ''),
            properties: props, durations: durs, maxMs: Math.max.apply(null, durs),
            layoutProps: layout,
          })
        }
      }
    }
    return { anims, trans }
  }

  function parseDur(s) {
    s = (s || '').trim()
    if (s.endsWith('ms')) return parseFloat(s)
    if (s.endsWith('s')) return parseFloat(s) * 1000
    return 0
  }

  api.readVars = function (names) {
    const cs = getComputedStyle(document.documentElement)
    const out = {}
    for (const n of names) out[n] = cs.getPropertyValue(n).trim()
    out['#data-theme'] = document.documentElement.getAttribute('data-theme')
    out['#color-scheme'] = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    out['#reduced-motion'] = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'
    return out
  }

  window.__a11y = api
})()
