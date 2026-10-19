/**
 * abstraction-layer —— §3.1 三维抽象接口 + L3 逃生舱派发。
 *
 * 职责：
 *   ① 对外提供"三维组合 → 探针/规则"的单一入口（包装 dimension-loader）
 *   ② L3 逃生舱：当某个维度需要数据表达不了的计算时，按 id 尝试加载
 *      src/dimensions/<id>.js（编译进包，现场一般不改）。缺失即返回 null
 *      —— 这是"默认走数据、必要时才写代码"的边界。
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createLoader } from './dimension-loader.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ESCAPE_DIR = join(HERE, '..', 'dimensions')

export function createAbstractionLayer({ assetsRoot }) {
  const loader = createLoader({ assetsRoot })

  /** 三维词表（用于 hint 里列可用取值）。 */
  function vocabulary() {
    return loader.listDimensions()
  }

  /** 解析组合；未注册/越界/组合非法由 loader 抛 ToolError（§2.1 映射）。 */
  function resolve(dims) {
    const combo = loader.resolveCombo(dims)
    return combo
  }

  /** 探测某个维度条目是否有 L3 逃生舱实现（有则加载，无则 null）。 */
  async function escapeHatch(kind, id) {
    const candidates = [join(ESCAPE_DIR, `${id}.js`), join(ESCAPE_DIR, kind, `${id}.js`)]
    for (const p of candidates) {
      if (!existsSync(p)) continue
      const mod = await import(pathToFileURL(p).href)
      return mod && typeof mod.apply === 'function' ? mod : null
    }
    return null
  }

  return {
    vocabulary,
    resolve,
    probeCatalog: loader.probeCatalog,
    sections: loader.sections,
    escapeHatch,
    invalidate: loader.invalidate,
    generationInfo: loader.generationInfo,
  }
}
