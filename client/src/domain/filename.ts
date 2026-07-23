const ILLEGAL = /[\\/:：*?"<>|]/g
/** 目录名：<date>_<hhmm>_<清洗主题>_<code>。非法字符→-，字素簇截断 60，空主题兜底 */
export function cleanDirName(date: string, hhmm: string, subject: string, code: string): string {
  let s = (subject ?? '').replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim()
  const graphemes = [...s]                          // 按码点近似字素簇，避免切断代理对
  if (graphemes.length > 60) s = graphemes.slice(0, 60).join('')
  if (s.length === 0) s = 'untitled'
  return `${date}_${hhmm}_${s}_${code}`
}
