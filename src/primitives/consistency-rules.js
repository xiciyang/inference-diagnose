/**
 * consistency-rules —— C 范式（一致性）的规则库加载与分析（L2；规则 L1 可热变）。
 *
 * 定位（用户 2026-09-28 裁决）：C 是"服务异常诊断"的第三个子问题，**最小可用实现**，
 * 不做完整复现测试框架；复用 A 的状态机（loop-controller），不新增状态机。
 *
 * 两条路径（由当前报告里已采集的信号决定，不由用户选择）：
 *   ① **能复现**（报告里存在同一输入的多次采样）→ 走"复现路径"：比对多次输出的指纹，
 *      检出非确定性；`DSH-SIGNAL quality.sample.N=core_hash:<h>` / `quality.deterministic` /
 *      `logits.prefill_repeat_consistent` / `tokenizer.roundtrip_ok` 都是判据。
 *   ② **不能复现**（样本不足或信号缺失）→ 走"环境差异路径"：列出必须逐项比对的**环境维度**
 *      （驱动/固件版本、硬件批次、并发与调度配置），并显式声明"非确定性在原理上不可判定"。
 *
 * 硬依赖源：规则文件缺失/为空 → ERR_ROOTCAUSE_RULES_NOT_LOADED（REFUSE）。
 * 规则分区：assets/root-causes/consistency/{determinism-rules.yaml,environment-rules.yaml}
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from './yaml-lite.js'
import { ToolError, ErrCode } from '../protocol/envelope.js'
import { assertJudgements } from './root-cause-rules.js'

const FILES = ['determinism-rules.yaml', 'environment-rules.yaml']

export function loadConsistencyRules(assetsRoot) {
  const rules = []
  const problems = []
  const loaded = []
  const seen = new Map()
  for (const rel of FILES) {
    const p = join(assetsRoot, 'root-causes', 'consistency', rel)
    if (!existsSync(p)) {
      problems.push(`缺 root-causes/consistency/${rel}`)
      continue
    }
    let doc
    try {
      doc = parse(readFileSync(p, 'utf8'))
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rules)) throw new Error('缺少 rules 列表')
    } catch (e) {
      problems.push(`root-causes/consistency/${rel}: 解析失败 ${String(e.message).slice(0, 80)}`)
      continue
    }
    loaded.push(rel)
    for (const r of doc.rules) {
      if (!r || !r.id || !r.when) {
        problems.push(`root-causes/consistency/${rel}: 规则缺少 id/when`)
        continue
      }
      if (seen.has(r.id)) problems.push(`规则 id 重复：${r.id}`)
      else seen.set(r.id, rel)
      rules.push({ ...r, sourceFile: `root-causes/consistency/${rel}`, ruleSet: doc.id || rel, track: rel.startsWith('determinism') ? 'determinism' : 'environment' })
    }
  }
  assertJudgements(rules, 'root-causes:consistency')
  if (problems.length > 0 || rules.length === 0) {
    throw new ToolError(ErrCode.ROOTCAUSE_RULES_NOT_LOADED, {
      affected: ['root-causes:consistency'],
      policy: 'REFUSE',
      recoverable: true,
      hint:
        `一致性（C）规则库不可用：${problems.length ? problems.join('；') : '规则集为空'}。` +
        `拒绝在无规则情况下推测（fail-closed）。请检查 assets/root-causes/consistency/。`,
    })
  }
  return { rules, files: loaded }
}

/**
 * 空字符串的 SHA-256 前 8 位。**退化输入防线**：
 * 2026-09-28 真实端点实测发现，探针在响应不可解析时曾对**空串**取哈希，
 * 8 次失败得到 8 个相同的 `core_hash:e3b0c442` → 分析侧据此得出「确定性」结论，
 * 把"全测失败"伪装成"全部一致"。探针侧已修（改输出 n/a），但分析侧**必须独立防御**：
 * 只要出现这个哨兵值，就不是样本，一律剔除并单独计数（防止探针将来回归）。
 */
export const EMPTY_SHA256_PREFIX = 'e3b0c442'

/** 从 `DSH-SIGNAL key=value` 形式的证据行里取值（可跨段/跨源）。 */
export function signalValue(evidence, key) {
  const re = new RegExp(`DSH-SIGNAL\\s+${key.replace(/\./g, '\\.')}=([^\\s(]+)`)
  for (const ev of evidence) {
    const m = String(ev.snippet || '').match(re)
    if (m) return { value: m[1], ref: ev.id, snippet: ev.snippet }
  }
  return { value: null, ref: null }
}

/**
 * 复现路径判定：把"同一输入的多次采样"指纹收集起来。
 * @returns {{path:'reproducible'|'not-reproducible', verdict:string, samples:Array, signals:object, reason:string}}
 */
export function analyzeDeterminism(evidence) {
  const samples = []
  const degenerate = []
  const seenKeys = new Set()
  const sampleRe = /DSH-SIGNAL\s+quality\.sample\.(\d+)=core_hash:([0-9a-fA-F]+)/
  for (const ev of evidence) {
    const m = String(ev.snippet || '').match(sampleRe)
    if (!m) continue
    // 退化样本：空串哈希哨兵 → 不是样本，不进一致性判定（防"全测失败"被读成"全部一致"）
    if (String(m[2]).toLowerCase().startsWith(EMPTY_SHA256_PREFIX)) {
      degenerate.push({ index: Number(m[1]), hash: m[2], ref: ev.id })
      continue
    }
    const key = `${m[1]}|${m[2]}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    samples.push({ index: Number(m[1]), hash: m[2], ref: ev.id, snippet: ev.snippet })
  }
  const signals = {
    degenerateSamples: degenerate.length,
    deterministic: signalValue(evidence, 'quality.deterministic').value,
    prefillRepeatConsistent: signalValue(evidence, 'logits.prefill_repeat_consistent').value,
    tokenizerRoundtripOk: signalValue(evidence, 'tokenizer.roundtrip_ok').value,
    endpoint: signalValue(evidence, 'quality.probe').value,
  }
  const hashes = new Set(samples.map((s) => s.hash))
  const distinct = hashes.size

  if (samples.length >= 2) {
    if (distinct > 1) {
      return {
        path: 'reproducible',
        verdict: 'nondeterministic',
        samples,
        signals,
        reason: `同一输入的 ${samples.length} 次采样出现 ${distinct} 种不同指纹：**可复现地**检出非确定性（不是采样随机性——同 temp=0 同 seed）`,
      }
    }
    return {
      path: 'reproducible',
      verdict: 'deterministic',
      samples,
      signals,
      reason: `同一输入的 ${samples.length} 次采样指纹完全一致：在本次采样条件下未检出非确定性`,
    }
  }
  if (signals.deterministic === 'false') {
    return { path: 'reproducible', verdict: 'nondeterministic', samples, signals, reason: '判别信号 quality.deterministic=false：temp=0 下两次输出不一致' }
  }
  if (signals.prefillRepeatConsistent === 'false') {
    return { path: 'reproducible', verdict: 'prefill-drift', samples, signals, reason: '判别信号 logits.prefill_repeat_consistent=false：两次完整重算的首 token logprob 不同，**采样前已漂移**' }
  }
  return {
    path: 'not-reproducible',
    verdict: 'insufficient-samples',
    samples,
    signals,
    reason:
      (degenerate.length > 0
        ? `报告中另有 ${degenerate.length} 个**退化样本**（空串哈希 ${EMPTY_SHA256_PREFIX}…，说明响应不可解析）已被剔除，不计入判定；`
        : '') +
      `当前报告只有 ${samples.length} 个可用采样指纹，且无 quality.deterministic / logits.prefill_repeat_consistent 判别信号：` +
      `**"是否非确定"在原理上不可判定**（缺证据，不是"未发现反例"）`,
  }
}

/**
 * 由**数值计算**（而非正则）得出的判定候选 —— "能复现"路径的主结论来源。
 *
 * 为什么不能只靠规则正则：`conditions` 只能对**单条证据行**做正则，无法表达
 * "多条采样指纹的**去重计数** > 1" 这种聚合判据。因此规则文件里用
 * `derivedBy: samples-distinct` 声明一条**数据驱动的规则槽**，由本函数填数：
 *   hypothesis / fix / needsProbes 全部来自 L1 数据，代码只提供数字与证据引用。
 *
 * 三种结局（第三种是防假阳性）：
 *   ① 指纹不一致且无截断解释 → **候选**（真非确定性）
 *   ② 指纹完全一致           → **排除**（kind: samples-identical，可追溯）
 *   ③ 指纹不一致但样本带 finish=length → **排除**（kind: explained-by-truncation）——
 *      截断位置不同会让指纹不同，这不是非确定性；先排除这一整类假阳性。
 */
export function determinismVerdictCandidates(det, rules) {
  const fired = []
  const excluded = []
  const rule = (rules || []).find((r) => r.derivedBy === 'samples-distinct')
  if (!rule || det.samples.length < 2) return { fired, excluded }

  const hashes = new Set(det.samples.map((s) => s.hash))
  const truncated = det.samples.some((s) => /"finish":"?length/.test(String(s.snippet || '')))
  const evidence = det.samples.slice(0, 4).map((s) => ({
    ref: s.ref,
    relevance: `采样 #${s.index} 的输出指纹 core_hash:${s.hash}`,
  }))
  const computed = {
    expr: 'distinct(core_hash)',
    assert: '(threshold <= 1)',
    inputs: { samples: det.samples.length, distinct: hashes.size },
    missingInputs: [],
    value: hashes.size,
    error: null,
    holds: hashes.size > 1,
  }
  const base = {
    ruleId: rule.id,
    ruleSet: rule.ruleSet,
    sourceFile: rule.sourceFile,
    hypothesis: rule.hypothesis,
    needsProbes: Array.isArray(rule.needsProbes) ? [...rule.needsProbes] : [],
    strong: rule.strong === true,
    judgement: rule.judgement,
    evidence,
  }

  if (hashes.size > 1 && !truncated) {
    fired.push({
      ...base,
      fixSpec: rule.fix === null ? null : rule.fix,
      methodology: { status: 'candidate', requires: [], falsifiedBy: [], computed, causal: null, structural: null, excludedBy: [] },
      excluded: false,
    })
    return { fired, excluded }
  }

  const why = hashes.size > 1
    ? {
        kind: 'explained-by-truncation',
        detail: `${det.samples.length} 个采样中出现 finish=length 截断样本：指纹差异可由截断位置解释，不能作为非确定性证据`,
        rationale: '先排除"截断口径不同"这一整类假阳性，再谈非确定性',
      }
    : {
        kind: 'samples-identical',
        detail: `${det.samples.length} 个采样的输出指纹完全一致（distinct=1）`,
        rationale: '判据在本次采样条件下不成立 ⇒ 该假设被排除（可撤回：提高采样数或改变并发条件后重测）',
      }
  excluded.push({
    ...base,
    fixSpec: null,
    methodology: { status: 'excluded', requires: [], falsifiedBy: [], computed, causal: null, structural: null, excludedBy: [why] },
    excluded: true,
  })
  return { fired, excluded }
}

/**
 * 环境差异路径：从报告里抽环境指纹，并列出"必须逐项比对"的环境维度。
 * 不臆断差异（没有基线就没有"差异"），只给可比对的维度与当前取值。
 *
 * 指纹键名来自 **L1 数据** `assets/config/env-fingerprints.json`，不在本文件硬编码：
 * 这些键名带框架/硬件品牌，写死在 src/ 会违反 §3.1 硬约束 1（核心零品牌硬编码），
 * 而且新增采集项就必须改代码。键名属现场可扩展数据 → 走 L1。
 */
export function loadFingerprintKeys(assetsRoot) {
  const p = join(assetsRoot, 'config', 'env-fingerprints.json')
  if (!existsSync(p)) {
    throw new ToolError(ErrCode.ROOTCAUSE_RULES_NOT_LOADED, {
      affected: ['config:env-fingerprints'],
      policy: 'REFUSE',
      recoverable: true,
      hint:
        '环境指纹白名单缺失：assets/config/env-fingerprints.json 不可读。' +
        '拒绝在无判据清单时输出"环境差异"结论（fail-closed）。',
    })
  }
  let doc
  try {
    doc = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    throw new ToolError(ErrCode.ROOTCAUSE_RULES_NOT_LOADED, {
      affected: ['config:env-fingerprints'],
      policy: 'REFUSE',
      recoverable: true,
      hint: `环境指纹白名单非法 JSON：${String(e.message).slice(0, 120)}。`,
    })
  }
  const keys = Array.isArray(doc.keys) ? doc.keys.filter((k) => typeof k === 'string' && k) : []
  if (keys.length === 0) {
    throw new ToolError(ErrCode.ROOTCAUSE_RULES_NOT_LOADED, {
      affected: ['config:env-fingerprints'],
      policy: 'REFUSE',
      recoverable: true,
      hint: '环境指纹白名单为空（assets/config/env-fingerprints.json 的 keys 为空数组）。',
    })
  }
  return keys
}

export function environmentFingerprint(evidence, keys) {
  const found = {}
  const missing = []
  for (const k of keys) {
    const got = signalValue(evidence, k)
    if (got.value !== null) found[k] = got.value
    else missing.push(k)
  }
  return { found, missing }
}
