/**
 * assets-hash —— `versions.assets` 的**唯一**算法（缺陷 #57 的修复落点）。
 *
 * 问题（2026-09-28 实测）：同一个 `assets` 版本字段曾有两个实现——
 *   ① `assets-hotloader`：哈希 6 个 SCAN_ROOT 下的全部 `.yaml/.yml/.json`（相对 assets/ 的路径）
 *   ② `dimension-loader#hashFiles`：只哈希"本次实际加载进维度注册表的那几个文件"
 * 二者对同一份资产给出**不同值**（长驻实例 `98525bfe…` vs 一次性进程 `a31df131…`）。
 * `index.js` 的 `assetsHashNow() = hotloader.assetsHash || layer.generationInfo().assetsHash`
 * 于是在"热点加载器尚未产出世代"的进程里悄悄换成了另一个数——`version-drift` 比对
 * 建立在"assets 值可比较"的假设上，双实现破坏了这个假设。
 *
 * 现约定：
 *   - **唯一**算法在本文件；`assets-hotloader` 与 `dimension-loader` 都从这里取。
 *   - 哈希输入 = 按 `path.localeCompare` 排序后的每个文件：`rel \0 content \0`
 *     （`rel` 是相对 assetsRoot 的 POSIX 路径）。**逐字节与历史 hotloader 实现一致**，
 *     故长驻实例的权威值不变，只有原先跑偏的 fallback 被纠正到同一个值。
 *   - `hashAssetsTree()` 是 fallback 路径的入口（不依赖 fs.watch / 轮询 / 计时器）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

/** 参与 `versions.assets` 的资产根目录（相对 assetsRoot）。改这里等于改版本语义。 */
export const ASSET_SCAN_ROOTS = Object.freeze([
  'config', 'dimensions', 'rules', 'root-causes', 'templates', 'verification',
])

/** 参与哈希的扩展名。 */
export const ASSET_EXT_RE = /\.(ya?ml|json)$/

/**
 * 扫描 assetsRoot 下的资产文件（不含内容），返回稳定排序的绝对路径列表。
 * @param {string} assetsRoot
 * @param {{roots?: readonly string[]}} [opts]
 */
export function scanAssetPaths(assetsRoot, { roots = ASSET_SCAN_ROOTS } = {}) {
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (ASSET_EXT_RE.test(name)) out.push(p)
    }
  }
  for (const r of roots) walk(join(assetsRoot, r))
  return out.sort((a, b) => a.localeCompare(b))
}

/**
 * 纯函数版资产树哈希——**fallback 路径**（无 ctx/timer/轮询时）与 hotloader 用同一算法。
 * @param {string} assetsRoot
 * @param {{roots?: readonly string[]}} [opts]
 * @returns {string} `sha256:<32 hex>`
 */
export function hashAssetsTree(assetsRoot, opts = {}) {
  const h = createHash('sha256')
  for (const p of scanAssetPaths(assetsRoot, opts)) {
    const rel = relative(assetsRoot, p).split('\\').join('/')
    h.update(rel)
    h.update('\u0000')
    h.update(readFileSync(p))
    h.update('\u0000')
  }
  return `sha256:${h.digest('hex').slice(0, 32)}`
}
