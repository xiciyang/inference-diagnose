/**
 * model-adapter —— §4.5 管道接通：loop-controller 机器定义 → LogicModelV1 形态。
 *
 * 未决 #2 的输入契约（已裁决，2026-09-18）：
 *   输入 = 状态机定义（结构化）+ 检查项清单（id + 断言文本）+ 配置
 *   输出 = [{ id, result, evidence{命令,输出,覆盖率}, blockedBy? }] + 顶层摘要
 *
 * 本适配器只做"结构转换"，不做验证 —— 验证由 logicprobe 管道执行。
 */
import { loadMachine } from '../engine/loop-controller.js'

export function toLogicModelV1(machinePath, { checks = [], config = {} } = {}) {
  const m = loadMachine(machinePath)
  const transitions = []
  for (const [key, branches] of m.table.entries()) {
    const [from, event] = key.split('|')
    for (const b of branches) {
      transitions.push({ from, event, to: b.to, guard: b.guard, updates: b.branch && b.branch.round_delta ? { round: `+${b.branch.round_delta}` } : undefined })
    }
  }
  return {
    schemaVersion: 1,
    id: m.id,
    init: 'IDLE',
    states: m.states.map((s) => ({ id: s, terminal: m.terminal.has(s) })),
    events: m.events,
    transitions,
    variables: { round: { init: 1, monotonic: 'inc', max: m.maxRounds } },
    invariants: [
      { kind: 'never-states', states: ['CLOSED', 'LIMIT_REACHED', 'EXITED'], when: 'outgoing-transition' },
      { kind: 'var-in-range', variable: 'round', min: 1, max: m.roundCap },
    ],
    budget: m.maxRounds,
    checks,
    config,
    meta: { source: 'model/loop-controller.machine.yaml', generatedBy: 'model-adapter' },
  }
}

/**
 * 管道投影（§4.5）：把机器定义翻译成 logicprobe 的 LogicModelV1。
 *
 * 2026-09-18 实测（真实管道调用）暴露两处适配缺口，已按 schema 修正：
 *   ① `variables` 必须是**数组** `{name, kind, init, min?, max?, monotonic?}`；
 *      `invariants[]` 每项需要 `id` + `description`，且 `variable` 必须引用已声明变量。
 *   ② 守卫必须是**结构化**的 `{variable, op, value}`；本机器的多数守卫是**配置表达式**
 *      （dims_ok / registry_ok / …），在逻辑探针里没有对应变量。
 *
 * 投影规则（保守，宁少不假）：
 *   - round 类守卫 → 结构化守卫（`round + 1 <= max` ⟺ `round < max`）
 *   - 同组内 round 守卫取一条，其余 round 分支留空作 else（保证穷尽）
 *   - 纯配置守卫的分支 → 投影为**无守卫边**（非确定），因此**S4/S6 在投影上不可信**，
 *     这两项仍由本地检查器（配置空间穷举）负责 —— 已在 §5.10 记录为投影损失。
 *   - 每条 round 推进边标注 `cost: 1`，配合 budget 不变量供 A12 检查。
 */
export function toPipelineModel(machinePath, { config = {} } = {}) {
  const m = loadMachine(machinePath)
  const groups = new Map()
  for (const [key, branches] of m.table.entries()) {
    const [from, event] = key.split('|')
    groups.set(key, { from, event, branches })
  }
  const transitions = []
  for (const { from, event, branches } of groups.values()) {
    const roundBranch = branches.find((b) => /round\s*[+\-]?\s*\d*\s*(<=|<|>=|>)/.test(String(b.guard)))
    const emitted = new Set()
    for (const b of branches) {
      const g = String(b.guard)
      let guard
      if (g.includes('round + 1 <= max_rounds') || g.includes('round < max_rounds')) {
        guard = { variable: 'round', op: '<', value: m.maxRounds }
      } else if (g.includes('round + 1 > max_rounds') || g.includes('round >= max_rounds')) {
        guard = { variable: 'round', op: '>=', value: m.maxRounds }
      } else if (b === roundBranch) {
        guard = { variable: 'round', op: '>=', value: m.maxRounds }
      } else {
        guard = undefined // 配置守卫：投影为非确定边（默认/else 语义）
      }
      const t = { from, event, to: b.to }
      if (guard) t.guard = guard
      // cost 模型（2026-09-18 管道实测修正）：LogicModelV1 里"缺省 cost = 1"，
      // 若不明示 0，budget 就退化成"总步数预算"而非"重采集轮数预算"。
      // 故：仅推进 round 的边 cost=1，其余一律 cost=0。
      if (b.branch && b.branch.round_delta) {
        t.updates = [{ variable: 'round', op: 'inc', value: b.branch.round_delta }]
        t.cost = 1
      } else {
        t.cost = 0
      }
      const sig = `${t.from}|${t.event}|${t.to}|${t.guard ? JSON.stringify(t.guard) : ''}`
      if (emitted.has(sig)) continue
      emitted.add(sig)
      transitions.push(t)
    }
  }
  return {
    schemaVersion: 1,
    init: 'IDLE',
    states: m.states.map((s) => ({ id: s, terminal: m.terminal.has(s) })),
    events: m.events,
    transitions,
    variables: [{ name: 'round', kind: 'integer', init: 1, min: 1, max: m.roundCap, monotonic: 'inc' }],
    invariants: [
      { id: 'I4', description: 'round 非递减且落在 [1, roundCap] 内（§3.2 I4/S8）', kind: 'var-in-range', variable: 'round', min: 1, max: m.roundCap },
      { id: 'I8', description: '重采集预算：任一可达路径成本不超过 maxRounds（§3.2 I8/A12）', kind: 'budget', budget: m.maxRounds },
      // I9（leads-to IDLE→LIMIT_REACHED）已移除：2026-09-18 管道实测证明该表述过强 ——
      // IDLE 在参数缺失时自环是**驻留态**（用户可重试），不是有害环；设计里的 A9 导向
      // 正确表述是 S3（无有害闭 SCC）+ 终态可达，已由 S1/S2/S3 覆盖。
      // I10（leads-to）同样移除：投影把配置守卫变成非确定边后，"必然可达"在 may-语义下
      // 不成立（坏分支总是可选）。A9 由本地检查器的 liveness（每状态可达终态）+ 管道 S3 覆盖。
      // ⇒ 管道侧可判定项：S1/S2/S3/S6/S7/S8/A3/A4/A6/A7/A10/A11/A12/A13/A14；S4/S5/A1/A2/A9 归本地检查器（投影损失）。
    ],
    concurrentPairs: [['PASTE_REPORT', 'EXIT'], ['FIX_OK', 'EXIT']],
    // 边界值只取**域内**值（0 低于 min=1；放进去会产出一条越界噪声，属建模错误，已由管道 A5 实测发现）
    boundaryChecks: [{ variable: 'round', values: [1, m.maxRounds, m.roundCap] }],
    // 只有真正的自环事件可宣告幂等（PASTE_REPORT 会改变状态，宣告它幂等是建模错误，2026-09-18 管道实测）
    idempotentEvents: ['ERR_MISSING_PARAM'],
    budget: m.maxRounds,
    config,
    meta: { source: 'model/loop-controller.machine.yaml', generatedBy: 'model-adapter.toPipelineModel', projection: 'config-guards become nondeterministic; S4/S6 not covered here' },
  }
}

/** 覆盖率统计（供 evidence.覆盖率 字段使用）。 */
export function coverage(model) {
  const cells = new Set(model.transitions.map((t) => `${t.from}|${t.event}`))
  return {
    states: model.states.length,
    events: model.events.length,
    cells: model.states.length * model.events.length,
    definedCells: cells.size,
    transitions: model.transitions.length,
  }
}
