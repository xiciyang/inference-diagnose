/**
 * loop-controller-conformance.spec —— P5 出口门禁之一（§3.2 状态机与 YAML 真源一致）。
 *
 * 与 python 检查器的分工：python 侧做穷举（S1-S8/A1/A3/A9/A12）+ C0 文档交叉验证；
 * 本 spec 验证**插件侧的 JS 引擎**读同一份物理文件后行为一致（不是另写一套守卫）。
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLoopController, loadMachine } from '../../src/engine/loop-controller.js'
import { detect, CLOSURE } from '../../src/engine/closure-detector.js'

export const NAME = 'loop-controller-conformance（JS 引擎 vs YAML 真源 / 转移抽样 / 终态忽略）'

const HERE = dirname(fileURLToPath(import.meta.url))
const MACHINE = join(HERE, '..', '..', 'model', 'loop-controller.machine.yaml')

const CFG = {
  dims_ok: true, registry_ok: true, desens_ok: true, template_ok: true, root_ok: true,
  corrupt: false, miss: false, changed: true, has_unconfirmed: false, has_partial: false,
  fix_available: true, round: 1,
}

export async function run(t) {
  t.assert(existsSync(MACHINE), `机器定义在唯一物理位置（${MACHINE}）`)
  const lc = createLoopController({ machinePath: MACHINE })
  const m = lc.machine

  // ---- 规模与闭集（与 python 检查器同源同值）----
  t.assert(m.states.length === 15, `状态数 15（实际 ${m.states.length}）`)
  t.assert(m.events.length === 18, `事件数 18（实际 ${m.events.length}）`)
  const stats = lc.stats()
  t.assert(stats.definedCells === 51, `已定义格 51（实际 ${stats.definedCells}）`)
  t.assert(stats.branches === 70, `分支数 70（实际 ${stats.branches}）`)
  t.assert(m.events.filter((e) => e.startsWith('ERR_')).length === 8, '闭集含 8 个 ErrCode')

  // ---- IDLE/DESCRIBE：五分支按守卫穷尽 ----
  const idleCases = [
    [{ ...CFG, dims_ok: false }, 'IDLE', 'ERR_MISSING_PARAM'],
    [{ ...CFG, registry_ok: false }, 'REFUSED@IDLE', 'ERR_DIMENSIONS_NOT_LOADED'],
    [{ ...CFG, desens_ok: false }, 'REFUSED@IDLE', 'ERR_DESENSITIZE_RULES_NOT_LOADED'],
    [{ ...CFG, template_ok: false }, 'REFUSED@IDLE', 'ERR_TEMPLATE_NOT_LOADED'],
    [CFG, 'SCRIPT_READY', 'generate_collect_script ok'],
  ]
  for (const [cfg, wantState, wantAction] of idleCases) {
    const r = lc.step('IDLE', 'DESCRIBE', cfg)
    t.assert(r.state === wantState, `IDLE/DESCRIBE(${wantAction}) → ${wantState}（实际 ${r.state}）`)
    t.assert(String(r.branch.action).includes(wantAction.split(' ')[0]), `分支动作标注 ${wantAction}`)
  }

  // ---- 拒绝态：RETRY 回到自身 origin（6 个 origin 互不相同）----
  for (const o of ['IDLE', 'SCRIPT_READY', 'REPORT_PARSED', 'DIAGNOSED', 'FIX_APPLIED', 'AWAITING_COLLECTION']) {
    const r = lc.step(`REFUSED@${o}`, 'RETRY', CFG)
    t.assert(r.state === o, `REFUSED@${o} --RETRY--> ${o}（实际 ${r.state}）`)
  }

  // ---- AWAITING_COLLECTION/PASTE_REPORT：round 守卫 + 预算 ----
  const r1 = lc.step('AWAITING_COLLECTION', 'PASTE_REPORT', { ...CFG, round: 1 })
  t.assert(r1.state === 'REPORT_PARSED' && r1.roundDelta === 1 && r1.writesTracker === true, 'round+1 且在报告解析前提交 tracker')
  const r2 = lc.step('AWAITING_COLLECTION', 'PASTE_REPORT', { ...CFG, round: 3 })
  t.assert(r2.state === 'LIMIT_REACHED', 'round+1 > maxRounds → LIMIT_REACHED（预算闸门）')
  const r3 = lc.step('AWAITING_COLLECTION', 'STALL', { ...CFG, changed: false })
  t.assert(r3.state === 'LIMIT_REACHED', 'stall（无变化）→ LIMIT_REACHED')
  const r4 = lc.step('AWAITING_COLLECTION', 'STALL', { ...CFG, changed: true })
  t.assert(r4.state === 'AWAITING_COLLECTION', 'stall 条件不成立 → 停留')

  // ---- DIAGNOSED/DISPATCH：置信度/修复三态分叉 ----
  const d1 = lc.step('DIAGNOSED', 'DISPATCH', { ...CFG, has_unconfirmed: true, desens_ok: false })
  t.assert(d1.state === 'REFUSED@DIAGNOSED', 'needs_additional ∧ ¬desens_ok → REFUSED（脚本路径硬依赖）')
  const d2 = lc.step('DIAGNOSED', 'DISPATCH', { ...CFG, has_unconfirmed: true })
  t.assert(d2.state === 'AWAITING_COLLECTION', 'needs_additional ∧ desens_ok → 等待补采')
  const d3 = lc.step('DIAGNOSED', 'DISPATCH', CFG)
  t.assert(d3.state === 'FIX_APPLIED', '有可用修复 → 交付')

  // ---- 终态忽略一切事件（S2/A1）----
  for (const term of ['CLOSED', 'LIMIT_REACHED', 'EXITED']) {
    for (const ev of ['DESCRIBE', 'FIX_OK', 'ERR_INTERNAL', 'STALL']) {
      const r = lc.step(term, ev, CFG)
      t.assert(r.state === term && r.ignored === true, `终态 ${term} 忽略 ${ev}`)
      t.assert(r.writesTracker === false && r.roundDelta === 0, `终态忽略 ${ev} 时零副作用`)
    }
  }

  // ---- 未定义格 = 显式忽略（不是崩溃/静默吸收）----
  const ig = lc.step('IDLE', 'FIX_OK', CFG)
  t.assert(ig.ignored === true && ig.state === 'IDLE', '序外事件 → 显式忽略（状态不变）')
  const unknown = lc.step('IDLE', 'TOTALLY_UNKNOWN_EVENT', CFG)
  t.assert(unknown.ignored === true && unknown.state === 'IDLE', '闭集外事件 → 显式忽略（不崩溃）')

  // ---- 每个已定义格的守卫互斥且穷尽（抽样全部已定义格）----
  const bools = ['dims_ok', 'registry_ok', 'desens_ok', 'template_ok', 'root_ok', 'corrupt', 'miss', 'changed', 'has_unconfirmed', 'has_partial', 'fix_available']
  let gaps = 0
  for (let bits = 0; bits < 1 << bools.length; bits += 37) {
    const cfg = { round: 1 }
    bools.forEach((b, i) => { cfg[b] = !!(bits & (1 << i)) })
    for (const key of m.table.keys()) {
      const [state, ev] = key.split('|')
      const r = lc.step(state, ev, cfg)
      if (r.guardGap) gaps += 1
    }
  }
  t.assert(gaps === 0, `抽样 {2^11/37} 配置下无守卫空洞（实际 ${gaps}）`)

  // ---- closure-detector：闭环/需补采/阻塞三态 ----
  t.assert(detect([]).closure === CLOSURE.BLOCKED, '无候选 → blocked')
  t.assert(detect([{ id: 'a', confidence: '未发现反例', fix: { state: 'complete' } }]).closure === CLOSURE.CLOSED, '有 complete → closed')
  t.assert(detect([{ id: 'a', confidence: '未确认', fix: null, additionalCollection: { needed: [{ probe: 'p' }] } }]).closure === CLOSURE.NEEDS_COLLECTION, '存在未确认 → needs-collection 并给出目标探针')
  const dp = detect([{ id: 'a', confidence: '未发现反例', fix: { state: 'partial' }, additionalCollection: { needed: [{ probe: 'p1' }, { probe: 'p2' }] } }])
  t.assert(dp.closure === CLOSURE.NEEDS_COLLECTION && dp.targets.join(',') === 'p1,p2', 'partial → 需补采且目标去重')

  // ---- loadMachine 对缺失文件 fail-loud ----
  let threw = false
  try { loadMachine('/no/such/machine.yaml') } catch { threw = true }
  t.assert(threw, '机器定义缺失 → 抛错（守卫单一真源不可缺省）')
}
