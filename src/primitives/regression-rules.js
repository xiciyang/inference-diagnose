/**
 * regression-rules —— B 范式（性能劣化）的规则库加载与"基线 × 当前值"对比（L2；规则 L1 可热变）。
 *
 * 与 A 的规则库（root-cause-rules.js）**分区不统一**（用户 2026-09-28 裁决）：
 *   assets/root-causes/regression/performance-rules.yaml   基线类型 = performance
 *   assets/root-causes/regression/accuracy-rules.yaml      基线类型 = accuracy
 *   assets/root-causes/regression/qualitative-rules.yaml   无基线时的定性规则（when 正则）
 *
 * 硬依赖源：本路径所需的规则文件缺失/为空 → ERR_ROOTCAUSE_RULES_NOT_LOADED（REFUSE）。
 * "无规则不推测"的约束对 B 同样成立。
 *
 * 两类规则的差别：
 *   - 阈值规则（metric/pattern/direction/warnRatio/criticalRatio）：**必须有基线**才能判定，
 *     产出 `methodology.comparison`（基线值 / 当前值 / 比值 / 档位）。
 *     比值未达阈值 → 该假设**被排除**并进 `closure.excludedHypotheses`（可追溯），
 *     而不是静默丢弃。
 *   - 定性规则（when 正则）：不需要基线，匹配当前报告即成立。仅在**基线不可用**的降级路径启用。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from './yaml-lite.js'
import { ToolError, ErrCode } from '../protocol/envelope.js'
import { extractNumber, applyMethodology, assertJudgements } from './root-cause-rules.js'

export const BASELINE_TYPES = Object.freeze(['performance', 'accuracy'])

function readRules(p) {
  const doc = parse(readFileSync(p, 'utf8'))
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rules)) throw new Error('缺少 rules 列表')
  return doc
}

/**
 * @param {string} assetsRoot
 * @param {'performance'|'accuracy'} baselineType
 * @param {{qualitative?: boolean}} opts  降级路径才需要 qualitative 规则文件
 */
export function loadRegressionRules(assetsRoot, baselineType, { qualitative = false } = {}) {
  if (!BASELINE_TYPES.includes(baselineType)) {
    throw new ToolError(ErrCode.MISSING_PARAM, {
      missing: ['baselineType'],
      recoverable: true,
      hint: `baselineType 必须是 ${BASELINE_TYPES.join(' | ')} 之一（当前：${String(baselineType)}）。`,
    })
  }
  const want = [`regression/${baselineType}-rules.yaml`]
  if (qualitative) want.push('regression/qualitative-rules.yaml')

  const metricRules = []
  const qualitativeRules = []
  const problems = []
  const loaded = []
  const seen = new Map()

  for (const rel of want) {
    const p = join(assetsRoot, 'root-causes', rel)
    if (!existsSync(p)) {
      problems.push(`缺 root-causes/${rel}`)
      continue
    }
    let doc
    try {
      doc = readRules(p)
    } catch (e) {
      problems.push(`root-causes/${rel}: 解析失败 ${String(e.message).slice(0, 80)}`)
      continue
    }
    loaded.push(rel)
    const isQual = rel.includes('qualitative')
    for (const r of doc.rules) {
      if (!r || !r.id) {
        problems.push(`root-causes/${rel}: 规则缺少 id`)
        continue
      }
      if (seen.has(r.id)) problems.push(`规则 id 重复：${r.id}（${seen.get(r.id)} 与 root-causes/${rel}）`)
      else seen.set(r.id, `root-causes/${rel}`)
      const item = { ...r, sourceFile: `root-causes/${rel}`, ruleSet: doc.id || rel }
      if (isQual) {
        if (!r.when) problems.push(`root-causes/${rel}: 定性规则 ${r.id} 缺少 when`)
        else qualitativeRules.push(item)
      } else {
        if (!r.metric || !r.pattern) problems.push(`root-causes/${rel}: 阈值规则 ${r.id} 缺少 metric/pattern`)
        else metricRules.push(item)
      }
    }
  }

  assertJudgements([...metricRules, ...qualitativeRules], `root-causes:regression/${baselineType}`)
  if (problems.length > 0 || metricRules.length === 0) {
    throw new ToolError(ErrCode.ROOTCAUSE_RULES_NOT_LOADED, {
      affected: [`root-causes:regression/${baselineType}`],
      policy: 'REFUSE',
      recoverable: true,
      hint:
        `性能劣化（B）规则库不可用：${problems.length ? problems.join('；') : '阈值规则集为空'}。` +
        `拒绝在无规则情况下推测（fail-closed）。请检查 assets/root-causes/regression/ 下是否存在 ` +
        `${baselineType}-rules.yaml${qualitative ? ' 与 qualitative-rules.yaml' : ''}。`,
    })
  }
  return { metricRules, qualitativeRules, files: loaded, baselineType }
}

function evById(evidence) {
  const m = new Map()
  for (const e of evidence) m.set(e.id, e)
  return m
}

/**
 * 值域归一化（缺陷 C14）。
 *
 * 问题：比值型规则的**基线**与**报告当前值**可能一个用百分数、一个用 0–1 分数。
 * 实测（真实 harness）：基线 `kv_cache_usage_perc: 50`（百分数习惯）× 报告
 * `gpu_cache_usage_perc{…} 0.42`（引擎自报的 0–1 分数）→ 直接相除得 **0.0084**，
 * 而正确比值是 **0.84**——差 100 倍，用户会据此得出**完全错误**的结论。
 *
 * 这是与 `rg-qual-003` **同一类**缺陷（那条规则已用 `usage * (1 + (usage <= 1) * 99)`
 * 把两种形态归一化到百分制），而阈值比值路径当时没有归一化——同一插件两套处理。
 *
 * 修法（复用同一声明式模式，不引入新机制）：规则层声明 `valueDomain: fraction`
 * （期望值域 0–1），引擎在**比值之前**把两侧都归一化：`v > 1 → v / 100`，否则保持。
 * 判据是确定性的：在 0–1 量纲的场景里，"百分数形态"必然 > 1。
 * 未声明值域的规则（ttft_ms / e2e_ms / num_preemptions / ppl / kl_divergence 等无界量）
 * 一律原样参与比较，行为与旧版**逐字节一致**。
 */
export function normalizeByDomain(value, domain) {
  if (!Number.isFinite(value)) return value
  if (domain === 'fraction' && value > 1) return value / 100
  return value
}

/**
 * 阈值对比：对每条阈值规则，取基线值 + 从当前报告抽取当前值 → 比值 → 档位。
 * @returns {{fired:Array, excluded:Array, unmeasured:Array, comparisons:Array}}
 */
export function compareMetrics({ metricRules, evidence, baseline, baselineType }) {
  const byId = evById(evidence)
  const fired = []
  const excluded = []
  const unmeasured = []
  const comparisons = []

  for (const r of metricRules) {
    const b = baseline.metrics[r.metric]
    if (!b) {
      unmeasured.push({ ruleId: r.id, metric: r.metric, reason: 'metric-absent-in-baseline' })
      comparisons.push({ ruleId: r.id, metric: r.metric, status: 'metric-absent-in-baseline' })
      continue
    }
    const got = extractNumber(evidence, r.pattern)
    if (got.value === null || !got.ref) {
      unmeasured.push({ ruleId: r.id, metric: r.metric, reason: 'metric-not-in-report', pattern: r.pattern })
      comparisons.push({ ruleId: r.id, metric: r.metric, status: 'metric-not-in-report', baseline: b.value })
      continue
    }
    const direction = r.direction === 'lower-worse' ? 'lower-worse' : 'higher-worse'
    // C14：先按规则声明的值域把**两侧**归一到同一量纲，再相除
    const domain = r.valueDomain === 'fraction' ? 'fraction' : null
    const baseRaw = b.value
    const curRaw = got.value
    const baseVal = normalizeByDomain(baseRaw, domain)
    const cur = normalizeByDomain(curRaw, domain)
    const normalized = domain !== null && (baseVal !== baseRaw || cur !== curRaw)
    // 比值语义：>1 一律表示"比基线更差"（两个方向都归一化到同一判据）
    let ratio
    if (direction === 'higher-worse') {
      ratio = baseVal === 0 ? (cur > 0 ? Infinity : 1) : cur / baseVal
    } else {
      ratio = cur === 0 ? (baseVal > 0 ? Infinity : 1) : baseVal / cur
    }
    const warn = Number.isFinite(r.warnRatio) ? r.warnRatio : 1.2
    const crit = Number.isFinite(r.criticalRatio) ? r.criticalRatio : 1.5
    const severity = ratio >= crit ? 'critical' : ratio >= warn ? 'warn' : 'normal'
    const ev = byId.get(got.ref)
    const comparison = {
      metric: r.metric,
      baselineType,
      // C14：这里给的是**参与比较的归一化后**数值（与 ratio 自洽）。
      // 若发生了归一化，下面额外给出原始值，避免"数字被改过却看不出来"。
      baseline: baseVal,
      baselineUnit: b.unit || null,
      current: cur,
      direction,
      ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : 'Infinity',
      warnRatio: warn,
      criticalRatio: crit,
      severity,
      evidenceRef: got.ref,
      ...(domain !== null ? { valueDomain: domain } : {}),
      ...(normalized ? { rawBaseline: baseRaw, rawCurrent: curRaw } : {}),
    }
    comparisons.push({ ruleId: r.id, status: severity === 'normal' ? 'within-threshold' : severity, ...comparison })

    const base = {
      ruleId: r.id,
      ruleSet: r.ruleSet,
      sourceFile: r.sourceFile,
      hypothesis: r.hypothesis || r.id,
      needsProbes: Array.isArray(r.needsProbes) ? [...r.needsProbes] : [],
      strong: r.strong === true,
    }
    const computed = {
      expr: direction === 'higher-worse' ? 'current / baseline' : 'baseline / current',
      assert: '(threshold <= ratio)',
      inputs: { baseline: baseVal, current: cur },
      missingInputs: [],
      value: Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : null,
      error: Number.isFinite(ratio) ? null : '比值溢出（分母为 0）',
      holds: severity !== 'normal',
    }

    // 规则声明的方法论语义（requires / falsifiedBy / causal / structural）对阈值规则**同样生效**：
    // 否则 YAML 里写了 causal 门槛却被 compareMetrics 忽略（2026-09-28 实测缺陷）。
    // computed 由本路径覆盖为"比值判据"（阈值规则的可算判据就是基线/当前之比值），
    // 其余字段一律沿用 applyMethodology 的结果。
    const declared = applyMethodology(r, evidence)
    const declaredExcluded = declared.status === 'excluded'

    if (severity === 'normal' || declaredExcluded) {
      const excludedBy = [
        ...(severity === 'normal'
          ? [{
              kind: 'regression-within-threshold',
              detail: `${r.metric}: 基线 ${baseVal}${normalized ? `（原始基线 ${baseRaw}）` : ''} → 当前 ${cur}（比值 ${comparison.ratio} < 告警阈值 ${warn}）`,
              rationale: '阈值判据不成立 ⇒ 该劣化假设被排除（可撤回：修改阈值或提供更贴近工况的基线）',
            }]
          : []),
        ...declared.excludedBy,
      ]
      // 未达阈值 → 该假设被排除（进 excludedHypotheses 台账，可追溯），不是静默丢弃
      excluded.push({
        ...base,
        evidence: [{ ref: got.ref, relevance: `当前值 ${cur} 相对基线 ${baseVal}${normalized ? `（原始基线 ${baseRaw}）` : ''} 的比值为 ${comparison.ratio}，未达告警阈值 ${warn}` }],
        fixSpec: null,
        judgement: r.judgement,
        methodology: {
          ...declared,
          status: 'excluded',
          computed,
          comparison,
          excludedBy,
        },
        excluded: true,
        _comparison: comparison,
      })
      continue
    }

    fired.push({
      ...base,
      evidence: [
        {
          ref: got.ref,
          relevance:
            `当前值 ${cur}${b.unit ? ' ' + b.unit : ''} 相对基线 ${baseVal}${b.unit ? ' ' + b.unit : ''}${normalized ? `（原始基线 ${baseRaw}）` : ''} ` +
            `劣化至 ${comparison.ratio}×（档位 ${severity}；告警阈值 ${warn}、严重阈值 ${crit}）`,
        },
      ],
      fixSpec: r.fix === null ? null : r.fix,
      judgement: r.judgement,
      methodology: { ...declared, computed, comparison },
      excluded: false,
      _comparison: comparison,
    })
    void ev
  }
  return { fired, excluded, unmeasured, comparisons }
}
