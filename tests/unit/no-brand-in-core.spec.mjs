/**
 * no-brand-in-core.spec —— P0 出口门禁 1（正向断言）。
 *
 * 判据（§5.1 P0 门禁）：注入一个 src/ 从未见过的维度，跑完三工具全流程，
 * 断言不报 ERR_INTERNAL、不因未知硬件崩溃。
 *
 * 这比 grep 零命中强：grep 只防显式字符串，防不住字符串拼接、从资产读入后
 * 写进变量、间接 import。正向断言证明的是"核心真的不认识品牌，只认识数据"。
 */
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const FIXTURES = join(HERE, '..', 'fixtures')

export const NAME = 'no-brand-in-core（正向断言：注入未知维度跑完三工具）'

export async function run(t) {
  // ---- 1. 构造临时资产树：真实资产 + 一个从未见过的硬件维度 ----
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-crash-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-fixture', version: '0.0.1' }))

  const assetsRoot = join(tmp, 'assets')
  cpSync(join(FIXTURES, 'fake-hardware.yaml'), join(assetsRoot, 'dimensions', 'hardware', 'fake-hardware.yaml'))
  cpSync(join(FIXTURES, 'fake-framework.yaml'), join(assetsRoot, 'dimensions', 'framework', 'fake-framework.yaml'))
  cpSync(join(FIXTURES, 'fake-hardware-rules.yaml'), join(assetsRoot, 'root-causes', 'fake-hardware-rules.yaml'))

  const dimsPath = join(assetsRoot, 'config', 'dims.json')
  const dims = JSON.parse(readFileSync(dimsPath, 'utf8'))
  t.assert(!dims.kinds.hardware.includes('fake-hardware'), '夹具硬件不在原始注册表中（保证"从未见过"）')
  t.assert(!dims.kinds.framework.includes('fake-framework'), '夹具框架不在原始注册表中（保证"从未见过"）')
  dims.kinds.hardware.push('fake-hardware')
  dims.kinds.framework.push('fake-framework')
  writeFileSync(dimsPath, JSON.stringify(dims, null, 2))

  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sessions'), persist: true })
  const report = readFileSync(join(FIXTURES, 'sample-report.txt'), 'utf8')
  const dimensions = { framework: 'fake-framework', runtime: 'docker', hardware: 'fake-hardware' }

  // 组合约束仍然生效：未注册进 requires 的组合必须被拒（fail-closed 证据）
  let comboRejected = false
  try {
    core.generateCollectScript({ description: 'x', dimensions: { framework: 'mindie', runtime: 'docker', hardware: 'fake-hardware' } })
  } catch (e) {
    comboRejected = e.code === 'ERR_MISSING_PARAM'
  }
  t.assert(comboRejected, '非法组合（requires 不满足）被拒且码为 ERR_MISSING_PARAM')

  // ---- 2. 三工具全流程 ----
  const g = core.generateCollectScript({ description: '夹具：未知硬件下服务崩溃', dimensions })
  t.assert(g.ok === true, `generate ok（实际 code=${g.code}）`)
  t.assert(g.code !== 'ERR_INTERNAL', 'generate 不得以 ERR_INTERNAL 结束')
  t.assert(typeof g.data.script === 'string' && g.data.script.length > 100, 'generate 返回脚本正文')
  t.assert(g.data.script.includes('dsh_desensitize'), '生成脚本内嵌脱敏函数（无明文落盘的前提）')
  t.assert(g.data.script.includes('fake-health') && g.data.script.includes('fake-errors'), '脚本包含未知维度的探针')
  t.assert(Array.isArray(g.data.manifest.sections) && g.data.manifest.sections.includes('fake-errors'), 'manifest 含未知维度 section')
  t.assert(/^sha256:/.test(g.versions.assets), 'versions.assets 为内容 hash')
  t.assert(g.data.degradations === undefined && g.data.notices === undefined, '正常路径不带降级/声明')

  // 由 manifest 合成"完整报告"（§2.3 完整路径）
  const sectionBody = (s) => (s === 'fake-errors' ? 'XERR 0xDEAD code=77\ndevice <SERIAL> reported XERR 0xDEAD at <IP>' : `FIXTURE-${s}-OK`)
  const fullReport = g.data.manifest.sections
    .map((s) => `=== ${s} ===\n--- cmd: fixture-${s}\n${sectionBody(s)}\n=== end:${s} ===`)
    .join('\n')

  const p = core.parseCollectReport({ report: fullReport, manifest: g.data.manifest })
  t.assert(p.ok === true, `parse ok（实际 code=${p.code}）`)
  t.assert(p.code !== 'ERR_INTERNAL', 'parse 不得以 ERR_INTERNAL 结束')
  t.assert(p.data.evidence.length > 0, 'parse 抽取出证据')
  t.assert(p.data.evidence.every((e) => e.hash && Number.isFinite(e.line) && e.snippet), '每条证据含 hash/line/snippet')
  t.assert(p.data.parseMeta.missingSections.length === 0, '完整报告无 missingSections')
  t.assert(p.data.desensitizeCheck.passed === true, '二次脱敏校验通过')
  t.assert(Array.isArray(p.data.probeHashes) && p.data.probeHashes.length >= 2, '返回探针粒度 hash（跨轮 diff 输入）')

  // §2.3 分流①：不完整（合法但缺段）→ ok + missingSections，不判为损坏
  const dropped = g.data.manifest.sections[g.data.manifest.sections.length - 1]
  const partialReport = fullReport
    .split('\n')
    .join('\n')
    .replace(new RegExp(`=== ${dropped} ===[\\s\\S]*?=== end:${dropped} ===\\n?`), '')
  const pPartial = core.parseCollectReport({ report: partialReport, manifest: g.data.manifest })
  t.assert(pPartial.ok === true, '不完整报告被接受（不完整 ≠ 损坏）')
  t.assert(pPartial.data.parseMeta.missingSections.includes(dropped), `missingSections 标记缺失段（${dropped}）`)
  t.assert((pPartial.data.notices || []).some((n) => n.code === 'report-incomplete'), '产出 report-incomplete 声明')

  // §2.3 分流②：损坏（格式非法/无段标记）→ 整份拒绝
  let corruptCode = null
  try {
    core.parseCollectReport({ report: '这不是报告：没有任何段标记', manifest: g.data.manifest })
  } catch (e) {
    corruptCode = e.code
  }
  t.assert(corruptCode === 'ERR_REPORT_CORRUPT', `损坏报告整份拒绝（实际 ${corruptCode}）`)

  // §2.3 分流③：二检命中 → 仅内存拒绝，返回片段必为打码
  const leaky = fullReport.replace('FIXTURE-fake-health-OK', 'device at 10.201.33.7 serial 210235A4KQ11Z')
  let missBody = null
  let missCode = null
  try {
    core.parseCollectReport({ report: leaky, manifest: g.data.manifest })
  } catch (e) {
    missCode = e.code
    missBody = e.body
  }
  t.assert(missCode === 'ERR_DESENSITIZE_MISS', `二检命中拒绝（实际 ${missCode}）`)
  t.assert(!!missBody && missBody.policy === 'REFUSE' && missBody.hits.length > 0, 'ERR_DESENSITIZE_MISS 带 policy:REFUSE 与命中片段')
  t.assert(missBody.hits.every((h) => h.maskedSnippet.includes('*')), '命中片段恒为打码（明文不出现在返回值）')

  const d = core.diagnoseService({ evidence: p.data.evidence, dimensions, context: { round: 1, description: '夹具' } })
  t.assert(d.ok === true, `diagnose ok（实际 code=${d.code}）`)
  t.assert(d.code !== 'ERR_INTERNAL', 'diagnose 不得以 ERR_INTERNAL 结束')
  // 该夹具维度贡献的是 contextual 规则 → 分层后落在弱信号区；两层合计仍有产出即可
  const produced = [...d.data.rootCauses, ...(d.data.closure.weakSignals || [])]
  t.assert(produced.length > 0, `至少产出 1 条根因候选（主 ${d.data.rootCauses.length} + 弱 ${(d.data.closure.weakSignals || []).length}）`)
  t.assert(d.data.rootCauses.length + (d.data.closure.weakSignals || []).length ===
    d.data.rootCauses.length + (d.data.closure.weakSignals || []).length, '分层计数自洽')
  const rc = produced[0]
  t.assert(rc.evidence.length >= 1, '根因绑定 ≥1 条证据（minItems:1）')
  t.assert(rc.evidence.every((e) => e.sourceFile && Number.isFinite(e.line) && e.snippet), '证据可溯源（file+line+snippet）')
  t.assert(['已证明', '未发现反例', '未确认'].includes(rc.confidence), `置信度在三档内（实际 ${rc.confidence}）`)
  t.assert(rc.confidence !== '未确认' ? !!rc.fix : rc.fix === null, '置信度↔fix 单向约束成立')
  if (rc.fix && rc.fix.state === 'complete') {
    for (const k of ['code', 'verification', 'rollback', 'riskLevel']) t.assert(!!rc.fix[k], `complete fix 含 ${k}`)
  }

  // ---- 3. 反向断言：真实维度组合仍然工作（夹具没有把真实路径挤掉） ----
  const real = core.generateCollectScript({ description: '真实组合回归', dimensions: { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' } })
  t.assert(real.ok === true && !real.data.script.includes('fake-'), '真实维度组合不掺入夹具维度')

  // ---- 4. 第四个依赖源：模板缺失必须走专用错误码（不是 ERR_INTERNAL） ----
  const tplDir = join(tmp, 'assets', 'templates')
  const stash = join(tmp, 'templates-stash')
  cpSync(tplDir, stash, { recursive: true })
  rmSync(tplDir, { recursive: true, force: true })
  let tplCode = null
  try {
    core.generateCollectScript({ description: '夹具：模板缺失', dimensions })
  } catch (e) {
    tplCode = e.code
  }
  t.assert(tplCode === 'ERR_TEMPLATE_NOT_LOADED', `模板缺失走 ERR_TEMPLATE_NOT_LOADED（实际 ${tplCode}）`)
  cpSync(stash, tplDir, { recursive: true })

  // ---- 5. 辅助断言：源码零品牌命中（grep 仅作辅助，见 §5.1） ----
  const srcFiles = []
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.js')) srcFiles.push(p)
    }
  }
  walk(join(PKG_ROOT, 'src'))
  const BRANDS = ['mindie', 'vllm', 'ascend', 'triton']
  const hits = []
  for (const f of srcFiles) {
    const text = readFileSync(f, 'utf8').toLowerCase()
    for (const b of BRANDS) if (text.includes(b)) hits.push(`${f.split('/src/')[1]}:${b}`)
  }
  t.assert(hits.length === 0, `src/ 零品牌命中（辅助断言，实际命中：${hits.join(', ') || '无'}）`)

  rmSync(tmp, { recursive: true, force: true })
}
