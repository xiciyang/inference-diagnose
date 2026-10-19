/**
 * baseline-loader —— B 范式（性能劣化）的基线读取与归一化（L2；基线数据由调用方传入）。
 *
 * 形态（最小实现，用户 2026-09-28 裁决："结构化数值，JSON/CSV"）：
 *   - object                     已解析的 JSON（{"metrics":{...}} 或扁平 {...}）
 *   - string（JSON 文本）         {"ttft_p50_ms": 120, ...}
 *   - string（CSV 文本）          header + 数据行，表头须含 metric/name/key 与 value 两列
 *
 * 三分支（契约，不可混同）：
 *   ① **未提供**（undefined / null / 空串 / 空对象）→ 返回 null。
 *      调用方据此走 D0–D3 降级（定性诊断），**不是**错误 —— 见 envelope.js 注释与设计文档 §2.1。
 *   ② **提供了但无法解析** → ToolError(ERR_BASELINE_MALFORMED)，**REFUSE**。
 *      与 ERR_REPORT_CORRUPT 同构：用户提供的结构化输入损坏，静默降级会把
 *      "你给的数据是坏的"伪装成"你没给数据"，这正是 D3 要防的误导。
 *   ③ 解析成功 → { metrics, source, metricCount }
 *
 * 无状态：不落盘、不缓存（用户 2026-09-28 裁决"不落盘，每次输入"）。
 */
import { ToolError, ErrCode } from '../protocol/envelope.js'

/** 基线上限：超过即拒绝（防止把一份大文件当基线塞进来）。 */
export const MAX_BASELINE_CHARS = 200_000
const METRIC_KEY_RE = /^(metric|name|key|指标|名称)$/i
const VALUE_KEY_RE = /^(value|val|数值|值)$/i
const UNIT_KEY_RE = /^(unit|单位)$/i

function malformed(reason, extra = {}) {
  return new ToolError(ErrCode.BASELINE_MALFORMED, {
    affected: ['baseline'],
    policy: 'REFUSE',
    recoverable: true,
    hint:
      `基线无法解析：${reason}。` +
      `接受两种形态：① JSON（如 {"ttft_p50_ms": 120, "tpot_ms": 30}，或 {"metrics": {...}}）；` +
      `② CSV（表头须含 metric 与 value 两列，可含 unit）。` +
      `若本次**没有**基线，请不要传 baseline 参数——那会走"降级为定性诊断"的正常路径，而不是这个错误。`,
    ...extra,
  })
}

function isProvided(baseline) {
  if (baseline === undefined || baseline === null) return false
  if (typeof baseline === 'string') return baseline.trim() !== ''
  if (typeof baseline === 'object') return Object.keys(baseline).length > 0
  return true
}

function normalizeEntry(name, raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { name, value: raw, unit: null, at: null }
  if (typeof raw === 'string') {
    const n = Number(raw.trim())
    return Number.isFinite(n) ? { name, value: n, unit: null, at: null } : null
  }
  if (raw && typeof raw === 'object') {
    const v = typeof raw.value === 'number' ? raw.value : Number(raw.value)
    if (!Number.isFinite(v)) return null
    return { name, value: v, unit: raw.unit || null, at: raw.at || raw.time || null }
  }
  return null
}

function fromObject(obj) {
  // 允许 {"metrics": {...}} 与扁平 {...} 两种
  const table = obj && typeof obj.metrics === 'object' && obj.metrics !== null ? obj.metrics : obj
  const metrics = {}
  const ignored = []
  for (const [k, v] of Object.entries(table)) {
    if (k === 'metrics' && typeof v === 'object') continue
    const e = normalizeEntry(k, v)
    if (e) metrics[k] = e
    else ignored.push(k)
  }
  if (Object.keys(metrics).length === 0) {
    throw malformed(
      `没有解析出任何数值型指标${ignored.length ? `（非数值键：${ignored.slice(0, 5).join(', ')}）` : ''}`,
      { ignoredKeys: ignored.slice(0, 20) },
    )
  }
  return { metrics, ignoredKeys: ignored.slice(0, 20) }
}

/** 极简 CSV：支持引号包裹的字段；首行表头。 */
function splitCsvLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function fromCsv(text) {
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (rows.length < 2) throw malformed('CSV 至少需要一行表头与一行数据')
  const header = splitCsvLine(rows[0])
  const nameIdx = header.findIndex((h) => METRIC_KEY_RE.test(h))
  const valIdx = header.findIndex((h) => VALUE_KEY_RE.test(h))
  const unitIdx = header.findIndex((h) => UNIT_KEY_RE.test(h))
  if (nameIdx < 0 || valIdx < 0) {
    throw malformed(`CSV 表头必须含指标列与数值列（当前表头：${header.join(', ')}）`)
  }
  const metrics = {}
  const ignored = []
  for (const row of rows.slice(1)) {
    const cells = splitCsvLine(row)
    const name = cells[nameIdx]
    if (!name) continue
    const e = normalizeEntry(name, cells[valIdx])
    if (e) {
      if (unitIdx >= 0 && cells[unitIdx]) e.unit = cells[unitIdx]
      metrics[name] = e
    } else ignored.push(`${name}=${cells[valIdx]}`)
  }
  if (Object.keys(metrics).length === 0) throw malformed('CSV 没有解析出任何数值型指标', { ignoredRows: ignored.slice(0, 20) })
  return { metrics, ignoredKeys: ignored.slice(0, 20) }
}

/**
 * @param {*} baseline 调用方原样传入的 baseline
 * @returns {null | {metrics: Record<string,{name,value,unit,at}>, source:'json'|'csv'|'object', metricCount:number, ignoredKeys:string[]}}
 */
export function loadBaseline(baseline) {
  if (!isProvided(baseline)) return null

  if (typeof baseline === 'object') {
    const { metrics, ignoredKeys } = fromObject(baseline)
    return { metrics, source: 'object', metricCount: Object.keys(metrics).length, ignoredKeys }
  }

  if (typeof baseline !== 'string') throw malformed(`不支持的基线类型：${typeof baseline}`)

  const text = baseline.trim()
  if (text.length > MAX_BASELINE_CHARS) {
    throw malformed(`基线过大（${text.length} 字符 > 上限 ${MAX_BASELINE_CHARS}）`)
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw malformed(`JSON 解析失败：${String(e.message).slice(0, 120)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw malformed('JSON 顶层必须是对象（数组或标量不是合法的基线）')
    }
    const { metrics, ignoredKeys } = fromObject(parsed)
    return { metrics, source: 'json', metricCount: Object.keys(metrics).length, ignoredKeys }
  }

  const { metrics, ignoredKeys } = fromCsv(text)
  return { metrics, source: 'csv', metricCount: Object.keys(metrics).length, ignoredKeys }
}
