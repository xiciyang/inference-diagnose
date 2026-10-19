/**
 * fix-output —— §2.4 fix 三态输出（complete / partial / null）+ 输出前复查。
 *
 * 单向硬约束（§2.4 条款 3）：
 *   confidence = 未确认            → fix 必须为 null，且 additionalCollection 必非 null
 *   confidence ∈ {已证明,未发现反例} → fix 必非 null，且为 complete 或 partial
 *   partial                        → code = "pending" 且必附补采指令
 * 反向不成立：fix 完备不抬高 confidence。
 */
import { ToolError, ErrCode } from '../protocol/envelope.js'
import { LEVELS } from './confidence.js'
import { violations } from './evidence-binder.js'

/**
 * 定向补采清单：**只**用规则声明的探针（§2.4）。
 * 若规则声明的探针在维度注册表里不存在 → 资产不一致，fail-loud（不得静默退化为"全量探针"）。
 */
function additionalCollection(combo, probeIds, reasons) {
  const wanted = Array.isArray(probeIds) ? probeIds : []
  // 未提供 dimensions（B/C 范式的可选参数）：没有探针表可解析 → **不假装能生成脚本**，
  // 只把规则声明的探针名原样交给用户（并说明为什么没有脚本）。证据链与非空约束不受影响。
  if (!combo) {
    return {
      needed: wanted.map((probe) => ({
        probe,
        reason: reasons || '现有报告缺少该探针，需补齐后才能确认/排除该机制',
      })),
      unresolved: [],
      reason: wanted.length
        ? '本次调用未提供 dimensions：无法把探针解析成定向补采脚本。请补上 dimensions 后重试，或直接用上述探针名重跑完整采集脚本。'
        : '该规则未声明所需探针：建议重跑完整采集脚本（generate_collect_script）而非定向补采',
      script: null,
    }
  }
  if (wanted.length === 0) {
    return {
      needed: [],
      unresolved: [],
      reason: '该规则未声明所需探针：建议重跑完整采集脚本（generate_collect_script）而非定向补采',
      script: null,
    }
  }
  const resolved = combo.probes.filter((p) => wanted.includes(p.probe))
  const unresolved = wanted.filter((id) => !resolved.some((p) => p.probe === id))
  if (unresolved.length > 0) {
    throw new ToolError(ErrCode.INTERNAL, {
      message: '规则声明了未注册的探针（资产不一致）',
      affected: ['root-causes', 'dimensions'],
      recoverable: false,
      hint:
        `以下探针被规则引用但不在当前三维组合的探针表内：${unresolved.join(', ')}。` +
        `这是资产数据缺陷：请把该探针补进对应维度的 assets/dimensions/<kind>/<id>.yaml，` +
        `或修正规则里的 needsProbes。不静默退化为"全量探针"（那会让 reason 变成假话）。`,
    })
  }
  return {
    needed: resolved.map((p) => ({
      probe: p.probe,
      reason: reasons || '现有报告缺少该探针，需补齐后才能确认/排除该机制',
    })),
    unresolved: [],
    script: null, // 由 index 层调用 script-composer 生成（定向补采脚本，内嵌脱敏）
  }
}

/**
 * @param {object} p
 * @param {object} p.candidate   规则匹配结果（含 fixSpec / needsProbes / evidence）
 * @param {string} p.confidence  confidence.grade 的结果
 * @param {object} p.combo       resolveCombo 结果
 */
export function build({ candidate, confidence, combo }) {
  const spec = candidate.fixSpec
  const needsProbes = Array.isArray(candidate.needsProbes) ? candidate.needsProbes : []

  // 未确认 → 禁止输出修复方案，只许给具体缺采集指令
  if (confidence === LEVELS.UNCONFIRMED) {
    return {
      fix: null,
      additionalCollection: additionalCollection(
        combo,
        needsProbes,
        needsProbes.length
          ? '判定该机制所必需的探针不在本轮证据中（需补采后才能确认或排除）'
          : '证据不足以判定机制（无匹配的修复规则）',
      ),
    }
  }

  if (!spec) {
    // 置信度与修复互相矛盾：按不变量 I3 拒绝输出该候选
    throw new ToolError(ErrCode.INTERNAL, {
      message: 'fix 形态与置信度不一致（不变量 I3 违例）',
      recoverable: false,
      hint: `候选 ${candidate.ruleId} 置信度为 ${confidence} 但规则未提供 fix：拒绝输出该候选。`,
    })
  }

  const partial = spec.mode === 'partial' || spec.code === 'pending'
  if (partial) {
    return {
      fix: {
        state: 'partial',
        code: 'pending',
        note: spec.note || '修复方向已定；精确命令需现场信息，先按补采指令收集。',
        verification: spec.verification || null,
        rollback: spec.rollback || null,
        riskLevel: spec.riskLevel || 'unknown',
      },
      additionalCollection: additionalCollection(combo, needsProbes, spec.note || 'partial：需现场信息才能给出精确命令'),
    }
  }

  return {
    fix: {
      state: 'complete',
      code: spec.code,
      verification: spec.verification,
      rollback: spec.rollback,
      riskLevel: spec.riskLevel || 'medium',
    },
    additionalCollection: needsProbes.length ? additionalCollection(combo, needsProbes) : null,
  }
}

/** 输出前复查：四部分完整性 + 证据非空。返回问题清单。 */
export function review(rootCauses) {
  const problems = violations(rootCauses)
  for (const rc of rootCauses) {
    const fix = rc.fix
    if (rc.confidence === LEVELS.UNCONFIRMED) {
      if (fix !== null) problems.push({ id: rc.id, why: '未确认却输出了 fix' })
      if (!rc.additionalCollection) problems.push({ id: rc.id, why: '未确认却没有 additionalCollection' })
      continue
    }
    if (!fix) {
      problems.push({ id: rc.id, why: '非未确认却没有 fix' })
      continue
    }
    if (fix.state === 'partial') {
      if (fix.code !== 'pending') problems.push({ id: rc.id, why: 'partial 的 code 必须为 pending' })
      if (!rc.additionalCollection) problems.push({ id: rc.id, why: 'partial 必附补采指令' })
    } else if (fix.state === 'complete') {
      for (const k of ['code', 'verification', 'rollback', 'riskLevel']) {
        if (!fix[k]) problems.push({ id: rc.id, why: `complete 缺 ${k}` })
      }
    } else {
      problems.push({ id: rc.id, why: `fix.state 非法：${fix.state}` })
    }
  }
  return problems
}
