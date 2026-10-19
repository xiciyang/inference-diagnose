/**
 * evidence-diff.spec —— P3 出口门禁之二（§2.4 diff 规则 + §4.4 细化 1 按维度定域失效）。
 *
 * 核心命题：**"未采集" ≠ "证据消失"**，且**不相关的变化不得冒充证据失效**。
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createTracker } from '../../src/session/closure-tracker.js'
import { createLoader } from '../../src/primitives/dimension-loader.js'
import { scopedInvalidation, dimensionOfPath } from '../../src/primitives/scope-resolver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }

export const NAME = 'evidence-diff（探针粒度 diff + 缺失段不参与 + 按维度定域失效）'

const H = (probe, section, hash) => ({ probe, section, hash })

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-diff-'))
  const tracker = createTracker({ storageDir: join(tmp, 'sessions'), persist: true })

  // ---- 上一轮（round 1）----
  tracker.recordParsed('s1', 1, {
    evidenceHashes: [
      H('kernel-log', 'kernel-log', 'sha256:k1'),
      H('npu-metrics', 'npu-metrics', 'sha256:m1'),
      H('mindie-log', 'mindie-log', 'sha256:l1'),
      H('env', 'env', 'sha256:e1'),
    ],
    missingSections: [],
    probesCollected: ['kernel-log', 'npu-metrics', 'mindie-log', 'env'],
  })

  // ---- 本轮（round 2）：kernel 变了、npu 没变、mindie 缺段、env 无交集、新增 container ----
  tracker.recordParsed('s1', 2, {
    evidenceHashes: [
      H('kernel-log', 'kernel-log', 'sha256:k2'),
      H('npu-metrics', 'npu-metrics', 'sha256:m1'),
      H('container-state', 'container-state', 'sha256:c1'),
    ],
    missingSections: ['mindie-log'],
  })

  const cur = {
    evidenceHashes: [
      H('kernel-log', 'kernel-log', 'sha256:k2'),
      H('npu-metrics', 'npu-metrics', 'sha256:m1'),
      H('container-state', 'container-state', 'sha256:c1'),
    ],
    missingSections: ['mindie-log'],
  }
  const diff = tracker.diffWithPrevious('s1', cur)
  t.assert(diff.available === true && diff.prevRound === 1, '可对比上一轮（round 1）')
  t.assert(diff.changed.length === 1 && diff.changed[0].probe === 'kernel-log', '只把 hash 变化的探针算作 changed')
  t.assert(diff.changed[0].before === 'sha256:k1' && diff.changed[0].after === 'sha256:k2', 'changed 记录前后 hash')
  t.assert(diff.unchanged.some((u) => u.probe === 'npu-metrics'), 'hash 未变 → unchanged')
  t.assert(diff.notCollected.some((n) => n.probe === 'mindie-log' && /未采集/.test(n.why)), '本轮缺段 → notCollected（**不判为证据消失**）')
  t.assert(!diff.changed.some((c) => c.probe === 'mindie-log'), '缺段探针绝不进 changed')
  t.assert(diff.notCollected.some((n) => n.probe === 'env' && /无交集/.test(n.why)), '两轮 section 无交集 → 超出对比域（不算消失）')
  t.assert(diff.added.some((a) => a.probe === 'container-state'), '本轮新增探针 → added')
  t.assert(diff.stall === false, '有变化 → stall=false')

  // ---- stall：连续两轮完全一致 ----
  tracker.recordParsed('s1', 3, { evidenceHashes: cur.evidenceHashes, missingSections: ['mindie-log'] })
  const diff3 = tracker.diffWithPrevious('s1', cur)
  t.assert(diff3.stall === true, '无 changed 且无 added → stall=true（终止信号）')

  // ---- 不可对比：只有一轮 ----
  const d0 = tracker.diffWithPrevious('s-fresh', cur)
  t.assert(d0.available === false && /没有上一轮/.test(d0.reason), '无上一轮记录时 available=false（不是空 diff）')

  // ---- 按维度定域失效（§4.4 细化 1）----
  const assetsRoot = join(PKG_ROOT, 'assets')
  const loader = createLoader({ assetsRoot })
  const combo = loader.resolveCombo(DIMS)
  const prevHashes = combo.probes.map((p, i) => H(p.probe, p.section, `sha256:x${i}`))

  const scope = scopedInvalidation({ assetsRoot, changedPaths: ['dimensions/hardware/ascend-arm.yaml'], combo, prevHashes })
  t.assert(scope.changedDimensions.length === 1 && scope.changedDimensions[0].kind === 'hardware', '识别出变化的是 hardware 维度')
  t.assert(scope.affectedSections.includes('kernel-log') && scope.affectedSections.includes('npu-metrics'), '受影响 section 含该维度贡献的段')
  t.assert(scope.unaffectedSections.includes('mindie-log') && scope.unaffectedSections.includes('container-log'), '未被改动的维度段保持可比（mindie/container）')
  t.assert(!scope.invalidatedProbes.includes('mindie-log'), 'mindie-log **不**被判采集失效（这正是"不整份判失效"）')
  t.assert(scope.comparableProbes.includes('mindie-log') && scope.comparableProbes.includes('container-state'), '未受影响的探针仍参与跨轮 diff')
  t.assert(scope.invalidatedProbes.includes('kernel-log'), '受影响探针被判采集失效（需定向补采）')
  t.assert(scope.rulesChanged === false && scope.templatesChanged === false, '非规则/模板变更时不置对应标志')

  const scopeRules = scopedInvalidation({ assetsRoot, changedPaths: ['rules/desensitize-v1.yaml'], combo, prevHashes })
  t.assert(scopeRules.rulesChanged === true && scopeRules.affectedSections.length === 0, '规则变更 → rulesChanged=true 且不把任何 section 判失效')

  // ---- 路径解析 ----
  t.assert(dimensionOfPath('dimensions/hardware/ascend-arm.yaml').id === 'ascend-arm', 'dimensionOfPath 解析 id')
  t.assert(dimensionOfPath('rules/desensitize-v1.yaml') === null, '非维度路径返回 null')

  rmSync(tmp, { recursive: true, force: true })
}
