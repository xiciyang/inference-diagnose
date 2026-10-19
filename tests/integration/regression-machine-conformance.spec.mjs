/**
 * regression-machine-conformance.spec —— P10 出口门禁（B 范式独立状态机与 YAML 真源一致）。
 *
 * 用户 2026-09-28 裁决：**模式隔离** —— B 不扩展现有状态机，而是独立真源 + 独立门禁。
 * 与 python 检查器（regression-model.py）的分工：python 侧做穷举（S1–S8/A1/A3/A9/A12）
 * 与 C0 文档×YAML 多重集交叉验证；本 spec 验证**插件侧的 JS 引擎**读同一份物理文件后
 * 行为一致（不是另写一套守卫），并把"与 A 的拓扑差异"钉死在断言里。
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLoopController, loadMachine } from '../../src/engine/loop-controller.js'
import { createCore } from '../../src/index.js'

export const NAME = 'regression-machine-conformance（B 独立状态机 vs YAML 真源 / 与 A 的拓扑差异）'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', '..')
const B_MACHINE = join(PLUGIN, 'model', 'regression-controller.machine.yaml')
const A_MACHINE = join(PLUGIN, 'model', 'loop-controller.machine.yaml')

const CFG = {
  report_ok: true, desens_ok: true, corrupt: false, miss: false,
  baseline_present: true, baseline_ok: true, root_ok: true,
  registry_ok: true, template_ok: true, fix_available: true, changed: true,
  has_unconfirmed: false, has_partial: false, round: 1,
}

export async function run(t) {
  t.assert(existsSync(B_MACHINE), `B 机器定义在唯一物理位置（${B_MACHINE}）`)
  const lc = createLoopController({ machinePath: B_MACHINE })
  const m = lc.machine

  // ── 规模与闭集（与 python 检查器同源同值）──
  t.assert(m.states.length === 16, `状态数 16（实际 ${m.states.length}）`)
  t.assert(m.events.length === 21, `事件数 21（实际 ${m.events.length}）`)
  const stats = lc.stats()
  t.assert(stats.definedCells === 56, `已定义格 56（实际 ${stats.definedCells}）`)
  t.assert(stats.branches === 77, `分支数 77（实际 ${stats.branches}）`)
  t.assert(m.events.filter((e) => e.startsWith('ERR_')).length === 9, 'B 闭集覆盖全部 9 个 ErrCode')
  t.assert(m.events.includes('ERR_BASELINE_MALFORMED'), 'B 闭集含新增的 ERR_BASELINE_MALFORMED')
  t.assert(m.maxRounds === 3 && m.roundCap === 5, 'maxRounds=3 / roundCap=5')

  // ── 与 A 的**拓扑差异**：B 有独有状态，且基线缺失不落入 REFUSED ──
  const a = createLoopController({ machinePath: A_MACHINE }).machine
  t.assert(!a.states.includes('INTAKE') && !a.states.includes('BASELINE_READY') && !a.states.includes('QUALITATIVE'),
    'A 机器不含 B 的 intake/baseline/qualitative 状态（拓扑不为共享）')
  t.assert(a.states.length === 15 && a.events.length === 18, 'A 机器拓扑未被 B 的引入改动（15 态 / 18 事件）')
  t.assert(!a.events.includes('ERR_BASELINE_MALFORMED'), 'A 机器不含 B 专有错误事件（错误域按范式拆分）')

  // ── IDLE/SUBMIT：五分支按守卫穷尽 ──
  const idle = [
    [{ ...CFG, report_ok: false }, 'IDLE'],
    [{ ...CFG, desens_ok: false }, 'REFUSED@IDLE'],
    [{ ...CFG, corrupt: true }, 'IDLE'],
    [{ ...CFG, miss: true }, 'IDLE'],
    [CFG, 'INTAKE'],
  ]
  for (const [cfg, want] of idle) {
    const r = lc.step('IDLE', 'SUBMIT', cfg)
    t.assert(r.state === want, `IDLE/SUBMIT → ${want}（实际 ${r.state}）`)
  }

  // ── INTAKE 三分支：未提供 → QUALITATIVE（降级）；提供且合法 → BASELINE_READY；提供但非法 → REFUSED ──
  const rMiss = lc.step('INTAKE', 'BASELINE_MISSING', { ...CFG, baseline_present: false })
  t.assert(rMiss.state === 'QUALITATIVE', '未提供基线 → QUALITATIVE（能力降级，**不是** REFUSED）')
  const rOk = lc.step('INTAKE', 'BASELINE_OK', CFG)
  t.assert(rOk.state === 'BASELINE_READY', '基线合法 → BASELINE_READY（定量路径）')
  const rBad = lc.step('INTAKE', 'BASELINE_OK', { ...CFG, baseline_ok: false })
  t.assert(rBad.state === 'REFUSED@INTAKE', '基线非法 → REFUSED@INTAKE（ERR_BASELINE_MALFORMED）')
  t.assert(String(rBad.branch.action).includes('ERR_BASELINE_MALFORMED'), '拒绝分支动作标注 ERR_BASELINE_MALFORMED')
  const rMal = lc.step('INTAKE', 'BASELINE_MALFORMED', { ...CFG, baseline_ok: false })
  t.assert(rMal.state === 'REFUSED@INTAKE', 'BASELINE_MALFORMED 事件 → REFUSED@INTAKE')
  const rNotMal = lc.step('INTAKE', 'BASELINE_MALFORMED', CFG)
  t.assert(rNotMal.state === 'INTAKE', '非非法态收到 BASELINE_MALFORMED → 停留（不误判）')

  // ── 规则库是 COMPARE 的硬依赖（两条路径各自可拒）──
  t.assert(lc.step('BASELINE_READY', 'COMPARE', { ...CFG, root_ok: false }).state === 'REFUSED@BASELINE_READY', '定量路径缺规则 → REFUSED@BASELINE_READY')
  t.assert(lc.step('QUALITATIVE', 'COMPARE', { ...CFG, root_ok: false }).state === 'REFUSED@QUALITATIVE', '定性路径缺规则 → REFUSED@QUALITATIVE')
  t.assert(lc.step('BASELINE_READY', 'COMPARE', CFG).state === 'COMPARED', '定量路径 → COMPARED')
  t.assert(lc.step('QUALITATIVE', 'COMPARE', CFG).state === 'COMPARED', '定性路径 → COMPARED')
  t.assert(lc.step('COMPARED', 'DIAGNOSE', CFG).state === 'DIAGNOSED', 'COMPARED/DIAGNOSE → DIAGNOSED')

  // ── DIAGNOSED/DISPATCH：六分支（补采脚本路径的依赖源逐个可拒）──
  const needs = { has_unconfirmed: true }
  const disp = [
    [{ ...CFG, ...needs, registry_ok: false }, 'REFUSED@DIAGNOSED', 'ERR_DIMENSIONS_NOT_LOADED'],
    [{ ...CFG, ...needs, template_ok: false }, 'REFUSED@DIAGNOSED', 'ERR_TEMPLATE_NOT_LOADED'],
    [{ ...CFG, ...needs, desens_ok: false }, 'REFUSED@DIAGNOSED', 'ERR_DESENSITIZE_RULES_NOT_LOADED'],
    [{ ...CFG, ...needs }, 'AWAITING_METRICS', 'emit targeted re-collect script'],
    [CFG, 'CLOSED', 'loop closed'],
    [{ ...CFG, fix_available: false }, 'REFUSED@DIAGNOSED', 'ERR_INTERNAL'],
  ]
  for (const [cfg, want, action] of disp) {
    const r = lc.step('DIAGNOSED', 'DISPATCH', cfg)
    t.assert(r.state === want, `DIAGNOSED/DISPATCH(${action}) → ${want}（实际 ${r.state}）`)
    t.assert(String(r.branch.action).includes(action.split(' ')[0]), `分支动作标注 ${action.split(' ')[0]}`)
  }
  t.assert(lc.step('DIAGNOSED', 'DISPATCH', CFG).writesTracker === true, '闭环分支持久化会话（writes_tracker）')

  // ── AWAITING_METRICS：回填 + 预算闸门 + 停滞闸门 ──
  const f1 = lc.step('AWAITING_METRICS', 'PASTE_METRICS', { ...CFG, round: 1 })
  t.assert(f1.state === 'COMPARED' && f1.roundDelta === 1 && f1.writesTracker === true, 'round+1 并在回填后重新对比')
  t.assert(lc.step('AWAITING_METRICS', 'PASTE_METRICS', { ...CFG, round: 3 }).state === 'LIMIT_REACHED', 'round+1 > maxRounds → LIMIT_REACHED')
  t.assert(lc.step('AWAITING_METRICS', 'PASTE_METRICS', { ...CFG, corrupt: true }).state === 'AWAITING_METRICS', '回填报告损坏 → 停留并报 ERR_REPORT_CORRUPT')
  t.assert(lc.step('AWAITING_METRICS', 'PASTE_METRICS', { ...CFG, desens_ok: false }).state === 'REFUSED@AWAITING_METRICS', '回填时脱敏规则不可用 → REFUSED')
  t.assert(lc.step('AWAITING_METRICS', 'MAX_ROUNDS', { ...CFG, round: 3 }).state === 'LIMIT_REACHED', 'MAX_ROUNDS 达上限 → LIMIT_REACHED')
  t.assert(lc.step('AWAITING_METRICS', 'MAX_ROUNDS', { ...CFG, round: 1 }).state === 'AWAITING_METRICS', 'MAX_ROUNDS 未达上限 → 停留')
  t.assert(lc.step('AWAITING_METRICS', 'STALL', { ...CFG, changed: false }).state === 'LIMIT_REACHED', 'stall（无变化）→ LIMIT_REACHED')
  t.assert(lc.step('AWAITING_METRICS', 'STALL', { ...CFG, changed: true }).state === 'AWAITING_METRICS', 'stall 条件不成立 → 停留')

  // ── 拒绝态：RETRY 回到自身 origin（6 个 origin 互不相同）──
  for (const o of ['IDLE', 'INTAKE', 'BASELINE_READY', 'QUALITATIVE', 'DIAGNOSED', 'AWAITING_METRICS']) {
    const r = lc.step(`REFUSED@${o}`, 'RETRY', CFG)
    t.assert(r.state === o, `REFUSED@${o} --RETRY--> ${o}（实际 ${r.state}）`)
  }

  // ── 终态忽略一切事件（S2/A1）──
  for (const term of ['CLOSED', 'LIMIT_REACHED', 'EXITED']) {
    for (const ev of ['SUBMIT', 'PASTE_METRICS', 'ERR_INTERNAL', 'STALL']) {
      const r = lc.step(term, ev, CFG)
      t.assert(r.state === term && r.ignored === true, `终态 ${term} 忽略 ${ev}`)
      t.assert(r.writesTracker === false && r.roundDelta === 0, `终态忽略 ${ev} 时零副作用`)
    }
  }
  const ig = lc.step('IDLE', 'DISPATCH', CFG)
  t.assert(ig.ignored === true && ig.state === 'IDLE', '序外事件 → 显式忽略（状态不变）')
  t.assert(lc.step('IDLE', 'TOTALLY_UNKNOWN_EVENT', CFG).ignored === true, '闭集外事件 → 显式忽略（不崩溃）')

  // ── 守卫互斥且穷尽（抽样 2^13 配置）──
  const bools = ['report_ok', 'desens_ok', 'corrupt', 'miss', 'baseline_present', 'baseline_ok', 'root_ok', 'registry_ok', 'template_ok', 'fix_available', 'changed', 'has_unconfirmed', 'has_partial']
  t.assert(bools.length === m.boolVars.length, `配置空间布尔量 ${bools.length} 个与 YAML 一致`)
  let gaps = 0
  for (let bits = 0; bits < 1 << bools.length; bits += 13) {
    const cfg = { round: 1 }
    bools.forEach((b, i) => { cfg[b] = !!(bits & (1 << i)) })
    for (const key of m.table.keys()) {
      const [state, ev] = key.split('|')
      if (lc.step(state, ev, cfg).guardGap) gaps += 1
    }
  }
  t.assert(gaps === 0, `抽样 {2^13/13} 配置下无守卫空洞（实际 ${gaps}）`)

  // ── 派生量：malformed / needs_metrics 与代码分支同一语义 ──
  t.assert(lc.step('INTAKE', 'BASELINE_OK', { ...CFG, baseline_present: false }).state === 'INTAKE', 'malformed 派生量在 baseline_present=false 时为假')
  t.assert(lc.step('DIAGNOSED', 'DISPATCH', { ...CFG, has_partial: true }).state === 'AWAITING_METRICS', 'needs_metrics 由 has_partial 亦可达')

  // ── 真源暴露给 core（改名后仍指向同一份物理文件）──
  const core = createCore({ pkgRoot: PLUGIN, storageDir: '/tmp/dsh-regmachine', persist: false })
  t.assert(core.regressionMachinePath === B_MACHINE, 'core 暴露 regressionMachinePath 指向 B 真源')
  t.assert(core.machinePath === A_MACHINE, 'core 的 machinePath 仍指向 A 真源（A 未被 B 顶替）')

  // ── loadMachine 对缺失文件 fail-loud ──
  let threw = false
  try { loadMachine('/no/such/regression.machine.yaml') } catch { threw = true }
  t.assert(threw, 'B 机器定义缺失 → 抛错（守卫单一真源不可缺省）')
}
