/**
 * §2.1 通用返回信封 —— 五个工具共用的唯一真源。
 *
 * 本文件是"接口契约"在代码里的落点：ErrCode 闭集（9 码）、ErrBody、
 * degradations[] 判别联合、notices[] 叠加规则。任何工具的返回都必须经
 * ok() / fail() 构造，不得各自拼装。
 *
 * 契约出处：design.md §2.1（含 2026-09-18 的能力降级判据 D0–D3 与统一通道）。
 */

/**
 * 错误码闭集（9 码）。新增码 = schema 版本变更，须回文档修订并确认。
 *
 * 闭集按**依赖源**拆分（§2.1）：每个"可独立失效、且失效语义不同"的依赖源一个码，
 * 不设"其他"桶。第 9 码 `ERR_BASELINE_MALFORMED` 按同一原则新增：它对应 B 范式
 * （性能劣化）的**客户提供基线**这一独立依赖源。
 * 与之配对的是"**基线未提供**"——那**不是**错误码，而是能力降级
 * （D0–D3 全成立：仍可产出定性诊断、无明文、置信度如实、语义在 notices[] 声明），
 * 走 `degradations[]` 的 `capability-unavailable / performance-baseline-diff`。
 */
export const ErrCode = Object.freeze({
  MISSING_PARAM: 'ERR_MISSING_PARAM',
  REPORT_CORRUPT: 'ERR_REPORT_CORRUPT',
  DESENSITIZE_RULES_NOT_LOADED: 'ERR_DESENSITIZE_RULES_NOT_LOADED',
  ROOTCAUSE_RULES_NOT_LOADED: 'ERR_ROOTCAUSE_RULES_NOT_LOADED',
  DIMENSIONS_NOT_LOADED: 'ERR_DIMENSIONS_NOT_LOADED',
  TEMPLATE_NOT_LOADED: 'ERR_TEMPLATE_NOT_LOADED',
  DESENSITIZE_MISS: 'ERR_DESENSITIZE_MISS',
  BASELINE_MALFORMED: 'ERR_BASELINE_MALFORMED',
  INTERNAL: 'ERR_INTERNAL',
})

export const ALL_ERR_CODES = Object.freeze(Object.values(ErrCode))

/**
 * 工具内部错误载体：primitives 抛 ToolError，index 统一转成信封。
 * 不抛裸 Error（那会退化成 ERR_INTERNAL 兜底，丢失可诊断性）。
 */
export class ToolError extends Error {
  constructor(code, body) {
    super(`${code}: ${body && body.hint ? body.hint : ''}`)
    this.name = 'ToolError'
    this.code = code
    this.body = body || {}
  }
}

/** 降级通道受控词表（§2.1）。准入规则：仅"能独立失效且可在单次调用中断言"的能力入表。 */
export const VOCAB = Object.freeze({
  capability: Object.freeze(['cross-round-evidence-diff', 'performance-baseline-diff']),
  check: Object.freeze(['desensitize-recheck']),
  reason: Object.freeze([
    'no-persistent-store',
    'in-process-store-only',
    'history-missing',
    'desensitize-rules-unavailable',
    'baseline-unavailable',
  ]),
  effects: Object.freeze([
    'round-reset-1',
    'recollection-degraded',
    'history-unavailable',
    'assurance-reduced',
    'qualitative-mode',
  ]),
})

/** notices 固定优先级：小者在前（§2.1）。 */
export const NOTICE_PRIORITY = Object.freeze({
  'capability-degraded': 1,
  'version-drift': 2,
  // residence-timeout 排第 3：驻留超时**阻塞推进**（用户必须动作），
  // 优先级高于"保证强度下降"与"数据完整度"这两类纯告知。
  'residence-timeout': 3,
  'assurance-reduced': 4,
  'report-incomplete': 5,
})

/** degradations[].kind → 对应 notice code（1:1 投影，§2.1） */
export const DEGRADATION_NOTICE = Object.freeze({
  'capability-unavailable': 'capability-degraded',
  'check-skipped': 'assurance-reduced',
})

/** 校验 degradations[] 是否落在受控词表内。越界即抛（契约违规，不是运行时意外）。 */
export function assertDegradations(list) {
  if (!Array.isArray(list)) throw new Error('degradations must be an array')
  for (const d of list) {
    if (!d || typeof d !== 'object') throw new Error('degradation entry must be an object')
    if (!(d.kind in DEGRADATION_NOTICE)) throw new Error(`degradation.kind out of vocab: ${d.kind}`)
    const check = (field, table) => {
      if (!(table || []).includes(d[field])) throw new Error(`degradation.${field} out of vocab: ${d[field]}`)
    }
    if (d.kind === 'capability-unavailable') {
      check('capability', VOCAB.capability)
      check('reason', VOCAB.reason)
    } else {
      check('check', VOCAB.check)
      check('reason', VOCAB.reason)
    }
    if (!Array.isArray(d.effects) || d.effects.length === 0) throw new Error('degradation.effects must be non-empty')
    for (const e of d.effects) {
      if (!VOCAB.effects.includes(e)) throw new Error(`degradation.effects out of vocab: ${e}`)
    }
  }
  return list
}

/**
 * 把 degradations[] 投影成 notices[] 条目（1:1，§2.1 强制）。
 * 不存在"机器可见但用户不可见"的降级。
 */
export function degradationsToNotices(degradations) {
  return degradations.map((d) => ({
    code: DEGRADATION_NOTICE[d.kind],
    text: degradationText(d),
  }))
}

function degradationText(d) {
  if (d.kind === 'check-skipped') {
    return (
      `本轮未执行${d.check === 'desensitize-recheck' ? '脱敏纵深复查' : d.check}（依赖不可用）：` +
      `结果保证强度下降，但硬闸门未受影响、未触发 REFUSE。恢复方式：修复脱敏规则库后重跑。`
    )
  }
  if (d.capability === 'cross-round-evidence-diff') {
    return (
      '本环境未启用持久化，跨轮证据对比不可用：本次诊断按单轮处理（round=1），' +
      '定向重采集已退化为按未确认根因的常规补采。启用持久化（形态 A）可恢复跨轮闭环。'
    )
  }
  if (d.capability === 'performance-baseline-diff') {
    return (
      '本次未提供可用基线，性能对比不可用：已降级为**定性诊断**（输出"当前为什么慢"的根因候选，' +
      '不下"相对基线劣化了多少"的结论，也不会给出劣化幅度）。' +
      '恢复方式：在调用里提供 baseline（JSON 或 CSV 的结构化数值基线）后重跑，即可恢复定量对比与劣化幅度输出。'
    )
  }
  return `能力降级：${d.capability}（${d.reason}）`
}

/** 按固定优先级 + 同类字典序排序（渲染顺序 = 数组顺序）。 */
export function sortNotices(notices) {
  return [...notices].sort((a, b) => {
    const pa = NOTICE_PRIORITY[a.code] ?? 99
    const pb = NOTICE_PRIORITY[b.code] ?? 99
    if (pa !== pb) return pa - pb
    return String(a.code).localeCompare(String(b.code))
  })
}

/** 正常返回（可携带 degradations / notices / 不完整标记）。 */
export function ok(data, versions, extras = {}) {
  const degradations = extras.degradations || []
  assertDegradations(degradations)
  const projected = degradationsToNotices(degradations)
  const notices = sortNotices([...(extras.notices || []), ...projected])
  const out = { ok: true, code: 'OK', data: { ...data } }
  if (degradations.length > 0) out.data.degradations = degradations
  if (notices.length > 0) out.data.notices = notices
  out.versions = versions
  return out
}

/** 错误返回。 */
export function fail(code, body, versions) {
  if (!ALL_ERR_CODES.includes(code)) throw new Error(`unknown ErrCode: ${code}`)
  return { ok: false, code, error: { message: body.message || code, ...body }, versions }
}

/** ToolError → 信封（未能识别的异常一律 ERR_INTERNAL 兜底）。 */
export function toEnvelope(err, versions) {
  if (err instanceof ToolError) return fail(err.code, err.body, versions)
  return fail(
    ErrCode.INTERNAL,
    {
      message: '内部错误（必须可诊断）',
      detail: String(err && err.message ? err.message : err).slice(0, 300),
      recoverable: false,
      hint: '这是插件内部异常，请连同 detail 一起上报；不影响已产出的历史结论。',
    },
    versions,
  )
}

/** 四元组版本绑定（§1.11）。 */
export function makeVersions({ plugin, schema, rules, assets }) {
  return { plugin, schema, rules, assets }
}
