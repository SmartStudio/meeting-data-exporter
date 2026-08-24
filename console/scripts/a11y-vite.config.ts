/** a11y 门槛专用的构建配置。
 *
 * 与 `npm run build` 唯一的差别是 CSS Module 的类名生成器：默认是哈希
 * （`_1f3x9`），这里改成 `组件名__局部名`（`MeetingRow__extendBtn`）。
 * 它**不改变规则顺序、不改变优先级**——两者都是单个类选择器——只是让门槛
 * 的报告能指名道姓说出是哪个组件的哪条样式。brief Step 5：只报「有 3 处失败」
 * 的脚本没人会去修。
 *
 * 其余一切（插件、别名、构建目标）都从 `../vite.config.ts` 合并，不复制一份，
 * 免得两边漂开之后门槛验的其实不是真实构建。
 * 产物落在 `node_modules/.a11y-dist`，不覆盖 `npm run build` 的 `dist/`。
 */
import path from 'node:path'
import { mergeConfig, type UserConfig } from 'vite'
import base from '../vite.config'

/** `src/ui/Input.module.css` 里的 `.field` → `Input__field`。 */
function scopedName(local: string, filename: string): string {
  const stem = path.basename(filename).replace(/\.module\.css$/i, '').replace(/[^\w-]/g, '')
  return `${stem}__${local}`
}

export default mergeConfig(base as unknown as UserConfig, {
  css: { modules: { generateScopedName: scopedName } },
  build: { outDir: 'node_modules/.a11y-dist', emptyOutDir: true, sourcemap: false },
} satisfies UserConfig)
