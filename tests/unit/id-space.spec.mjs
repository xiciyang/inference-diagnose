/**
 * id-space.spec —— 对外根因 id 空间统一（缺陷 C8 的回归门禁）。
 *
 * 背景：规则文件里的 id 有 `rc-` 与 `rg-` 两族（`rg-*` 是 B 范式的阈值/定性规则），
 * 但**对外 id 空间统一带 `rc-` 前缀**。修复前只有 `rootCauses[]` / `weakSignals[]` 走归一化，
 * `closure.excludedHypotheses[].id` 与 `closure.unmeasuredMetrics[].ruleId` 直接吐原始 id
 * ⇒ 同一条规则在主列表叫 `rc-rg-qual-003`、在排除台账叫 `rg-qual-003`，
 * 调用方跨层按 id 关联必须自己再归一化一遍。
 *
 * 本 spec 锁死四件事：
 *   ① 四个对外出口的 id **全部**带 `rc-` 前缀（同一 id 空间）；
 *   ② 同一条规则在不同层出现时，id 字符串**完全相等**（跨层直接可比）；
 *   ③ `publicRuleId` 幂等（已带前缀者不得被二次加前缀）；
 *   ④ 三个工具都遵守（A / B / C 各走一遍真实调用）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore, publicRuleId } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'vllm', runtime: 'docker', hardware: 'ascend-arm' }
const SEC = (n, b) => `=== ${n} ===\n--- cmd: probe-${n}\n${b}\n=== end:${n} ===`
const EV = (...ss) => ss.map((s, i) => ({
  id: `ev-${String(i + 1).padStart(3, '0')}`,
  section: 'vllm-log', sourceFile: 'vllm-log', line: i + 1, snippet: s, hash: `sha256:h${i}`,
}))

export const NAME = 'id-space（对外 id 统一 rc- 前缀 / 跨层直接可比 / 三工具一致）'

/** 收集一个结果信封里所有对外 id（含嵌套结构） */
function allPublicIds(data) {
  const out = []
  const push = (v, where) => { if (typeof v === 'string' && v) out.push({ id: v, where }) }
  for (const rc of data.rootCauses || []) push(rc.id, 'rootCauses[].id')
  for (const rc of (data.closure && data.closure.weakSignals) || []) push(rc.id, 'weakSignals[].id')
  for (const ex of (data.closure && data.closure.excludedHypotheses) || []) push(ex.id, 'excludedHypotheses[].id')
  for (const u of (data.closure && data.closure.unmeasuredMetrics) || []) push(u.ruleId, 'unmeasuredMetrics[].ruleId')
  return out
}

export async function run(t) {
  const core = createCore({ pkgRoot: PKG_ROOT, persist: false, inProcessStore: true })

  // ── ③ publicRuleId 幂等且是唯一归一化点 ──
  t.assert(publicRuleId('rg-qual-003') === 'rc-rg-qual-003', 'publicRuleId: rg-qual-003 → rc-rg-qual-003')
  t.assert(publicRuleId('rc-rg-qual-003') === 'rc-rg-qual-003', 'publicRuleId 幂等（已带前缀不加二次前缀）')
  t.assert(publicRuleId('rc-docker-001') === 'rc-docker-001', 'publicRuleId 对 rc- 原样返回')
  t.assert(typeof publicRuleId === 'function' && publicRuleId.length === 1, 'publicRuleId 是导出的单一实现')

  // ── ④-A 形态：一条被可算判据否证的规则进排除台账（rc-idx-001）──
  const a = core.diagnoseService({
    evidence: EV('kScaleBlkStride = 73856', 'blockId max=29076'),
    dimensions: DIMS,
    context: { round: 1, sessionId: 'ids-a' },
  }).data
  const aEx = (a.closure.excludedHypotheses || [])
  t.assert(aEx.some((x) => x.id === 'rc-idx-001'),
    `A：被否证的假设在台账里用**归一化后**的 id（实际 ${aEx.map((x) => x.id).join(',') || 'none'}）`)

  // ── ④-B 形态：同一条 rg-* 规则，进主列表与进台账时 id 必须完全相等 ──
  const bHigh = core.diagnoseRegression({
    report: SEC('metrics-full', 'vllm:gpu_cache_usage_perc{model_name="q"} 0.97'),
    baselineType: 'performance', dimensions: DIMS, sessionId: 'ids-b1',
  }).data
  const bLow = core.diagnoseRegression({
    report: SEC('metrics-full', 'vllm:gpu_cache_usage_perc{model_name="q"} 0.42'),
    baselineType: 'performance', dimensions: DIMS, sessionId: 'ids-b2',
  }).data
  const inMain = (bHigh.rootCauses || []).find((x) => /rg-qual-003$/.test(x.id))
  const inLedger = (bLow.closure.excludedHypotheses || []).find((x) => /rg-qual-003$/.test(x.id))
  t.assert(!!inMain, 'B：0.97 时 rg-qual-003 进主列表')
  t.assert(!!inLedger, 'B：0.42 时 rg-qual-003 进排除台账')
  t.assert(inMain.id === inLedger.id,
    `C8 跨层 id 直接可比：主列表 id === 台账 id（${inMain.id} vs ${inLedger.id}）`)
  t.assert(inLedger.id === 'rc-rg-qual-003', `C8 台账 id 带 rc- 前缀（实际 ${inLedger.id}）`)

  // ── ④-C 形态：一致性工具的台账同样归一化 ──
  const c = core.diagnoseConsistency({
    report: SEC('quality-sweep', 'DSH-SIGNAL quality.sample.1=core_hash:aaa {"c":"x","c_len":1,"r_len":0,"finish":"stop"}\nDSH-SIGNAL quality.sample.2=core_hash:bbb {"c":"y","c_len":1,"r_len":0,"finish":"stop"}'),
    dimensions: DIMS, sessionId: 'ids-c',
  }).data

  // ── ① 四出口全部同空间；无裸 rg-/其它前缀泄漏 ──
  for (const [label, data] of [['A', a], ['B(0.97)', bHigh], ['B(0.42)', bLow], ['C', c]]) {
    const ids = allPublicIds(data)
    t.assert(ids.length > 0, `${label}：产出里至少有一个对外 id（${ids.length}）`)
    const bad = ids.filter((x) => !String(x.id).startsWith('rc-'))
    t.assert(bad.length === 0,
      `${label}：所有对外 id 都以 rc- 开头（违规：${bad.map((x) => `${x.where}=${x.id}`).join(', ') || 'none'}）`)
  }

  // ── ② 跨层重名一致性：同一规则 id 在任意两层出现时必须逐字相等 ──
  {
    const ids = allPublicIds(bLow).concat(allPublicIds(bHigh))
    const byRule = new Map()
    for (const x of ids) {
      const key = x.id.replace(/^rc-/, '')
      if (!byRule.has(key)) byRule.set(key, new Set())
      byRule.get(key).add(x.id)
    }
    const conflicts = [...byRule.entries()].filter(([, s]) => s.size > 1)
    t.assert(conflicts.length === 0,
      `C8 同一规则在各层 id 逐字一致（冲突：${conflicts.map(([k, s]) => `${k}→${[...s].join('/')}`).join(', ') || 'none'}）`)
  }

  // ── ①' unmeasuredMetrics 也必须在同一空间（B 形态：基线里有、报告里没有的指标）──
  {
    const base = JSON.stringify({ ttft_ms: 120, num_preemptions: 10, kv_cache_usage_perc: 88 })
    const r = core.diagnoseRegression({
      report: SEC('perf-snapshot', 'DSH-SIGNAL perf.ttft_ms=420'),
      baselineType: 'performance', baseline: base, dimensions: DIMS, sessionId: 'ids-b3',
    }).data
    const um = (r.closure.unmeasuredMetrics || [])
    t.assert(um.length > 0, `B：不可测指标进 closure.unmeasuredMetrics（${um.length} 条）`)
    const bad = um.filter((u) => !String(u.ruleId).startsWith('rc-'))
    t.assert(bad.length === 0,
      `C8 unmeasuredMetrics[].ruleId 同处 rc- 空间（违规：${bad.map((u) => u.ruleId).join(',') || 'none'}）`)
    t.assert(um.some((u) => u.ruleId === 'rc-rg-perf-003' || u.ruleId === 'rc-rg-perf-004' || /^rc-rg-/.test(u.ruleId)),
      `C8 不可测项的 ruleId 是归一化形态（实际 ${um.map((u) => u.ruleId).join(',')}）`)
  }
}
