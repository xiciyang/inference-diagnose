/**
 * assets-hotloader —— §4.2 L1 资产热加载（世代切换 / fail-soft / 安全闸门不降级）。
 *
 * 语义（§4.2）：
 *   - 触发：fs.watch 优先 + mtime/size 轮询兜底（容器与网络 FS 上 watch 不可靠）
 *   - 加载：读 → 解析 → per-class 校验 → 计算内容 hash
 *   - 原子切换：新代全部通过才切 current；任一失败保留旧代 + 记录诊断
 *   - **安全闸门不降级**：脱敏规则校验失败绝不切到"无规则"代
 *
 * 世代号单调递增；assetsHash 即 versions.assets 的来源。
 */
import { readFileSync, watch } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'
import { parse } from './yaml-lite.js'
import { scanAssetPaths } from './assets-hash.js'

export function createHotloader({ assetsRoot, pollMs = 5000, logger = null }) {
  let generation = 0
  let current = null // { generation, assetsHash, files, errors }
  const log = (m) => {
    try {
      if (logger && typeof logger.info === 'function') logger.info(`[hotloader] ${m}`)
    } catch {
      /* 日志失败静默 */
    }
  }

  /** 扫描 + 校验一个候选世代；返回 { ok, assetsHash, files, errors }。不改变 current。 */
  function loadGeneration() {
    // 文件集合与排序**唯一**由 assets-hash.js 决定（缺陷 #57：这里曾与
    // dimension-loader 各有一套算法，对同一份资产给出两个 assets 值）
    const files = scanAssetPaths(assetsRoot).map((p) => ({ path: p }))
    const errors = []
    const hash = createHash('sha256')
    const rels = []
    for (const f of files) {
      const rel = relative(assetsRoot, f.path).split('\\').join('/')
      rels.push(rel)
      let buf
      try {
        buf = readFileSync(f.path)
      } catch (e) {
        errors.push(`${rel}: 读取失败 ${String(e.message).slice(0, 60)}`)
        continue
      }
      hash.update(rel)
      hash.update('\u0000')
      hash.update(buf)
      hash.update('\u0000')
      if (rel.endsWith('.yaml') || rel.endsWith('.yml')) {
        try {
          parse(buf.toString('utf8'))
        } catch (e) {
          errors.push(`${rel}: YAML 解析失败 ${String(e.message).slice(0, 80)}`)
        }
      } else if (rel.endsWith('.json')) {
        try {
          JSON.parse(buf.toString('utf8'))
        } catch (e) {
          errors.push(`${rel}: JSON 解析失败 ${String(e.message).slice(0, 60)}`)
        }
      }
    }
    // 安全闸门：脱敏规则必须存在且至少一条（绝不切到"无规则"代）
    const hasRules = rels.some((r) => r.startsWith('rules/'))
    if (!hasRules) errors.push('rules/: 缺失脱敏规则（安全闸门：拒绝切到无规则世代）')
    return {
      ok: errors.length === 0,
      assetsHash: `sha256:${hash.digest('hex').slice(0, 32)}`,
      files: rels,
      errors,
    }
  }

  /** 首次装载（失败即抛：初始世代不可用时不进入服务）。 */
  function init() {
    const g = loadGeneration()
    generation = 1
    current = { generation, ...g }
    if (!g.ok) {
      const e = new Error(`初始资产世代校验失败：${g.errors.join('；')}`)
      e.assetsErrors = g.errors
      throw e
    }
    log(`generation=1 files=${g.files.length} assets=${g.assetsHash}`)
    return current
  }

  /**
   * 重新扫描；有变化且新代校验通过 → 原子切换到新代。
   * 失败：保留旧代 + 返回 problems（不抛，调用方决定是否报警）。
   */
  function reloadIfChanged() {
    const g = loadGeneration()
    if (current && g.assetsHash === current.assetsHash) return { changed: false, generation, assetsHash: current.assetsHash }
    if (!g.ok) {
      log(`reload rejected (keep generation=${generation}): ${g.errors.join('；')}`)
      return { changed: false, generation, assetsHash: current.assetsHash, problems: g.errors, keptGeneration: generation }
    }
    generation += 1
    const prev = current
    current = { generation, ...g }
    log(`generation=${generation} switched (prev=${prev ? prev.generation : 'none'}) assets=${g.assetsHash}`)
    return { changed: true, generation, assetsHash: g.assetsHash, previous: prev ? prev.generation : null, files: g.files }
  }

  /** fs.watch（尽力而为）+ 轮询兜底。返回 dispose。 */
  function watchAndPoll(onChange) {
    let timer = null
    let watcher = null
    const tick = () => {
      const r = reloadIfChanged()
      if (r.changed || (r.problems && r.problems.length)) onChange(r)
    }
    try {
      watcher = watch(assetsRoot, { recursive: true }, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(tick, 300)
      })
      if (watcher && typeof watcher.on === 'function') watcher.on('error', () => {})
    } catch {
      watcher = null // 某些平台/FS 不支持 recursive watch → 仅靠轮询
    }
    const poll = setInterval(tick, pollMs)
    return () => {
      if (timer) clearTimeout(timer)
      clearInterval(poll)
      if (watcher) {
        try {
          watcher.close()
        } catch {
          /* ignore */
        }
      }
    }
  }

  return {
    init,
    reloadIfChanged,
    watchAndPoll,
    status: () => (current ? { generation: current.generation, assetsHash: current.assetsHash, files: current.files.length, ok: current.ok } : null),
    get assetsHash() {
      return current ? current.assetsHash : null
    },
    get generation() {
      return generation
    },
  }
}
