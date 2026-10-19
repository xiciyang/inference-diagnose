/**
 * rule-quality-gates.spec —— P3 规则质量门禁（三条防复发闸 + 分级自身的 G1/G2/G5）。
 *
 * 背景：2026-09-28 在健康服务器上跑出 22 条候选，根因是**规则判据粒度不齐**：
 *   ① 单条规则命中 126 行（正则过宽）；② 规则命中**探针自己写给用户的提示行**；
 *   ③ "存在性关键词"类规则拿到「已证明」。本 spec 把这三条固化成机器闸门。
 *
 * 口径：`docs/judgement-rubric.md` §4。
 *   G1 每条规则有合法 judgement        （加载期 fail-closed，本 spec 复验并计数）
 *   G2 decisive 必带"具体到字段/取值"的理由
 *   G3 单规则在**语料**上命中行数 > 20 ⇒ 过宽，FAIL
 *   G4 `when` 不得命中**插件自己产出的标签/提示文本** ⇒ FAIL
 *   G5 contextual 候选不得得到「已证明」
 *
 * G4 的自述语料**从探针命令自动抽取**（不手抄）：探针改了标签，门禁自动跟上。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/primitives/yaml-lite.js'
import { JUDGEMENTS, DECISIVE_RATIONALE_MIN } from '../../src/primitives/root-cause-rules.js'
import { createCore } from '../../src/index.js'
import { render as renderReview } from '../../scripts/gen-judgement-review.mjs'
import { synthesize, splitTopAlternatives } from '../lib/regex-witness.mjs'

export const NAME = 'rule-quality-gates（G1 分级 / G2 decisive 理由 / G3 过宽 / G4 自述文本 / G5 置信度校准）'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const RC = join(PKG_ROOT, 'assets', 'root-causes')
const DIMS = join(PKG_ROOT, 'assets', 'dimensions')

/** 豁免资格：`when` 必须真的在匹配"证据缺席/不可用"标记（防止拿豁免当逃生舱）。 */
const ABSENCE_MARKER = /evidence\\?\.missing|unavailable|=none|n\/a|=0\b|=\$|endpoint-unreachable/

/** 允许豁免的规则 id 白名单——**锁定**，新增须显式改这里（不允许静默增长）。 */
const EXEMPT_ALLOWLIST = new Set([
  'rc-vllm-010', 'rc-evi-001', 'rc-out-007', 'rc-out-008',
  'rg-qual-008', 'rg-qual-009',
  'rc-cons-005', 'rc-cons-env-005', 'rc-cons-env-006',
])

const RULE_FILES = [
  'framework-vllm-rules.yaml', 'framework-mindie-rules.yaml', 'hardware-ascend-arm-rules.yaml',
  // 2026-09-28 长任务 1 / A1：新增 NVIDIA CUDA 硬件簇与宿主资源簇（被 gb10 / nvidia / cpu 三个维度引用）
  'hardware-nvidia-rules.yaml', 'hardware-host-rules.yaml',
  'runtime-docker-rules.yaml', 'methodology-rules.yaml', 'quality-gibberish-rules.yaml',
  'output-anomaly-rules.yaml', 'regression/performance-rules.yaml', 'regression/accuracy-rules.yaml',
  'regression/qualitative-rules.yaml', 'consistency/determinism-rules.yaml',
  'consistency/environment-rules.yaml',
]

/** 门禁 G3 的语料：真实端点报告 + 退化夹具（探针自述/标签形态的输入） */
function corpusTexts() {
  const out = []
  const cdir = join(PKG_ROOT, 'tests', 'fixtures', 'corpus')
  for (const f of readdirSync(cdir)) if (f.endsWith('.txt')) out.push({ name: `corpus/${f}`, text: readFileSync(join(cdir, f), 'utf8') })
  const ddir = join(PKG_ROOT, 'tests', 'fixtures', 'degenerate')
  for (const f of readdirSync(ddir)) {
    if (!f.endsWith('.txt')) continue
    if (f.startsWith('07') || f.startsWith('10')) continue // 损坏报告/空文件不是报告语料
    out.push({ name: `degenerate/${f}`, text: readFileSync(join(ddir, f), 'utf8') })
  }
  return out
}

/** 与 report-parser 同口径的证据行抽取（段标记行与空行不算证据）。 */
function evidenceLines(text) {
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim()
    if (t === '') continue
    if (/^===\s*(.+?)\s*===$/.test(t)) continue
    out.push(t)
  }
  return out
}

/** 从探针命令里自动抽取"插件自己产出的自述文本"（非 DSH-SIGNAL 的 echo 字面量 + 段名）。 */
function narrationCorpus() {
  const out = new Set()
  // 2026-09-28 长任务 1 / A1：新增维度也必须进自述语料 —— 否则"新探针的提示行撞上新规则"
  // 这条正是 G4 要防的形态，却恰好在新维度上成了盲区。
  const dirs = [
    ['framework', ['vllm.yaml', 'mindie.yaml']],
    ['runtime', ['docker.yaml']],
    ['hardware', ['ascend-arm.yaml', 'gb10.yaml', 'nvidia.yaml', 'cpu.yaml']],
  ]
  for (const [kind, files] of dirs) {
    for (const f of files) {
      let doc
      try { doc = parse(readFileSync(join(DIMS, kind, f), 'utf8')) } catch { continue }
      for (const p of doc.probes || []) {
        // **不把段名放进语料**：段名只出现在 `=== name ===` 标记行，而解析器会跳过标记行
        // （它不会成为证据）。把它算进语料会让"规则命中段名"变成误报。
        const cmd = String(p.command || '')
        const re = /echo\s+(\\?"((?:[^"\\]|\\.)*)\\?"|'([^']*)')/g
        let m
        while ((m = re.exec(cmd)) !== null) {
          let lit = m[2] !== undefined ? m[2] : m[3]
          if (lit === undefined) continue
          lit = lit.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          if (lit.startsWith('DSH-SIGNAL')) continue // 那是数据，不是自述
          const head = lit.split('${')[0].trim() // 去掉变量插值，只留字面前缀
          if (head.length >= 3) out.add(head)
        }
      }
    }
  }
  return [...out]
}

function loadAllRules() {
  const rules = []
  for (const rel of RULE_FILES) {
    const doc = parse(readFileSync(join(RC, rel), 'utf8'))
    for (const r of doc.rules) rules.push({ ...r, _file: rel })
  }
  return rules
}

// ⚠️ 实测坑（2026-09-28）：`new RegExp(undefined, 'i')` **不抛错**，而是得到 `/(?:)/i`
// —— 一个"空模式、匹配一切"的正则。首版门禁因此让所有 B 阈值规则"命中 630 行"，全部误报。
// 故这里显式要求 when/pattern 是非空字符串，否则返回 null（该规则没有可测判据）。
const safeRe = (v) => (typeof v === 'string' && v.length > 0 ? new RegExp(v, 'i') : null)
const reOf = (r) => safeRe(r.when)
const metricReOf = (r) => safeRe(r.pattern)

export async function run(t) {
  const rules = loadAllRules()
  // 71 = 72 - 1：rc-conf-oom-trace 已按"同机制不留两条 decisive 规则"合并进 rc-docker-001
  //（其 when 是 rc-docker-001 的真子集 → 实测命中集合逐条相同，同源）
  // 80 = 71 + 9：长任务 1 / A1 新增两条规则簇 —— hardware-nvidia-rules.yaml（5 条）
  //  与 hardware-host-rules.yaml（4 条）。两簇都被 gb10 / nvidia / cpu 三个新硬件维度引用；
  //  宿主簇单列成文件而不是复制三份，正是"同机制不留两条规则"的应用。
  t.assert(rules.length === 80, `规则总数 80（实际 ${rules.length}）`)
  t.assert(!rules.some((r) => r.id === 'rc-conf-oom-trace'), '重复的 OOM 规则已删除（同机制只留一条 decisive）')
  t.assert(rules.some((r) => r.id === 'rc-docker-001' && Array.isArray(r.falsifiedBy) && r.falsifiedBy.length > 0),
    '合并后的 rc-docker-001 带否证条件（只有 137 而无 OOM/SHM 痕迹时可被否证）')

  // ═══ G1：每条规则都有合法 judgement ═══
  const counts = { decisive: 0, quantitative: 0, contextual: 0 }
  for (const r of rules) {
    t.assert(JUDGEMENTS.includes(r.judgement), `${r._file} ${r.id}：judgement 合法（实际 ${r.judgement}）`)
    if (JUDGEMENTS.includes(r.judgement)) counts[r.judgement] += 1
  }
  t.assert(counts.decisive + counts.quantitative + counts.contextual === rules.length,
    `三档之和 == 规则总数（${counts.decisive}/${counts.quantitative}/${counts.contextual}）`)
  t.assert(counts.decisive >= 8, `decisive 至少 8 条（实际 ${counts.decisive}）——防止把一切都降级成 contextual 蒙混`)

  // ═══ G2：decisive 必带"具体到字段/取值"的理由 ═══
  for (const r of rules) {
    if (r.judgement === 'decisive') {
      const why = String(r.decisiveRationale || '').trim()
      t.assert(why.length >= DECISIVE_RATIONALE_MIN, `${r.id}：decisiveRationale ≥${DECISIVE_RATIONALE_MIN} 字（实际 ${why.length}）`)
      t.assert(why.includes('`') || why.includes('='), `${r.id}：decisiveRationale 含具体字段/取值引用（不是空话）`)
    } else {
      t.assert(r.decisiveRationale === undefined, `${r.id}：非 decisive 不得带 decisiveRationale`)
    }
  }

  // 每条规则必须有可测判据（when 或 pattern），且不两者皆有
  for (const r of rules) {
    const hasWhen = typeof r.when === 'string' && r.when.length > 0
    const hasPat = typeof r.pattern === 'string' && r.pattern.length > 0
    t.assert(hasWhen !== hasPat, `${r._file} ${r.id}：恰有 when 或 pattern 之一（when=${hasWhen} pattern=${hasPat}）`)
  }

  // ═══ G3：单规则命中语料行数 > 20 ⇒ 过宽 ═══
  const corpus = corpusTexts()
  t.assert(corpus.length >= 2, `语料至少 2 份（实际 ${corpus.length}：${corpus.map((c) => c.name).join(', ')}）`)
  const allLines = corpus.flatMap((c) => evidenceLines(c.text))
  t.assert(allLines.length > 300, `语料证据行数 > 300（实际 ${allLines.length}）`)
  const over = []
  const hitCount = new Map()
  for (const r of rules) {
    const re = reOf(r) || metricReOf(r)
    if (!re) continue
    const n = allLines.filter((l) => { re.lastIndex = 0; return re.test(l) }).length
    hitCount.set(r.id, n)
    if (n > 20) over.push(`${r.id}(${n} 行)`)
  }
  t.assert(over.length === 0, `G3 无过宽规则（命中 >20 行）：${over.join(', ') || 'none'}`)

  // ═══ G4：when 不得命中插件自述文本 ═══
  const narration = narrationCorpus()
  t.assert(narration.length >= 20, `自述语料自动抽取成功（实际 ${narration.length} 条）`)
  const selfHits = []
  for (const r of rules) {
    const re = reOf(r) || metricReOf(r)
    if (!re) continue
    for (const line of narration) {
      re.lastIndex = 0
      if (re.test(line)) { selfHits.push(`${r.id} ← "${line.slice(0, 40)}"`); break }
    }
  }
  t.assert(selfHits.length === 0, `G4 无规则命中自述文本：${selfHits.join(' | ') || 'none'}`)
  // #49 专项：那条提示行已去掉触发词
  t.assert(!narration.some((l) => /kScaleBlkStride|block_table|blockId/.test(l)), '#49：探针提示行已不含规则触发词')

  // #55 专项：**采集脚本自身**的 shell 报错混入报告时，不得被任何规则当成服务行为
  //（真机报告实测：`grep: write error: Broken pipe` 把 engine 配置行截断并混入）
  const collectorArtifact = '(EngineCore pid=98) INFO Initializing a V1 LLM engine with config: enable_chunked_prefilgrep: write error: Broken pipe'
  const artifactHits = rules.filter((r) => {
    const re = reOf(r) || metricReOf(r)
    return re && (re.lastIndex = 0, re.test(collectorArtifact))
  }).map((r) => r.id)
  t.assert(artifactHits.length === 0, `#55 采集脚本 shell 报错不得触发规则：${artifactHits.join(', ') || 'none'}`)
  const r6 = rules.find((r) => r.id === 'rc-out-006')
  t.assert(!!r6 && (new RegExp(r6.when, 'i')).test('upstream connect error: Broken pipe'),
    '#55 修 narrow 后服务侧 `broken pipe` 仍然命中（不是把整条分支砍掉）')

  // ═══ G6（静态半）：正则字段不得含"未声明的双反斜杠"——死分支 ═══
  // 背景（缺陷 #54，2026-09-28 实测）：`qualitative-rules.yaml` 是唯一把 `\s`/`\{`/`\.` 写成
  // `\\s`/`\\{`/`\\.` 的文件。在 YAML 单引号标量里反斜杠**不是转义字符**，故这些分支等价于
  // "匹配一个字面反斜杠"，**永远命中不了**——rg-qual-002 三条分支全死，该规则在任何输入下都不触发。
  // 唯一合法的双反斜杠是"故意匹配 JSON 转义后的字面文本"（如 rc-out-004 的 `\ufffd`），须显式声明。
  {
    const dead = []
    const reFields = (r) => {
      const out = []
      for (const k of ['when', 'pattern']) if (typeof r[k] === 'string') out.push([k, r[k]])
      if (r.causal && typeof r.causal.closurePattern === 'string') out.push(['causal.closurePattern', r.causal.closurePattern])
      for (const q of (r.requires || [])) if (q && typeof q.when === 'string') out.push(['requires.when', q.when])
      for (const q of (r.falsifiedBy || [])) if (q && typeof q.when === 'string') out.push(['falsifiedBy.when', q.when])
      for (const i of ((r.computeCheck && r.computeCheck.inputs) || [])) if (i && typeof i.pattern === 'string') out.push(['computeCheck.inputs.pattern', i.pattern])
      return out
    }
    for (const r of rules) {
      if (r.literalBackslash === true) continue
      for (const [field, pat] of reFields(r)) {
        if (pat.includes('\\\\')) dead.push(`${r.id}.${field}`)
      }
    }
    t.assert(dead.length === 0,
      `G6 无死分支（正则字段不得含未声明的双反斜杠）：${dead.join(', ') || 'none'}`)
    const exempt = rules.filter((r) => r.literalBackslash === true).map((r) => r.id)
    t.assert(exempt.length === 1 && exempt[0] === 'rc-out-004',
      `G6 双反斜杠豁免名单恰好是 rc-out-004（实际：${exempt.join(',') || 'none'}）——豁免不得扩散`)
  }

  // ═══ G6b：每条规则必须有**能被自身 when 命中的正例**（逐分支覆盖）═══
  // 背景（缺陷 #54）：G3 查"命中太多"、G4 查"命中自述文本"、G6 查"静态双反斜杠"，
  // **没有任何一条门禁问"这条规则还能不能命中"**。死分支的表现是"命中 0 行"，
  // 恰好是既有门禁的盲区——`rg-qual-002` 三条分支全死、规则静默失效，就是这么漏过去的。
  {
    const whenRules = rules.filter((r) => typeof r.when === 'string' && r.when.length > 0)
    t.assert(whenRules.length >= 55, `G6b 参与检查的 when 规则数合理（实际 ${whenRules.length}）`)

    const noExample = []
    const bothFields = []
    const exemptReasons = []
    const missingAlt = []
    const badExample = []
    const dupExample = []
    let exampleCount = 0

    for (const r of whenRules) {
      const hasEx = r.signalExample !== undefined
      const hasEm = r.signalExampleExempt !== undefined
      if (!hasEx && !hasEm) noExample.push(r.id)
      if (hasEx && hasEm) bothFields.push(r.id)

      if (hasEm) {
        // 豁免必须"显式声明 + 有实质理由 + 有资格"，三者缺一即 FAIL
        const why = String(r.signalExampleExempt).trim()
        if (why.length < 20) exemptReasons.push(`${r.id}(理由过短)`)
        if (!ABSENCE_MARKER.test(r.when)) exemptReasons.push(`${r.id}(when 不含缺席标记，无豁免资格)`)
        if (!EXEMPT_ALLOWLIST.has(r.id)) exemptReasons.push(`${r.id}(不在豁免白名单)`)
        continue
      }
      if (!hasEx) continue

      const exs = Array.isArray(r.signalExample) ? r.signalExample : [r.signalExample]
      exampleCount += exs.length
      const re = new RegExp(r.when, 'i')
      for (const e of exs) {
        const es = typeof e === 'string' ? e.trim() : ''
        if (es.length < 4 || new Set(es).size < 2) { badExample.push(`${r.id}(${JSON.stringify(e)} 过短/无信息)`); continue }
        re.lastIndex = 0
        if (!re.test(e)) badExample.push(`${r.id} ← ${JSON.stringify(e)} 命中不了自身 when`)
      }
      if (new Set(exs).size !== exs.length) dupExample.push(r.id)

      // 逐分支覆盖：每个顶层分支都必须被至少一个示例命中
      for (const alt of splitTopAlternatives(r.when)) {
        let altRe
        try { altRe = new RegExp(alt, 'i') } catch { continue }
        const covered = exs.some((e) => { altRe.lastIndex = 0; return typeof e === 'string' && altRe.test(e) })
        if (!covered) missingAlt.push(`${r.id} ← 分支 /${alt.slice(0, 44)}/ 无正例`)
      }
    }

    t.assert(noExample.length === 0, `G6b 每条 when 规则要么有 signalExample、要么显式声明豁免：${noExample.join(', ') || 'none'}`)
    t.assert(bothFields.length === 0, `G6b 不得同时声明 signalExample 与豁免：${bothFields.join(', ') || 'none'}`)
    t.assert(exemptReasons.length === 0, `G6b 豁免资格与理由合法：${exemptReasons.join(', ') || 'none'}`)
    t.assert(badExample.length === 0, `G6b 每个 signalExample 都能命中自身 when 且足够具体：\n      ${badExample.join('\n      ') || 'none'}`)
    t.assert(dupExample.length === 0, `G6b 同一规则内示例不重复：${dupExample.join(', ') || 'none'}`)
    t.assert(missingAlt.length === 0, `G6b 逐分支覆盖（每个顶层分支都有正例）：\n      ${missingAlt.join('\n      ') || 'none'}`)

    const exemptIds = whenRules.filter((r) => r.signalExampleExempt !== undefined).map((r) => r.id).sort()
    t.assert(exemptIds.length === EXEMPT_ALLOWLIST.size,
      `G6b 豁免数恰为 ${EXEMPT_ALLOWLIST.size}（实际 ${exemptIds.length}：${exemptIds.join(',')}）——不允许静默增长`)
    t.assert(exemptIds.every((id) => EXEMPT_ALLOWLIST.has(id)), 'G6b 豁免名单与白名单逐条一致')
    t.assert(exampleCount >= 200, `G6b 正例总量 ≥200（实际 ${exampleCount}，覆盖 ${whenRules.length - exemptIds.length} 条规则）`)

    // pattern 型（B 阈值）规则同样必须有正例，且能抽出数字（与 regression-contract ⑦ 同源，此处计入 G6b 口径）
    const patRules = rules.filter((r) => typeof r.pattern === 'string' && r.pattern.length > 0)
    t.assert(patRules.every((r) => typeof r.signalExample === 'string' && r.signalExample.length > 0),
      `G6b pattern 型规则全部带 signalExample（${patRules.length} 条）`)
    // ═══ G6b-2（C12 修订版变体）：可分离分支必须有**独占**示例；结构性重叠必须显式登记 ═══
    // 背景：只要求"分支被某个示例命中"是偏松的——示例可能"顺手"命中多个分支，
    // 让某分支看起来被覆盖、实际从没有专为它写的示例。变体用「见证串」做三分类：
    //   ① 可分离（W(B) 只命中 B）  ⇒ 必须有独占示例，否则 FAIL（可修：换个更专的示例）
    //   ② 结构性重叠（W(B) 命中多分支）⇒ 必须在 DECLARED_OVERLAPS 显式登记（不许静默通过）
    //   ③ 合成器失败 ⇒ FAIL（否则作者可用"合成器不认识的写法"绕过 ①②）
    // 本仓目标形态：③ 为 0、② 为空集（= 没有任何分支需要豁免）。
    const DECLARED_OVERLAPS = new Set([])
    {
      const needExclusive = []
      const undeclared = []
      const synthFail = []
      let branchTotal = 0
      let nSeparable = 0
      let nOverlap = 0

      for (const r of whenRules) {
        if (r.signalExampleExempt !== undefined) continue
        const exs = Array.isArray(r.signalExample) ? r.signalExample : [r.signalExample]
        const alts = splitTopAlternatives(r.when)
        const altRes = alts.map((a) => { try { return new RegExp(a, 'i') } catch { return null } })
        const hitIdx = (e) => altRes.map((o, j) => (o && (o.lastIndex = 0, o.test(e)) ? j : -1)).filter((x) => x >= 0)
        alts.forEach((alt, i) => {
          branchTotal += 1
          let w = null
          try { w = synthesize(alt) } catch { w = null }
          // 允许单字符见证：`rc-out-004` 的替换字符分支本身就是 1 个字符（U+FFFD）
          const wOk = typeof w === 'string' && w.length >= 1 && altRes[i] && (altRes[i].lastIndex = 0, altRes[i].test(w))
          if (!wOk) { synthFail.push(`${r.id} /${String(alt).slice(0, 40)}/`); return }
          const hits = hitIdx(w)
          const witnessExclusive = hits.length === 1 && hits[0] === i
          if (witnessExclusive) {
            nSeparable += 1
            const hasExclusive = exs.some((e) => { const k = hitIdx(e); return k.length === 1 && k[0] === i })
            if (!hasExclusive) needExclusive.push(`${r.id} /${String(alt).slice(0, 40)}/ (见证串 ${JSON.stringify(w)})`)
          } else {
            nOverlap += 1
            if (!DECLARED_OVERLAPS.has(`${r.id}::${alt}`)) {
              undeclared.push(`${r.id} /${String(alt).slice(0, 40)}/ 同时命中 ${hits.map((k) => alts[k].slice(0, 22)).join(' + ')}`)
            }
          }
        })
      }

      t.assert(synthFail.length === 0,
        `G6b-2 合成器必须能为每个分支合成见证串（否则作者可绕过独占性要求，请扩展 tests/lib/regex-witness.mjs）：\n      ${synthFail.join('\n      ') || 'none'}`)
      t.assert(needExclusive.length === 0,
        `G6b-2 可分离分支必须有**独占**示例（该示例只命中它、不命中其它分支）：\n      ${needExclusive.join('\n      ') || 'none'}`)
      t.assert(undeclared.length === 0,
        `G6b-2 结构性重叠分支必须显式登记（不许静默通过）：\n      ${undeclared.join('\n      ') || 'none'}`)
      t.assert(DECLARED_OVERLAPS.size === 0,
        `G6b-2 白名单必须为空集（红线 4：非空说明还有未识别的重叠，应停下回报；实际 ${DECLARED_OVERLAPS.size} 条）`)
      t.assert(branchTotal >= 230, `G6b-2 参与检查的顶层分支数合理（实际 ${branchTotal}）`)
      console.log(`   G6b-2 分支三分类：可分离 ${nSeparable} / 结构性重叠 ${nOverlap} / 合成失败 ${synthFail.length}；白名单 ${DECLARED_OVERLAPS.size} 条（空集为目标形态）`)
    }

    console.log(`   G6b 正例：${whenRules.length - exemptIds.length} 条规则 / ${exampleCount} 个示例；显式豁免 ${exemptIds.length} 条；pattern 型 ${patRules.length} 条`)
  }

  // ═══ G7：B 定性规则的可算阈值判据必须真的可算（缺陷 #53 回归） ═══
  // rg-qual-003 旧形态 `…[ \t]+[0-9.]+` 匹配**任意**占用率数值，假设却是"接近打满"——
  // 数值出现了却没有比较。现改为 computeCheck 阈值判据，此处锁死其行为边界。
  {
    const q3 = rules.find((r) => r.id === 'rg-qual-003')
    t.assert(!!q3 && q3.judgement === 'quantitative', 'G7 rg-qual-003 判 quantitative（判据是数值比较，不是关键词存在）')
    t.assert(!!q3.computeCheck && typeof q3.computeCheck.assert === 'string' && /90/.test(q3.computeCheck.assert),
      `G7 rg-qual-003 携带显式阈值判据（实际 assert：${q3 && q3.computeCheck ? q3.computeCheck.assert : 'none'}）`)
    const q4 = rules.find((r) => r.id === 'rg-qual-004')
    t.assert(!!q4 && q4.judgement === 'contextual', 'G7 rg-qual-004 仍判 contextual（命中率为 0 也可能来自启动初期/无共享前缀）')
    t.assert(!/\[0-9\.\]\+/.test(q4.when) && /0\(\?:\\\.0\+\)\?/.test(q4.when),
      'G7 rg-qual-004 的 when 只判"命中率为 0"（下界），不再匹配任意数值')
  }

  // ═══ G8：文档单源——docs/judgement-review.md 必须等于由 assets 重新生成的结果 ═══
  // 背景（缺陷 #56）：该文档原先手写维护，于是成了规则判据的**第二真源**——
  // 71 条 / decisive 13 的现实下文档仍写 72 / 14，且已删除的 rc-conf-oom-trace 仍在清单里。
  {
    const want = renderReview()
    const p = join(PKG_ROOT, 'docs', 'judgement-review.md')
    const have = existsSync(p) ? readFileSync(p, 'utf8') : null
    t.assert(have === want,
      'G8 docs/judgement-review.md 与 assets 一致（单源；不一致请运行 node scripts/gen-judgement-review.mjs）')
    t.assert(/请勿手改/.test(have || ''), 'G8 文档顶部声明"由脚本生成、请勿手改"')
  }

  // ═══ G5：contextual 候选不得得到「已证明」 ═══
  {
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-g5-'))
    const core = createCore({ pkgRoot: PKG_ROOT, storageDir: join(tmp, 's'), persist: false })
    // 构造：让一条 contextual 规则（量化配置字段出现）拿到 **2 条以上不同 section 的证据**，
    // 这正是旧实现会误判为「已证明」的形态
    const ev = [
      { id: 'ev-001', section: 'model-config', sourceFile: 'model-config', line: 3, snippet: '"quant_method": "ascend"', hash: 'sha256:a' },
      { id: 'ev-002', section: 'vllm-serving-args', sourceFile: 'vllm-serving-args', line: 9, snippet: '--quantization ascend', hash: 'sha256:b' },
      { id: 'ev-003', section: 'engine-log', sourceFile: 'engine-log', line: 4, snippet: 'quantization=compressed-tensors', hash: 'sha256:c' },
    ]
    const r = core.diagnoseService({ evidence: ev, dimensions: { framework: 'vllm', runtime: 'docker', hardware: 'ascend-arm' }, context: { round: 1, sessionId: 'g5' } })
    const produced = [...r.data.rootCauses, ...(r.data.closure.weakSignals || [])]
    t.assert(produced.length > 0, 'G5：构造用例确实产出了候选')
    const ctx = produced.filter((x) => x.judgement === 'contextual')
    t.assert(ctx.length > 0, 'G5：构造用例里有 contextual 候选')
    for (const rc of ctx) t.assert(rc.confidence !== '已证明', `G5：contextual 候选 ${rc.id} 不得为「已证明」（实际 ${rc.confidence}）`)
    rmSync(tmp, { recursive: true, force: true })
  }

  // 汇总（可见输出，便于审阅）
  const top = [...hitCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  console.log(`   档位分布：decisive ${counts.decisive} / quantitative ${counts.quantitative} / contextual ${counts.contextual}`)
  console.log(`   语料：${corpus.length} 份 / ${allLines.length} 行；自述语料：${narration.length} 条`)
  console.log(`   命中最多的规则：${top.map(([id, n]) => `${id}=${n}`).join(', ')}`)
}
