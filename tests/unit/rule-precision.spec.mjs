/**
 * rule-precision.spec —— 假阳性防线（2026-09-28 真实端点实测缺陷回归）。
 *
 * 本 spec 的每一条断言都对应一次**本机真实端点实测**抓到的缺陷（不是构造出来的假想）：
 *   ① 探针在端点失败时**编造信号**：`logits.prefill_repeat_consistent=false`（两端都取不到 logprob）
 *   ② 探针把**空输出的哈希**当样本指纹：8 次失败 → 8 个 `core_hash:e3b0c442`（空串的 sha256）
 *      → 分析侧据此得出「确定性」结论 —— 把"全测失败"伪装成"全部一致"
 *   ③ `when` 正则匹配"提到该词的任何一行"而非"承载判据的那一行"：
 *      `repeat` 命中 `prefill_repeat_consistent`、`loop` 命中 `uvloop`、
 *      `temp` 命中 `template` / `temp0-run1`、`speculative` 命中 `speculative_config=None`、
 *      `kv_cache.*96` 命中启动配置里的捕获尺寸列表
 *   ④ `when` 命中**本插件探针自己的标签文本**（`--- 抢占/KV/队列/调度 ...`）
 *
 * 真源侧修法：探针"不确定就写 n/a"（L1 数据）+ 正则一律要求"带值/带边界"（L1 规则）。
 * 本 spec 把这些修法钉死为回归断言。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'

export const NAME = 'rule-precision（假阳性防线：不编造信号 / 不靠子串命中 / 不命中自身标签）'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'vllm', runtime: 'docker', hardware: 'ascend-arm' }
const SEC = (n, b) => `=== ${n} ===\n--- cmd: probe-${n}\n${b}\n=== end:${n} ===`

// 全部取自本机真实报告里**曾经触发假阳性**的那些行（一字未改其触发特征）
const BENIGN = [
  // ① 探针失败 → 只能是 n/a，不得变成 false
  'DSH-SIGNAL logits.prefill_repeat_consistent=n/a (端点未返回可解析的 logprobs：**不下结论**，不把失败当成漂移)',
  // ② 采样失败 → 只能是 n/a，不得取空串哈希
  'DSH-SIGNAL quality.sample.1=n/a (响应不可解析：**不下结论**，不用空串哈希冒充样本指纹)',
  'DSH-SIGNAL quality.sample.2=n/a (响应不可解析：**不下结论**，不用空串哈希冒充样本指纹)',
  'DSH-SIGNAL quality.sweep.valid=0/8 (有效样本数：n/a 的不是样本，不能计入一致性判定)',
  // ③ 启动配置行：含 speculative_config=None / kv_cache_dtype=auto / 捕获尺寸列表里的 96/104
  "(EngineCore pid=140) INFO Initializing a V1 LLM engine with config: speculative_config=None, "
  + "tokenizer_mode=auto, dtype=torch.bfloat16, max_seq_len=8192, kv_cache_dtype=auto, enable_prefix_caching=True, "
  + "cudagraph_capture_sizes=[1, 2, 4, 8, 16, 24, 32, 96, 104, 112]",
  // ④ 探针自身标签文本（含"抢占"/"spec_decode"等触发词的旧标签形态也要安全）
  '--- 抢占/KV/队列/调度（H-C 直接证据链）:',
  'DSH-SIGNAL quality.sweep.done=true（core_hash 仅覆盖 content/reasoning/finish；snapshot 用于把异常样本与 spec_decode/抢占/缓存计数关联）',
  // ⑤ 其它子串陷阱：template / temp0 / uvloop / repeat
  'DSH-SIGNAL chat_template.container_vllm_pid=1 (容器 PID1 常是启动脚本，故按进程名找)',
  '--- temp0-run1(core): ',
  '(APIServer pid=1)     uvloop.run(run_server(args))',
].join('\n')

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-prec-'))
  const core = createCore({ pkgRoot: PKG_ROOT, storageDir: join(tmp, 's'), persist: false })
  const g = core.generateCollectScript({ description: '假阳性防线', dimensions: DIMS })
  const report = g.data.manifest.sections.map((s) => SEC(s, s === 'quality-probe' ? BENIGN : 'no findings')).join('\n')
  const parsed = core.parseCollectReport({ report, manifest: g.data.manifest })
  t.assert(parsed.ok === true, '良性报告可解析')

  // ── ① A 范式：这些行不得产出任何输出异常候选 ──
  const svc = core.diagnoseService({ evidence: parsed.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: 'prec-a' } })
  // 分层后必须读两层：弱信号里的假阳性同样是假阳性
  const svcIds = new Set([...svc.data.rootCauses.map((x) => x.id),
    ...(svc.data.closure.weakSignals || []).map((x) => x.id),
    ...(svc.data.closure.excludedHypotheses || []).map((x) => x.id)])
  for (const id of ['rc-out-001', 'rc-out-002', 'rc-out-003', 'rc-out-004', 'rc-out-005', 'rc-out-006']) {
    t.assert(!svcIds.has(id), `良性行不得触发 ${id}（子串/标签命中即假阳性）`)
  }

  // ── ② B 范式定性路径：不得触发需要"真实指标异常/真实回退"的规则 ──
  const reg = core.diagnoseRegression({ report, manifest: g.data.manifest, baselineType: 'performance', sessionId: 'prec-b' })
  const regIds = new Set([...reg.data.rootCauses.map((x) => x.id), ...(reg.data.closure.weakSignals || []).map((x) => x.id)])
  for (const id of ['rc-rc-rg-qual-001', 'rc-rg-qual-001', 'rc-rg-qual-002', 'rc-rg-qual-003', 'rc-rg-qual-004', 'rc-rg-qual-005', 'rc-rg-qual-006', 'rc-rg-qual-007']) {
    t.assert(!regIds.has(id), `良性行不得触发 ${id}`)
  }
  t.assert(reg.data.rootCauses.length === 0, `良性报告的定性路径应无候选（实际 ${reg.data.rootCauses.length} 条）`)

  // ── ③ C 范式：探测失败必须落"不可判定"，不得落"确定性" ──
  const con = core.diagnoseConsistency({ report, manifest: g.data.manifest, dimensions: DIMS, sessionId: 'prec-c' })
  const k = con.data.closure.consistency
  t.assert(k.sampleCount === 0, `n/a 采样不计入样本数（实际 ${k.sampleCount}）`)
  t.assert(k.path === 'not-reproducible' && k.verdict === 'insufficient-samples',
    `探测失败 → not-reproducible/insufficient-samples（实际 ${k.path}/${k.verdict}）`)
  const conIds = new Set([...con.data.rootCauses.map((x) => x.id), ...(con.data.closure.weakSignals || []).map((x) => x.id)])
  t.assert(!conIds.has('rc-cons-003'), '不得由 n/a 得出"采样前已漂移"')
  t.assert(!conIds.has('rc-cons-007'), 'n/a 采样不得进入数据驱动槽的判定')
  t.assert(k.reason.includes('不可判定'), '理由必须是"不可判定"，不是"未发现反例"')

  // ── ④ 探针文本自身不得再携带规则触发词（L1 数据纪律）──
  const { readFileSync } = await import('node:fs')
  const vllm = readFileSync(join(PKG_ROOT, 'assets', 'dimensions', 'framework', 'vllm.yaml'), 'utf8')
  t.assert(!/snapshot 用于把异常样本与 spec_decode/.test(vllm), 'quality-sweep 的说明文本已去掉 spec_decode 触发词')
  t.assert(!/--- 抢占\/KV\/队列\/调度/.test(vllm), 'metrics-full 的段内标签已去掉"抢占"触发词')
  t.assert(/prefill_repeat_consistent=n\/a/.test(vllm), 'logits 探针在数据不足时输出 n/a（不编造 false）')
  t.assert(/quality\.sweep\.valid=/.test(vllm), 'quality-sweep 输出有效样本数（n/a 不计入）')

  rmSync(tmp, { recursive: true, force: true })
}
