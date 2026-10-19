/**
 * report-parser —— §2.3 报告解析 + 二次脱敏校验（全程内存，明文不落盘）。
 *
 * 关键分流（§2.3）：
 *   损坏（格式非法/无法解析）      → ERR_REPORT_CORRUPT（整份拒绝）
 *   不完整（合法但缺段/截断）      → ok + parseMeta.missingSections（缺失段不参与跨轮 diff）
 *   二检命中未脱敏内容            → ERR_DESENSITIZE_MISS（仅内存；hits 必为打码片段）
 *   二检规则不可用                → ERR_DESENSITIZE_RULES_NOT_LOADED（二检不可跳过）
 */
import { createHash } from 'node:crypto'
import { ToolError, ErrCode } from '../protocol/envelope.js'
import { scan } from './desensitizer.js'

const MAX_EVIDENCE = 400
const SECTION_RE = /^===\s*(.+?)\s*===$/

export function parseReport({ report, manifest, ruleset }) {
  if (typeof report !== 'string' || report.trim() === '') {
    throw new ToolError(ErrCode.MISSING_PARAM, {
      missing: ['report'],
      recoverable: true,
      hint: '请粘贴完整采集报告（以 === 段落标记 === 开头的文本）。',
    })
  }
  if (!ruleset || !ruleset.ok) {
    throw new ToolError(ErrCode.DESENSITIZE_RULES_NOT_LOADED, {
      affected: ['desensitize'],
      policy: 'REFUSE',
      recoverable: true,
      hint: '二检脱敏规则不可用：二检不可跳过，没有校验就不许解析（fail-closed）。请检查 assets/rules/。',
    })
  }

  const lines = report.split(/\r?\n/)

  // ---- 结构校验：至少能定位到一个段落标记，否则视为损坏（整份拒绝） ----
  const markers = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SECTION_RE)
    if (m) markers.push({ line: i, name: m[1] })
  }
  if (markers.length === 0) {
    throw new ToolError(ErrCode.REPORT_CORRUPT, {
      affected: ['whole-report'],
      policy: 'REFUSE',
      recoverable: true,
      hint:
        '报告整体无法解析：没有找到任何 === 段落标记 ===（编码损坏 / 结构不可定位）。' +
        '请确认粘贴的是采集脚本产出的原文；报告过大请分段（每段 ≤ 200KB）。',
    })
  }

  // ---- 二次脱敏校验（先于证据抽取：命中即拒绝，不进后续任何处理） ----
  const hits = scan(ruleset.rules, report)
  if (hits.length > 0) {
    throw new ToolError(ErrCode.DESENSITIZE_MISS, {
      policy: 'REFUSE',
      hits,
      recoverable: true,
      hint:
        '检测到上述行存在疑似未脱敏内容（片段已打码显示）。原始内容已在内存中拒绝：' +
        '不落盘、不记日志、不回显。请用采集脚本内嵌的脱敏函数重新处理后重新粘贴。',
    })
  }

  // ---- 抽取证据：段内每个非空行一条 ----
  //
  // 2026-09-28（长任务 1 / A1）真机实测缺陷：原先**按文档顺序**吃全局预算，
  // 于是长度不可控的长尾段会把预算吃光，排在它**后面**的段一条证据都进不来。
  // 本机实测（GB10 + 一个在跑的容器）：整份报告 743 行证据，第 400 行落在
  // `container-log`（`docker logs --tail 300` 一次 300 行）内部，于是新增的
  // GPU/宿主硬件段（nv-device / nv-ecc / host-mem / host-limits …）**全部**被
  // 判进 parseMeta.missingSections —— 报告里明明有证据，分析侧却当成缺段。
  // 这正是"已采集 ≠ 已分析"的脱节，且它**只会**在证据多的真机上暴露。
  //
  // 修法：按段**比例配额**分配全局预算，再按段序补满。
  //   quota_i = min(len_i, floor(MAX_EVIDENCE * len_i / T))       （T = 证据总行数）
  //   → 任何非空段都不会因为别的段长而拿到 0；
  //   → 长段仍拿到与其体量相称的最大份额（不是粗暴地一刀切每段 40 行）；
  //   → 全局上限仍是 MAX_EVIDENCE（有界载荷不变），且当 T ≤ MAX 时**逐字节等价**于旧行为。
  // 输出顺序仍是原始行序（按行号排序），对既有消费方（跨轮 diff / 证据绑定）透明。
  const sectionBlocks = []
  const sectionsFound = []
  for (let mi = 0; mi < markers.length; mi++) {
    const start = markers[mi].line
    const end = mi + 1 < markers.length ? markers[mi + 1].line : lines.length
    const name = markers[mi].name
    if (/^end:/.test(name)) continue
    if (!sectionsFound.includes(name)) sectionsFound.push(name)
    const block = []
    for (let i = start + 1; i < end; i++) {
      const text = lines[i].trim()
      if (text === '') continue
      if (SECTION_RE.test(lines[i])) continue
      block.push({ line: i + 1, text })
    }
    sectionBlocks.push({ name, block })
  }

  const T = sectionBlocks.reduce((a, s) => a + s.block.length, 0)
  const quota = sectionBlocks.map((s) => s.block.length)
  if (T > MAX_EVIDENCE) {
    for (let i = 0; i < sectionBlocks.length; i++) {
      quota[i] = Math.min(sectionBlocks[i].block.length, Math.floor((MAX_EVIDENCE * sectionBlocks[i].block.length) / T))
    }
    // 保底：非空段至少 1 行（比例取整可能把它压成 0），但总额不得越界
    let used = quota.reduce((a, n) => a + n, 0)
    for (let i = 0; i < sectionBlocks.length; i++) {
      if (sectionBlocks[i].block.length > 0 && quota[i] === 0 && used < MAX_EVIDENCE) {
        quota[i] = 1
        used += 1
      }
    }
    // 补满：仍有余额则按段序吃满（长段在这里拿回剩余份额）
    let left = MAX_EVIDENCE - used
    for (let i = 0; i < sectionBlocks.length && left > 0; i++) {
      const room = sectionBlocks[i].block.length - quota[i]
      const extra = Math.min(room, left)
      quota[i] += extra
      left -= extra
    }
  }

  const truncated = T > MAX_EVIDENCE
  const picked = []
  for (let i = 0; i < sectionBlocks.length; i++) {
    for (let k = 0; k < quota[i]; k++) picked.push({ name: sectionBlocks[i].name, ...sectionBlocks[i].block[k] })
  }
  picked.sort((a, b) => a.line - b.line)
  const evidence = picked.map((p, idx) => ({
    id: `ev-${String(idx + 1).padStart(3, '0')}`,
    section: p.name,
    sourceFile: subSourceFile(lines[p.line - 1]) || p.name,
    line: p.line,
    snippet: p.text,
    hash: 'sha256:' + createHash('sha256').update(`${p.name}\u0000${p.text}`).digest('hex').slice(0, 16),
  }))

  const expected = manifest && Array.isArray(manifest.sections) ? manifest.sections : []
  const missingSections = expected.filter((s) => !sectionsFound.includes(s))

  return {
    evidence,
    parseMeta: {
      sectionsFound,
      missingSections,
      truncated,
      manifestMissing: !manifest,
      evidenceCount: evidence.length,
    },
    desensitizeCheck: { passed: true, scannedPatterns: ruleset.rules.length, hits: [] },
  }
}

/** 从 "--- cmd: xxx" 行提取来源命令作为 sourceFile（便于证据溯源）。 */
function subSourceFile(line) {
  const m = line.match(/^---\s*cmd:\s*(.+)$/)
  return m ? m[1].trim().slice(0, 80) : null
}

/** 探针粒度证据 hash（§2.4 priorRound / §3.3 closure-tracker 消费）。 */
export function probeHashes(evidence) {
  const bySection = new Map()
  for (const ev of evidence) {
    if (!bySection.has(ev.section)) bySection.set(ev.section, [])
    bySection.get(ev.section).push(ev.hash)
  }
  return [...bySection.entries()].map(([section, hashes]) => ({
    probe: section,
    section,
    hash: 'sha256:' + createHash('sha256').update(hashes.join('\u0000')).digest('hex').slice(0, 16),
  }))
}
