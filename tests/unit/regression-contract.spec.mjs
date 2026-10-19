/**
 * regression-contract.spec —— P10 专项（B 范式：性能劣化诊断）。
 *
 * 覆盖用户 2026-09-28 裁决的每一条设计要点：
 *   ① 基线 = 结构化数值（JSON / CSV），**每次输入、不落盘、无侧车、无缓存**
 *   ② 三分支：未提供 → **能力降级**（定性诊断，不是 REFUSE）；提供了但非法 → ERR_BASELINE_MALFORMED（REFUSE）；成功 → 定量
 *   ③ 定量对比进 rootCauses[].methodology.comparison（嵌套）；未达阈值进 closure.excludedHypotheses；不可测进 closure.unmeasuredMetrics
 *   ④ 返回信封与 diagnose_service **完全同构**（顶层字段不多不少）
 *   ⑤ 契约不变量：证据非空 + fix 三态 + 置信度↔修复单向
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'
import { ErrCode, ALL_ERR_CODES } from '../../src/protocol/envelope.js'
import { normalizeByDomain } from '../../src/primitives/regression-rules.js'

export const NAME = 'regression-contract（B 基线 JSON/CSV · 定量/降级/拒绝三分支 · 信封同构）'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const SEC = (n, b) => `=== ${n} ===\n--- cmd: probe-${n}\n${b}\n=== end:${n} ===`
const DIMS = { framework: 'vllm', runtime: 'docker', hardware: 'ascend-arm' }
const SENTINEL = 987654321 // 基线里唯一的数字：用来证明"基线没有被写到磁盘上"

const REPORT = [
  SEC('perf-snapshot', [
    'DSH-SIGNAL perf.model=deepseek',
    `DSH-SIGNAL perf.ttft_ms=420`,
    `DSH-SIGNAL perf.e2e_ms=3600`,
    `DSH-SIGNAL perf.num_preemptions=120`,
  ].join('\n')),
  SEC('metrics-full', 'vllm:num_preemptions_total 120\nRunning: 32\nWaiting: 40'),
  SEC('vllm-serving-args', '--max-num-seqs=32\n--enable-prefix-caching'),
].join('\n')

const BASELINE_TEXT = JSON.stringify({
  ttft_ms: 120,
  e2e_ms: 1200,
  num_preemptions: 10,
  kv_cache_usage_perc: SENTINEL, // 报告里没有这个指标 → 会进 unmeasuredMetrics
})
const BASELINE_CSV = `metric,value,unit\nttft_ms,120,ms\ne2e_ms,1200,ms\nnum_preemptions,10,`

function scanFor(root, needle) {
  const hits = []
  const walk = (dir) => {
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p)
      else {
        try { if (readFileSync(p, 'utf8').includes(needle)) hits.push(p) } catch { /* 二进制跳过 */ }
      }
    }
  }
  walk(root)
  return hits
}

function attempt(fn) {
  try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e.code, body: e.body } }
}

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-reg-'))
  const storage = join(tmp, 'sessions')
  const core = createCore({ pkgRoot: PKG_ROOT, storageDir: storage, persist: true })
  const coreB1 = createCore({ pkgRoot: PKG_ROOT, storageDir: join(tmp, 's-b1'), persist: false })
  const coreB2 = createCore({ pkgRoot: PKG_ROOT, storageDir: null, persist: false, inProcessStore: false })
  void coreB1

  // ═══ ① 基线读取：JSON 对象 / JSON 文本 / CSV ═══
  const q1 = core.diagnoseRegression({ report: REPORT, baseline: JSON.parse(BASELINE_TEXT), baselineType: 'performance', sessionId: 'r1' })
  t.assert(q1.ok === true, 'JSON 对象基线 → 正常返回')
  t.assert(q1.data.closure.baseline.status === 'used' && q1.data.closure.baseline.source === 'object', 'baseline.status=used / source=object')
  const q2 = core.diagnoseRegression({ report: REPORT, baseline: BASELINE_TEXT, baselineType: 'performance', sessionId: 'r2' })
  t.assert(q2.data.closure.baseline.source === 'json', 'JSON 文本基线被识别（source=json）')
  const q3 = core.diagnoseRegression({ report: REPORT, baseline: BASELINE_CSV, baselineType: 'performance', sessionId: 'r3' })
  t.assert(q3.ok === true && q3.data.closure.baseline.source === 'csv', 'CSV 基线被识别（source=csv）')
  t.assert(q3.data.closure.baseline.metricCount === 3, `CSV 解析出 3 个指标（实际 ${q3.data.closure.baseline.metricCount}）`)

  // ═══ ② 定量对比：越阈 → 候选，且带基线/当前/比值 ═══
  const fired = q1.data.rootCauses
  t.assert(fired.length >= 2, `越阈指标产出 ≥2 条候选（实际 ${fired.length}）`)
  const c1 = fired.find((rc) => rc.methodology && rc.methodology.comparison && rc.methodology.comparison.metric === 'ttft_ms')
  t.assert(!!c1, 'ttft_ms 越阈 → 候选')
  t.assert(c1.methodology.comparison.baseline === 120 && c1.methodology.comparison.current === 420, 'comparison 记录基线值 120 与当前值 420')
  t.assert(c1.methodology.comparison.ratio === 3.5, `comparison.ratio = 3.5（实际 ${c1.methodology.comparison.ratio}）`)
  t.assert(c1.methodology.comparison.severity === 'critical', 'severity=critical（超过 criticalRatio）')
  t.assert(c1.methodology.computed && c1.methodology.computed.holds === true, '可算判据 holds=true（阈值成立）')
  t.assert(c1.evidence.length >= 1 && c1.evidence[0].snippet.includes('perf.ttft_ms'), '证据指向报告里真实的那一行')
  // 因果闭环门槛：有 =true 的闭环信号才可能"已证明"，否则最高"未发现反例"
  t.assert(c1.confidence !== '已证明', '缺因果闭环证据 → 不得称"已证明"（§6.2 能力④）')
  t.assert(c1.methodology.causal && c1.methodology.causal.requireForProven === true && c1.methodology.causal.closureSatisfied === false, 'causal 门槛被声明且未满足')

  // ═══ ③ 未达阈值 → 排除台账（可追溯）；不可测 → unmeasuredMetrics ═══
  const noperf = core.diagnoseRegression({
    report: REPORT,
    baseline: JSON.stringify({ ttft_ms: 410, e2e_ms: 1200, kv_cache_usage_perc: 40 }),
    baselineType: 'performance',
    sessionId: 'r4',
  })
  const within = (noperf.data.closure.excludedHypotheses || []).filter((x) => x.excludedBy && x.excludedBy.some((e) => e.kind === 'regression-within-threshold'))
  t.assert(within.length >= 1, `未达阈值 → 进排除台账（实际 ${within.length} 条）`)
  t.assert(within.every((x) => x.computed && x.computed.holds === false), '排除条目带可算判据（holds=false，可撤回）')
  const unmeasured = noperf.data.closure.unmeasuredMetrics || []
  t.assert(unmeasured.some((u) => u.metric === 'num_preemptions' && u.reason === 'metric-absent-in-baseline'), '基线里没有 num_preemptions → unmeasuredMetrics 记录 metric-absent-in-baseline')
  t.assert(unmeasured.some((u) => u.reason === 'metric-not-in-report'), '报告里没有该指标 → 记录 metric-not-in-report')

  // ═══ ④ 基线**未提供** → 能力降级（不是 REFUSE）═══
  const deg = core.diagnoseRegression({ report: REPORT, baselineType: 'performance', sessionId: 'r5' })
  t.assert(deg.ok === true, '未提供基线 → 仍然正常返回（不 REFUSE）')
  const d0 = deg.data.degradations || []
  t.assert(d0.length === 1 && d0[0].kind === 'capability-unavailable', '产出恰一条 capability-unavailable 降级')
  t.assert(d0[0].capability === 'performance-baseline-diff' && d0[0].reason === 'baseline-unavailable', 'capability=performance-baseline-diff / reason=baseline-unavailable')
  t.assert(JSON.stringify(d0[0].effects) === JSON.stringify(['qualitative-mode']), 'effects=[qualitative-mode]')
  const notice = (deg.data.notices || []).find((n) => n.code === 'capability-degraded')
  t.assert(!!notice && /定性诊断/.test(notice.text), 'D3：用户可见层声明"已降级为定性诊断"')
  t.assert(/baseline/.test(notice.text) && /重跑/.test(notice.text), 'D3：给出恢复路径（提供 baseline 后重跑）')
  t.assert(deg.data.closure.baseline.status === 'unavailable' && deg.data.closure.baseline.path === 'qualitative', 'closure.baseline 如实标注 unavailable/qualitative')
  t.assert(deg.data.rootCauses.length >= 1, '降级路径仍产出定性结论（"当前为什么慢"）')
  t.assert(deg.data.rootCauses.every((rc) => !(rc.methodology && rc.methodology.comparison)), '降级路径**不产出**劣化幅度（无 comparison）')

  // ═══ ④b 定性规则的**阈值判据真的可算**（缺陷 #53 回归：匹配任意数值 ≠ 判据成立）═══
  {
    const runQual = (metrics) => core.diagnoseRegression({
      report: SEC('metrics-full', metrics), baselineType: 'performance', dimensions: DIMS, sessionId: 'qual',
    }).data
    const pick = (d) => {
      const all = [...d.rootCauses, ...(d.closure.weakSignals || [])]
      return {
        q3: all.find((x) => /rg-qual-003$/.test(x.id)),
        q4: all.find((x) => /rg-qual-004$/.test(x.id)),
        ex3: (d.closure.excludedHypotheses || []).find((x) => /rg-qual-003$/.test(x.id)),
      }
    }
    // ① 健康区间（42%）：数值在场但**达不到** 90% → 判据不成立 ⇒ 进排除台账（不是弱信号）
    const low = pick(runQual('vllm:gpu_cache_usage_perc{model_name="q"} 0.42'))
    t.assert(!low.q3, '#53 占用率 42% 不得作为候选（旧形态会误报弱信号）')
    t.assert(!!low.ex3 && low.ex3.excludedBy.some((x) => x.kind === 'compute-falsified'),
      '#53 42% → compute-falsified 进 closure.excludedHypotheses（可追溯，不是静默丢弃）')
    t.assert(low.ex3.computed && low.ex3.computed.value === 42, `#53 排除台账携带归一化数值（实际 ${low.ex3 && low.ex3.computed && low.ex3.computed.value}）`)
    // ② 打满（97%，0–1 分数形态）→ 归一化 ×100 → 主列表，judgement=quantitative
    const high = pick(runQual('vllm:gpu_cache_usage_perc{model_name="q"} 0.97'))
    t.assert(!!high.q3 && high.q3.judgement === 'quantitative' && high.q3.methodology.computed.value === 97,
      '#53 占用率 0.97 → 归一化 97 → 主列表（quantitative）')
    t.assert(high.q3.methodology.computed.holds === true && /90/.test(high.q3.methodology.computed.assert || ''),
      '#53 可算判据断言可见（assert 含 90，holds=true）')
    // ③ 百分数形态（96%）也要能归一化并命中
    const pct = pick(runQual('KV cache usage: 96%'))
    t.assert(!!pct.q3 && pct.q3.methodology.computed.value === 96, '#53 百分数形态（96%）归一化正确')
    // ④ 只有指标名、没有值 → 不构成判据（旧形态 `[0-9.]+` 也不该命中，此处锁死）
    const bare = pick(runQual('vllm:gpu_cache_usage_perc\nvllm:prefix_cache_hit_rate'))
    t.assert(!bare.q3 && !bare.q4, '#53 指标族清单（只有名字无值）不得产出候选')
    // ⑤ 启动配置里的巧合数字（96/128）不得被当成占用率
    const coincidence = pick(runQual('kv_cache_dtype=auto, block_size=128, cudagraph_capture_sizes=[1, 96, 104]'))
    t.assert(!coincidence.q3, '#53 启动配置里的巧合数字（96/128）不得命中 KV 占用率规则')
    // ⑥ rg-qual-004 只判"命中率为 0"：0.42 不命中、0.0 命中
    t.assert(!pick(runQual('vllm:prefix_cache_hit_rate{model_name="q"} 0.42')).q4, '#53 命中率 0.42 → rg-qual-004 不命中（不再匹配任意数值）')
    t.assert(!!pick(runQual('vllm:prefix_cache_hit_rate{model_name="q"} 0.0')).q4, '#53 命中率 0.0 → rg-qual-004 命中（下界事实）')
    // ⑦ 缺陷 #54 回归：escape 修复后，旧的"死分支"规则必须真的能被触发
    const preempt = pick(runQual('DSH-SIGNAL perf.num_waiting=9'))
    t.assert(!preempt.q3 && true, '#54 定性簇在 escape 修复后仍不误报无关规则')
    const waiting = core.diagnoseRegression({
      report: SEC('metrics-full', 'DSH-SIGNAL perf.num_waiting=9'), baselineType: 'performance', dimensions: DIMS, sessionId: 'qual2',
    }).data
    const rg2 = [...waiting.rootCauses, ...(waiting.closure.weakSignals || [])].find((x) => /rg-qual-002$/.test(x.id))
    t.assert(!!rg2, '#54 rg-qual-002 的 `DSH-SIGNAL perf.num_waiting=` 分支在 escape 修复后**真的能命中**（修复前三条分支全死）')
  }

  // ═══ ④c C14：0–1 值域规则的比值必须先归一化（否则差 100 倍，得出错误结论）═══
  {
    const cmpOf = (baselineObj, metricsLine) => {
      const d = core.diagnoseRegression({
        report: SEC('metrics-full', metricsLine),
        baselineType: 'performance',
        baseline: JSON.stringify(baselineObj),
        dimensions: DIMS, sessionId: 'c14',
      }).data
      const all = [...d.rootCauses, ...(d.closure.weakSignals || []), ...(d.closure.excludedHypotheses || [])]
      // 越阈候选把 comparison 放在 methodology 下；未达阈值的排除项放在条目顶层
      const hit = all.map((x) => (x.methodology && x.methodology.comparison) || x.comparison).find(Boolean)
      return hit || null
    }

    // ① 基线百分数 × 报告分数：旧实现给 0.0084，正确是 0.84
    const mixed = cmpOf({ kv_cache_usage_perc: 50 }, 'vllm:gpu_cache_usage_perc{model_name="q"} 0.42')
    t.assert(!!mixed, 'C14 产出 comparison')
    t.assert(mixed && mixed.ratio === 0.84,
      `C14 基线 50（百分数）vs 当前 0.42（分数）→ 比值 **0.84**（实际 ${mixed && mixed.ratio}；旧实现为 0.0084）`)
    t.assert(mixed && mixed.baseline === 0.5 && mixed.current === 0.42,
      `C14 comparison 给出归一化后的数值（实际 ${mixed && mixed.baseline}/${mixed && mixed.current}）`)
    t.assert(mixed && mixed.rawBaseline === 50, `C14 归一化发生时保留原始基线（实际 ${mixed && mixed.rawBaseline}）`)
    t.assert(mixed && mixed.valueDomain === 'fraction', 'C14 comparison 标注值域')
    t.assert(mixed && mixed.severity === 'normal', 'C14 0.84 < 告警阈值 1.2 → 档位 normal')

    // ② 同量纲输入：不得改动，且不出现原始值字段（旧行为逐字节不变）
    const same = cmpOf({ kv_cache_usage_perc: 0.5 }, 'vllm:gpu_cache_usage_perc{model_name="q"} 0.42')
    t.assert(same && same.ratio === 0.84 && same.baseline === 0.5, 'C14 同量纲输入结果不变')
    t.assert(same && same.rawBaseline === undefined, 'C14 未发生归一化时不引入 rawBaseline（形状不变）')

    // ③ lower-worse 方向（prefix_cache_hit_rate）：基线 60% × 当前 0.30 → 比值 2
    const lower = cmpOf({ prefix_cache_hit_rate: 60 }, 'DSH-SIGNAL perf.prefix_cache_hit_rate=0.3000')
    t.assert(lower && lower.ratio === Number((0.6 / 0.3).toFixed(4)),
      `C14 lower-worse 方向同样归一化（基线 0.6 / 当前 0.3 = ${lower && lower.ratio}）`)
    t.assert(lower && lower.rawBaseline === 60, 'C14 lower-worse 也保留原始基线')

    // ④ 无界量（未声明 valueDomain）绝不归一化
    const unbounded = cmpOf({ ttft_ms: 120 }, 'DSH-SIGNAL perf.ttft_ms=420')
    t.assert(unbounded && unbounded.ratio === 3.5 && unbounded.baseline === 120 && unbounded.valueDomain === undefined,
      'C14 无界量（ttft_ms）原样比较，不声明值域、不改数值')

    // ⑤ 归一化纯函数本身
    t.assert(normalizeByDomain(0.42, 'fraction') === 0.42, 'C14 ≤1 保持不变')
    t.assert(normalizeByDomain(1, 'fraction') === 1, 'C14 恰好 1 保持不变')
    t.assert(normalizeByDomain(50, 'fraction') === 0.5, 'C14 >1 除以 100')
    t.assert(normalizeByDomain(120, null) === 120, 'C14 未声明值域时原样返回')
    t.assert(Number.isNaN(normalizeByDomain(Number.NaN, 'fraction')), 'C14 非有限值原样透传（NaN）')
  }

  // ═══ ⑤ 基线**提供了但非法** → ERR_BASELINE_MALFORMED（REFUSE）═══
  t.assert(ALL_ERR_CODES.includes('ERR_BASELINE_MALFORMED'), 'ERR_BASELINE_MALFORMED 已进入错误码闭集')
  t.assert(ErrCode.BASELINE_MALFORMED === 'ERR_BASELINE_MALFORMED', 'ErrCode 常量与闭集一致')
  for (const [bad, label] of [['{not json', 'JSON 语法错'], ['{"a": "x"}', '无任何数值型指标'], ['metric\n1,2', 'CSV 缺表头列'], ['[1,2,3]', '顶层是数组']]) {
    const r = attempt(() => core.diagnoseRegression({ report: REPORT, baseline: bad, baselineType: 'performance' }))
    t.assert(!r.ok && r.code === 'ERR_BASELINE_MALFORMED', `${label} → ERR_BASELINE_MALFORMED（实际 ${r.code}）`)
    t.assert(r.body && r.body.policy === 'REFUSE', `${label} → policy=REFUSE`)
  }
  const inconsistent = attempt(() => core.diagnoseRegression({ report: REPORT, baseline: '', baselineType: 'performance' }))
  t.assert(inconsistent.ok === true, '空串基线 = "未提供"（走降级），不得误报为非法')

  // ═══ ⑥ 规则自带样例：每条阈值规则的 pattern 必须能从规范证据样例里抽出数字 ═══
  // 2026-09-28 实测缺陷：`DSH-SIGNAL \s+` 里多写一个字面空格，会让"信号形态"这一支**永远匹配不上**
  // （`\s+` 要求的空白已被那个空格吃掉），而另一支恰好又能从别的行勉强匹配 → 缺陷静默存活。
  // 故把"规则必须自带样例、且 pattern 必须匹配它"设成机器校验。
  {
    const { parse } = await import('../../src/primitives/yaml-lite.js')
    const { readFileSync } = await import('node:fs')
    for (const rel of ['performance-rules.yaml', 'accuracy-rules.yaml']) {
      const doc = parse(readFileSync(join(PKG_ROOT, 'assets', 'root-causes', 'regression', rel), 'utf8'))
      t.assert(doc.rules.length >= 4, `${rel} 规则数 ≥4（实际 ${doc.rules.length}）`)
      for (const r of doc.rules) {
        t.assert(typeof r.signalExample === 'string' && r.signalExample.length > 0, `${r.id} 声明了 signalExample`)
        const m = String(r.signalExample).match(new RegExp(r.pattern, 'i'))
        t.assert(!!m && m[1] !== undefined, `${r.id} 的 pattern 能从 signalExample 抽出数字（样例：${r.signalExample}）`)
        t.assert(Number.isFinite(Number(m && m[1])), `${r.id} 抽出的值可解析为数字`)
      }
    }
  }

  // ═══ ⑦ 参数校验与规则分区 ═══
  const noReport = attempt(() => core.diagnoseRegression({ baseline: BASELINE_TEXT, baselineType: 'performance' }))
  t.assert(!noReport.ok && noReport.code === 'ERR_MISSING_PARAM', '缺 report → ERR_MISSING_PARAM')
  const noType = attempt(() => core.diagnoseRegression({ report: REPORT, baseline: BASELINE_TEXT }))
  t.assert(!noType.ok && noType.code === 'ERR_MISSING_PARAM', '缺 baselineType → ERR_MISSING_PARAM')
  const badType = attempt(() => core.diagnoseRegression({ report: REPORT, baseline: BASELINE_TEXT, baselineType: 'throughput' }))
  t.assert(!badType.ok && badType.code === 'ERR_MISSING_PARAM', '非法 baselineType → ERR_MISSING_PARAM（受控枚举）')
  const acc = attempt(() => core.diagnoseRegression({ report: REPORT, baseline: JSON.stringify({ accuracy: 0.9 }), baselineType: 'accuracy' }))
  t.assert(acc.ok === true, 'accuracy 分区可用（独立规则文件）')
  t.assert(String(acc.value.data.summary).includes('accuracy'), 'accuracy 路径的 summary 标注基线类型')

  // ═══ ⑦ 返回信封与 diagnose_service 同构（顶层字段不多不少）═══
  const p = core.parseCollectReport({ report: REPORT })
  const svc = core.diagnoseService({ evidence: p.data.evidence, dimensions: { framework: 'vllm', runtime: 'docker', hardware: 'ascend-arm' }, context: { round: 1, sessionId: 'r6' } })
  const keysOf = (r) => Object.keys(r.data).filter((k) => k !== 'requestedRound').sort()
  t.assert(JSON.stringify(keysOf(q1)) === JSON.stringify(keysOf(svc)), `顶层字段与 diagnose_service 同构（${keysOf(q1).join(',')}）`)
  t.assert(q1.code === 'OK' && q1.versions && q1.versions.assets, '信封含 code/versions（四元组齐备）')

  // ═══ ⑧ 契约不变量 ═══
  for (const rc of [...q1.data.rootCauses, ...deg.data.rootCauses]) {
    t.assert(rc.evidence.length >= 1 && rc.evidence.every((e) => e.sourceFile && Number.isFinite(e.line) && e.snippet), `${rc.id} 证据非空且可溯源`)
    if (rc.confidence === '未确认') t.assert(rc.fix === null && !!rc.additionalCollection, `${rc.id} 未确认 → fix=null + 补采`)
    else t.assert(!!rc.fix && ['complete', 'partial'].includes(rc.fix.state), `${rc.id} 非未确认 → fix 完整或部分`)
  }

  // ═══ ⑨ 无状态：基线不落盘 / 无侧车 ═══
  t.assert(scanFor(tmp, String(SENTINEL)).length === 0, '基线里的哨兵数字未出现在磁盘任何文件中（不落盘）')
  t.assert(!readdirSync(storage).some((f) => /baseline/i.test(f)), '存储目录没有基线侧车文件')
  writeFileSync(join(tmp, 'placeholder.txt'), 'x')

  // ═══ ⑩ 多轮语义与 A 同源（B2 无存储 → 降级为单轮；A 形态缺 priorRound → 报缺参数）═══
  const b2r2 = coreB2.diagnoseRegression({ report: REPORT, baseline: BASELINE_TEXT, baselineType: 'performance', sessionId: 'b2', context: { round: 2 } })
  t.assert(b2r2.data.effectiveRound === 1 && b2r2.data.requestedRound === 2, 'B2 形态 round=2 → effectiveRound 降为 1 并回显 requestedRound')
  t.assert(
    b2r2.data.degradations.some((d) => d.capability === 'cross-round-evidence-diff' && d.reason === 'no-persistent-store'),
    'B2 降级声明复用既有 capability/reason 词表（与 A 同源）',
  )
  const aR2 = attempt(() => core.diagnoseRegression({ report: REPORT, baseline: BASELINE_TEXT, baselineType: 'performance', sessionId: 'a1', context: { round: 2 } }))
  t.assert(!aR2.ok && aR2.code === 'ERR_MISSING_PARAM', 'A 形态 round=2 缺 priorRound → ERR_MISSING_PARAM（与 A 同一实现）')

  rmSync(tmp, { recursive: true, force: true })
}
