/**
 * methodology.spec —— 证据演绎方法论能力（2026-09-23，抽象自"QLI int32 溢出致偶发乱码"的成功定位）。
 *
 * 覆盖四项新增语义（全部为规则**可选**字段，旧规则行为不变）：
 *   ① requires    合取：多条件须各自命中，未满足 → 该假设被排除（且进台账，不静默丢弃）
 *   ② falsifiedBy 否证：**必然痕迹**缺席 ⇒ 假设被排除（缺席即否证，但只允许写"若真必见"的痕迹）
 *   ③ computeCheck 可算判据：把"可能溢出"变成数字；判据不成立 ⇒ 排除
 *   ④ causal      因果闭环门槛：缺"回切复现/双向开闭/二进制一致"不得称"已证明"
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parse } from '../../src/primitives/yaml-lite.js'
import { applyMethodology, evaluateExpr, loadRuleFiles } from '../../src/primitives/root-cause-rules.js'
import { grade } from '../../src/primitives/confidence.js'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'vllm', runtime: 'docker', hardware: 'ascend-arm' }
const RULES = parse(readFileSync(join(PKG_ROOT, 'assets', 'root-causes', 'methodology-rules.yaml'), 'utf8')).rules
// ④ 的否证样本取自 runtime-docker-rules.yaml：rc-conf-oom-trace 已按"同机制不留两条 decisive"
// 合并进 rc-docker-001，否证条件随之迁移（见该文件 decisiveRationale / falsifiedBy）
const DOCKER_RULES = parse(readFileSync(join(PKG_ROOT, 'assets', 'root-causes', 'runtime-docker-rules.yaml'), 'utf8')).rules
const rule = (id) => RULES.find((r) => r.id === id) || DOCKER_RULES.find((r) => r.id === id)
const EV = (...ss) => ss.map((s, i) => ({ id: `e${i}`, sourceFile: `src${i}.txt`, line: i + 1, snippet: s }))
const SEC = (n, b) => `=== ${n} ===\n--- skip ---\n${b}\n=== end:${n} ===`

export const NAME = 'methodology（合取 / 否证 / 可算判据 / 因果闭环门槛）'

export async function run(t) {
  // ── ① 安全算术求值器 ──
  t.assert(evaluateExpr('floor(2147483647 / stride) + 1', { stride: 73856 }) === 29077, '① 可算判据：floor(2^31/73856)+1 = 29077（int32 溢出阈值）')
  t.assert(evaluateExpr('(threshold <= maxBlock)', { threshold: 29077, maxBlock: 29076 }) === 0, '① 比较运算：29076 < 阈值 → 0')
  t.assert(evaluateExpr('(threshold <= maxBlock)', { threshold: 29077, maxBlock: 29077 }) === 1, '① 比较运算：29077 ≥ 阈值 → 1')
  t.assert(evaluateExpr('max(1, min(3, 2)) + abs(-4)', {}) === 6, '① min/max/abs 可用')
  let threw = false
  try { evaluateExpr('stride * 2', {}) } catch { threw = true }
  t.assert(threw === true, '① 缺输入变量必须抛错——**不得静默当 0**（否则会产生假判据）')
  let threw2 = false
  try { evaluateExpr('1 + ', {}) } catch { threw2 = true }
  t.assert(threw2 === true, '① 非法表达式抛错（不用 eval/Function，语法外输入不可执行）')

  // ── ② 合取 requires ──
  const onlyBlock = applyMethodology(rule('rc-idx-001'), EV('blockId max=29080'))
  t.assert(onlyBlock.status === 'excluded' && onlyBlock.excludedBy.some((x) => x.kind === 'requires-unmet'), '② 合取未满足（只有 blockId 无 stride）→ 排除，原因为 requires-unmet')
  const bothPresent = applyMethodology(rule('rc-idx-001'), EV('blockId max=29080', 'kScaleBlkStride = 73856'))
  t.assert(bothPresent.status === 'candidate' && bothPresent.requires.every((r) => r.matched), '② 合取两条件均命中 → 候选保留')

  // ── ③ 可算判据 computeCheck ──
  t.assert(bothPresent.computed.value === 29077 && bothPresent.computed.holds === true, '③ 阈值算出 29077 且判据成立（maxBlock=29080 ≥ 阈值）')
  const belowThreshold = applyMethodology(rule('rc-idx-001'), EV('blockId max=29076', 'kScaleBlkStride = 73856'))
  t.assert(belowThreshold.status === 'excluded' && belowThreshold.computed.holds === false, '③ 现场最大页号 29076 < 阈值 → **可算判据否证该假设**（不是"未发现反例"）')
  const missingInput = applyMethodology(rule('rc-idx-001'), EV('blockId max=29080', 'kScaleBlkStride 未给出'))
  t.assert(missingInput.computed.missingInputs.length > 0 && missingInput.computed.holds === null, '③ 数字缺失时 holds=null（不下结论），并把缺的输入名列进 missingInputs')

  // ── ④ 否证 falsifiedBy（必然痕迹缺席）──
  // 样本 = 合并后的 rc-docker-001（rc-conf-oom-trace 已并入，否证条件随之迁移）
  t.assert(rule('rc-conf-oom-trace') === undefined, '④ rc-conf-oom-trace 已合并删除（同机制不留两条 decisive 规则）')
  const oomNoTrace = applyMethodology(rule('rc-docker-001'), EV('ExitCode 137'))
  t.assert(oomNoTrace.status === 'excluded' && oomNoTrace.excludedBy.some((x) => x.kind === 'falsifier-absent'), '④ 只有 ExitCode 137、全量证据无 OOM 痕迹 → 否证（137 也可能来自其它 SIGKILL）')
  const oomWithTrace = applyMethodology(rule('rc-docker-001'), EV('ExitCode 137', 'OOMKilled'))
  t.assert(oomWithTrace.status === 'candidate', '④ 出现 OOMKilled（必然痕迹在场）→ 不否证')
  // docker ps -a 的原生渲染（shipped 探针的真实输出格式）必须能被识别为故障事实本身。
  // applyMethodology 不做 when 匹配（调用方已预筛），故这里走端到端：container-state 给原生渲染、
  // container-log 给 OOM 痕迹 → 规则应进候选（合并前两条规则都不识别 `Exited (137)` 这一形态）。
  const coreOom = createCore({ pkgRoot: PKG_ROOT, persist: false, inProcessStore: true })
  const reportNative = [
    SEC('container-state', 'a1b2c3d4e5f6   vllm-svc    Exited (137) 2 hours ago'),
    SEC('container-log', 'Sep 18 02:11:03 kernel: oom-kill:constraint=CONSTRAINT_MEMCG'),
  ].join('\n')
  const evNative = coreOom.parseCollectReport({ report: reportNative }).data.evidence
  const rOom = coreOom.diagnoseService({ evidence: evNative, dimensions: DIMS }).data
  const oomHit = [...(rOom.rootCauses || []), ...((rOom.closure && rOom.closure.weakSignals) || [])].find((x) => x.id === 'rc-docker-001')
  t.assert(!!oomHit, '④ `Exited (137)`（docker ps -a 原生渲染）能被识别：rc-docker-001 进候选（合并前两条规则都不识别该形态）')
  t.assert(oomHit.evidence.some((e) => /Exited \(137\)/.test(e.snippet)), '④ 命中证据含 `Exited (137)` 本身（不止靠日志行）')

  // ── ⑤ 数值型否证：往返 / 分片 / 滑窗 ──
  t.assert(applyMethodology(rule('rc-conf-tokenizer-ok'), EV('DSH-SIGNAL tokenizer.roundtrip_ok=true')).status === 'excluded', '⑤ 往返成功 → tokenizer 不同源假设被否证')
  t.assert(applyMethodology(rule('rc-conf-tokenizer-ok'), EV('DSH-SIGNAL tokenizer.roundtrip_ok=false')).status === 'candidate', '⑤ 往返失败 → 该假设保留')
  t.assert(applyMethodology(rule('rc-conf-shards-ok'), EV('DSH-SIGNAL weights.shards_declared=274', 'DSH-SIGNAL weights.shards_present=270')).status === 'candidate', '⑤ 分片 270/274 → 不完整假设保留')
  t.assert(applyMethodology(rule('rc-conf-shards-ok'), EV('DSH-SIGNAL weights.shards_declared=274', 'DSH-SIGNAL weights.shards_present=274')).status === 'excluded', '⑤ 分片 274/274 → 不完整假设被否证')
  t.assert(applyMethodology(rule('rc-struct-sliding-eq-block'), EV('"sliding_window": 128', '--block-size 128')).status === 'candidate', '⑤ 滑窗==块大小 → 「边界重合」假设保留（结构决策点）')
  t.assert(applyMethodology(rule('rc-struct-sliding-eq-block'), EV('"sliding_window": 128', '--block-size 256')).status === 'excluded', '⑤ 滑窗≠块大小 → 该假设被否证')

  // ── ⑥ 因果闭环门槛 ──
  const strongTwoSources = {
    ruleId: 'rc-x', hypothesis: 'h', strong: true, fixSpec: { code: 'c', verification: 'v', rollback: 'r', riskLevel: 'low' },
    evidence: [{ sourceFile: 'a' }, { sourceFile: 'b' }],
    methodology: { causal: { closureSatisfied: false, requireForProven: true } },
  }
  t.assert(grade(strongTwoSources) !== '已证明', '⑥ 声明了因果闭环要求但证据缺失 → **不得**判"已证明"（"改了就好了"不算因果）')
  const withClosure = { ...strongTwoSources, methodology: { causal: { closureSatisfied: true, requireForProven: true } } }
  t.assert(grade(withClosure) === '已证明', '⑥ 具备回切复现/双向开闭/二进制一致 → 可判"已证明"')
  const noCausalReq = { ...strongTwoSources, methodology: { causal: { closureSatisfied: false, requireForProven: false } } }
  t.assert(grade(noCausalReq) === '已证明', '⑥ 规则未声明闭环要求时，不因缺少闭环证据而降级（保持旧行为）')

  // ── ⑦ 与管线集成：excluded 进台账、不进根因列表；候选带 methodology ──
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-meth-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-meth', version: '0.0.1' }))
  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sessions'), persist: true })
  core.hotloader.init()
  const { rules: loaded, files } = loadRuleFiles(join(tmp, 'assets'), core.layer.resolve(DIMS))
  t.assert(files.includes('root-causes/methodology-rules.yaml'), '⑦ 组合加载了 methodology-rules.yaml（规则数据可热更新）')

  const g = core.generateCollectScript({ description: ' méthodologie 集成用例', dimensions: DIMS })
  const report = [
    SEC('serving-args', '--tensor-parallel-size=8\n--block-size 128'),
    SEC('model-config', '"sliding_window": 128'),
    SEC('container-log', 'blockId max=29076\nkScaleBlkStride = 73856'), // 未达阈值 → 应被否证
    SEC('precision-log', 'no fallback'),
  ].join('\n')
  const p = core.parseCollectReport({ report, manifest: g.data.manifest })
  const d = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: 'meth-1' } })
  const ids = d.data.rootCauses.map((rc) => rc.id)
  t.assert(!ids.includes('rc-idx-001'), '⑦ 被可算判据否证的假设**不出现**在根因列表里')
  const ledger = d.data.closure.excludedHypotheses || []
  t.assert(ledger.some((x) => x.id === 'rc-idx-001'), '⑦ 被否证的假设进入 closure.excludedHypotheses 台账（排除可追溯、可撤回）')
  const idxEntry = ledger.find((x) => x.id === 'rc-idx-001')
  t.assert(idxEntry && Array.isArray(idxEntry.excludedBy) && idxEntry.excludedBy.some((x) => x.kind === 'compute-falsified'), '⑦ 台账记录了否证类型与判据表达式')
  t.assert(d.data.rootCauses.every((rc) => 'methodology' in rc), '⑦ 每个根因都带 methodology 元数据字段（嵌套，非顶层）')
  const withCausal = d.data.rootCauses.find((rc) => rc.methodology && rc.methodology.causal)
  t.assert(withCausal === undefined || withCausal.confidence !== '已证明', '⑦ 未提供闭环证据时，任何根因都不会被判"已证明"')

  rmSync(tmp, { recursive: true, force: true })
}
