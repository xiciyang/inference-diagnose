/**
 * dimension-loader —— §3.1 三维抽象层 API（L2，只认契约不认品牌）。
 *
 * 硬约束 1 的落点：本文件不得出现任何框架/硬件品牌字样；三维取值与探针集
 * 全部来自 L1 数据（assets/config/dims.json + assets/dimensions/<kind>/<id>.yaml）。
 *
 * API（§3.1）：
 *   listDimensions()                 → { framework:[], runtime:[], hardware:[] }
 *   resolveCombo({framework,runtime,hardware}) → { dims, probes, ruleFiles, ... }
 *   probeCatalog(combo, probeIds)    → 定向补采所需探针（§2.4 additionalCollection）
 *
 * 错误映射（§2.1 依赖源矩阵）：注册表读不到/非法 → ERR_DIMENSIONS_NOT_LOADED（REFUSE）；
 * 缺项/取值越界/组合非法 → ERR_MISSING_PARAM（用户可修，hint 列可用取值）。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from './yaml-lite.js'
import { hashAssetsTree } from './assets-hash.js'
import { ToolError, ErrCode } from '../protocol/envelope.js'

export const KINDS = Object.freeze(['framework', 'runtime', 'hardware'])

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * @param {{assetsRoot: string}} opts
 */
export function createLoader({ assetsRoot }) {
  const cfgPath = join(assetsRoot, 'config', 'dims.json')
  let cache = null

  function loadRegistry() {
    if (cache) return cache
    if (!existsSync(cfgPath)) {
      throw new ToolError(ErrCode.DIMENSIONS_NOT_LOADED, {
        affected: ['dims-registry'],
        policy: 'REFUSE',
        recoverable: true,
        hint:
          '维度注册表不可用：找不到 assets/config/dims.json，无法解析 framework/runtime/hardware ' +
          '取值与探针集（fail-closed）。请检查插件包内 assets/config/dims.json 与 assets/dimensions/ 是否就位。',
      })
    }
    let cfg
    try {
      cfg = readJson(cfgPath)
    } catch (e) {
      throw new ToolError(ErrCode.DIMENSIONS_NOT_LOADED, {
        affected: ['dims-registry'],
        policy: 'REFUSE',
        recoverable: true,
        hint: `维度注册表非法 JSON：${String(e.message).slice(0, 120)}。请修正 assets/config/dims.json（fail-closed）。`,
      })
    }
    const kinds = cfg.kinds || {}
    const entries = {}
    const files = ['config/dims.json']
    const problems = []
    for (const kind of KINDS) {
      const ids = Array.isArray(kinds[kind]) ? kinds[kind] : []
      entries[kind] = {}
      for (const id of ids) {
        const rel = `dimensions/${kind}/${id}.yaml`
        const p = join(assetsRoot, rel)
        if (!existsSync(p)) {
          problems.push(`${kind}:${id} → 缺 ${rel}`)
          continue
        }
        try {
          const doc = parse(readFileSync(p, 'utf8'))
          if (!doc || typeof doc !== 'object') throw new Error('not a mapping')
          if (doc.id !== id) problems.push(`${kind}:${id} → 文件内 id="${doc.id}" 与注册表不一致`)
          if (doc.kind !== kind) problems.push(`${kind}:${id} → 文件内 kind="${doc.kind}" 与目录不一致`)
          entries[kind][id] = doc
          files.push(rel)
        } catch (e) {
          problems.push(`${rel} 解析失败：${String(e.message).slice(0, 80)}`)
        }
      }
    }
    if (problems.length > 0) {
      throw new ToolError(ErrCode.DIMENSIONS_NOT_LOADED, {
        affected: ['dims-registry'],
        policy: 'REFUSE',
        recoverable: true,
        hint: `维度注册表存在问题，拒绝在维度集合不完整时继续（fail-closed）：${problems.join('；')}`,
      })
    }
    cache = {
      kinds: Object.fromEntries(KINDS.map((k) => [k, Object.keys(entries[k])])),
      entries,
      files,
      loadOrder: Array.isArray(cfg.loadOrder) && cfg.loadOrder.length ? cfg.loadOrder : [...KINDS],
      overrides: cfg.overrides || {},
      // 兜底路径的 assets 版本：必须是**与 hotloader 同算法**的资产树哈希（缺陷 #57）。
      // 放在缓存对象里 ⇒ 未 invalidate 时不重读盘（缓存语义不变）。
      assetsHash: hashAssetsTree(assetsRoot),
    }
    return cache
  }

  function listDimensions() {
    const reg = loadRegistry()
    return { ...reg.kinds }
  }

  function resolveCombo(dims) {
    const reg = loadRegistry()
    const input = dims || {}
    const missing = KINDS.filter((k) => !input[k]).map((k) => `dimensions.${k}`)
    if (missing.length > 0) {
      throw new ToolError(ErrCode.MISSING_PARAM, {
        missing,
        recoverable: true,
        hint:
          `请确认故障机器的框架/运行时/硬件。当前缺 ${missing.join(', ')}；` +
          `可用取值：` +
          KINDS.map((k) => `${k} ∈ [${reg.kinds[k].join(', ')}]`).join('；'),
      })
    }
    const unknown = []
    for (const k of KINDS) {
      if (!reg.kinds[k].includes(input[k])) unknown.push(`${k}="${input[k]}"（可用：${reg.kinds[k].join(', ')}）`)
    }
    if (unknown.length > 0) {
      throw new ToolError(ErrCode.MISSING_PARAM, {
        missing: KINDS.filter((k) => !reg.kinds[k].includes(input[k])).map((k) => `dimensions.${k}`),
        recoverable: true,
        hint: `三维取值不在词表内：${unknown.join('；')}。请改用词表内取值，或先在 assets/dimensions/ 中新增该维度。`,
      })
    }

    const ordered = [...reg.loadOrder.filter((k) => KINDS.includes(k)), ...KINDS.filter((k) => !reg.loadOrder.includes(k))]
    const probes = new Map()
    const ruleFiles = new Set()
    const envHints = {}
    const missingPeer = []
    for (const kind of ordered) {
      const doc = reg.entries[kind][input[kind]]
      for (const [peerKind, allowed] of Object.entries(doc.requires || {})) {
        if (!allowed.includes(input[peerKind])) {
          missingPeer.push(`${kind}:${input[kind]} 要求 ${peerKind} ∈ [${allowed.join(', ')}]，当前 "${input[peerKind]}"`)
        }
      }
      for (const p of doc.probes || []) {
        if (!p || !p.id || !p.section) continue
        if (!probes.has(p.id)) {
          probes.set(p.id, { probe: p.id, section: p.section, command: p.command || '', from: `${kind}:${input[kind]}` })
        }
      }
      for (const r of doc.ruleRefs || []) ruleFiles.add(r)
      Object.assign(envHints, doc.envHints || {})
    }
    if (missingPeer.length > 0) {
      throw new ToolError(ErrCode.MISSING_PARAM, {
        missing: ['dimensions'],
        recoverable: true,
        hint: `三维组合不合法：${missingPeer.join('；')}。请改成受支持的组合。`,
      })
    }
    return {
      dims: { framework: input.framework, runtime: input.runtime, hardware: input.hardware },
      probes: [...probes.values()],
      ruleFiles: [...ruleFiles],
      ruleFilesSorted: [...ruleFiles].sort(),
      envHints,
      missingPeer,
      warnings: [],
      assetsHash: reg.assetsHash,
    }
  }

  /** 定向补采：按 probe id 取探针定义（§2.4 additionalCollection 消费）。 */
  function probeCatalog(combo, probeIds) {
    const wanted = probeIds ? new Set(probeIds) : null
    return combo.probes.filter((p) => !wanted || wanted.has(p.probe))
  }

  function sections(combo) {
    return [...new Set(combo.probes.map((p) => p.section))]
  }

  /** 热加载用：丢弃缓存，下次访问重新读盘（§4.2 世代切换由 assets-hotloader 驱动）。 */
  function invalidate() {
    cache = null
  }

  function generationInfo() {
    const reg = loadRegistry()
    return { assetsHash: reg.assetsHash, files: reg.files }
  }

  return { listDimensions, resolveCombo, probeCatalog, sections, invalidate, generationInfo, assetsRoot }
}

/** 便于测试：列出 assets 根下所有维度文件（不经过注册表，用于"未见过维度"注入检查）。 */
export function scanDimensionFiles(assetsRoot) {
  const out = []
  for (const kind of KINDS) {
    const dir = join(assetsRoot, 'dimensions', kind)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.yaml') || f.endsWith('.yml')) out.push(`dimensions/${kind}/${f}`)
    }
  }
  return out.sort()
}
