/**
 * loop-controller —— §3.2 闭环状态机。
 *
 * 纪律（§5.5 纪律 1）：**守卫只能来自 model/loop-controller.machine.yaml，
 * 禁止在本文件手写任何守卫**。本模块的职责是：加载机器定义 → 求值守卫 →
 * 给出 (状态, 事件, 配置) 的确定转移。
 *
 * 快照语义（§4.3）：调用入口取一次世代，全程不重读 current（由 index 层保证）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../primitives/yaml-lite.js'

// ---------------------------------------------------------------------------
// 受限表达式求值（只允许机器定义里出现的形态：and/or/not/比较/四则/括号/常量）
// ---------------------------------------------------------------------------
function evaluate(expr, env) {
  const tokens = tokenize(expr)
  let i = 0
  const peek = () => tokens[i]
  const eat = (t) => {
    if (tokens[i] === t) {
      i += 1
      return true
    }
    return false
  }
  function or() {
    let v = and()
    while (eat('or')) v = and() || v
    return v
  }
  function and() {
    let v = not()
    while (eat('and')) v = not() && v
    return v
  }
  function not() {
    if (eat('not')) return !not()
    return cmp()
  }
  function cmp() {
    const l = sum()
    const op = peek()
    if (op === '>' || op === '<' || op === '>=' || op === '<=' || op === '==' || op === '!=') {
      i += 1
      const r = sum()
      switch (op) {
        case '>':
          return l > r
        case '<':
          return l < r
        case '>=':
          return l >= r
        case '<=':
          return l <= r
        case '==':
          return l === r
        default:
          return l !== r
      }
    }
    return l
  }
  function sum() {
    let v = atom()
    for (;;) {
      if (eat('+')) v += atom()
      else if (eat('-')) v -= atom()
      else return v
    }
  }
  function atom() {
    if (eat('(')) {
      const v = or()
      if (!eat(')')) throw new Error('loop-controller: unbalanced parentheses in guard')
      return v
    }
    const t = tokens[i]
    if (t === undefined) throw new Error('loop-controller: unexpected end of guard')
    i += 1
    if (t === 'true') return true
    if (t === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    if (!(t in env)) throw new Error(`loop-controller: unknown identifier in guard: ${t}`)
    return env[t]
  }
  const v = or()
  if (i !== tokens.length) throw new Error(`loop-controller: trailing tokens in guard: ${expr}`)
  return v
}

function tokenize(expr) {
  const out = []
  const re = /\s*(\d+(?:\.\d+)?|>=|<=|==|!=|&&|\|\||[()+\-<>]|not|and|or|true|false|[A-Za-z_][A-Za-z0-9_]*)/g
  let m
  let consumed = 0
  while ((m = re.exec(expr)) !== null) {
    consumed = m.index + m[0].length
    let t = m[1]
    if (t === '&&') t = 'and'
    if (t === '||') t = 'or'
    out.push(t)
  }
  if (consumed < expr.trim.length) throw new Error(`loop-controller: cannot tokenize guard: ${expr}`)
  return out
}

// ---------------------------------------------------------------------------
// 机器定义加载
// ---------------------------------------------------------------------------
export function loadMachine(machinePath) {
  if (!existsSync(machinePath)) {
    throw new Error(`loop-controller: 机器定义缺失 ${machinePath}（守卫单一真源，不可缺省）`)
  }
  const m = parse(readFileSync(machinePath, 'utf8'))
  const prefix = m.parameterized.prefix
  const origins = m.parameterized.domain || []
  const states = [...m.base_states, ...origins.map((o) => `${prefix}@${o}`)]
  const terminal = new Set(m.terminal || [])
  const nonTerminal = states.filter((s) => !terminal.has(s))
  const derived = m.derived || {}

  const expand = (spec) => {
    if (spec === 'non_terminal') return nonTerminal
    if (String(spec).endsWith('@*')) return states.filter((s) => s.startsWith(`${prefix}@`))
    return [spec]
  }
  const resolveTarget = (to, s) => {
    if (to === '$self') return s
    if (to === '$origin') return s.split('@')[1]
    if (to === '$refused_of_self') return s.startsWith(`${prefix}@`) ? s : `${prefix}@${origins.includes(s) ? s : 'IDLE'}`
    return to
  }

  const table = new Map() // key `${state}|${event}` → [{guard, to, branch}]
  const push = (s, e, branch) => {
    const k = `${s}|${e}`
    if (!table.has(k)) table.set(k, [])
    table.get(k).push({ guard: branch.guard, to: resolveTarget(branch.to, s), branch })
  }
  for (const g of m.globals || []) for (const s of expand(g.states)) for (const b of g.branches) push(s, g.event, b)
  for (const t of m.transitions || []) for (const s of expand(t.from)) for (const b of t.branches) push(s, t.event, b)

  return {
    id: m.id,
    maxRounds: m.max_rounds,
    roundCap: m.round_cap,
    states,
    terminal,
    nonTerminal,
    events: m.events,
    boolVars: m.bool_vars,
    derived,
    ignore: m.ignore,
    independentEvents: m.independent_events || [],
    table,
  }
}

export function createLoopController({ machinePath }) {
  const machine = loadMachine(machinePath)

  function env(cfg) {
    const e = { ...cfg, max_rounds: machine.maxRounds }
    for (const [k, expr] of Object.entries(machine.derived)) e[k] = evaluate(expr, e)
    return e
  }

  /**
   * 单步转移。未定义格 → 显式忽略（§3.2 完备性约定）。
   * @returns {{state:string, branch:object|null, ignored:boolean, writesTracker:boolean, roundDelta:number}}
   */
  function step(state, event, cfg) {
    const branches = machine.table.get(`${state}|${event}`)
    if (!branches) {
      return { state, branch: null, ignored: true, writesTracker: machine.ignore.writes_tracker, roundDelta: 0 }
    }
    const e = env(cfg)
    for (const b of branches) {
      if (evaluate(b.guard, e)) {
        return {
          state: b.to,
          branch: b.branch,
          ignored: false,
          writesTracker: !!b.branch.writes_tracker,
          roundDelta: Number(b.branch.round_delta || 0),
        }
      }
    }
    // 守卫应当穷尽；落到这里说明机器定义有洞 → 按显式忽略处理并让调用方可见
    return { state, branch: null, ignored: true, writesTracker: false, roundDelta: 0, guardGap: true }
  }

  /** 关闭前不动点检查用：状态 × 事件 的已定义格数（与 C0 交叉验证同源）。 */
  function stats() {
    const cells = new Set([...machine.table.keys()])
    let branches = 0
    for (const v of machine.table.values()) branches += v.length
    return { states: machine.states.length, events: machine.events.length, definedCells: cells.size, branches }
  }

  /**
   * 构造完整配置：机器定义声明了 `bool_vars`，调用方必须全部提供，
   * 否则 derived（如 needs_additional = has_unconfirmed or has_partial）无法求值。
   * 2026-09-18 实测：漏字段会让守卫求值抛"unknown identifier"，故提供此助手并作为推荐入口。
   */
  function defaultConfig(overrides = {}) {
    const cfg = {}
    for (const b of machine.boolVars) cfg[b] = false
    cfg.round = 1
    return { ...cfg, ...overrides }
  }

  return { machine, step, evaluate, stats, defaultConfig }
}
