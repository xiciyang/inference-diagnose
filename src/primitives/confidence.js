/**
 * confidence —— §2.4 三档置信度判定（只由证据决定，与修复完备性正交）。
 *
 * 档位语义（§2）：
 *   已证明       证据充分且指向唯一机制（规则声明 strong + ≥2 条独立证据）
 *   未发现反例   有证据支持，但未穷尽排除其它机制（默认档）
 *   未确认       证据不足以判定 / 缺关键探针 → 禁止输出修复，只许给补采指令
 *
 * 重要：本模块不看 fix 是否存在来"抬高"置信度（反向不成立，§2.4 条款 3）。
 * 但 fix 缺失（fixSpec=null）本身是"机制未确定"的证据 → 判为未确认。
 */

export const LEVELS = Object.freeze({ PROVEN: '已证明', NO_COUNTEREXAMPLE: '未发现反例', UNCONFIRMED: '未确认' })

export function grade(candidate, { evidence = [] } = {}) {
  const bound = Array.isArray(candidate.evidence) ? candidate.evidence : []
  const independentSources = new Set(bound.map((e) => e.sourceFile)).size
  const rule = candidate.fixSpec

  // fix 三态与置信度的单向关系（§2.4 条款 3）：
  //   fixSpec 为 null → 机制未定 → 未确认（禁出修复，只给补采指令）
  //   fixSpec.mode = 'unconfirmed' → 规则显式声明未确认
  //   fixSpec.mode = 'partial' → 方向已定、精确命令待现场信息 → 未发现反例 + fix.state=partial
  //   其余（complete）→ strong 且 ≥2 条独立来源证据才给"已证明"，否则"未发现反例"
  // 注意：needsProbes 非空**不等于**未确认 —— 它只说明还需要哪些探针细化，
  //       而规则已给出修复方向（2026-09-18 真实 harness 调用发现此缺陷并修正）。
  // ── 方法论门槛（2026-09-23，抽象自"QLI int32 溢出"案例）──
  //  ① 可算判据不成立（如"未见高页号"）→ 该假设已被否证，不得作为根因输出
  //  ② 规则声明了因果闭环要求，但证据里没有"回切复现/双向开闭/二进制一致" →
  //     最高只能到"未发现反例"，**不得**称"已证明"（"改了就好了"不算因果）
  const m = candidate.methodology || null
  if (m && m.computed && m.computed.holds === false) return LEVELS.UNCONFIRMED
  if (!rule || rule.mode === 'unconfirmed') return LEVELS.UNCONFIRMED
  if (rule.mode === 'partial') return LEVELS.NO_COUNTEREXAMPLE
  if (m && m.causal && m.causal.requireForProven === true && m.causal.closureSatisfied !== true) {
    return LEVELS.NO_COUNTEREXAMPLE
  }
  // ── 判据分级门槛（2026-09-28，口径见 docs/judgement-rubric.md §4 G5）──
  //   contextual（存在性/上下文关键词）**永不得**称"已证明"：它的命中性既不充分也不必要，
  //   即便证据条数多，也只是"多处提到同一个词"，不构成机制成立的证明。
  //   典型实测反例：健康服务器上"量化配置字段出现"这类规则拿到了"已证明"——
  //   它只是"多处提到同一个词"，不构成机制成立的证明。
  if (candidate.judgement === 'contextual') return LEVELS.NO_COUNTEREXAMPLE
  if (candidate.strong === true && bound.length >= 2 && independentSources >= 2) return LEVELS.PROVEN
  return LEVELS.NO_COUNTEREXAMPLE
}
