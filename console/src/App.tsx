import styles from './App.module.css'
import { useTheme, type Theme } from './theme/useTheme'

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

// 验证令牌真的画出来了：一批代表性令牌，各梯度都要出现。
const SWATCHES: Array<{ token: string; label: string }> = [
  { token: 'brand', label: '主交互 · 数据可被取走' },
  { token: 'brand-press', label: '主交互 · 按下态' },
  { token: 'warn', label: '手动改写 / 保留期将至' },
  { token: 'fail', label: '失败 · 最严重状态' },
  { token: 'ground', label: '页面底' },
  { token: 'surface', label: '卡片底' },
  { token: 'rail', label: '左栏' },
  { token: 'ink', label: '正文一档' },
  { token: 'ink-2', label: '正文二档' },
  { token: 'ink-3', label: '正文三档 · 梯度到此为止' },
  { token: 'ink-4', label: '图形专用 · 禁止用于文字' },
]

export default function App() {
  const { theme, setTheme } = useTheme()

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>控制台工程骨架</h1>
          <span className={styles.badge}>原型 · 全部数字为示例</span>
        </div>
        <div className={styles.themeGroup} role="group" aria-label="主题切换">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={
                theme === option.value
                  ? `${styles.themeButton} ${styles.themeButtonActive}`
                  : styles.themeButton
              }
              aria-pressed={theme === option.value}
              onClick={() => setTheme(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>令牌色板（当前主题：{theme}）</h2>
        <div className={styles.grid}>
          {SWATCHES.map(({ token, label }) => (
            <div key={token} className={styles.swatch}>
              <div
                className={styles.swatchColor}
                style={{ background: `var(--${token})` }}
              />
              <span className={styles.swatchLabel}>--{token}</span>
              <span className={styles.swatchValue}>{label}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
