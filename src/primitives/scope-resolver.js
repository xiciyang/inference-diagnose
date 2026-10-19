/**
 * scope-resolver —— §4.4 细化 1「按维度定域失效」（L2，P3 新增）。
 *
 * 问题：assets 变化通常只影响**部分维度**（例如只改了某个 hardware 维度文件）。
 * 若把整份采集证据判失效，一次硬件维度更新会连带把 kernel-log 等无关 section 的证据也废掉。
 *
 * 解法：定位变化的维度文件 → 求其贡献的探针 → 求这些探针覆盖的 section →
 * **只**把这些 section 判为受影响；其余 section 的证据 hash 仍参与跨轮 diff。
 *
 * 与 §2.4「缺失 section 不参与 diff」同源原则：**不相关的变化不得冒充"证据消失/失效"**。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from './yaml-lite.js'

/** 从 assets 相对路径解析出维度身份：dimensions/<kind>/<id>.yaml */
export function dimensionOfPath(rel) {
  const m = String(rel).match(/^dimensions\/(framework|runtime|hardware)\/([^/]+)\.ya?ml$/)
  return m ? { kind: m[1], id: m[2] } : null
}

/**
 * @param {object} p
 * @param {string} p.assetsRoot
 * @param {string[]} p.changedPaths 相对 assetsRoot 的变化文件（如 hotloader 的 diff 输出）
 * @param {object} p.combo          resolveCombo 结果（提供 section ↔ probe 全域）
 * @param {Array<{probe:string,section:string,hash:string}>} [p.prevHashes] 上轮探针 hash
 */
export function scopedInvalidation({ assetsRoot, changedPaths = [], combo, prevHashes = [] }) {
  const dims = []
  let rulesChanged = false
  let templatesChanged = false
  for (const rel of changedPaths) {
    const d = dimensionOfPath(rel)
    if (d) dims.push({ ...d, path: rel })
    else if (/^rules\//.test(rel)) rulesChanged = true
    else if (/^templates\//.test(rel)) templatesChanged = true
  }

  const probes = new Set()
  const problems = []
  for (const d of dims) {
    const p = join(assetsRoot, d.path)
    if (!existsSync(p)) {
      // 维度被删除：其探针整体从组合里消失 → 相关 section 视为受影响（但不算"证据消失"）
      for (const pr of combo.probes.filter((x) => x.from === `${d.kind}:${d.id}`)) probes.add(pr.probe)
      continue
    }
    try {
      const doc = parse(readFileSync(p, 'utf8'))
      for (const pr of doc.probes || []) if (pr && pr.id) probes.add(pr.id)
    } catch (e) {
      problems.push(`${d.path}: 解析失败 ${String(e.message).slice(0, 60)}`)
    }
  }

  const affectedProbes = combo.probes.filter((p) => probes.has(p.probe))
  const affectedSections = [...new Set(affectedProbes.map((p) => p.section))]
  const allSections = [...new Set(combo.probes.map((p) => p.section))]
  const unaffectedSections = allSections.filter((s) => !affectedSections.includes(s))

  // 参与 diff 的探针：上轮 hash 中**不属于**受影响 section 的那些
  const comparable = prevHashes.filter((h) => !affectedSections.includes(h.section))
  const excluded = prevHashes.filter((h) => affectedSections.includes(h.section))

  return {
    changedDimensions: dims,
    rulesChanged,
    templatesChanged,
    affectedProbes: affectedProbes.map((p) => p.probe),
    affectedSections,
    unaffectedSections,
    /** 仍参与跨轮 diff 的探针（关键：不是整份判失效） */
    comparableProbes: comparable.map((h) => h.probe),
    /** 被判"采集失效"的探针（这些才需要定向补采） */
    invalidatedProbes: excluded.map((h) => h.probe),
    problems,
  }
}
