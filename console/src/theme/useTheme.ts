import { useCallback, useEffect, useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'
const KEY = 'mde-console-theme'

/** 读存储。私密窗口 / 禁用站点数据的浏览器会直接抛，不能让它炸掉整个应用。 */
function read(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply(t: Theme): void {
  // 「跟随系统」是**移除属性**，不是写 data-theme="system"。
  // tokens.css 的暗色块是 :root:not([data-theme="light"])，任何标记都会改变匹配。
  if (t === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', t)
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, setState] = useState<Theme>(read)

  useEffect(() => {
    apply(theme)
  }, [theme])

  const setTheme = useCallback((t: Theme) => {
    setState(t)
    try {
      t === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t)
    } catch {
      /* 存不了就只在本次会话生效 */
    }
  }, [])

  return { theme, setTheme }
}
