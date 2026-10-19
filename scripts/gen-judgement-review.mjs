#!/usr/bin/env node
/**
 * gen-judgement-review.mjs —— 从 assets/root-causes/** 生成 docs/judgement-review.md
 *
 * 为什么要有这个生成器（2026-09-28，缺陷 #56）：
 *   `docs/judgement-review.md` 原先**手写**维护，于是它成了规则判据的**第二真源**——
 *   在 71 条 / decisive 13 的现实下，文档仍写着 72 条 / decisive 14，且 `rc-conf-oom-trace`
 *   已合并删除却仍在清单里。手抄必然漂移。
 *   现在：文档**只能**由本脚本生成；`tests/unit/rule-quality-gates.spec.mjs` 的 G8 断言
 *   "重新生成的结果与磁盘上的一致"，漂移即门禁 FAIL。
 *
 * 用法：
 *   node scripts/gen-judgement-review.mjs          # 生成/覆盖 docs/judgement-review.md
 *   node scripts/gen-judgement-review.mjs --check   # 只校验（不一致时 exit 1）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../src/primitives/yaml-lite.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = join(HERE, '..')
const ASSETS = join(PKG_ROOT, 'assets', 'root-causes')
const OUT = join(PKG_ROOT, 'docs', 'judgement-review.md')

/** 规则文件的固定人工顺序（清单按此排列；新增文件须显式加入，不靠目录遍历顺序） */
const FILE_ORDER = [
  'framework-vllm-rules.yaml',
  'framework-mindie-rules.yaml',
  'hardware-ascend-arm-rules.yaml',
  // 2026-09-28 长任务 1 / A1：NVIDIA CUDA 硬件簇 + 宿主资源簇
  'hardware-nvidia-rules.yaml',
  'hardware-host-rules.yaml',
  'runtime-docker-rules.yaml',
  'quality-gibberish-rules.yaml',
  'output-anomaly-rules.yaml',
  'methodology-rules.yaml',
  'regression/performance-rules.yaml',
  'regression/accuracy-rules.yaml',
  'regression/qualitative-rules.yaml',
  'consistency/determinism-rules.yaml',
  'consistency/environment-rules.yaml',
]

export function loadAll() {
  const out = []
  for (const rel of FILE_ORDER) {
    const p = join(ASSETS, rel)
    if (!existsSync(p)) continue
    const doc = parse(readFileSync(p, 'utf8'))
    for (const r of doc.rules || []) out.push({ ...r, _file: rel })
  }
  return out
}

const JUDGEMENT_LABEL = { decisive: 'decisive', quantitative: 'quantitative', contextual: 'contextual' }

/** 判据来源字段（用于 quantitative 表格的"判据字段"列） */
function criterionFields(r) {
  const f = []
  if (r.computeCheck) f.push('computeCheck')
  if (r.derivedBy) f.push('derivedBy')
  if (Number.isFinite(r.warnRatio) || Number.isFinite(r.criticalRatio)) f.push('threshold')
  if (r.causal) f.push('causal')
  return f.length ? f.join(',') : '—'
}

/** contextual 表格的"属性"列：仅标注与分层有关的属性 */
function contextAttrs(r) {
  const f = []
  if (r.fix === null) f.push('fix:null')
  if (r.causal) f.push('causal')
  return f.length ? f.join(',') : '—'
}

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\n/g, ' ')
  return t.length > n ? t.slice(0, n) : t
}
const cell = (s, n) => clip(s, n).replace(/\|/g, '\\|')

/**
 * §四「边界裁决」——**不是**从 assets 推导，而是对已生效裁决的记录。
 * 每条 = 当时的两难 + 最终裁决 + 证据；改动它等于改动裁决记录，须显式提交。
 */
const BOUNDARY_RULINGS = [
  {
    title: '`rc-conf-oom-trace`（methodology）与 `rc-docker-001`（runtime）主张同一机制',
    status: '已关闭（2026-09-28）',
    body: [
      '**裁决**：合并为一条，保留 `rc-docker-001`，删除 `rc-conf-oom-trace`。',
      '**判据**：`rc-conf-oom-trace` 的 `when`（`ExitCode 137|exit code 137|OOMKilled`）是 `rc-docker-001` 的**真子集**；',
      '三组输入（真机语料 / docker 原生渲染 / 显式 OOMKilled）实测命中集合**逐条相同** → 同源，按"同机制不留两条 decisive"删除其一。',
      '保留 runtime 维度的那条，因为它对**全部框架组合**可达（mindie+docker 同样命中），而 methodology 簇只被 vllm 组合引用。',
      '`rc-conf-oom-trace` 的否证条件随之迁入 `rc-docker-001`（只有 137 而无 OOM/SHM 痕迹 → 否证），故合并**未损失**可证伪性。',
      '顺带修复该规则的一个真机盲区：`docker ps -a` 的原生渲染是 `Exited (137)`，两条规则原先**都不匹配**——现已并入并加测试（缺陷 #52）。',
    ].join('\n'),
  },
  {
    title: '`rg-qual-001/002` 判 decisive，而 `rg-qual-003/004` 同类却未判',
    status: '已关闭（2026-09-28）',
    body: [
      '**裁决**：003 改为 `quantitative` 并携带显式阈值判据；004 保持 `contextual` 但把 `when` 收窄到"命中率为 0"这一无需基线的下限事实。',
      '**003 的阈值来源**：不是新定的领域判断——规则自己的 `relevance` 早已写明"占用率进入 90%+ 区间"，',
      '故用 `computeCheck: usage * (1 + (usage <= 1) * 99)` + `assert: (threshold >= 90)` 把它变成**可算、可审计、可撤回**的判据（0–1 分数与百分数两种形态都归一化）。',
      '**004 的"骤降"归属**：该阈值**本就已存在**于 B 定量规则 `rg-perf-004`（`metric=prefix_cache_hit_rate`，`warnRatio 1.25` / `criticalRatio 1.6`，方向 lower-worse），',
      '故 004 不再重复主张"骤降"，只在 `relevance` 里指名移交——**没有新造任何阈值**。',
      '**连带缺陷**：修 003/004 时发现 `regression/qualitative-rules.yaml` 是唯一把 `\\s`/`\\{`/`\\.` 写成双反斜杠的文件，',
      '在该 YAML 引号约定下这些分支等价于"匹配一个字面反斜杠"，**永远命中不了**（`rg-qual-002` 三条分支全死，任何输入都不触发）→ 缺陷 #54；',
      '并由新增门禁 **G6**（正则字段不得含未声明的双反斜杠）锁死，A 路径同类的 3 处死分支一并修复。',
    ].join('\n'),
  },
]

export function render() {
  const rules = loadAll()
  const by = (j) => rules.filter((r) => r.judgement === j)
  const decisive = by('decisive')
  const quant = by('quantitative')
  const ctx = by('contextual')
  const L = []

  L.push(`# 规则判据分级清单（${rules.length} 条，供抽样复核）`)
  L.push('')
  L.push('> **本文件由 `scripts/gen-judgement-review.mjs` 从 `assets/root-causes/**` 生成，请勿手改。**')
  L.push('> 手改会在门禁 G8（文档单源）上失败：重新生成的结果必须与磁盘上的一致。')
  L.push('>')
  L.push('> 本表列的是**规则文件里的 id**（`rc-*` 与 `rg-*` 两族）。**对外 id 统一加 `rc-` 前缀**')
  L.push('> （缺陷 C8；唯一归一化点在 `src/index.js` 的 `publicRuleId`）：规则文件里的 `rg-qual-003`')
  L.push('> 在 `rootCauses[]`/`weakSignals[]`/`excludedHypotheses[]`/`unmeasuredMetrics[]` 里一律是 `rc-rg-qual-003`。')
  L.push('')
  L.push('**口径**：`docs/judgement-rubric.md`（判定顺序 ① `fix:null` → contextual ② 有可算判据 → quantitative ③ `when` 每一分支皆事实本身 → decisive ④ 其余 → contextual）')
  L.push('')
  L.push(`**分布**：decisive ${decisive.length} / quantitative ${quant.length} / contextual ${ctx.length}（合计 ${rules.length}）`)
  L.push('')
  const sampleCount = decisive.length + quant.length
  L.push(`**建议抽样口径（≥30%）**：**全部 ${decisive.length} 条 decisive（逐条核 rationale 是否具体到可构造的字段/取值）** + quantitative 全部 ${quant.length} 条 + contextual 中随机抽取。`)
  L.push('')
  L.push('---')
  L.push('')
  L.push(`## 一、decisive（${decisive.length} 条，逐条附 decisiveRationale）`)
  L.push('')
  for (const r of decisive) {
    L.push(`### \`${r.id}\`  <sub>${r._file}</sub>`)
    L.push('')
    L.push(`- **when**：\`${clip(r.when || r.pattern, 200)}\``)
    if (r.falsifiedBy) L.push(`- **否证条件**：\`${clip(r.falsifiedBy.map((f) => f.when).join(' | '), 200)}\``)
    L.push(`- **rationale（${String(r.decisiveRationale || '').trim().length} 字）**：${String(r.decisiveRationale || '').replace(/\n/g, ' ')}`)
    L.push('')
  }
  L.push('---')
  L.push('')
  L.push(`## 二、quantitative（${quant.length} 条：结论由数值比较得出）`)
  L.push('')
  L.push('| 规则 | 文件 | 判据字段 | when/metric |')
  L.push('|---|---|---|---|')
  for (const r of quant) {
    L.push(`| \`${r.id}\` | ${r._file} | ${criterionFields(r)} | \`${cell(r.when || (r.metric ? `metric:${r.metric}` : ''), 90)}\` |`)
  }
  L.push('')
  L.push('---')
  L.push('')
  L.push(`## 三、contextual（${ctx.length} 条：存在性/上下文关键词；\`fix:null\` 者恒入主列表）`)
  L.push('')
  L.push('| 规则 | 文件 | 属性 | when/metric |')
  L.push('|---|---|---|---|')
  for (const r of ctx) {
    L.push(`| \`${r.id}\` | ${r._file} | ${contextAttrs(r)} | \`${cell(r.when || '', 90)}\` |`)
  }
  L.push('')
  L.push('---')
  L.push('')
  L.push('## 四、边界裁决记录（已生效，供复核）')
  L.push('')
  L.push(`共 ${BOUNDARY_RULINGS.length} 条。每条 = 当时的两难 + 最终裁决 + 支撑证据。`)
  L.push('')
  for (let i = 0; i < BOUNDARY_RULINGS.length; i++) {
    const b = BOUNDARY_RULINGS[i]
    L.push(`### ${i + 1}. ${b.title}`)
    L.push('')
    L.push(`**状态**：${b.status}`)
    L.push('')
    L.push(b.body)
    L.push('')
  }
  L.push('---')
  L.push('')
  const wEx = rules.filter((r) => r.signalExample !== undefined)
  const wEm = rules.filter((r) => r.signalExampleExempt !== undefined)
  const exCount = wEx.reduce((a, r) => a + (Array.isArray(r.signalExample) ? r.signalExample.length : 1), 0)
  L.push(`## 五、正例覆盖（门禁 G6b：每条规则的 when 必须能被自身正例命中，逐分支覆盖）`)
  L.push('')
  L.push(`**覆盖**：${wEx.length} 条规则 / ${exCount} 个正例；**显式豁免** ${wEm.length} 条（证据缺口声明规则）。`)
  L.push('逐分支覆盖的含义：`when` 的**每一个顶层分支**都至少被一个正例命中——只写一条正例挡不住"分支死了一条"。')
  L.push('')
  L.push('| 规则 | 正例（signalExample） |')
  L.push('|---|---|')
  for (const r of wEx) {
    const exs = Array.isArray(r.signalExample) ? r.signalExample : [r.signalExample]
    L.push(`| \`${r.id}\` | ${exs.map((e) => `\`${cell(e, 60)}\``).join(' · ')} |`)
  }
  L.push('')
  L.push('### 显式豁免（`when` 匹配的是"证据缺席"标记，规则本身是缺口声明而非成因主张）')
  L.push('')
  L.push('| 规则 | 豁免理由 |')
  L.push('|---|---|')
  for (const r of wEm) L.push(`| \`${r.id}\` | ${cell(r.signalExampleExempt, 120)} |`)
  L.push('')
  L.push(`**按 rubric §3 仍未定档的规则：无。** ${rules.length} 条全部按判定顺序定档。`)
  L.push('')
  return L.join('\n')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const want = render()
  const check = process.argv.includes('--check')
  const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null
  if (check) {
    if (have === want) {
      console.log('judgement-review.md 与 assets 一致（单源 OK）')
      process.exit(0)
    }
    console.error('judgement-review.md 与 assets **不一致**：请运行 node scripts/gen-judgement-review.mjs 重新生成')
    process.exit(1)
  }
  writeFileSync(OUT, want)
  console.log(`已生成 ${relative(PKG_ROOT, OUT)}（${want.split('\n').length} 行）`)
}
