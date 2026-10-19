/**
 * diagnose-contract.spec —— P4 出口门禁之一（§2.4 契约：证据非空 / fix 三态 / 单向约束 / 依赖分档）。
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }

export const NAME = 'diagnose-contract（§2.4 证据非空 / fix 三态 / 单向约束 / 依赖分档）'

function tree() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-diag-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-diag', version: '0.0.1' }))
  return tmp
}
function attempt(fn) {
  try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e.code, body: e.body } }
}
const EV = (id, section, line, snippet, sourceFile) => ({ id, section, line, snippet, sourceFile, hash: `sha256:${id}` })

export async function run(t) {
  const tmp = tree()
  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 's'), persist: true })

  // ---- 正常：三条不同形态的根因 ----
  const evidence = [
    EV('ev-1', 'kernel-log', 10, '[ 4821.13] HBM ECC uncorrectable error on device 3', 'dmesg'),
    EV('ev-2', 'container-state', 12, 'mindie-svc Exited (137) 2 hours ago', 'docker ps -a'),
    EV('ev-3', 'container-state', 14, 'ExitCode 137 OOMKilled shm 64m', 'docker inspect'),
    EV('ev-4', 'container-log', 18, 'shm allocation failed: out of memory', 'docker logs'),
    EV('ev-5', 'mindie-log', 4, 'driver version 24.1.RC2 != required 24.1.RC3 (compat failed)', 'mindie-log'),
    EV('ev-6', 'npu-metrics', 22, 'temp 92C (throttle threshold 85C)', 'npu-metrics'),
  ]
  const r = core.diagnoseService({ evidence, dimensions: DIMS, context: { round: 1 } })
  t.assert(r.ok === true && r.code === 'OK', '正常返回 ok:true')
  t.assert(r.data.effectiveRound === 1, 'effectiveRound=1')
  // 分层后的**全部产出**（主列表 + 弱信号）；闭环判定仍只看主列表
  const rcs = [...r.data.rootCauses, ...(r.data.closure.weakSignals || [])]
  t.assert(Array.isArray(rcs) && rcs.length >= 4, `产出多条根因候选（实际 ${rcs.length}）`)

  // minItems:1 + 可溯源
  for (const rc of rcs) {
    t.assert(Array.isArray(rc.evidence) && rc.evidence.length >= 1, `${rc.id}: 证据非空（minItems:1）`)
    t.assert(rc.evidence.every((e) => e.ref && e.sourceFile && Number.isFinite(e.line) && e.snippet), `${rc.id}: 证据可溯源`)
    t.assert(['已证明', '未发现反例', '未确认'].includes(rc.confidence), `${rc.id}: 置信度在三档内`)
  }
  // 单向约束（§2.4 条款 3）
  for (const rc of rcs) {
    if (rc.confidence === '未确认') {
      t.assert(rc.fix === null, `${rc.id}: 未确认 ⇒ fix=null（禁出修复）`)
      t.assert(rc.additionalCollection && rc.additionalCollection.needed.length > 0, `${rc.id}: 未确认 ⇒ 必给补采指令`)
    } else {
      t.assert(rc.fix !== null && rc.fix !== undefined, `${rc.id}: 非未确认 ⇒ fix 非 null`)
      t.assert(['complete', 'partial'].includes(rc.fix.state), `${rc.id}: fix.state ∈ {complete,partial}`)
    }
  }
  // 三态各自的形态
  const byId = Object.fromEntries(rcs.map((x) => [x.id, x]))
  const complete = rcs.find((x) => x.fix && x.fix.state === 'complete')
  t.assert(!!complete, '存在 complete 形态的根因')
  for (const k of ['code', 'verification', 'rollback', 'riskLevel']) t.assert(!!complete.fix[k], `complete fix 含 ${k}`)
  const partial = byId['rc-mindie-003']
  t.assert(partial && partial.confidence === '未发现反例', 'rc-mindie-003 为未发现反例（partial 不等于未确认）')
  t.assert(partial.fix.state === 'partial' && partial.fix.code === 'pending', 'partial 的 code 必为 pending')
  t.assert(partial.additionalCollection.needed.length === 1 && partial.additionalCollection.needed[0].probe === 'npu-driver-matrix', 'partial 只列声明的探针（不是全量）')
  t.assert(typeof partial.additionalCollection.script === 'string' && partial.additionalCollection.script.includes('dsh_desensitize'), 'partial 的补采脚本内嵌脱敏')
  const unc = byId['rc-ascend-002']
  t.assert(unc && unc.confidence === '未确认' && unc.fix === null, 'rc-ascend-002 为未确认 + fix=null')
  t.assert(unc.additionalCollection.needed.map((n) => n.probe).join(',') === 'npu-thermal-history', '未确认只列该规则声明的探针')
  // 已证明需要 strong + ≥2 条独立来源
  if (byId['rc-docker-001']) {
    t.assert(byId['rc-docker-001'].evidence.length >= 2, 'rc-docker-001 绑定多条证据（strong 规则的已证明前提）')
  }
  t.assert(r.data.closure && r.data.closure.closure, '返回闭环判定')
  t.assert(typeof r.data.summary === 'string' && r.data.summary.includes('闭环状态'), 'summary 说明闭环状态')

  // ---- ERR_MISSING_PARAM ----
  const e1 = attempt(() => core.diagnoseService({ evidence: [], dimensions: DIMS }))
  t.assert(!e1.ok && e1.code === 'ERR_MISSING_PARAM' && e1.body.missing.includes('evidence'), '空证据 → ERR_MISSING_PARAM')
  const e2 = attempt(() => core.diagnoseService({ evidence, dimensions: { framework: 'mindie' } }))
  t.assert(!e2.ok && e2.code === 'ERR_MISSING_PARAM', '缺维度 → ERR_MISSING_PARAM')
  const e3 = attempt(() => core.diagnoseService({ evidence, dimensions: DIMS, context: { round: 2 } }))
  t.assert(!e3.ok && e3.code === 'ERR_MISSING_PARAM' && e3.body.missing.includes('context.priorRound'), 'A 形态下 round≥2 缺 priorRound → ERR_MISSING_PARAM')
  const e3b = attempt(() => core.diagnoseService({ evidence, dimensions: DIMS, context: { round: 2, priorRound: { fixApplied: 'x', assets: 'sha256:old' } } }))
  t.assert(e3b.ok === true, 'A 形态下 round≥2 带 priorRound → 正常返回')
  t.assert((e3b.value.data.notices || []).some((n) => n.code === 'version-drift'), '且产出 version-drift 声明（快照 ≠ 当前）')

  // ---- ERR_ROOTCAUSE_RULES_NOT_LOADED（硬依赖）----
  const t2 = tree()
  rmSync(join(t2, 'assets', 'root-causes'), { recursive: true })
  const c2 = createCore({ pkgRoot: t2, storageDir: join(t2, 's'), persist: false })
  const e4 = attempt(() => c2.diagnoseService({ evidence, dimensions: DIMS }))
  t.assert(!e4.ok && e4.code === 'ERR_ROOTCAUSE_RULES_NOT_LOADED' && e4.body.policy === 'REFUSE', '根因规则缺失 → REFUSE（禁止无规则推测）')

  // ---- ERR_DESENSITIZE_MISS（纵深复查）----
  const leaky = [...evidence, EV('ev-9', 'kernel-log', 30, 'device 10.201.33.7 reported error', 'dmesg')]
  const e5 = attempt(() => core.diagnoseService({ evidence: leaky, dimensions: DIMS }))
  t.assert(!e5.ok && e5.code === 'ERR_DESENSITIZE_MISS' && e5.body.policy === 'REFUSE', '纵深复查命中 → REFUSE')

  // ---- 脱敏规则软依赖：无脚本需求时降级；需要脚本时 REFUSE ----
  const t3 = tree()
  rmSync(join(t3, 'assets', 'rules'), { recursive: true })
  const c3 = createCore({ pkgRoot: t3, storageDir: join(t3, 's'), persist: false })
  const e6 = attempt(() => c3.diagnoseService({ evidence, dimensions: DIMS }))
  t.assert(!e6.ok && e6.code === 'ERR_DESENSITIZE_RULES_NOT_LOADED' && e6.body.policy === 'REFUSE', '需生成补采脚本 + 规则缺失 → REFUSE（脚本必须内嵌脱敏）')
  // 只喂"不需要脚本"的证据（只有 complete 类命中）
  const noScriptEvidence = [evidence[0], evidence[1], evidence[2]] // ECC + docker OOM
  const e6b = attempt(() => c3.diagnoseService({ evidence: noScriptEvidence, dimensions: DIMS }))
  t.assert(e6b.ok === true, '纯诊断（不需要脚本）+ 规则缺失 → 降级继续（软依赖）')
  const degs = e6b.value.data.degradations || []
  t.assert(degs.some((d) => d.kind === 'check-skipped' && d.check === 'desensitize-recheck'), '降级通道记 check-skipped')
  t.assert((e6b.value.data.notices || []).some((n) => n.code === 'assurance-reduced'), '并投影为用户可见声明（1:1）')

  for (const x of [tmp, t2, t3]) rmSync(x, { recursive: true, force: true })
}
