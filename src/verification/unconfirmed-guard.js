/**
 * unconfirmed-guard —— 未确认结论阻塞阶段推进（§1.11 / §2.6 / §5.5 纪律 2）。
 *
 * 语义：只要阶段里存在"未确认"条目，该阶段不得宣告完成。热更新本身**不解除**
 * 阻塞 —— 只有重评得到非"未确认"结果才解除（§4.4）。
 */
import { RESULT } from './stage-recorder.js'

export class UnconfirmedBlocked extends Error {
  constructor(pending) {
    super(`阶段被 ${pending.length} 条未确认项阻塞：${pending.join(', ')}`)
    this.name = 'UnconfirmedBlocked'
    this.pending = pending
  }
}

/** 条目必须已具备 blockedBy / nextAction / owner（否则视为"未确认但未接线"，同样阻塞）。 */
export function assertCanAdvance(entries) {
  const pending = []
  for (const e of entries) {
    if (e.result !== RESULT.UNCONFIRMED) continue
    const missing = ['blockedBy', 'nextAction', 'owner'].filter((f) => !e[f])
    pending.push(missing.length ? `${e.id}(缺 ${missing.join('/')})` : e.id)
  }
  if (pending.length > 0) throw new UnconfirmedBlocked(pending)
  return true
}

/** 不抛的变体：返回阻塞报告（供工具返回里携带，而不是让调用崩掉）。 */
export function checkAdvance(entries) {
  try {
    assertCanAdvance(entries)
    return { ok: true, pending: [] }
  } catch (e) {
    if (e instanceof UnconfirmedBlocked) return { ok: false, pending: e.pending }
    throw e
  }
}
