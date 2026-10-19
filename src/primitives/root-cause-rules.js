/**
 * root-cause-rules —— §2.4 根因规则库加载与匹配（L2；规则数据 L1 可热变）。
 *
 * 硬依赖源：combo.ruleFiles 指向的文件缺失/非法 → ERR_ROOTCAUSE_RULES_NOT_LOADED（REFUSE）。
 * 这是 §2.1 依赖源矩阵里"第三个依赖源之外"的第二个规则库：无规则即禁止推测。
 *
 * 规则形态（assets/root-causes/*.yaml）：
 *   - id, when(正则), hypothesis, minEvidence, needsProbes, fix{mode,code,verification,rollback,riskLevel}
 *   fix 三态（§2.4）：
 *     complete → fix 四部分齐（mode 省略即 complete）
 *     partial  → fix.mode == 'partial'（code 通常为 pending，必附补采指令）
 *     null     → 规则无 fix（或显式 null）→ 未确认 + 定向补采
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from './yaml-lite.js'
import { ToolError, ErrCode } from '../protocol/envelope.js'

// ───────────── 规则判据分级（judgement）校验：G1/G2，fail-closed ─────────────
// 口径见 docs/judgement-rubric.md。**加载即校验**：缺字段/值越界/decisive 缺理由
// 一律拒绝加载该规则库（而不是运行时才发现），与"无规则不推测"同一 fail-closed 纪律。
export const JUDGEMENTS = Object.freeze(['decisive', 'quantitative', 'contextual'])

/** G2 的"不是空话"判据：长度 ≥40 且含具体引用（反引号内的字段/取值，或 `=` 赋值）。 */
export const DECISIVE_RATIONALE_MIN = 40

export function judgeReasons(rule) {
  const out = []
  const j = rule.judgement
  if (!JUDGEMENTS.includes(j)) out.push(`judgement 缺失或越界："${j}"（应为 ${JUDGEMENTS.join(' | ')}）`)
  if (j === 'decisive') {
    const r = typeof rule.decisiveRationale === 'string' ? rule.decisiveRationale.trim() : ''
    if (r.length < DECISIVE_RATIONALE_MIN) {
      out.push(`decisive 必须给出 ≥${DECISIVE_RATIONALE_MIN} 字的 decisiveRationale（实际 ${r.length} 字）`)
    } else if (!r.includes('`') && !r.includes('=')) {
      out.push('decisiveRationale 必须是"具体到字段/取值"的理由（需含反引号引用的字段名或 `=` 赋值），不允许空话')
    }
  } else if (rule.decisiveRationale !== undefined) {
    out.push('非 decisive 规则不得带 decisiveRationale（防止注释漂移成第二真源）')
  }
  return out
}

/** 校整批规则；有问题即抛（fail-closed）。 */
export function assertJudgements(rules, sourceLabel) {
  const problems = []
  for (const r of rules) for (const why of judgeReasons(r)) problems.push(`${r.id}: ${why}`)
  if (problems.length > 0) {
    throw new ToolError(ErrCode.ROOTCAUSE_RULES_NOT_LOADED, {
      affected: ['root-causes'],
      policy: 'REFUSE',
      recoverable: true,
      hint:
        `规则判据分级（judgement）不合法，拒绝加载（口径见 docs/judgement-rubric.md）：${problems.join('；')}。` +
        `每条规则必须声明 judgement ∈ {${JUDGEMENTS.join(', ')}}；判 decisive 的必须给出具体的 decisiveRationale。`,
      source: sourceLabel,
    })
  }
  return rules
}

/** 读取组合对应的一组根因规则文件（并集）。 */
export function loadRuleFiles(assetsRoot, combo) {
  const want = combo.ruleFilesSorted || combo.ruleFiles || []
  const rules = []
  const problems = []
  const loaded = []
  for (const rel of want) {
    const p = join(assetsRoot, rel)
    if (!existsSync(p)) {
      problems.push(`缺 ${rel}`)
      continue
    }
    try {
      const doc = parse(readFileSync(p, 'utf8'))
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rules)) {
        problems.push(`${rel}: 缺少 rules 列表`)
        continue
      }
      loaded.push(rel)
      for (const r of doc.rules) {
        if (!r || !r.id || !r.when) {
          problems.push(`${rel}: 规则缺少 id/when`)
          continue
        }
        rules.push({ ...r, sourceFile: rel, ruleSet: doc.id || rel })
      }
    } catch (e) {
      problems.push(`${rel}: 解析失败 ${String(e.message).slice(0, 80)}`)
    }
  }
  if (problems.length > 0) {
    throw new ToolError(ErrCode.ROOTCAUSE_RULES_NOT_LOADED, {
      affected: [`root-causes:${combo.dims.framework}/${combo.dims.hardware}`],
      policy: 'REFUSE',
      recoverable: true,
      hint:
        `当前三维组合的根因规则库不可用：${problems.join('；')}。拒绝在无规则情况下推测（fail-closed）。` +
        `请检查 assets/root-causes/ 下对应维度的规则文件。`,
    })
  }
  // 规则 id 唯一性守卫（2026-09-23 实测缺陷）：同 id 出现在两个规则文件时，
  // 会出现"同一条假设既有候选版本又有被否证版本"，结论自相矛盾。
  const seen = new Map()
  for (const r of rules) {
    if (seen.has(r.id)) {
      problems.push(`规则 id 重复：${r.id}（${seen.get(r.id)} 与 ${r.sourceFile}）`)
    } else {
      seen.set(r.id, r.sourceFile)
    }
  }
  if (problems.some((x) => x.startsWith('规则 id 重复'))) {
    throw new ToolError(ErrCode.ROOTCAUSE_RULES_NOT_LOADED, {
      affected: ['root-causes'],
      policy: 'REFUSE',
      recoverable: true,
      hint:
        `根因规则 id 必须唯一，当前存在重复：${problems.filter((x) => x.startsWith('规则 id 重复')).join('；')}。` +
        `请让每条规则只有一个物理定义（规则库是单一真源），否则会出现同一假设既被判候选又被判否证。`,
    })
  }
  assertJudgements(rules, `root-causes:${combo.dims.framework}/${combo.dims.hardware}`)
  if (rules.length === 0) {
    throw new ToolError(ErrCode.ROOTCAUSE_RULES_NOT_LOADED, {
      affected: [`root-causes:${combo.dims.framework}/${combo.dims.hardware}`],
      policy: 'REFUSE',
      recoverable: true,
      hint: '当前三维组合的规则集为空：没有任何可用根因规则。拒绝无规则推测（fail-closed）。',
    })
  }
  return { rules, files: loaded }
}

// ───────────── 方法论语义（2026-09-23 抽象自"QLI int32 溢出"成功案例）─────────────
// 现规则引擎只有"单片段正则 → 假设"，缺四样东西，正是那次成功定位所依赖的：
//   ① 合取 requires：多条件必须**各自**在证据里命中（可跨段/跨源）
//   ② 否证 falsifiedBy / computeCheck：若 H 为真则**必然**观察到 X；X 缺席或数值判据不成立 ⇒ H 被排除
//   ③ 可算判据 computeCheck：把"可能溢出"变成"第 floor(2^31/stride)+1 页必溢出"这类**数字**
//   ④ 因果闭环 causal：无"回切复现/双向开闭/二进制一致"不得称'已证明'
// 全部为可选字段：旧规则（只有 when）行为完全不变。

/** 极小的安全算术求值器：支持 + - * / ( ) 与 floor/ceil/min/max/abs，**不使用 eval/Function**。 */
export function evaluateExpr(expr, vars = {}) {
  const toks = String(expr).match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+(?:\.[0-9]+)?|<=|>=|==|!=|[+\-*/(),<>]/g)
  if (!toks) throw new Error('表达式不可解析')
  let i = 0
  const peek = () => toks[i]
  const eat = (t) => { if (toks[i] !== t) throw new Error(`期望 ${t}，遇到 ${toks[i]}`); i++ }
  function primary() {
    const t = peek()
    if (t === '(') { eat('('); const v = expression(); eat(')'); return v }
    if (t === '-') { i++; return -primary() }
    if (/^[0-9]/.test(t)) { i++; return Number(t) }
    if (/^[A-Za-z_]/.test(t)) {
      i++
      if (peek() === '(') {
        eat('(')
        const args = []
        if (peek() !== ')') { args.push(expression()); while (peek() === ',') { eat(','); args.push(expression()) } }
        eat(')')
        if (t === 'floor') return Math.floor(args[0])
        if (t === 'ceil') return Math.ceil(args[0])
        if (t === 'abs') return Math.abs(args[0])
        if (t === 'min') return Math.min(...args)
        if (t === 'max') return Math.max(...args)
        throw new Error(`未知函数 ${t}`)
      }
      if (!(t in vars)) throw new Error(`缺少输入变量 ${t}`)
      return Number(vars[t])
    }
    throw new Error(`意外记号 ${t}`)
  }
  function muldiv() { let v = primary(); while (peek() === '*' || peek() === '/') { const op = toks[i++]; const r = primary(); v = op === '*' ? v * r : v / r } return v }
  function addsub() { let v = muldiv(); while (peek() === '+' || peek() === '-') { const op = toks[i++]; const r = muldiv(); v = op === '+' ? v + r : v - r } return v }
  // 比较层：返回 1/0，使 assert 可写成 (threshold <= maxBlock)
  function cmp() {
    const l = addsub()
    const t = peek()
    if (t === '<' || t === '>' || t === '<=' || t === '>=' || t === '==' || t === '!=') {
      i++
      const r = addsub()
      if (t === '<') return l < r ? 1 : 0
      if (t === '>') return l > r ? 1 : 0
      if (t === '<=') return l <= r ? 1 : 0
      if (t === '>=') return l >= r ? 1 : 0
      if (t === '==') return l === r ? 1 : 0
      return l !== r ? 1 : 0
    }
    return l
  }
  function expression() { return cmp() }
  const out = expression()
  if (i !== toks.length) throw new Error('表达式尾部有多余记号')
  return out
}

function ruleRe(pat) { try { return new RegExp(pat, 'i') } catch { return null } }

/** 从证据里按 pattern 抽取第一个捕获组为数字。 */
export function extractNumber(evidence, pattern) {
  const re = ruleRe(pattern)
  if (!re) return { value: null, ref: null }
  for (const ev of evidence) {
    const m = String(ev.snippet || '').match(re)
    if (m && m[1] !== undefined) {
      const raw = String(m[1]).toLowerCase()
      // 布尔信号（DSH-SIGNAL key=true/false）映射为 1/0，使 computeCheck 能对"是否出现"做可算判据
      if (raw === 'true') return { value: 1, ref: ev.id, snippet: ev.snippet }
      if (raw === 'false') return { value: 0, ref: ev.id, snippet: ev.snippet }
      if (Number.isFinite(Number(m[1]))) return { value: Number(m[1]), ref: ev.id, snippet: ev.snippet }
    }
  }
  return { value: null, ref: null }
}

/**
 * 对单条规则应用方法论语义，返回可直接并入候选的元数据。
 * 返回 { status, requires, falsifiedBy, computed, causal, structural, excludedBy }
 *   status='candidate' 正常候选；status='excluded' 被否证（excludedBy 说明是被哪条否证掉）
 */
export function applyMethodology(rule, evidence) {
  const out = { status: 'candidate', requires: [], falsifiedBy: [], computed: null, causal: null, structural: null, excludedBy: [] }
  const exclude = (kind, detail, rationale) => { out.status = 'excluded'; out.excludedBy.push({ kind, detail, rationale: rationale || null }) }

  // ① 合取
  if (Array.isArray(rule.requires)) {
    for (const req of rule.requires) {
      const re = ruleRe(req && req.when ? req.when : String(req))
      const hit = re ? evidence.filter((ev) => re.test(String(ev.snippet || ''))) : []
      out.requires.push({ when: req && req.when ? req.when : String(req), matched: hit.length > 0, evidence: hit.map((e) => e.id) })
    }
    if (out.requires.some((r) => !r.matched)) {
      exclude('requires-unmet', out.requires.filter((r) => !r.matched).map((r) => r.when))
    }
  }

  // ② 否证（absence）与 ③ 可算判据（数值不成立）
  if (Array.isArray(rule.falsifiedBy)) {
    for (const f of rule.falsifiedBy) {
      const re = ruleRe(f && f.when ? f.when : String(f))
      const present = re ? evidence.some((ev) => re.test(String(ev.snippet || ''))) : false
      out.falsifiedBy.push({ when: f && f.when ? f.when : String(f), present, absent: present === false })
      if (present === false) {
        exclude('falsifier-absent', (f && f.when) || String(f), f && f.rationale)
      }
    }
  }
  if (rule.computeCheck && typeof rule.computeCheck.expr === 'string') {
    const cc = rule.computeCheck
    const vars = {}
    const missing = []
    for (const inp of (cc.inputs || [])) {
      const got = extractNumber(evidence, inp.pattern)
      if (got.value === null) missing.push(inp.name)
      else vars[inp.name] = got.value
    }
    let value = null
    let error = null
    try { value = evaluateExpr(cc.expr, vars) } catch (e) { error = String(e.message) }
    const holds = error === null && missing.length === 0 && value !== null && cc.assert
      ? Boolean(evaluateExpr(`(${cc.assert})`, { ...vars, value, threshold: value }))
      : null
    out.computed = { expr: cc.expr, assert: cc.assert || null, inputs: vars, missingInputs: missing, value, error, holds }
    if (holds === false) {
      exclude('compute-falsified', `${cc.expr} = ${value} 不满足 ${cc.assert}`, cc.rationale)
    }
  }

  // ④ 因果闭环门槛
  if (rule.causal || rule.causalClosure) {
    const c = rule.causal || { closurePattern: rule.causalClosure }
    const re = ruleRe(c.closurePattern)
    const hit = re ? evidence.filter((ev) => re.test(String(ev.snippet || ''))) : []
    out.causal = { closurePattern: c.closurePattern, closureSatisfied: hit.length > 0, requireForProven: c.requireForProven !== false, evidence: hit.map((e) => e.id) }
  }

  // ⑤ 结构标注（离散决策点等，供方法论文档与排序使用）
  if (rule.structural) out.structural = { kind: rule.structural.kind || 'unknown', note: rule.structural.note || null }

  return out
}

/** 用证据匹配规则 → 候选（未绑定证据的候选由 evidence-binder 丢弃）。 */
export function match(rules, evidence) {
  const candidates = []
  for (const r of rules) {
    let re
    try {
      re = new RegExp(r.when, 'i')
    } catch {
      continue
    }
    const bound = evidence.filter((ev) => re.test(String(ev.snippet || '')))
    const min = Number.isFinite(r.minEvidence) ? r.minEvidence : 1
    if (bound.length < min) continue
    const methodology = applyMethodology(r, evidence)
    if (methodology.status === 'excluded') {
      // 被否证/合取未满足的假设**不静默丢弃**：作为 excluded 候选上报（可追溯），
      // 由 index.js 收进 closure.excludedHypotheses，而不是混进 rootCauses。
      candidates.push({
        ruleId: r.id,
        ruleSet: r.ruleSet,
        sourceFile: r.sourceFile,
        hypothesis: r.hypothesis || r.id,
        // 保留"触发该假设"的证据：既让 evidence-binder 不丢（可追溯），
        // 也让读者看到"这条假设为什么曾被列入、又是被什么否证的"。
        evidence: bound.map((ev) => ({
          ref: ev.id,
          sourceFile: ev.sourceFile,
          line: ev.line,
          snippet: ev.snippet,
          relevance: `该假设曾被列入（命中主条件），随后被否证：${methodology.excludedBy.map((x) => x.kind).join('/')}`,
        })),
        needsProbes: [],
        fixSpec: null,
        strong: r.strong === true,
        judgement: r.judgement,
        methodology,
        excluded: true,
      })
      continue
    }
    candidates.push({
      ruleId: r.id,
      ruleSet: r.ruleSet,
      sourceFile: r.sourceFile,
      hypothesis: r.hypothesis || r.id,
      evidence: bound.map((ev) => ({
        ref: ev.id,
        sourceFile: ev.sourceFile,
        line: ev.line,
        snippet: ev.snippet,
        relevance: r.relevance || `命中规则 ${r.id} 的判定条件`,
      })),
      needsProbes: Array.isArray(r.needsProbes) ? [...r.needsProbes] : [],
      fixSpec: r.fix === null ? null : r.fix,
      strong: r.strong === true,
      judgement: r.judgement,
      methodology,
      excluded: false,
    })
  }
  return candidates
}
