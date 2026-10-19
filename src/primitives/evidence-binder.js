/**
 * evidence-binder —— §2.4 证据非空强制（接口层的 minItems:1 在代码侧的落点）。
 *
 * 两个断言：
 *   ① 丢弃无法绑定 ≥1 条证据的候选（不产出，而不是产出后标"证据不足"）
 *   ② 输出前复查（fix-output 调用）—— 任何候选若无证据，直接拒绝输出该候选
 *
 * 该模块存在的意义：即便规则引擎将来放宽，候选也不会无证据地流到用户面前。
 */

export function bind(candidates, evidence) {
  const byId = new Map(evidence.map((e) => [e.id, e]))
  const out = []
  for (const c of candidates) {
    const refs = Array.isArray(c.evidence) ? c.evidence : []
    const resolved = refs
      .map((r) => {
        const ev = byId.get(r.ref)
        if (!ev) return null
        return {
          ref: ev.id,
          sourceFile: r.sourceFile || ev.sourceFile,
          line: ev.line,
          snippet: ev.snippet,
          relevance: r.relevance || '',
        }
      })
      .filter(Boolean)
    if (resolved.length === 0) continue
    out.push({ ...c, evidence: resolved })
  }
  return out
}

/** 输出前复查：返回不合规的候选清单（调用方据此拒绝输出并记 ERR_INTERNAL）。 */
export function violations(candidates) {
  const bad = []
  for (const c of candidates) {
    if (!Array.isArray(c.evidence) || c.evidence.length === 0) bad.push({ id: c.ruleId, why: 'evidence 为空（违反 minItems:1）' })
    for (const ev of c.evidence || []) {
      if (!ev.sourceFile || !Number.isFinite(ev.line) || !ev.snippet) {
        bad.push({ id: c.ruleId, why: `证据 ${ev.ref} 缺少可溯源字段（sourceFile/line/snippet）` })
      }
    }
  }
  return bad
}
