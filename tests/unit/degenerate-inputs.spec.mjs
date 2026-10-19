/**
 * degenerate-inputs.spec —— 退化输入夹具常驻回归（2026-09-28，用户追加要求）。
 *
 * 背景：真实端点实测一次跑出 9 个真缺陷，而夹具测试当时全绿。根因是
 * **夹具的输出格式永远是设计者预期的那一种**——不会出现"空串 / 失败 / 探针自己的标签文本 /
 * 格式错"这类退化输入，所以退化路径长期无覆盖。本 spec 把那些输入形态固化成夹具
 * （`tests/fixtures/degenerate/`，见其 README），并在 A/B/C 三范式上逐条断言。
 *
 * 断言分三类：
 *   ① **不得出现**：某类假阳性候选（编造信号、子串命中、命中自身标签）
 *   ② **必须出现**：证据缺口声明（缺证据必须说"不可判定"，不能沉默）
 *   ③ **形态正确**：路径/判定/样本数/错误码（失败不等于确定，空不等于没有）
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'
import { EMPTY_SHA256_PREFIX } from '../../src/primitives/consistency-rules.js'

export const NAME = 'degenerate-inputs（退化输入夹具：失败 / 空串 / 标签文本 / 格式错 常驻）'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIR = join(PKG_ROOT, 'tests', 'fixtures', 'degenerate')
const DIMS = { framework: 'vllm', runtime: 'docker', hardware: 'ascend-arm' }
const fx = (n) => readFileSync(join(DIR, n), 'utf8')

function attempt(fn) {
  try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e.code, body: e.body } }
}

// 每个夹具的三范式判定：返回 { svc, reg, con, ids, conIds }
function runAll(core, report, seq) {
  const parsed = core.parseCollectReport({ report })
  const svc = core.diagnoseService({ evidence: parsed.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: `deg-svc-${seq}` } })
  const reg = core.diagnoseRegression({ report, baselineType: 'performance', sessionId: `deg-reg-${seq}` })
  const con = core.diagnoseConsistency({ report, dimensions: DIMS, sessionId: `deg-con-${seq}` })
  // 输出已分层（docs/judgement-rubric.md §5）：**弱信号也是"产出了"**
  // —— 只读 rootCauses 会让"不得出现"类断言空过，等于没有断言。
  const idsOf = (r) => new Set([
    ...r.data.rootCauses.map((x) => x.id),
    ...((r.data.closure && r.data.closure.weakSignals) || []).map((x) => x.id),
    ...((r.data.closure && r.data.closure.excludedHypotheses) || []).map((x) => x.id),
  ])
  return { parsed, svc, reg, con, svcIds: idsOf(svc), regIds: idsOf(reg), conIds: idsOf(con) }
}

/** 断言：这些 id 在三范式里都**不得出现**。 */
function forbid(t, ids, r, label) {
  for (const id of ids) {
    t.assert(!r.svcIds.has(id), `${label}：A 范式不得产出 ${id}`)
    t.assert(!r.regIds.has(id), `${label}：B 范式不得产出 ${id}`)
    t.assert(!r.conIds.has(id), `${label}：C 范式不得产出 ${id}`)
  }
}
function requireAny(t, ids, r, label) {
  for (const id of ids) {
    t.assert(r.svcIds.has(id) || r.regIds.has(id) || r.conIds.has(id), `${label}：必须产出 ${id}（缺证据必须说"不可判定"）`)
  }
}

// 真实端点实测里出现过的"假阳性规则"全集（任何退化夹具都不得触发它们）
const FABRICATION_RULES = [
  'rc-out-001', 'rc-out-002', 'rc-out-003', 'rc-out-004', 'rc-out-005', 'rc-out-006',
  'rc-rg-qual-001', 'rc-rg-qual-002', 'rc-rg-qual-003', 'rc-rg-qual-004',
  'rc-rg-qual-005', 'rc-rg-qual-006', 'rc-rg-qual-007',
  'rc-cons-001', 'rc-cons-002', 'rc-cons-003', 'rc-cons-004', 'rc-cons-007',
]

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-deg-'))
  const core = createCore({ pkgRoot: PKG_ROOT, storageDir: join(tmp, 's'), persist: false })
  let seq = 0
  const next = () => ++seq

  // ═══ 01 端点全失败 ═══
  {
    const r = runAll(core, fx('01-probe-failure.txt'), next())
    forbid(t, FABRICATION_RULES, r, '01 端点全失败')
    requireAny(t, ['rc-rg-qual-008', 'rc-rg-qual-009'], r, '01 端点全失败')
    requireAny(t, ['rc-cons-005'], r, '01 端点全失败')
    const k = r.con.data.closure.consistency
    t.assert(k.path === 'not-reproducible' && k.verdict === 'insufficient-samples',
      `01：探测失败必须落"不可判定"（实际 ${k.path}/${k.verdict}）`)
    t.assert(k.sampleCount === 0, `01：无有效样本（实际 ${k.sampleCount}）`)
    t.assert(k.reason.includes('不可判定'), '01：理由必须写明"不可判定"')
  }

  // ═══ 02 空串哈希陷阱（旧版探针形态；分析侧必须独立防御）═══
  {
    const r = runAll(core, fx('02-empty-hash-trap.txt'), next())
    forbid(t, ['rc-cons-003', 'rc-cons-007'], r, '02 空串哈希')
    const k = r.con.data.closure.consistency
    t.assert(k.sampleCount === 0, `02：空串哈希不得计入样本（实际 ${k.sampleCount}）`)
    t.assert(k.signals.degenerateSamples >= 3, `02：必须把退化样本单独计数（实际 ${k.signals.degenerateSamples}）`)
    t.assert(k.path === 'not-reproducible', `02：不得由空串哈希得出"确定性"（实际 ${k.path}/${k.verdict}）`)
    t.assert(k.reason.includes('退化样本'), '02：理由必须点明"退化样本已剔除"')
    t.assert(EMPTY_SHA256_PREFIX === 'e3b0c442', '02：空串哈希哨兵常量稳定（e3b0c442…）')
  }

  // ═══ 03 只有探针自身标签文本 ═══
  {
    const r = runAll(core, fx('03-probe-labels.txt'), next())
    forbid(t, FABRICATION_RULES, r, '03 仅标签文本')
    t.assert(r.reg.data.rootCauses.length === 0, `03：B 定性路径不得从标签文本产出候选（实际 ${r.reg.data.rootCauses.length}）`)
    t.assert(r.con.data.rootCauses.length === 0, `03：C 不得从标签文本产出候选（实际 ${r.con.data.rootCauses.length}）`)
  }

  // ═══ 04 子串陷阱 ═══
  {
    const r = runAll(core, fx('04-substring-traps.txt'), next())
    forbid(t, ['rc-rg-qual-005', 'rc-rg-qual-006', 'rc-rg-qual-007', 'rc-out-003', 'rc-out-005', 'rc-out-004'], r, '04 子串陷阱')
    t.assert(r.reg.data.rootCauses.length === 0, `04：B 不得因 speculative_config=None / template / temp0 出候选（实际 ${r.reg.data.rootCauses.length}）`)
  }

  // ═══ 05 数值巧合（指标族清单无值 / 捕获尺寸里的 96）═══
  {
    const r = runAll(core, fx('05-numeric-coincidence.txt'), next())
    forbid(t, ['rc-rg-qual-001', 'rc-rg-qual-003', 'rc-rg-qual-004'], r, '05 数值巧合')
    t.assert(r.reg.data.rootCauses.length === 0, `05：B 不得因"指标名出现"或"96"出候选（实际 ${r.reg.data.rootCauses.length}）`)
  }

  // ═══ 06 指纹不同但带 finish=length（假阳性防线）═══
  {
    const r = runAll(core, fx('06-truncated-samples.txt'), next())
    const k = r.con.data.closure.consistency
    t.assert(k.path === 'reproducible' && k.verdict === 'nondeterministic', '06：指纹不同 → 可复现路径')
    t.assert(!r.con.data.rootCauses.some((x) => x.id === 'rc-cons-007'), '06：截断可解释时 rc-cons-007 不得进候选')
    const ex = (r.con.data.closure.excludedHypotheses || []).find((x) => x.id === 'rc-cons-007')
    t.assert(!!ex && ex.excludedBy[0].kind === 'explained-by-truncation', '06：必须进排除台账（explained-by-truncation）')
    t.assert(r.con.data.rootCauses.some((x) => x.id === 'rc-cons-001'), '06：由 rc-cons-001 指出"先排除截断"')
  }

  // ═══ 07 整份损坏报告 ═══
  {
    const r = attempt(() => core.parseCollectReport({ report: fx('07-corrupt-report.txt') }))
    t.assert(!r.ok && r.code === 'ERR_REPORT_CORRUPT', `07：无段落标记 → ERR_REPORT_CORRUPT（实际 ${r.code}）`)
    t.assert(r.body && r.body.policy === 'REFUSE', '07：损坏报告策略为 REFUSE（整份拒绝）')
    const r2 = attempt(() => core.diagnoseRegression({ report: fx('07-corrupt-report.txt'), baselineType: 'performance' }))
    t.assert(!r2.ok && r2.code === 'ERR_REPORT_CORRUPT', '07：B 范式同样整份拒绝（与 parse 同一实现）')
  }

  // ═══ 08/09/10 基线退化形态 ═══
  {
    const okReport = fx('06-truncated-samples.txt')
    const bad1 = attempt(() => core.diagnoseRegression({ report: okReport, baseline: fx('08-baseline-malformed.json'), baselineType: 'performance' }))
    t.assert(!bad1.ok && bad1.code === 'ERR_BASELINE_MALFORMED', `08：无数值型指标 → ERR_BASELINE_MALFORMED（实际 ${bad1.code}）`)
    t.assert(bad1.body && bad1.body.policy === 'REFUSE', '08：策略为 REFUSE')

    const bad2 = attempt(() => core.diagnoseRegression({ report: okReport, baseline: fx('09-baseline-csv-wrong-columns.csv'), baselineType: 'performance' }))
    t.assert(!bad2.ok && bad2.code === 'ERR_BASELINE_MALFORMED', `09：CSV 缺 metric/value 列 → ERR_BASELINE_MALFORMED（实际 ${bad2.code}）`)

    const empty = attempt(() => core.diagnoseRegression({ report: okReport, baseline: fx('10-baseline-empty.txt'), baselineType: 'performance' }))
    t.assert(empty.ok === true, `10：空基线 = 未提供 → 正常返回（实际 ${empty.ok ? 'ok' : empty.code}）`)
    const dg = (empty.value.data.degradations || [])[0]
    t.assert(dg && dg.capability === 'performance-baseline-diff' && dg.reason === 'baseline-unavailable',
      '10：走能力降级（performance-baseline-diff / baseline-unavailable）')
    t.assert(empty.value.data.closure.baseline.status === 'unavailable', '10：closure.baseline 如实标注 unavailable')
    t.assert((empty.value.data.notices || []).some((n) => n.code === 'capability-degraded'), '10：用户可见层声明降级')
  }

  // ═══ 夹具集合自检：目录里的每个输入文件都必须被本 spec 消费 ═══
  {
    const listed = ['01-probe-failure.txt', '02-empty-hash-trap.txt', '03-probe-labels.txt', '04-substring-traps.txt',
      '05-numeric-coincidence.txt', '06-truncated-samples.txt', '07-corrupt-report.txt',
      '08-baseline-malformed.json', '09-baseline-csv-wrong-columns.csv', '10-baseline-empty.txt']
    const { readdirSync } = await import('node:fs')
    const onDisk = readdirSync(DIR).filter((f) => f !== 'README.md').sort()
    t.assert(JSON.stringify(onDisk) === JSON.stringify([...listed].sort()),
      `夹具目录与期望表一一对应（盘上 ${onDisk.length} 个 / 表里 ${listed.length} 个）`)
    for (const f of listed) t.assert(typeof fx(f) === 'string', `夹具 ${f} 可读`)
  }

  rmSync(tmp, { recursive: true, force: true })
}
