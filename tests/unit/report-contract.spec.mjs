/**
 * report-contract.spec —— P3 出口门禁之一（§2.3 返回结构 / 损坏 vs 不完整 / 二检）。
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')

export const NAME = 'report-contract（§2.3 结构 / 损坏 vs 不完整 / 二检 / 截断）'

function tree() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-rpt-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-rpt', version: '0.0.1' }))
  return tmp
}
const SEC = (name, body) => `=== ${name} ===\n--- cmd: probe-${name}\n${body}\n=== end:${name} ===`
function attempt(fn) {
  try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e.code, body: e.body } }
}

export async function run(t) {
  const tmp = tree()
  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 's'), persist: false })
  const manifest = { sections: ['kernel-log', 'npu-metrics', 'mindie-log'] }

  // ---- 正常结构 ----
  const full = [SEC('kernel-log', '[ 4821.13] HBM ECC uncorrectable error'), SEC('npu-metrics', 'temp 92C (throttle threshold 85C)'), SEC('mindie-log', 'RuntimeError: infer failed, abort')].join('\n')
  const r = core.parseCollectReport({ report: full, manifest })
  t.assert(r.ok === true && r.code === 'OK', '正常返回 ok:true')
  const d = r.data
  t.assert(Array.isArray(d.evidence) && d.evidence.length >= 3, '抽取出证据')
  t.assert(d.evidence.every((e) => e.id && e.section && e.line && e.snippet && e.hash), '每条证据含 id/section/line/snippet/hash')
  t.assert(d.evidence.every((e) => String(e.hash).startsWith('sha256:')), 'hash 为 sha256 形态')
  t.assert(d.parseMeta.sectionsFound.length === 3, 'sectionsFound 覆盖三段')
  t.assert(d.parseMeta.missingSections.length === 0, '完整报告 missingSections 为空')
  t.assert(d.parseMeta.truncated === false && d.parseMeta.manifestMissing === false, 'truncated/manifestMissing 均为 false')
  t.assert(d.desensitizeCheck.passed === true && d.desensitizeCheck.scannedPatterns >= 7, '二检通过并报告扫描规则数')
  t.assert(Array.isArray(d.probeHashes) && d.probeHashes.length === 3, '探针粒度 hash 每段一条')
  t.assert(d.probeHashes.every((h) => h.probe && h.section && String(h.hash).startsWith('sha256:')), 'probeHashes 字段齐备')
  t.assert(r.versions && r.versions.rules === 'desensitize-v1', 'versions 绑定脱敏规则版本')

  // ---- 不完整（合法但缺段）→ ok + missingSections + notice ----
  const partial = [SEC('kernel-log', 'HBM ECC uncorrectable error'), SEC('npu-metrics', 'temp 92C')].join('\n')
  const rp = core.parseCollectReport({ report: partial, manifest })
  t.assert(rp.ok === true, '不完整报告被接受（不完整 ≠ 损坏）')
  t.assert(rp.data.parseMeta.missingSections.length === 1 && rp.data.parseMeta.missingSections[0] === 'mindie-log', 'missingSections 精确列出缺段')
  t.assert((rp.data.notices || []).some((n) => n.code === 'report-incomplete'), '产出 report-incomplete 声明')
  t.assert(rp.data.notices.find((n) => n.code === 'report-incomplete').text.includes('mindie-log'), '声明文本点名缺哪段')

  // ---- manifest 缺省 → 退化为纯结构解析并标记 ----
  const rn = core.parseCollectReport({ report: full })
  t.assert(rn.ok === true && rn.data.parseMeta.manifestMissing === true, '无 manifest → 纯结构解析并标记 manifestMissing')

  // ---- 损坏（格式非法/无段标记）→ 整份拒绝 ----
  const e1 = attempt(() => core.parseCollectReport({ report: '这不是报告', manifest }))
  t.assert(!e1.ok && e1.code === 'ERR_REPORT_CORRUPT' && e1.body.policy === 'REFUSE', '无段标记 → ERR_REPORT_CORRUPT（整份拒绝）')
  // `attempt()` 失败分支只返回 { ok, code, body }，**没有** value/data。
  // 原实现写成 `!('value' in e1) || true` —— `|| true` 使其恒真，这条检查从来没生效过。
  t.assert(!('value' in e1) && !('data' in e1), '损坏报告不混入部分证据（拒绝即无返回体：无 value / 无 data）')

  // ---- ERR_MISSING_PARAM ----
  const e2 = attempt(() => core.parseCollectReport({ report: '   ' }))
  t.assert(!e2.ok && e2.code === 'ERR_MISSING_PARAM' && e2.body.missing.includes('report'), '空报告 → ERR_MISSING_PARAM')
  const e2b = attempt(() => core.parseCollectReport({ report: 42 }))
  t.assert(!e2b.ok && e2b.code === 'ERR_MISSING_PARAM', '非字符串报告 → ERR_MISSING_PARAM')

  // ---- 二检命中 → REFUSE + 打码 ----
  const leaky = full.replace('temp 92C', 'device 10.201.33.7 temp 92C')
  const e3 = attempt(() => core.parseCollectReport({ report: leaky, manifest }))
  t.assert(!e3.ok && e3.code === 'ERR_DESENSITIZE_MISS' && e3.body.policy === 'REFUSE', '二检命中 → ERR_DESENSITIZE_MISS + REFUSE')
  t.assert(e3.body.hits.every((h) => h.maskedSnippet.includes('*')), '命中片段打码')
  t.assert(!JSON.stringify(e3.body).includes('10.201.33.7'), '返回体中不含明文')

  // ---- 二检规则缺失 → 不可跳过 ----
  const t2 = tree()
  rmSync(join(t2, 'assets', 'rules'), { recursive: true })
  const c2 = createCore({ pkgRoot: t2, storageDir: join(t2, 's'), persist: false })
  const e4 = attempt(() => c2.parseCollectReport({ report: full, manifest }))
  t.assert(!e4.ok && e4.code === 'ERR_DESENSITIZE_RULES_NOT_LOADED' && e4.body.policy === 'REFUSE', '二检规则缺失 → REFUSE（二检不可跳过）')

  // ---- 截断标记 ----
  const many = SEC('kernel-log', Array.from({ length: 500 }, (_, i) => `line-${i} HBM ECC event`).join('\n'))
  const rt = core.parseCollectReport({ report: many, manifest: { sections: ['kernel-log'] } })
  t.assert(rt.ok === true && rt.data.parseMeta.truncated === true, '证据超上限 → truncated=true')
  t.assert(rt.data.parseMeta.evidenceCount === 400, `证据数被截到 400（实际 ${rt.data.parseMeta.evidenceCount}）`)

  // ---- 预算分配：长尾段不得吃光全局预算（2026-09-28 真机实测缺陷回归）----
  // 缺陷现场：本机报告 743 行证据，第 400 行落在 `container-log`（docker logs --tail 300）
  // 内部，排在它后面的 nv-device / nv-ecc / host-mem 等段全部进了 missingSections ——
  // 报告里有证据，分析侧却当成缺段。修法是按段比例配额 + 按段序补满。
  {
    const sections = ['big-tail', 'gpu-a', 'gpu-b', 'host-mem']
    const big = SEC('big-tail', Array.from({ length: 500 }, (_, i) => `tail-${i}: noisy container log line`).join('\n'))
    const ga = SEC('gpu-a', Array.from({ length: 24 }, (_, i) => `GPU has fallen off the bus sample ${i}`).join('\n'))
    const gb = SEC('gpu-b', Array.from({ length: 24 }, (_, i) => `Uncorrectable ECC sample ${i}`).join('\n'))
    const hm = SEC('host-mem', 'DSH-SIGNAL mem.available_kb=1024')
    const mixed = [big, ga, gb, hm].join('\n')
    const m = core.parseCollectReport({ report: mixed, manifest: { sections } })
    t.assert(m.ok === true && m.data.parseMeta.truncated === true, '混合超限报告：truncated=true')
    t.assert(m.data.parseMeta.evidenceCount === 400, `全局上限仍为 400（实际 ${m.data.parseMeta.evidenceCount}）`)
    t.assert(m.data.parseMeta.missingSections.length === 0,
      `长尾段不得把后面的段挤成缺段（实际缺：${JSON.stringify(m.data.parseMeta.missingSections)}）`)
    const bySection = {}
    for (const e of m.data.evidence) bySection[e.section] = (bySection[e.section] || 0) + 1
    t.assert(Object.keys(bySection).length === 4, `四段都有证据（实际 ${JSON.stringify(bySection)}）`)
    t.assert(bySection['big-tail'] > bySection['gpu-a'],
      `最长的段仍拿到最大份额（big-tail=${bySection['big-tail']} vs gpu-a=${bySection['gpu-a']}）—— 不是粗暴地每段等分`)
    // 顺序仍是原始行序（跨轮 diff / 证据绑定依赖它）
    const lines = m.data.evidence.map((e) => e.line)
    t.assert(JSON.stringify(lines) === JSON.stringify([...lines].sort((a, b) => a - b)), '证据顺序仍是原始行序')
    // 未超限时逐字节等价于旧行为（全量、不截断）
    const small = SEC('only-one', 'a\nb\nc')
    const s2 = core.parseCollectReport({ report: small, manifest: { sections: ['only-one'] } })
    t.assert(s2.data.parseMeta.evidenceCount === 4 && s2.data.parseMeta.truncated === false, '未超限报告全量保留、不标截断')
  }

  for (const x of [tmp, t2]) rmSync(x, { recursive: true, force: true })
}
