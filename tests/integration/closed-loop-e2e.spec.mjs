/**
 * closed-loop-e2e.spec —— P8 出口门禁：端到端闭环（含"修复失败 → 定向重采 → 第二轮"）。
 *
 * 场景：
 *   round 1  生成脚本 → 采集 → 解析 → 诊断（一条 complete、一条 partial、一条未确认）
 *   用户执行修复 → 失败 → loop-controller 进入 AWAITING_COLLECTION（定向补采）
 *   round 2  只补采未确认根因所需的探针 → 解析（含缺段）→ 诊断（带 priorRound）→ 与上轮 diff
 *   终止   连续无变化 → stall → LIMIT_REACHED（终态"已达诊断上限"）
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'
import { createLoopController } from '../../src/engine/loop-controller.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const MACHINE = join(PKG_ROOT, 'model', 'loop-controller.machine.yaml')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }
const SEC = (n, body) => `=== ${n} ===\n--- cmd: probe-${n}\n${body}\n=== end:${n} ===`

export const NAME = 'closed-loop-e2e（generate→parse→diagnose→修复失败→定向重采→round2→stall 终态）'

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-e2e', version: '0.0.1' }))
  const session = 'e2e-1'
  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sessions'), persist: true })
  core.hotloader.init()
  const lc = createLoopController({ machinePath: MACHINE })

  // ── ① round 1：生成脚本 ──
  const g = core.generateCollectScript({ description: '推理服务崩溃，温度高、ECC 报错、容器 137', dimensions: DIMS })
  t.assert(g.ok === true && g.data.manifest.sections.length >= 5, '① generate 产出脚本与 manifest')

  // ── ② 用户执行脚本 → 粘贴报告 → 解析 ──
  // 夹具按 manifest 的 sections 生成：显式段给有诊断意义的正文，其余段给"无发现"占位行。
  // 这样**新增探针不会让 round1 报告变成"不完整"**（否则每加一个探针都要手改夹具，
  // 而 missingSections 会悄悄变成非空、把 e2e 的语义悄悄改掉）。
  const explicit = new Map([
    ['mindie-log', '[ERROR] RuntimeError: infer failed, abort\n[ERROR] driver version 24.1.RC2 != required 24.1.RC3 (compat check failed)'],
    ['npu-status', 'NPU 0 health OK'],
    ['npu-driver-matrix', 'driver 24.1.RC2\nboard 0x2c OK'],
    ['container-state', 'mindie-svc Exited (137) 2 hours ago\nExitCode 137 OOMKilled shm 64m'],
    ['container-log', 'shm allocation failed: out of memory'],
    ['npu-metrics', 'temp 92C (throttle threshold 85C)'],
    ['kernel-log', '[ 4821.13] HBM ECC uncorrectable error on device 3, rank 3'],
    // 2026-09-23：combo 新增输出质量探针（乱码类症状）
    ['serving-args', 'DSH-SIGNAL proc.pid=4242\n--tensor-parallel-size=4\nASCEND_PRECISION_MODE=fp16'],
    ['model-config', '"torch_dtype": "bfloat16"\n"max_position_embeddings": 32768'],
    ['model-weights', 'DSH-SIGNAL weights.shards_declared=8\nDSH-SIGNAL weights.shards_present=8'],
    ['tokenizer-fingerprint', '--- tokenizer-file: /m/tokenizer.json\nsha256:aaa'],
    ['quality-probe', '--- temp0-run1: 张量并行是把一层权重切成多份\nDSH-SIGNAL quality.deterministic=true'],
    ['precision-log', 'no fallback, no overflow'],
  ])
  const report1 = g.data.manifest.sections
    .map((s) => SEC(s, explicit.get(s) || 'no findings in this section'))
    .join('\n')
  const p1 = core.parseCollectReport({ report: report1, manifest: g.data.manifest })
  t.assert(p1.ok === true && p1.data.evidence.length >= 6, '② parse 抽取出证据')
  t.assert(p1.data.parseMeta.missingSections.length === 0, '② 报告完整')
  t.assert(g.data.manifest.sections.every((s) => p1.data.parseMeta.sectionsFound.includes(s)), '② 夹具覆盖 manifest 的全部 section')

  // ── ③ round 1 诊断 ──
  core.tracker.beginRound(session, DIMS)
  core.tracker.recordParsed(session, 1, {
    evidenceHashes: p1.data.probeHashes,
    missingSections: p1.data.parseMeta.missingSections,
    probesCollected: p1.data.probeHashes.map((h) => h.probe),
  })
  const d1 = core.diagnoseService({ evidence: p1.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: session } })
  t.assert(d1.ok === true && d1.data.effectiveRound === 1, '③ round1 诊断成功')
  const all1 = [...d1.data.rootCauses, ...(d1.data.closure.weakSignals || [])]
  const byId = Object.fromEntries(all1.map((x) => [x.id, x]))
  t.assert(Object.keys(byId).length >= 4, `③ 产出 ≥4 条根因（实际 ${Object.keys(byId).length}）`)
  const unconfirmed = all1.filter((x) => x.confidence === '未确认')
  t.assert(unconfirmed.length >= 1, '③ 存在未确认根因（本轮需补采）')
  t.assert(unconfirmed.every((x) => x.fix === null && x.additionalCollection), '③ 未确认根因：fix=null + 补采指令')
  const partial = all1.find((x) => x.fix && x.fix.state === 'partial')
  t.assert(!!partial && partial.additionalCollection.script.includes('dsh_desensitize'), '③ partial 根因带内嵌脱敏的定向补采脚本')
  t.assert(d1.data.closure.closure === 'closed', '③ 存在完整修复 → closure=closed')
  core.tracker.recordDiagnosis(session, 1, { fixState: partial ? 'partial' : 'complete' })

  // ── ④ 用户执行修复 → 失败 → 状态机进入定向补采 ──
  core.tracker.recordFixApplied(session, 1, { fixApplied: partial.note || '升级驱动', outcome: 'fix_failed' })
  const t1 = lc.step('FIX_APPLIED', 'FIX_FAIL', lc.defaultConfig({ round: 1, desens_ok: true }))
  t.assert(t1.state === 'AWAITING_COLLECTION', '④ 修复失败 → AWAITING_COLLECTION（定向补采）')
  const needProbes = [...new Set(unconfirmed.flatMap((x) => x.additionalCollection.needed.map((n) => n.probe)))]
  t.assert(needProbes.length >= 1, `④ 补采目标探针：${needProbes.join(', ')}`)

  // ── ⑤ round 2：只补采目标探针（脚本由 additionalCollection 提供）──
  core.tracker.beginRound(session, DIMS)
  const targeted = unconfirmed.find((x) => x.additionalCollection.script)
  t.assert(!!targeted, '⑤ 补采脚本可直接执行（来自 additionalCollection）')
  const report2 = [
    SEC('npu-metrics', 'temp 92C (throttle threshold 85C)\ntemp 94C (throttle threshold 85C)\ntemp 95C sustained 10min'),
    SEC('kernel-log', '[ 4821.13] HBM ECC uncorrectable error on device 3, rank 3'),
    // 注意：故意不包含 container-* 段 → 缺段（"未采集" ≠ "证据消失"）
  ].join('\n')
  const p2 = core.parseCollectReport({ report: report2 })
  t.assert(p2.ok === true, '⑤ round2 报告被接受')
  t.assert(p2.data.parseMeta.manifestMissing === true, '⑤ 未带 manifest（纯结构解析）')
  const keepSections = p2.data.parseMeta.sectionsFound
  core.tracker.recordParsed(session, 2, {
    evidenceHashes: p2.data.probeHashes,
    missingSections: ['container-state', 'container-log', 'mindie-log'].filter((s) => !keepSections.includes(s)),
    probesCollected: p2.data.probeHashes.map((h) => h.probe),
  })

  // ── ⑥ diff：识别变化，且未采集段**不算证据消失** ──
  const diff = core.tracker.diffWithPrevious(session, {
    evidenceHashes: p2.data.probeHashes,
    missingSections: ['container-state', 'container-log', 'mindie-log'],
  })
  t.assert(diff.available === true, '⑥ 能与上一轮对比')
  t.assert(diff.notCollected.length >= 1, '⑥ 未采集段进 notCollected')
  t.assert(diff.changed.every((c) => !['container-state', 'container-log'].includes(c.section)), '⑥ 未采集段绝不出现在 changed（不冒充"证据消失"）')

  // ── ⑦ round 2 诊断（带 priorRound）──
  const d2 = core.diagnoseService({
    evidence: p2.data.evidence,
    dimensions: DIMS,
    context: { round: 2, sessionId: session, priorRound: { fixApplied: partial.note, assets: core.hotloader.assetsHash } },
  })
  t.assert(d2.ok === true && d2.data.effectiveRound === 2, '⑦ round2 诊断生效（effectiveRound=2）')
  t.assert((d2.data.notices || []).filter((n) => n.code === 'version-drift').length === 0, '⑦ 同世代 → 无版本漂移声明')
  t.assert(d2.versions.assets === core.hotloader.assetsHash, '⑦ 结果绑定当前世代')
  const rcs2 = d2.data.rootCauses
  t.assert(rcs2.every((x) => x.evidence.length >= 1), '⑦ round2 每条根因仍绑定证据')

  // ── ⑧ 终止：连续无变化 → stall → 终态 ──
  const sameAgain = { evidenceHashes: p2.data.probeHashes, missingSections: ['container-state'] }
  core.tracker.recordParsed(session, 3, sameAgain)
  const diff3 = core.tracker.diffWithPrevious(session, sameAgain)
  t.assert(diff3.stall === true, '⑧ 连续无变化 → stall=true')
  const tstall = lc.step('AWAITING_COLLECTION', 'STALL', lc.defaultConfig({ round: 2, changed: false }))
  t.assert(tstall.state === 'LIMIT_REACHED', '⑧ stall → LIMIT_REACHED（终态）')
  const tmax = lc.step('AWAITING_COLLECTION', 'PASTE_REPORT', lc.defaultConfig({ round: 3, desens_ok: true }))
  t.assert(tmax.state === 'LIMIT_REACHED', '⑧ round 达上限 → LIMIT_REACHED')
  t.assert(String(tstall.branch.action).includes('diagnostic cap') || String(tstall.branch.action).includes('no evidence change'), '⑧ 终态动作文本记录终止原因')
  // 终态忽略后续事件（不会"复活"）
  t.assert(lc.step('LIMIT_REACHED', 'PASTE_REPORT', lc.defaultConfig({ round: 1 })).state === 'LIMIT_REACHED', '⑧ 终态吸收后续事件（不复活）')

  // ── ⑨ 全链路无明文落盘（抽查：存储目录里没有报告原文）──
  const { readFileSync, readdirSync } = await import('node:fs')
  const dir = join(tmp, 'sessions')
  let leaked = false
  for (const f of readdirSync(dir)) {
    const txt = readFileSync(join(dir, f), 'utf8')
    if (txt.includes('HBM ECC uncorrectable') || txt.includes('throttle threshold')) leaked = true
  }
  t.assert(leaked === false, '⑨ 跨轮持久化中无报告原文（只存 hash/结构）')

  rmSync(tmp, { recursive: true, force: true })
}
