/**
 * output-anomaly.spec —— P9 扩面专项（A 范式新增「输出异常」）。
 *
 * 用户 2026-09-28 裁决：A 在原覆盖（崩溃/启动失败/挂起/被外部杀/资源耗尽）之外，
 * 新增「输出异常」——乱码、截断、重复、语义错误。
 *
 * 定位要点（本 spec 的断言对象）：乱码/截断/重复/语义错误都是**当前状态异常**，
 * 与崩溃同构（采集当前配置 + 日志 + 输出样本 → 规则匹配 → 根因），**不需要基线**，
 * 因此归 A 而不归 B。本 spec 用"当前报告"直接驱动，全程不涉及任何基线。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'
import { parse } from '../../src/primitives/yaml-lite.js'

export const NAME = 'output-anomaly（A 扩面：乱码 / 截断 / 重复 / 语义错误，无需基线）'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }
const SEC = (n, body) => `=== ${n} ===\n--- cmd: probe-${n}\n${body}\n=== end:${n} ===`

// 每个异常类一行"当前状态"证据；全部来自**当前报告**，没有任何基线
const LINES = {
  截断: 'DSH-SIGNAL quality.sample.1=core_hash:ab12 {"c":"张量并行","finish":"length"}',
  content空: 'DSH-SIGNAL quality.content_empty=true (content 空：思考型模型 + max_tokens 不足)',
  重复: 'repetition_penalty=1.50 top_p=0.95 (重读检测 repetition detected)',
  乱码编码层: '--- response-raw: 输出含替换字符 \uFFFD 与控制字符（可能被网关截断）',
  语义错位: '--- chat_template: /m/template.jinja (工具调用格式不匹配：疑似模板与模型训练口径不同)',
  传输截断: '--- response incomplete: stream aborted before finish_reason',
  缺响应正文: 'DSH-SIGNAL evidence.missing.3=response_body (vLLM 不落响应正文)',
  缺请求参数: 'DSH-SIGNAL evidence.missing.1=client_request_params (未开 --enable-log-requests)',
  乱码内容层: '"quant_method": "ascend"  kv_cache_dtype=fp8  --block-size=128',
}

export async function run(t) {
  // ── ① 规则文件在唯一物理位置，且被两个框架维度的 ruleRefs 引用 ──
  const rulePath = join(PKG_ROOT, 'assets', 'root-causes', 'output-anomaly-rules.yaml')
  t.assert(existsSync(rulePath), 'output-anomaly-rules.yaml 在 L1 资产树内')
  const doc = parse(readFileSync(rulePath, 'utf8'))
  const ids = doc.rules.map((r) => r.id)
  t.assert(doc.rules.length === 8, `输出异常规则 8 条（实际 ${doc.rules.length}）`)
  t.assert(new Set(ids).size === ids.length, '规则 id 唯一（单一真源，无重复定义）')
  for (const rel of ['dimensions/framework/mindie.yaml', 'dimensions/framework/vllm.yaml']) {
    const d = parse(readFileSync(join(PKG_ROOT, 'assets', rel), 'utf8'))
    t.assert(d.ruleRefs.includes('root-causes/output-anomaly-rules.yaml'), `${rel} 的 ruleRefs 已引用输出异常规则集`)
  }

  // ── ② 四类异常各自能产出带证据的结论（无需基线）──
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-out-'))
  const core = createCore({ pkgRoot: PKG_ROOT, storageDir: join(tmp, 's'), persist: false })
  const body = Object.values(LINES).join('\n')
  const g = core.generateCollectScript({ description: '输出乱码/截断/重复', dimensions: DIMS })
  const report = [...g.data.manifest.sections.map((s) => SEC(s, s === 'quality-probe' ? body : 'no findings'))].join('\n')
  const p = core.parseCollectReport({ report, manifest: g.data.manifest })
  t.assert(p.ok === true && p.data.evidence.length > 0, '解析当前报告得到证据')
  const d = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: 'out-1' } })
  t.assert(d.ok === true, '诊断成功（无基线依赖）')

  // 分层后："产出"= 主列表 ∪ 弱信号；"未产出"= 只在排除台账里
  const firedIds = new Set([
    ...d.data.rootCauses.map((rc) => rc.id),
    ...(d.data.closure.weakSignals || []).map((rc) => rc.id),
  ])
  const excludedIds = new Set((d.data.closure.excludedHypotheses || []).map((x) => x.id))
  for (const id of ids) {
    t.assert(firedIds.has(id) || excludedIds.has(id), `输出异常规则 ${id} 命中（候选或已排除台账）`)
  }

  // 四类必覆盖面（用户裁决的"乱码、截断、重复、语义错误"）
  const cover = {
    截断: ['rc-out-001', 'rc-out-006'],
    重复: ['rc-out-003'],
    语义错误: ['rc-out-005'],
    乱码: ['rc-out-004'],
  }
  for (const [klass, want] of Object.entries(cover)) {
    t.assert(want.some((id) => firedIds.has(id)), `「${klass}」类有产出候选（${want.join('/')}）`)
  }
  // 乱码的另一半：内容层（quality-gibberish 规则簇）仍然命中——两份规则分工不重叠
  const qg = [...firedIds].filter((id) => id.startsWith('rc-qg-'))
  t.assert(qg.length >= 1, `内容层乱码由 quality-gibberish 规则簇覆盖（命中 ${qg.join(',') || '无'}）`)

  // ── ③ 契约不变量：证据非空 + fix 三态 + 单向约束 ──
  t.assert(d.data.rootCauses.length > 0, '至少产出一条根因候选')
  for (const rc of [...d.data.rootCauses, ...(d.data.closure.weakSignals || [])]) {
    t.assert(Array.isArray(rc.evidence) && rc.evidence.length >= 1, `${rc.id} 证据非空（minItems:1）`)
    t.assert(rc.evidence.every((e) => e.sourceFile && Number.isFinite(e.line) && e.snippet), `${rc.id} 证据可溯源（file/line/snippet）`)
    if (rc.confidence === '未确认') {
      t.assert(rc.fix === null && !!rc.additionalCollection, `${rc.id} 未确认 → 禁出修复，只给补采指令`)
    } else {
      t.assert(!!rc.fix && ['complete', 'partial'].includes(rc.fix.state), `${rc.id} 非未确认 → fix 为 complete/partial`)
    }
  }

  // ── ④ 输出异常是"当前状态异常"，不得因为"没有基线"而降级或拒绝 ──
  t.assert(!d.data.degradations || !d.data.degradations.some((x) => x.capability === 'performance-baseline-diff'),
    'A 路径不产生基线相关降级（输出异常不需要基线）')

  rmSync(tmp, { recursive: true, force: true })
}
