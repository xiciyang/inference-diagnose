/**
 * @xiciyang/inference-diagnose —— 插件入口。
 *
 * 注册五个模型工具（§2）：
 *   generate_collect_script  生成定制采集脚本（内嵌脱敏）
 *   parse_collect_report     解析脱敏报告 + 二次脱敏校验（全程内存）
 *   diagnose_service         A 服务异常诊断（崩溃/启动失败/挂起/被外部杀/资源耗尽/输出异常）
 *   diagnose_regression      B 性能劣化诊断（客户提供基线；无基线 → 降级为定性诊断）
 *   diagnose_consistency     C 一致性诊断（能复现 → 检出非确定性；不能复现 → 查环境差异）
 *
 * 本文件只做"装配 + 契约映射"：业务逻辑全在 src/primitives / engine / session。
 * createCore() 不依赖 ctx，供测试直接驱动（no-brand-in-core.spec 走这条路径）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { ErrCode, ToolError, ok, toEnvelope, makeVersions, sortNotices } from './protocol/envelope.js'
import { createAbstractionLayer } from './primitives/abstraction-layer.js'
import { loadRules, rulesVersion } from './primitives/desensitizer.js'
import { compose } from './primitives/script-composer.js'
import { parseReport, probeHashes } from './primitives/report-parser.js'
import { loadRuleFiles, match } from './primitives/root-cause-rules.js'
import { loadBaseline } from './primitives/baseline-loader.js'
import { loadRegressionRules, compareMetrics, BASELINE_TYPES } from './primitives/regression-rules.js'
import { loadConsistencyRules, analyzeDeterminism, determinismVerdictCandidates, environmentFingerprint, loadFingerprintKeys } from './primitives/consistency-rules.js'
import { bind } from './primitives/evidence-binder.js'
import { grade, LEVELS } from './primitives/confidence.js'
import { build as buildFix, review } from './primitives/fix-output.js'
import { createHotloader } from './primitives/assets-hotloader.js'
import { createTracker, FORM } from './session/closure-tracker.js'
import { createHashBinder } from './verification/hash-binder.js'
import { detect } from './engine/closure-detector.js'
import { scopedInvalidation } from './primitives/scope-resolver.js'
// A2/A3：治理面（风险分级 + append-only 审计哈希链），单一真源在 src/governance/
import { TOOL_RISK, requiresConfirmation, assertRiskDeclarations, riskManifest } from './governance/risk.js'
import { auditRootFromEnv, recordToolCall, verifyAuditChain, verifyAllAuditChains, auditDirFor } from './governance/audit.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const name = '@xiciyang/inference-diagnose'
export const inject = ['tools']

export const SCHEMA_VERSION = '2'
export const PLUGIN_VERSION = '0.0.1'

/**
 * 工具面真源（A5：命名空间声明）。
 *
 * 五个工具用**裸名**，没有 `inference_` 前缀 —— 这不是疏漏，是刻意的：
 * 推理侧三插件已经把 `inference_serving_*` / `inference_quantization_*` /
 * `inference_tuning_*` 三个前缀占满，本插件与它们**没有功能重叠**
 * （不依赖、不被依赖、不共享状态文件，见 INFERENCE_DIAGNOSE_FACTS §3.5）。
 * 加前缀反而会暗示"同族可互换"，而 `diagnose_service` 与 `inference_tuning_analyze`
 * 不是可互换的东西。
 *
 * 冲突由机器判定而不是靠人眼：`tests/unit/governance.spec.mjs` 会去兄弟包的
 * `src/tools.mjs` / `src/index.mjs` 里把它们的工具名全部抓出来做交集检查 ——
 * 命名空间纪律若只写在注释里，下次谁加个同名工具都不会有人发现。
 */
export const TOOL_NAMES = Object.freeze([
  'generate_collect_script',
  'parse_collect_report',
  'diagnose_service',
  'diagnose_regression',
  'diagnose_consistency',
])

/**
 * 对外根因 id 的**唯一**归一化点（缺陷 C8）。
 *
 * 规则文件里的 id 有 `rc-` 与 `rg-` 两族（前者是 A/C 范式与所有根因规则，后者是 B 范式的
 * `rg-perf-*` / `rg-acc-*` / `rg-qual-*`），但**对外 id 空间统一带 `rc-` 前缀**。
 * 此前只有主列表/弱信号走归一化，`closure.excludedHypotheses[].id` 与
 * `closure.unmeasuredMetrics[].ruleId` 直接吐原始 ruleId ⇒ 同一条规则在主列表叫
 * `rc-rg-qual-003`、在排除台账叫 `rg-qual-003`，调用方跨层按 id 关联必须自己归一化。
 * 现在所有对外出口共用本函数，跨层 id **直接可比**。
 */
export function publicRuleId(ruleId) {
  const s = String(ruleId)
  return s.startsWith('rc-') ? s : `rc-${s}`
}

/**
 * 构造核心（无 ctx 依赖）。测试与 apply() 共用同一实现 —— 保证"跑通测试的代码
 * 就是注入后跑的代码"。
 */
export function createCore({ pkgRoot = PKG_ROOT, storageDir = null, persist = true, inProcessStore = true, logger = null,
  residenceTimeoutMs = 30 * 60 * 1000 } = {}) {
  const assetsRoot = join(pkgRoot, 'assets')
  const machinePath = join(pkgRoot, 'model', 'loop-controller.machine.yaml')
  // B 范式的**独立**状态机真源（与 A 的拓扑不共享；引擎/脱敏/证据链/会话共享）
  const regressionMachinePath = join(pkgRoot, 'model', 'regression-controller.machine.yaml')
  const layer = createAbstractionLayer({ assetsRoot })
  const binder = createHashBinder({ pkgRoot, schemaVersion: SCHEMA_VERSION })
  const tracker = createTracker({
    storageDir: storageDir === null ? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'inference-diagnose', 'sessions') : storageDir,
    persist,
    inProcessStore,
  })
  const hotloader = createHotloader({ assetsRoot, logger })

  /**
   * `versions.assets` 的唯一来源 = **热加载世代 hash**（全资产树内容）。
   * 2026-09-18 缺陷修复：此前 generate 用 dimension-loader 的"注册表级" hash，
   * 而热加载世代用"全资产" hash —— 同一字段两个来源会破坏四元组绑定与快照语义。
   * 未初始化热加载时（测试/降级）退回注册表级 hash。
   */
  const assetsHashNow = () => hotloader.assetsHash || layer.generationInfo().assetsHash

  const versionsFor = (ruleset) =>
    binder.bind({ rules: ruleset && ruleset.ok ? rulesVersion(ruleset) : 'unavailable', assets: assetsHashNow() })

  // 脱敏规则按**世代**缓存：热加载被拒绝时不失效，从而继续服务上一代（§4.2"保留旧代"）。
  // 若每次调用都直接读盘，一次被拒绝的坏更新（如 rules/ 被删）会让工具立刻 REFUSE，
  // 与"保留旧代 + 记录诊断"的契约不符 —— 2026-09-18 P1 修复。
  let rulesCache = { generation: -1, ruleset: null }

  function currentRules() {
    const gen = hotloader.generation
    if (rulesCache.generation === gen && rulesCache.ruleset && rulesCache.ruleset.ok) return rulesCache.ruleset
    const fresh = loadRules(assetsRoot)
    if (fresh.ok) {
      rulesCache = { generation: gen, ruleset: fresh }
      return fresh
    }
    // 载入失败：世代未变（拒绝路径）→ 保留旧代；世代已变 → 如实返回失败
    if (rulesCache.generation === gen && rulesCache.ruleset && rulesCache.ruleset.ok) return rulesCache.ruleset
    return fresh
  }

  function requireRules() {
    const ruleset = currentRules()
    if (!ruleset.ok) throw ruleset.error
    return ruleset
  }

  // ---------------------------------------------------------------- tool 1
  function generateCollectScript({ description, dimensions }) {
    const versions = versionsFor(null, null)
    if (typeof description !== 'string' || description.trim() === '') {
      throw new ToolError(ErrCode.MISSING_PARAM, {
        missing: ['description'],
        recoverable: true,
        hint: '请用一句话描述崩溃现象（如"推理服务跑一会儿就崩，日志里有 abort"）。',
      })
    }
    const combo = layer.resolve(dimensions) // 注册表不可用 → ERR_DIMENSIONS_NOT_LOADED
    const ruleset = requireRules() // 脱敏规则硬依赖：不发无脱敏脚本
    const v = binder.bind({ rules: rulesVersion(ruleset), assets: assetsHashNow() })
    const { script, manifest } = compose({ assetsRoot, combo, description, ruleset, versions: v })
    return ok({ script, manifest }, v)
  }

  // ---------------------------------------------------------------- tool 2
  function parseCollectReport({ report, manifest }) {
    const ruleset = requireRules() // 二检不可跳过
    const parsed = parseReport({ report, manifest, ruleset })
    // 报告解析绑定**当前世代**（manifest 里的 assets 只用于展示/对比，不作为本次绑定值）
    const v = binder.bind({ rules: rulesVersion(ruleset), assets: assetsHashNow() })
    const notices = []
    if (parsed.parseMeta.missingSections.length > 0) {
      notices.push({
        code: 'report-incomplete',
        text:
          `报告不完整：缺少段 ${parsed.parseMeta.missingSections.join(', ')}（不完整 ≠ 损坏，已照常解析）。` +
          `缺失段的证据不参与跨轮对比；如需补齐请重跑采集脚本中对应探针。`,
      })
    }
    return ok(
      {
        evidence: parsed.evidence,
        parseMeta: parsed.parseMeta,
        desensitizeCheck: parsed.desensitizeCheck,
        probeHashes: probeHashes(parsed.evidence),
      },
      v,
      { notices },
    )
  }

  // ---------------------------------------------------------------- tool 3
  /**
   * A14 驻留限时提醒（§3.2 I7 / §4.4）：
   *   ① 诊断入口检查该会话是否驻留超时 → 超时则追加 `residence-timeout` notice（走既有 notices[] 通道）
   *   ② 出口按结果维护驻留计时：需补采 → 记 AWAITING_COLLECTION；REFUSE → 记 REFUSED；
   *      得到完整修复 → 清除（用户响应/闭环即重置）
   * 说明：notice 在"下次调用该 session 的工具"时出现 —— 本插件没有独立会话打开钩子，
   *       这一点作为实现边界记入文档（不谎称"访问页面即弹"）。
   */
  // §2.1 依赖源矩阵：这些 ErrCode 一律 REFUSE（部分未在 body 里带 policy 标记）
  const REFUSE_CODES = new Set([
    ErrCode.MISSING_PARAM,
    ErrCode.REPORT_CORRUPT,
    ErrCode.DESENSITIZE_RULES_NOT_LOADED,
    ErrCode.ROOTCAUSE_RULES_NOT_LOADED,
    ErrCode.DIMENSIONS_NOT_LOADED,
    ErrCode.TEMPLATE_NOT_LOADED,
    ErrCode.BASELINE_MALFORMED,
  ])
  const isRefuse = (e) =>
    e instanceof ToolError && ((e.body && e.body.policy === 'REFUSE') || REFUSE_CODES.has(e.code))

  /**
   * §4.3 版本漂移 + §4.4 细化 2 会话失效声明（A/B/C 共用，唯一实现）。
   * 两条都走既有 `notices[]` 通道、复用既有 `version-drift` code（D3 复用语义）。
   */
  function versionAndStaleNotices({ context, sessionId }) {
    const out = []
    const priorAssets = context.priorRound && context.priorRound.assets
    const currentAssets = assetsHashNow()
    if (priorAssets && priorAssets !== currentAssets) {
      out.push({
        code: 'version-drift',
        text:
          `本次诊断基于规则版本 assets=${priorAssets}；当前规则版本 assets=${currentAssets}。` +
          `结论可能需要基于新规则复评。`,
      })
    }
    const stale = tracker.staleFor(sessionId)
    if (stale) {
      out.push({
        code: 'version-drift',
        text:
          `本会话既有结论所依据的规则/资产已更新（${stale.reason}，generation=${stale.generation}），` +
          `可能需复评；本次诊断按当前版本重新绑定。`,
      })
    }
    return out
  }

  /**
   * §4.4 多轮语义（A/B 共用，唯一实现）：返回 effectiveRound，并把降级条目 push 进 degradations。
   *   B2 无任何存储 / B1 仅进程内且无历史 → 降级为单轮（正常返回 + 降级声明，**不是** REFUSE）
   *   A 形态但缺 priorRound → ERR_MISSING_PARAM（用户可补）
   */
  function applyRoundSemantics({ context, form, degradations }) {
    const wantRound = Number(context.round || 1)
    if (wantRound < 2) return wantRound
    if (context.priorRound) return wantRound
    if (form === FORM.B2) {
      degradations.push({
        kind: 'capability-unavailable',
        capability: 'cross-round-evidence-diff',
        reason: 'no-persistent-store',
        effects: ['round-reset-1', 'recollection-degraded'],
        note: '宿主未提供状态存储：无法读取上一轮证据 hash。',
      })
      return 1
    }
    if (form === FORM.B1) {
      degradations.push({
        kind: 'capability-unavailable',
        capability: 'cross-round-evidence-diff',
        reason: 'history-missing',
        effects: ['round-reset-1', 'history-unavailable'],
        note: '进程内存储中没有该会话的上一轮记录（进程曾重启或会话为新）。',
      })
      return 1
    }
    throw new ToolError(ErrCode.MISSING_PARAM, {
      missing: ['context.priorRound'],
      recoverable: true,
      hint: '第 2 轮诊断需上一轮证据 hash 清单（context.priorRound.evidenceHashesBefore）。',
    })
  }

  /**
   * 候选 → rootCauses（A/B/C **共用，唯一实现**）。四件事，顺序不可换：
   *   ① 证据绑定：无证据候选**不产出**（§2.4 minItems:1 的代码侧落点）
   *   ② 三档置信度 + fix 三态（单向约束由 confidence/fix-output 强制）
   *   ③ 需要定向补采脚本时生成脚本 —— 此时脱敏规则是**硬依赖**（fail-closed）
   *   ④ 输出前复查：不满足契约即整轮拒绝输出（ERR_INTERNAL，不静默降级）
   * 被否证/合取未满足的假设**不静默丢弃**：进 `excludedHypotheses` 台账（可追溯、可撤回）。
   * @returns {{rootCauses:Array, excludedHypotheses:Array}}
   */

  /**
   * closure 组装（A/B/C **唯一实现**）：闭环判定只看**主列表**（弱信号不构成结论），
   * 弱信号与排除台账一律随 closure 返回；主列表为空而弱信号非空时，理由必须说清
   * （否则会显示成"没有任何候选"，把"只有弱信号"误报成"什么都没查出来"）。
   */
  function buildClosure({ rootCauses, weakSignals, excludedHypotheses, extras = {} }) {
    const base = detect(rootCauses)
    const closure = { ...base }
    if (rootCauses.length === 0 && weakSignals.length > 0) {
      closure.reason = `主列表为空：${weakSignals.length} 条候选未达主列表门槛（判据为存在性/上下文关键词），已放入弱信号区待展开`
      closure.weakOnly = true
    }
    closure.weakSignals = weakSignals
    closure.excludedHypotheses = excludedHypotheses
    return { ...closure, ...extras }
  }

  /** 分层计数（用户可见层必须"折叠但不隐藏"）：返回 { text, counts }。 */
  function layeringCounts({ rootCauses, weakSignals, excludedHypotheses, unmeasured = 0 }) {
    const byTier = (t) => rootCauses.filter((x) => x.judgement === t).length
    const gaps = rootCauses.filter((x) => x.fix === null).length
    const counts = {
      total: rootCauses.length + weakSignals.length,
      main: rootCauses.length,
      decisive: byTier('decisive'),
      quantitative: byTier('quantitative'),
      gapDeclarations: gaps,
      weak: weakSignals.length,
      excluded: excludedHypotheses.length,
      unmeasured,
    }
    const text =
      `共 ${counts.total} 条候选：主列表 ${counts.main} 条` +
      `（决定性 ${counts.decisive} / 数值判据 ${counts.quantitative} / 证据缺口声明 ${counts.gapDeclarations}）` +
      `＋弱信号 ${counts.weak} 条（存在性/上下文关键词，已折叠在 closure.weakSignals，**未隐藏**）` +
      `＋排除台账 ${counts.excluded} 条（closure.excludedHypotheses）` +
      (counts.unmeasured > 0 ? `；另有 ${counts.unmeasured} 个指标不可测` : '')
    return { text, counts }
  }

  function assembleRootCauses({ candidates, evidence, combo, ruleset, v }) {
    const bound = bind(candidates, evidence)
    const excludedHypotheses = bound
      .filter((c) => c.excluded === true)
      .map((c) => ({
        id: publicRuleId(c.ruleId),
        hypothesis: c.hypothesis,
        excludedBy: c.methodology ? c.methodology.excludedBy : null,
        falsifiersAbsent: c.methodology ? c.methodology.falsifiedBy.filter((f) => f.absent).map((f) => f.when) : [],
        requiresUnmet: c.methodology ? c.methodology.requires.filter((r) => !r.matched).map((r) => r.when) : [],
        computed: c.methodology ? c.methodology.computed : null,
        // B 范式专有（嵌套；A 路径为 undefined，字段不出现，旧行为不变）
        ...(c.methodology && c.methodology.comparison ? { comparison: c.methodology.comparison } : {}),
      }))

    // 候选 → 输出对象（**主列表与弱信号共用同一构造器**：弱信号不是摘要，
    // 它保留完整证据与 fix，只是不进主列表。见 docs/judgement-rubric.md §5）
    const buildOne = (c) => {
      const confidence = grade(c)
      const built = buildFix({ candidate: c, confidence, combo })
      const m = c.methodology || null
      return {
        id: publicRuleId(c.ruleId),
        hypothesis: c.hypothesis,
        confidence,
        judgement: c.judgement || 'contextual',
        evidence: c.evidence,
        fix: built.fix,
        additionalCollection: built.additionalCollection,
        // 方法论元数据（嵌套字段，非顶层）：合取/否证/可算判据/因果闭环/结构标注/基线对比
        methodology: m
          ? {
              requires: m.requires,
              falsifiedBy: m.falsifiedBy,
              computed: m.computed,
              causal: m.causal,
              structural: m.structural,
              ...(m.comparison ? { comparison: m.comparison } : {}),
            }
          : null,
      }
    }

    // 分层规则（rubric §5）：
    //   主列表 = decisive + quantitative + **全部 fix:null 的缺口声明**
    //   弱信号 = 其余 contextual（存在性/上下文关键词——在健康服务器上也必然命中）
    const isGap = (c) => c.fixSpec === null
    const toMain = (c) => isGap(c) || (c.judgement || 'contextual') !== 'contextual'
    const kept = bound.filter((c) => c.excluded !== true)
    const rootCauses = kept.filter(toMain).map(buildOne)
    const weakSignals = kept.filter((c) => !toMain(c)).map(buildOne)

    // 若需要定向补采**脚本** → 脱敏规则此时成为硬依赖（脚本必须内嵌脱敏）。
    // 注意：combo === null（B/C 未提供 dimensions）时**不生成脚本**，只给文字指引，
    // 因此脱敏规则不构成硬依赖 —— 否则会把"没给维度"误报成"脱敏规则不可用"。
    const allOutputs = [...rootCauses, ...weakSignals]
    const needsScript = combo !== null && allOutputs.some((rc) => rc.additionalCollection)
    if (needsScript && !ruleset.ok) {
      throw new ToolError(ErrCode.DESENSITIZE_RULES_NOT_LOADED, {
        affected: ['desensitize'],
        policy: 'REFUSE',
        recoverable: true,
        hint:
          '本轮诊断需要生成定向补采脚本，而脱敏规则不可用：拒绝生成未内嵌脱敏的脚本（fail-closed）。' +
          '请先修复 assets/rules/ 后重试（纯文字诊断不需要脚本，可在规则缺失时进行）。',
      })
    }
    if (needsScript) {
      for (const rc of allOutputs) {
        if (!rc.additionalCollection) continue
        const wanted = rc.additionalCollection.needed.map((n) => n.probe)
        if (wanted.length === 0) continue // 规则未声明探针：不给脚本，交给文字建议
        const filtered = { ...combo, probes: combo.probes.filter((p) => wanted.includes(p.probe)) }
        const { script } = compose({
          assetsRoot,
          combo: filtered.probes.length ? filtered : combo,
          description: `targeted re-collect for ${rc.id}`,
          ruleset,
          versions: v,
        })
        rc.additionalCollection.script = script
      }
    }

    // 输出前复查对**两层都做**：弱信号同样要满足 fix 形态与证据链契约
    const problems = review(allOutputs)
    if (problems.length > 0) {
      throw new ToolError(ErrCode.INTERNAL, {
        message: '输出前复查失败（fix 形态 / 证据链不满足接口契约）',
        details: problems,
        recoverable: false,
        hint: `以下候选不满足契约，已拒绝输出：${problems.map((p) => `${p.id}:${p.why}`).join('；')}`,
      })
    }
    return { rootCauses, weakSignals, excludedHypotheses }
  }

  function diagnoseService(input) {
    const sessionId = (input && input.context && input.context.sessionId) || 'default'
    const timeoutNotice = (() => {
      const r = tracker.residenceOf(sessionId)
      if (!r || r.ageMs < residenceTimeoutMs) return null
      // 阈值可被测试压到秒级；文案不得把 <1 分钟谎报成 "0 分钟"
      const fmt = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60000)} 分钟`)
      // 计时口径声明（D3：语义改变须在用户可见层穷尽声明）：
      //   A 形态 = 跨进程持久化 → 计时与"进入驻留态的真实时刻"一致，无需限定；
      //   B1/B2  = 仅进程内 → 进程重启会丢失起点、计时随之重置，**实际驻留可能远长于所示值**。
      //   故必须在文案里给出限定词，否则用户会据"已 5 分钟"误判"还早"。
      const timingBasis = tracker.form() === FORM.A ? '' : '（进程内计时）'
      return {
        code: 'residence-timeout',
        text:
          `本会话自进入驻留态「${r.state}」${timingBasis}已 ${fmt(r.ageMs)}（阈值 ${fmt(residenceTimeoutMs)}）：` +
          `仍在等待你的动作（执行采集/补采脚本并粘贴报告，或修复依赖后重试）。` +
          `这不是静默等待——请尽快响应，或显式结束该会话。`,
      }
    })()
    let result
    try {
      result = diagnoseInner(input)
    } catch (e) {
      if (isRefuse(e)) tracker.markResidence(sessionId, 'REFUSED')
      throw e
    }
    const needsCollection = result.data.rootCauses.some((rc) => rc.additionalCollection)
    if (needsCollection) tracker.markResidence(sessionId, 'AWAITING_COLLECTION')
    else tracker.clearResidence(sessionId)
    if (timeoutNotice) {
      result.data.notices = sortNotices([...(result.data.notices || []), timeoutNotice])
    }
    return result
  }

  function diagnoseInner({ evidence, dimensions, context = {} }) {
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new ToolError(ErrCode.MISSING_PARAM, {
        missing: ['evidence'],
        recoverable: true,
        hint: 'diagnose 需要 parse_collect_report 返回的 data.evidence（非空数组）。',
      })
    }
    const form = tracker.form()
    const sessionId = context.sessionId || 'default'
    const wantRound = Number(context.round || 1)
    const degradations = []
    const extraNotices = versionAndStaleNotices({ context, sessionId })
    const effectiveRound = applyRoundSemantics({ context, form, degradations })

    const combo = layer.resolve(dimensions)
    // 脱敏规则：diagnose 的纵深复查是软依赖（可降级），但补采脚本路径是硬依赖（见下）
    const ruleset = currentRules()
    if (ruleset.ok) {
      const joined = evidence.map((e) => String(e.snippet || '')).join('\n')
      const hits = []
      for (const r of ruleset.rules) {
        r.re.lastIndex = 0
        const m = joined.match(r.re)
        if (m) hits.push({ field: r.field, line: evidence[0].line, maskedSnippet: `${String(m[0]).slice(0, 2)}***` })
      }
      if (hits.length > 0) {
        throw new ToolError(ErrCode.DESENSITIZE_MISS, {
          policy: 'REFUSE',
          hits,
          recoverable: true,
          hint: '进推理前纵深复查命中疑似未脱敏内容（片段已打码）：已在内存中拒绝，不落盘。请重新脱敏后重试。',
        })
      }
    } else {
      degradations.push({
        kind: 'check-skipped',
        check: 'desensitize-recheck',
        reason: 'desensitize-rules-unavailable',
        effects: ['assurance-reduced'],
        note: '纵深复查未执行（parse 时点二检仍为硬闸门，未被跳过）。',
      })
    }

    const { rules } = loadRuleFiles(assetsRoot, combo) // 硬依赖：无规则不推测
    const v = binder.bind({ rules: `root-causes:${combo.dims.framework}/${combo.dims.hardware}`, assets: assetsHashNow() })

    const { rootCauses, weakSignals, excludedHypotheses } = assembleRootCauses({
      candidates: match(rules, evidence),
      evidence,
      combo,
      ruleset,
      v,
    })
    const closure = buildClosure({ rootCauses, weakSignals, excludedHypotheses })
    const lay = layeringCounts({ rootCauses, weakSignals, excludedHypotheses })
    const summary =
      `${lay.text}。` +
      (rootCauses.length === 0
        ? '主列表为空：请补充证据或按提示补采。'
        : rootCauses.map((rc) => `${rc.id}=${rc.confidence}`).join('；') +
          `；闭环状态=${closure.closure}（${closure.reason}）`)

    return ok(
      {
        effectiveRound,
        rootCauses,
        summary,
        closure,
        ...(effectiveRound !== wantRound ? { requestedRound: wantRound } : {}),
      },
      v,
      { degradations, notices: extraNotices },
    )
  }

  // ---------------------------------------------------------------- tool 4（B 性能劣化）
  /**
   * diagnose_regression —— 性能劣化诊断。
   *
   * 设计要点（用户 2026-09-28 裁决）：
   *   - 不做常驻、不做基线自动采集、不做告警：**用户触发，一次给基线**，插件无状态
   *   - 基线由调用方传入（JSON/CSV），**不落盘、不缓存**
   *   - 基线**不可用（未提供）** → 按 §2.1 D0–D3 判据走**能力降级**（定性诊断），不是 REFUSE：
   *       D0 仍可产出非空结论（"当前为什么慢"）／D1 无明文／D2 置信度如实／D3 语义改变在 notices 声明
   *   - 基线**提供了但非法** → ERR_BASELINE_MALFORMED（REFUSE，与 ERR_REPORT_CORRUPT 同构）
   *   - 返回信封与 diagnose_service **完全同构**（不新增顶层字段）：
   *       定量对比进 `rootCauses[].methodology.comparison`（嵌套）；
   *       未达阈值的假设进 `closure.excludedHypotheses`；
   *       不可测量的指标进 `closure.unmeasuredMetrics`。
   */
  function diagnoseRegression(input = {}) {
    if (typeof input.report !== 'string' || input.report.trim() === '') {
      throw new ToolError(ErrCode.MISSING_PARAM, {
        missing: ['report'],
        recoverable: true,
        hint: 'diagnose_regression 需要当前采集报告原文（以 === 段落标记 === 开头的文本）。',
      })
    }
    const baselineType = input.baselineType
    if (!BASELINE_TYPES.includes(baselineType)) {
      throw new ToolError(ErrCode.MISSING_PARAM, {
        missing: ['baselineType'],
        recoverable: true,
        hint: `baselineType 必须是 ${BASELINE_TYPES.join(' | ')} 之一（当前：${String(baselineType)}）。它决定启用哪一套规则分区。`,
      })
    }

    const context = input.context || {}
    const sessionId = input.sessionId || context.sessionId || 'default'
    const form = tracker.form()
    const degradations = []
    const extraNotices = versionAndStaleNotices({ context, sessionId })
    const effectiveRound = applyRoundSemantics({ context, form, degradations })

    const ruleset = requireRules() // 报告解析的二检不可跳过
    const parsed = parseReport({ report: input.report, manifest: input.manifest, ruleset })
    if (parsed.parseMeta.missingSections.length > 0) {
      extraNotices.push({
        code: 'report-incomplete',
        text:
          `报告不完整：缺少段 ${parsed.parseMeta.missingSections.join(', ')}（不完整 ≠ 损坏，已照常解析）。` +
          `缺失段的证据不参与对比；如需补齐请重跑采集脚本中对应探针。`,
      })
    }

    // 三分支：未提供 → 降级；提供了但非法 → REFUSE；成功 → 定量
    const baselineInfo = loadBaseline(input.baseline)
    const qualitative = baselineInfo === null
    const { metricRules, qualitativeRules } = loadRegressionRules(assetsRoot, baselineType, { qualitative })

    // 可选 dimensions：仅用于把规则声明的 needsProbes 解析成**定向补采脚本**
    let combo = null
    if (input.dimensions) combo = layer.resolve(input.dimensions)

    const v = binder.bind({ rules: `root-causes:regression/${baselineType}`, assets: assetsHashNow() })
    let candidates = []
    let unmeasured = []
    let comparisons = []
    let path

    if (qualitative) {
      path = 'qualitative'
      comparisons = [{ status: 'baseline-absent', reason: '调用方未提供 baseline：无法做定量对比' }]
      degradations.push({
        kind: 'capability-unavailable',
        capability: 'performance-baseline-diff',
        reason: 'baseline-unavailable',
        effects: ['qualitative-mode'],
        note: '未提供基线：本次只做定性诊断（"当前为什么慢"），不产出劣化幅度。',
      })
      candidates = match(qualitativeRules, parsed.evidence)
    } else {
      path = 'quantitative'
      const cmp = compareMetrics({ metricRules, evidence: parsed.evidence, baseline: baselineInfo, baselineType })
      candidates = [...cmp.fired, ...cmp.excluded]
      unmeasured = cmp.unmeasured
      comparisons = cmp.comparisons
    }

    const { rootCauses, weakSignals, excludedHypotheses } = assembleRootCauses({
      candidates,
      evidence: parsed.evidence,
      combo,
      ruleset,
      v,
    })
    const closure = buildClosure({
      rootCauses,
      weakSignals,
      excludedHypotheses,
      extras: {
        // ruleId 与 rootCauses/weakSignals/excludedHypotheses 的 id 同处一个对外 id 空间（C8）
        ...(unmeasured.length > 0
          ? { unmeasuredMetrics: unmeasured.map((u) => ({ ...u, ruleId: publicRuleId(u.ruleId) })) }
          : {}),
        baseline: qualitative
          ? { status: 'unavailable', source: null, metricCount: 0, path }
          : { status: 'used', source: baselineInfo.source, metricCount: baselineInfo.metricCount, path },
      },
    })
    const lay = layeringCounts({ rootCauses, weakSignals, excludedHypotheses, unmeasured: unmeasured.length })

    const head =
      path === 'quantitative'
        ? `基线类型=${baselineType}（来源 ${baselineInfo.source}，${baselineInfo.metricCount} 个指标）；` +
          `已对比 ${comparisons.filter((c) => ['warn', 'critical', 'within-threshold'].includes(c.status)).length} 个指标，` +
          `其中 ${comparisons.filter((c) => ['warn', 'critical'].includes(c.status)).length} 个越阈、` +
          `${comparisons.filter((c) => c.status === 'within-threshold').length} 个在阈值内、` +
          `${comparisons.filter((c) => String(c.status).startsWith('metric-')).length} 个指标不可测。`
        : `未提供基线 → **定性诊断**（只答"当前为什么慢"，不产出劣化幅度）；请提供 baseline 以恢复定量对比。`
    const summary =
      `${head} ${lay.text}。` +
      (rootCauses.length === 0
        ? '主列表为空：请补充证据或按提示补采。'
        : rootCauses.map((rc) => `${rc.id}=${rc.confidence}`).join('；') +
          `；闭环状态=${closure.closure}（${closure.reason}）`)

    return ok(
      {
        effectiveRound,
        rootCauses,
        summary,
        closure,
        ...(effectiveRound !== Number(context.round || 1) ? { requestedRound: Number(context.round || 1) } : {}),
      },
      v,
      { degradations, notices: extraNotices },
    )
  }

  // ---------------------------------------------------------------- tool 5（C 一致性）
  /**
   * diagnose_consistency —— 一致性诊断（最小可用实现）。
   *
   * 两条路径由**报告里已采集的信号**决定，不由用户选择：
   *   ① 能复现（有同一输入的多份采样）→ 比对指纹，检出非确定性
   *   ② 不能复现 → 不臆断，列出必须逐项比对的环境维度（驱动/固件、硬件批次、并发配置），
   *      并显式声明"非确定性在原理上不可判定"
   * 复用 A 的状态机（loop-controller），**不新增状态机**（用户 2026-09-28 裁决）。
   * 返回信封与 diagnose_service 同构；路径判据进 `closure.consistency`（嵌套）。
   */
  function diagnoseConsistency(input = {}) {
    if (typeof input.report !== 'string' || input.report.trim() === '') {
      throw new ToolError(ErrCode.MISSING_PARAM, {
        missing: ['report'],
        recoverable: true,
        hint: 'diagnose_consistency 需要当前采集报告原文（以 === 段落标记 === 开头的文本）。',
      })
    }
    const context = input.context || {}
    const sessionId = input.sessionId || context.sessionId || 'default'
    const extraNotices = versionAndStaleNotices({ context, sessionId })
    const degradations = []
    const effectiveRound = applyRoundSemantics({ context, form: tracker.form(), degradations })

    const ruleset = requireRules()
    const parsed = parseReport({ report: input.report, manifest: input.manifest, ruleset })
    if (parsed.parseMeta.missingSections.length > 0) {
      extraNotices.push({
        code: 'report-incomplete',
        text: `报告不完整：缺少段 ${parsed.parseMeta.missingSections.join(', ')}（不完整 ≠ 损坏，已照常解析）。`,
      })
    }
    const { rules } = loadConsistencyRules(assetsRoot)
    let combo = null
    if (input.dimensions) combo = layer.resolve(input.dimensions)

    const det = analyzeDeterminism(parsed.evidence)
    // 指纹键名走 L1 数据（src/ 零品牌硬编码）
    const env = environmentFingerprint(parsed.evidence, loadFingerprintKeys(assetsRoot))
    const v = binder.bind({ rules: 'root-causes:consistency', assets: assetsHashNow() })

    // 两条来源合并：
    //   ① 规则正则（when）—— 单行证据可判的机制
    //   ② 数值推导（determinismVerdictCandidates）—— 聚合判据（指纹去重计数）无法用正则表达，
    //      由 L1 里 `derivedBy: samples-distinct` 的规则槽提供文案/修复，代码只填数。
    // 派生槽必须从 ① 中剔除，否则它的 when 会在任何有采样的报告上重复命中。
    const verdictCmp = determinismVerdictCandidates(det, rules)
    const { rootCauses, weakSignals, excludedHypotheses } = assembleRootCauses({
      candidates: [
        ...verdictCmp.fired,
        ...verdictCmp.excluded,
        ...match(rules.filter((r) => r.derivedBy !== 'samples-distinct'), parsed.evidence),
      ],
      evidence: parsed.evidence,
      combo,
      ruleset,
      v,
    })
    const closure = buildClosure({ rootCauses, weakSignals, excludedHypotheses })
    const lay = layeringCounts({ rootCauses, weakSignals, excludedHypotheses })
    closure.consistency = {
      path: det.path,
      verdict: det.verdict,
      reason: det.reason,
      sampleCount: det.samples.length,
      distinctHashes: new Set(det.samples.map((s) => s.hash)).size,
      signals: det.signals,
      environment: {
        fingerprints: env.found,
        missing: env.missing,
        note:
          det.path === 'reproducible'
            ? '已走复现路径：环境指纹仅作旁证'
            : '未走复现路径：请把下列指纹与"正常环境"逐项比对（缺项即不可判定）',
      },
    }
    const summary =
      `一致性路径=${det.path}（判定 ${det.verdict}）：${det.reason}。${lay.text}。` +
      (rootCauses.length === 0
        ? ' 主列表为空。'
        : ' ' + rootCauses.map((rc) => `${rc.id}=${rc.confidence}`).join('；'))

    return ok(
      {
        effectiveRound,
        rootCauses,
        summary,
        closure,
        ...(effectiveRound !== Number(context.round || 1) ? { requestedRound: Number(context.round || 1) } : {}),
      },
      v,
      { degradations, notices: extraNotices },
    )
  }

  return {
    assetsRoot,
    machinePath,
    regressionMachinePath,
    layer,
    tracker,
    hotloader,
    generateCollectScript,
    parseCollectReport,
    diagnoseService,
    diagnoseRegression,
    diagnoseConsistency,
    currentRules,
    scopedInvalidation: (changedPaths, prevHashes, combo) =>
      scopedInvalidation({ assetsRoot, changedPaths, combo, prevHashes }),
    residence: {
      timeoutMs: residenceTimeoutMs,
      of: (sessionId) => tracker.residenceOf(sessionId),
      list: () => tracker.listResidence(),
      clear: (sessionId) => tracker.clearResidence(sessionId),
    },
    markStaleAndInvalidate: (changedPaths, info) => {
      const result = tracker.markAllStale(info)
      layer.invalidate()
      rulesCache = { generation: hotloader.generation, ruleset: null }
      const fresh = currentRules()
      // 摊平返回：调用方直接拿 marked（会话 id 数组）+ rulesReloaded
      return { ...result, rulesReloaded: !!fresh.ok, changedPaths: changedPaths || [] }
    },
    status: () => ({ form: tracker.form(), hotloader: hotloader.status(), assetsRoot, sessions: tracker.listSessions() }),
    // A2：把风险声明真源也挂到 core 上，让测试不必 import 两个地方
    risk: riskManifest,
    // A3：审计自检入口（无新增工具 —— A2/A5 都把工具面钉死在 5 个裸名上，
    // 故复算链走 core/脚本，不占工具位）
    governance: {
      auditDir: (root = auditRootFromEnv()) => auditDirFor(root),
      verifyChain: (opts = {}) => verifyAuditChain(opts.root || auditRootFromEnv(), opts),
      verifyAll: (opts = {}) => verifyAllAuditChains(opts.root || auditRootFromEnv()),
    },
  }
}

// ---------------------------------------------------------------- cordis apply
export function apply(ctx) {
  const core = createCore({ logger: ctx.logger })
  try {
    core.hotloader.init()
    ctx.logger?.info?.(`[${name}] 资产世代已装载：${JSON.stringify(core.hotloader.status())}`)
  } catch (e) {
    // 资产初始校验失败不阻塞插件装配：工具调用会以对应错误码 fail-closed 返回
    ctx.logger?.warn?.(`[${name}] 资产初始校验失败（工具将以 fail-closed 响应）：${String(e.message).slice(0, 200)}`)
  }

  // A2：装配期就校验"声明面 ⇄ 工具面"一致 —— 声明漂移必须在挂载时响亮失败，
  // 而不是等到审计时才发现某个工具没有风险声明。
  assertRiskDeclarations(TOOL_NAMES)

  // A3：只读操作也留痕。落点 ~/.ai-infra/logs/audit/inference-diagnose/<date>.jsonl
  const auditRoot = auditRootFromEnv()

  /**
   * 统一的工具调用包装：**唯一**的审计与治理信息注入点。
   *
   * 为什么放在这里而不是各工具内部：留痕与风险声明是**工具面**的属性，
   * 五个 execute 各写一遍必然漂移（改一个漏一个）。放在装配层，
   * "注册了哪些工具"与"留了哪些痕"由同一份清单驱动。
   */
  const runTool = async (toolName, args, fn) => {
    const versions = makeVersions({ plugin: PLUGIN_VERSION, schema: SCHEMA_VERSION, rules: 'unknown', assets: 'unknown' })
    const t0 = Date.now()
    let env
    try {
      env = fn()
    } catch (e) {
      env = toEnvelope(e, versions)
    }
    const rec = await recordToolCall(auditRoot, {
      tool: toolName,
      args,
      envelope: env,
      durationMs: Date.now() - t0,
      pkgVersion: PLUGIN_VERSION,
      assets: env?.versions?.assets ?? null,
      rules: env?.versions?.rules ?? null,
      risk: TOOL_RISK[toolName]?.risk,
    })
    const decl = TOOL_RISK[toolName]
    env.governance = {
      schema: 'inference-diagnose/governance@1',
      risk: decl.risk,
      sandbox: decl.sandbox,
      confirmation: decl.confirmation,
      confirmationRequired: requiresConfirmation(toolName),
      audit: rec.ok
        ? { ok: true, file: rec.file, seq: rec.seq, hash: rec.hash, prevHash: rec.prevHash, auditId: rec.auditId }
        : { ok: false, reason: rec.reason },
    }
    return env
  }

  const OUTPUT = {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }]
    },
  }

  const ctxOf = () => ({ assetsRoot: core.assetsRoot, status: core.status() })
  void ctxOf

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'generate_collect_script',
        description:
          'Generate a customized, self-desensitizing crash-collection script for an LLM inference service. ' +
          'Takes a natural-language problem description plus the three dimensions (framework / runtime / hardware); ' +
          'returns the script (desensitization rules embedded, so plaintext never reaches the report file) and a manifest. ' +
          'Fail-closed: refuses to emit a script when the desensitization rules or the dimension registry are unavailable.',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Natural-language description of the crash/incident.' },
            dimensions: {
              type: 'object',
              description: 'Three-dimension context: { framework, runtime, hardware }.',
              properties: {
                framework: { type: 'string' },
                runtime: { type: 'string' },
                hardware: { type: 'string' },
              },
            },
          },
          required: ['description', 'dimensions'],
        },
        output: OUTPUT,
        async execute(args) {
          const a = args || {}
          return runTool('generate_collect_script', a, () => core.generateCollectScript({ description: a.description, dimensions: a.dimensions }))
        },
      }),
    `${name}: register generate_collect_script`,
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'parse_collect_report',
        description:
          'Parse a pasted, already-desensitized collection report into structured evidence with file/line/snippet/hash, ' +
          'while running a second in-memory desensitization check. Corrupted reports are rejected whole; incomplete reports ' +
          '(missing sections) are accepted and marked in parseMeta.missingSections. Never writes plaintext to disk.',
        parameters: {
          type: 'object',
          properties: {
            report: { type: 'string', description: 'The pasted report text (produced by the generated script).' },
            manifest: { description: 'Optional manifest returned by generate_collect_script (used for structure checks).' },
          },
          required: ['report'],
        },
        output: OUTPUT,
        async execute(args) {
          const a = args || {}
          return runTool('parse_collect_report', a, () => core.parseCollectReport({ report: a.report, manifest: a.manifest }))
        },
      }),
    `${name}: register parse_collect_report`,
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'diagnose_service',
        description:
          'Diagnose a **service anomaly** of an LLM inference service from structured evidence plus the three dimensions. ' +
          'Covers crashes, startup failures, hangs, externally killed processes, resource exhaustion, and output anomalies ' +
          '(garbled / truncated / repeated / semantically wrong output). Every root cause is bound to traceable evidence ' +
          '(file + line + snippet); confidence is graded in three tiers, and each root cause carries a fix in one of three ' +
          'states (complete / partial / null). Unconfirmed causes never carry a fix — they carry concrete additional-collection ' +
          'instructions instead. Fails closed when the root-cause rule library for the combination is unavailable. ' +
          '(For performance degradation vs a customer baseline use diagnose_regression; for consistency/non-determinism use diagnose_consistency.)',
        parameters: {
          type: 'object',
          properties: {
            evidence: { type: 'array', description: 'data.evidence from parse_collect_report (must be non-empty).' },
            dimensions: { type: 'object', properties: { framework: { type: 'string' }, runtime: { type: 'string' }, hardware: { type: 'string' } } },
            context: { type: 'object', description: 'Optional context: { description, round, priorRound }.' },
          },
          required: ['evidence', 'dimensions'],
        },
        output: OUTPUT,
        async execute(args) {
          const a = args || {}
          return runTool('diagnose_service', a, () => core.diagnoseService({ evidence: a.evidence, dimensions: a.dimensions, context: a.context || {} }))
        },
      }),
    `${name}: register diagnose_service`,
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'diagnose_regression',
        description:
          'Diagnose **performance/accuracy degradation** against a customer-supplied baseline. Reads the pasted collection ' +
          'report as the current state, reads the baseline (structured numbers: JSON or CSV), compares metric by metric, and ' +
          'returns root causes with the baseline/current/ratio attached (rootCauses[].methodology.comparison). Hypotheses that ' +
          'stay within threshold are recorded in closure.excludedHypotheses (traceable, retractable) and metrics that could not ' +
          'be measured are listed in closure.unmeasuredMetrics. When **no baseline is supplied** the call does NOT fail: it ' +
          'degrades to a qualitative diagnosis ("why is it slow now") and declares that change through degradations/notices — ' +
          'it just never claims a degradation magnitude. A baseline that IS supplied but cannot be parsed is rejected whole ' +
          '(ERR_BASELINE_MALFORMED), because silently treating a broken baseline as a missing one would hide a user error. ' +
          'Stateless: the baseline is never written to disk or cached.',
        parameters: {
          type: 'object',
          properties: {
            report: { type: 'string', description: 'The current collection report text (already desensitized).' },
            baseline: {
              description:
                'Customer-supplied baseline: structured numbers as JSON ({"ttft_ms":120,...} or {"metrics":{...}}) ' +
                'or as CSV (header must contain metric and value columns). Omit entirely to get a qualitative diagnosis.',
            },
            baselineType: { type: 'string', enum: ['performance', 'accuracy'], description: 'Selects the rule partition.' },
            sessionId: { type: 'string', description: 'Optional session id (reuses the cross-round session for this plugin).' },
            dimensions: {
              type: 'object',
              description:
                'Optional three-dimension context: only used to resolve targeted re-collection SCRIPT probes. ' +
                'Without it, additionalCollection carries textual guidance only (no script).',
              properties: { framework: { type: 'string' }, runtime: { type: 'string' }, hardware: { type: 'string' } },
            },
            context: { type: 'object', description: 'Optional context: { round, priorRound }.' },
          },
          required: ['report', 'baselineType'],
        },
        output: OUTPUT,
        async execute(args) {
          const a = args || {}
          return runTool('diagnose_regression', a, () => core.diagnoseRegression({
            report: a.report,
            baseline: a.baseline,
            baselineType: a.baselineType,
            sessionId: a.sessionId,
            dimensions: a.dimensions,
            context: a.context || {},
          }))
        },
      }),
    `${name}: register diagnose_regression`,
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'diagnose_consistency',
        description:
          'Diagnose **consistency / non-determinism** from the pasted collection report. Two paths, chosen by the evidence ' +
          'already in the report rather than by the caller: (1) reproducible — repeated samples of the same input are present, ' +
          'so their fingerprints are compared and non-determinism is detected (truncation-only differences are ruled out first); ' +
          '(2) not reproducible — nothing is guessed; the environment fingerprints that must be compared item by item (driver/' +
          'firmware versions, hardware batch, concurrency and scheduling config) are listed, and "whether it is non-deterministic" ' +
          'is explicitly declared undecidable rather than reported as "no counterexample". Path verdict lands in closure.consistency ' +
          '(nested). Reuses the service-diagnosis state machine (no separate machine).',
        parameters: {
          type: 'object',
          properties: {
            report: { type: 'string', description: 'The current collection report text (already desensitized).' },
            dimensions: {
              type: 'object',
              description: 'Optional three-dimension context: only used to resolve targeted re-collection SCRIPT probes.',
              properties: { framework: { type: 'string' }, runtime: { type: 'string' }, hardware: { type: 'string' } },
            },
            sessionId: { type: 'string', description: 'Optional session id.' },
            context: { type: 'object', description: 'Optional context: { round, priorRound }.' },
          },
          required: ['report'],
        },
        output: OUTPUT,
        async execute(args) {
          const a = args || {}
          return runTool('diagnose_consistency', a, () => core.diagnoseConsistency({
            report: a.report,
            dimensions: a.dimensions,
            sessionId: a.sessionId,
            context: a.context || {},
          }))
        },
      }),
    `${name}: register diagnose_consistency`,
  )

  // 资产热加载：watch + 轮询兜底；随 Fiber 清理（§4.2 生命周期）
  ctx.effect(
    () =>
      core.hotloader.watchAndPoll((r) => {
        if (r.changed) {
          core.layer.invalidate()
          ctx.logger?.info?.(`[${name}] 资产热更新：generation=${r.generation} assets=${r.assetsHash}`)
        } else if (r.problems) {
          ctx.logger?.warn?.(`[${name}] 资产热更新被拒绝（保留 generation=${r.keptGeneration}）：${r.problems.join('；')}`)
        }
      }),
    `${name}: assets hotloader`,
  )

  ctx.logger?.info?.(`[${name}] 五工具已注册（storage form=${core.tracker.form()}）`)
}
