/**
 * consistency-contract.spec —— P11 专项（C 范式：一致性诊断，最小可用实现）。
 *
 * 用户 2026-09-28 裁决：能复现 → 走复现路径（采集多次同输入输出、检出非确定性）；
 * 不能复现 → 查环境差异（驱动版本、硬件批次、并发配置）；
 * **复用 A 的状态机，不新增状态机**；新规则库 assets/root-causes/consistency/。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'
import { parse } from '../../src/primitives/yaml-lite.js'

export const NAME = 'consistency-contract（C 复现路径 / 环境差异路径 / 复用 A 状态机 / L1 指纹白名单）'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'vllm', runtime: 'docker', hardware: 'ascend-arm' }
const SEC = (n, b) => `=== ${n} ===\n--- cmd: probe-${n}\n${b}\n=== end:${n} ===`
const SAMPLE = (i, hash, finish) => `DSH-SIGNAL quality.sample.${i}=core_hash:${hash} {"c":"张量并行","c_len":4,"r_len":0,"finish":"${finish}"}`

const ENV_SECTIONS = [
  SEC('vllm-version', 'DSH-SIGNAL pkg.vllm=0.27.1\nDSH-SIGNAL pkg.vllm-ascend=0.1.dev5097\nDSH-SIGNAL npu.device_count=8\nDSH-SIGNAL torch_npu.available=true'),
  SEC('npu-driver-matrix', 'driver 25.5.1\nfirmware 25.5.1\nboard 0x2c SOC ascend910_9391'),
  SEC('vllm-serving-args', '--max-num-seqs=32\n--tensor-parallel-size=8\n--enable-chunked-prefill'),
]

function attempt(fn) {
  try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e.code, body: e.body } }
}

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-cons-'))
  const core = createCore({ pkgRoot: PKG_ROOT, storageDir: join(tmp, 's'), persist: false })

  // ── ① 规则库分区（L1，独立于 A/B）──
  for (const f of ['determinism-rules.yaml', 'environment-rules.yaml']) {
    t.assert(existsSync(join(PKG_ROOT, 'assets', 'root-causes', 'consistency', f)), `consistency/${f} 在位`)
  }
  const detDoc = parse(readFileSync(join(PKG_ROOT, 'assets', 'root-causes', 'consistency', 'determinism-rules.yaml'), 'utf8'))
  t.assert(detDoc.rules.some((r) => r.derivedBy === 'samples-distinct'), '存在 derivedBy=samples-distinct 的数据驱动规则槽（聚合判据无法用单行正则）')
  // 指纹白名单在 L1（src/ 零品牌硬编码）
  const fpPath = join(PKG_ROOT, 'assets', 'config', 'env-fingerprints.json')
  t.assert(existsSync(fpPath), '环境指纹白名单在 L1（assets/config/env-fingerprints.json）')
  t.assert(JSON.parse(readFileSync(fpPath, 'utf8')).keys.length >= 10, '指纹白名单含 ≥10 个键')

  // ── ② 能复现：指纹不一致 → 检出非确定性 ──
  const repNondet = [SEC('quality-sweep', [SAMPLE(1, 'aaaa', 'stop'), SAMPLE(2, 'bbbb', 'stop'), 'DSH-SIGNAL quality.sweep.done=true'].join('\n')), ...ENV_SECTIONS].join('\n')
  const r1 = core.diagnoseConsistency({ report: repNondet, dimensions: DIMS, sessionId: 'c1' })
  t.assert(r1.ok === true, '复现路径调用成功')
  const k1 = r1.data.closure.consistency
  t.assert(k1.path === 'reproducible' && k1.verdict === 'nondeterministic', `路径/判定 = reproducible/nondeterministic（实际 ${k1.path}/${k1.verdict}）`)
  t.assert(k1.sampleCount === 2 && k1.distinctHashes === 2, 'report 了样本数与去重指纹数')
  t.assert(k1.reason.includes('非确定性'), '理由直说"可复现地检出非确定性"')
  const nd = r1.data.rootCauses.find((rc) => rc.id === 'rc-cons-007')
  t.assert(!!nd, 'rc-cons-007（数据驱动规则槽）产出候选')
  t.assert(nd.methodology.computed.value === 2 && nd.methodology.computed.holds === true, '可算判据记录 distinct=2 且 holds=true')
  t.assert(nd.evidence.length === 2 && nd.evidence.every((e) => e.snippet.includes('core_hash')), '证据绑定到两条真实采样行')

  // ── ③ 能复现但指纹一致 → 该假设被**排除**（可追溯） ──
  const repDet = [SEC('quality-sweep', [SAMPLE(1, 'aaaa', 'stop'), SAMPLE(2, 'aaaa', 'stop'), 'DSH-SIGNAL quality.sweep.done=true'].join('\n')), ...ENV_SECTIONS].join('\n')
  const r2 = core.diagnoseConsistency({ report: repDet, dimensions: DIMS, sessionId: 'c2' })
  t.assert(r2.data.closure.consistency.verdict === 'deterministic', '指纹一致 → verdict=deterministic')
  const ex2 = (r2.data.closure.excludedHypotheses || []).find((x) => x.id === 'rc-cons-007')
  t.assert(!!ex2 && ex2.excludedBy[0].kind === 'samples-identical', '指纹一致 → 进排除台账（kind=samples-identical）')
  t.assert(!r2.data.rootCauses.some((rc) => rc.id === 'rc-cons-007'), '指纹一致时**不得**把该假设作为候选输出')
  t.assert(ex2.computed.holds === false, '排除条目带可算判据（holds=false，可撤回）')

  // ── ④ 假阳性防线：指纹不同但有 finish=length 截断 → 排除而非候选 ──
  const repTrunc = [SEC('quality-sweep', [SAMPLE(1, 'aaaa', 'length'), SAMPLE(2, 'bbbb', 'stop'), 'DSH-SIGNAL quality.sweep.done=true'].join('\n')), ...ENV_SECTIONS].join('\n')
  const r3 = core.diagnoseConsistency({ report: repTrunc, dimensions: DIMS, sessionId: 'c3' })
  const ex3 = (r3.data.closure.excludedHypotheses || []).find((x) => x.id === 'rc-cons-007')
  t.assert(!!ex3 && ex3.excludedBy[0].kind === 'explained-by-truncation', '截断可解释指纹差异 → 排除（kind=explained-by-truncation）')
  t.assert(!r3.data.rootCauses.some((rc) => rc.id === 'rc-cons-007'), '截断场景下不得把差异当非确定性')
  t.assert(r3.data.rootCauses.some((rc) => rc.id === 'rc-cons-001'), '同时由 rc-cons-001 指出"先排除截断"这一整类假阳性')

  // ── ⑤ 不能复现 → 环境差异路径（不臆断，只列必须逐项比对的维度）──
  const r4 = core.diagnoseConsistency({ report: ENV_SECTIONS.join('\n'), dimensions: DIMS, sessionId: 'c4' })
  const k4 = r4.data.closure.consistency
  t.assert(k4.path === 'not-reproducible' && k4.verdict === 'insufficient-samples', '无采样 → not-reproducible/insufficient-samples')
  t.assert(k4.reason.includes('不可判定'), '显式声明"在原理上不可判定"（缺证据 ≠ 未发现反例）')
  const envIds = [...r4.data.rootCauses, ...(r4.data.closure.weakSignals || [])]
    .map((rc) => rc.id)
    .filter((id) => id.startsWith('rc-cons-env-'))
  t.assert(envIds.includes('rc-rc-cons-env-001') || envIds.includes('rc-cons-env-001'), `环境差异规则命中（${envIds.join(',')}）`)
  t.assert(envIds.some((id) => id.includes('env-001')), '驱动/固件版本比对被提出')
  t.assert(envIds.some((id) => id.includes('env-003')), '并发/调度配置比对被提出')
  t.assert(Object.keys(k4.environment.fingerprints).length >= 2, `环境指纹已抽取（${Object.keys(k4.environment.fingerprints).join(',')}）`)
  t.assert(k4.environment.missing.length >= 1, '缺项也被如实列出（不可判定项）')

  // ── ⑥ 证据缺口声明：端点不可达 → 明确"不可判定"，不给修复 ──
  const gapReport = [SEC('quality-probe', 'DSH-SIGNAL quality.probe=endpoint-unreachable (响应无 choices)'), ...ENV_SECTIONS].join('\n')
  const r5 = core.diagnoseConsistency({ report: gapReport, dimensions: DIMS, sessionId: 'c5' })
  const gap = r5.data.rootCauses.find((rc) => rc.id === 'rc-cons-005')
  t.assert(!!gap, '端点不可达 → 产出 rc-cons-005 证据缺口声明')
  t.assert(gap.fix === null && gap.confidence === '未确认', '缺口声明不给修复方案（fix=null / 未确认）')
  t.assert(!!gap.additionalCollection, '缺口声明给出补采/恢复方式')

  // ── ⑦ 复用 A 的状态机：C 不新增机器 ──
  t.assert(core.machinePath.endsWith('loop-controller.machine.yaml'), 'C 复用 A 的状态机真源')
  t.assert(core.regressionMachinePath.endsWith('regression-controller.machine.yaml'), 'B 的机器独立存在')
  t.assert(!('consistencyMachinePath' in core), 'C **没有**独立状态机（复用 A，不新增）')

  // ── ⑧ 返回信封与 diagnose_service 同构 ──
  const p = core.parseCollectReport({ report: repDet })
  const svc = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: 'c6' } })
  const keysOf = (r) => Object.keys(r.data).filter((k) => k !== 'requestedRound').sort()
  t.assert(JSON.stringify(keysOf(r1)) === JSON.stringify(keysOf(svc)), `顶层字段与 diagnose_service 同构（${keysOf(r1).join(',')}）`)
  t.assert(!r1.data.degradations, 'C 路径不产生降级（不需要基线，也不依赖持久化）')

  // ── ⑨ 契约不变量 ──
  for (const rc of [...r1.data.rootCauses, ...(r1.data.closure.weakSignals || []), ...r4.data.rootCauses, ...(r4.data.closure.weakSignals || [])]) {
    t.assert(rc.evidence.length >= 1 && rc.evidence.every((e) => e.sourceFile && Number.isFinite(e.line) && e.snippet), `${rc.id} 证据非空且可溯源`)
    if (rc.confidence === '未确认') t.assert(rc.fix === null && !!rc.additionalCollection, `${rc.id} 未确认 → fix=null + 补采`)
    else t.assert(!!rc.fix && ['complete', 'partial'].includes(rc.fix.state), `${rc.id} 非未确认 → fix 完整或部分`)
  }

  // ── ⑩ L1 指纹白名单缺失 → fail-closed（不臆断环境差异）──
  const tmpPkg = mkdtempSync(join(tmpdir(), 'dsh-cons-pkg-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmpPkg, 'assets'), { recursive: true })
  rmSync(join(tmpPkg, 'assets', 'config', 'env-fingerprints.json'))
  const broken = createCore({ pkgRoot: tmpPkg, storageDir: join(tmp, 's2'), persist: false })
  const r = attempt(() => broken.diagnoseConsistency({ report: ENV_SECTIONS.join('\n'), dimensions: DIMS, sessionId: 'c7' }))
  t.assert(!r.ok && r.code === 'ERR_ROOTCAUSE_RULES_NOT_LOADED', `指纹白名单缺失 → fail-closed（实际 ${r.code}）`)
  t.assert(r.body && r.body.policy === 'REFUSE', '缺指纹白名单时策略为 REFUSE')

  rmSync(tmp, { recursive: true, force: true })
  rmSync(tmpPkg, { recursive: true, force: true })
}
