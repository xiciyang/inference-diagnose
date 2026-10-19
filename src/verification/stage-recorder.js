/**
 * stage-recorder —— §1.11 验证框架运行时支撑：阶段记录 + 汇总计数。
 *
 * 纪律（§5.5 纪律 5）：**汇总数字必须由条目推导，禁止手写**。
 * 本模块的 summary() 是唯一计数来源；任何地方需要 proven/noCounterexample/
 * unconfirmed 都必须调用它，不得使用常量。
 */

export const RESULT = Object.freeze({ PROVEN: '已证明', NO_COUNTEREXAMPLE: '未发现反例', UNCONFIRMED: '未确认' })

const KEY = {
  [RESULT.PROVEN]: 'proven',
  [RESULT.NO_COUNTEREXAMPLE]: 'noCounterexample',
  [RESULT.UNCONFIRMED]: 'unconfirmed',
}

export function createStageRecorder({ stage }) {
  const entries = []

  function add(entry) {
    if (!entry || !entry.id || !entry.result) throw new Error('stage-recorder: entry 需含 id 与 result')
    if (!(entry.result in KEY)) throw new Error(`stage-recorder: 非法 result: ${entry.result}`)
    if (entry.result === RESULT.UNCONFIRMED) {
      for (const f of ['blockedBy', 'nextAction', 'owner']) {
        if (!entry[f]) throw new Error(`stage-recorder: 未确认条目 ${entry.id} 缺 ${f}（§5.5 纪律 2）`)
      }
    }
    entries.push({ stage, ...entry })
    return entry
  }

  /** 计数由条目推导（唯一真源）。 */
  function summary() {
    const s = { proven: 0, noCounterexample: 0, unconfirmed: 0 }
    for (const e of entries) s[KEY[e.result]] += 1
    return s
  }

  function unconfirmed() {
    return entries.filter((e) => e.result === RESULT.UNCONFIRMED).map((e) => e.id)
  }

  return { add, all: () => [...entries], summary, unconfirmed, stage }
}
