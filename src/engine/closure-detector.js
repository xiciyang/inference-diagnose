/**
 * closure-detector —— 单轮闭环检测（当下）：判断一次诊断结果是否已形成闭环。
 *
 * 与 loop-controller 的分工（§1.1 消歧）：
 *   closure-detector  管"当下这一轮"：本轮是否已给出可执行修复且证据充分
 *   loop-controller   管"流转"：下一步该走哪个状态
 *   closure-tracker   管"历史"：跨轮状态与轮次计数
 */

export const CLOSURE = Object.freeze({
  CLOSED: 'closed', // 本轮已给出完整修复（可执行）→ 闭环
  NEEDS_COLLECTION: 'needs-collection', // 需定向补采
  BLOCKED: 'blocked', // 未确认且无可用补采路径
})

export function detect(rootCauses) {
  if (!Array.isArray(rootCauses) || rootCauses.length === 0) {
    return { closure: CLOSURE.BLOCKED, reason: '没有任何根因候选（无证据或无匹配规则）', targets: [] }
  }
  const executable = rootCauses.filter((rc) => rc.fix && rc.fix.state === 'complete')
  const partial = rootCauses.filter((rc) => rc.fix && rc.fix.state === 'partial')
  const unconfirmed = rootCauses.filter((rc) => rc.confidence === '未确认')

  if (executable.length > 0) {
    return { closure: CLOSURE.CLOSED, reason: `${executable.length} 条根因给出完整可执行修复`, targets: executable.map((r) => r.id) }
  }
  if (partial.length > 0 || unconfirmed.length > 0) {
    const targets = []
    for (const rc of [...partial, ...unconfirmed]) {
      for (const n of (rc.additionalCollection && rc.additionalCollection.needed) || []) {
        if (!targets.includes(n.probe)) targets.push(n.probe)
      }
    }
    return {
      closure: CLOSURE.NEEDS_COLLECTION,
      reason: partial.length > 0 ? '修复为 partial（需现场信息）' : '存在未确认根因',
      targets,
    }
  }
  return { closure: CLOSURE.BLOCKED, reason: '候选均无 fix 且无补采指令（不应发生）', targets: [] }
}
