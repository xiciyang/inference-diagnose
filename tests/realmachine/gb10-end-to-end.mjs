#!/usr/bin/env node
/**
 * gb10-end-to-end.mjs —— 真机端到端（**不进 CI**，见本目录 README）。
 *
 * 五步，全在**本机**真跑：
 *   ① 三维组合可解析（维度注册表 + 规则文件就位）
 *   ② 生成采集脚本（内嵌脱敏函数）
 *   ③ **真跑脚本**：写到临时文件、`bash` 执行、拿到真实报告
 *   ④ 解析报告 → 结构化证据
 *   ⑤ 用该组合的规则做一次诊断
 *
 * 出口判据（任一不过即 exit 1）：
 *   - 五步全过
 *   - `parseMeta.missingSections` 为空 —— "报告里有证据"必须等于"分析侧看得见"。
 *     这条判据是有来历的：2026-09-28 真机第一次跑时，证据预算被 container-log 吃光，
 *     排在后面的 nv-* / host-* 段全部被判成缺段（缺陷已修，判据留在这里防回归）。
 *
 * 附加模式 `--controls`：新规则的已知阳性对照（注入故障原文必须命中）+
 *   已知阴性对照（**真机健康输出**必须零命中）。
 *
 * 用法：
 *   node tests/realmachine/gb10-end-to-end.mjs [--skip-collect] [--controls]
 *   INFERENCE_DIMS=ascend-arm node tests/realmachine/gb10-end-to-end.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const OUT = join(HERE, 'out')
const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)

const DIMS = process.env.INFERENCE_DIMS
  ? { framework: process.env.INFERENCE_FRAMEWORK || 'vllm', runtime: process.env.INFERENCE_RUNTIME || 'docker', hardware: process.env.INFERENCE_DIMS }
  : { framework: 'vllm', runtime: 'docker', hardware: 'gb10' }

const failures = []
const step = (n, ok, note) => {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${n}${note ? ` — ${note}` : ''}`)
  if (!ok) failures.push(n)
  return ok
}

mkdirSync(OUT, { recursive: true })
const tmp = join(tmpdir(), `dsh-realmachine-${Date.now()}`)
mkdirSync(tmp, { recursive: true })

const core = createCore({ pkgRoot: PKG_ROOT, storageDir: join(tmp, 'sessions'), persist: false })
const desc = process.env.INFERENCE_DESC || `本机 ${DIMS.hardware} 上 ${DIMS.framework} 服务异常，需要采集证据`

// ── ① 组合可解析 + ② 生成脚本 ──
let gen = null
try {
  gen = core.generateCollectScript({ description: desc, dimensions: DIMS })
  step('① 三维组合可解析并生成脚本', gen.ok === true, `${DIMS.framework}/${DIMS.runtime}/${DIMS.hardware}；sections=${gen.data.manifest.sections.length} probes=${gen.data.manifest.probes.length}`)
} catch (e) {
  step('① 三维组合可解析并生成脚本', false, String(e.message).slice(0, 160))
}
if (!gen || !gen.ok) { console.error('\n组合不可解析 —— 后续步骤无法进行'); process.exit(1) }

const scriptPath = join(OUT, 'collect-script.sh')
const reportPath = join(OUT, 'collect-report.txt')
writeFileSync(scriptPath, gen.data.script, { mode: 0o755 })
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(gen.data.manifest, null, 2))
console.log(`     脚本 → ${scriptPath}（${gen.data.script.length} 字节）`)
console.log(`     rules=${gen.versions.rules} assets=${gen.versions.assets}`)

// ── ③ 真跑 ──
let collected = false
if (!has('--skip-collect')) {
  try {
    const t0 = Date.now()
    execFileSync('bash', [scriptPath, reportPath], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 20 * 60 * 1000,
      env: { ...process.env, THERMAL_SAMPLES: process.env.THERMAL_SAMPLES || '2', THERMAL_INTERVAL: process.env.THERMAL_INTERVAL || '2' },
    })
    const bytes = readFileSync(reportPath).length
    collected = true
    step('③ 真跑采集脚本', bytes > 1000, `${(bytes / 1024).toFixed(0)} KB / ${((Date.now() - t0) / 1000).toFixed(0)}s → ${reportPath}`)
  } catch (e) {
    step('③ 真跑采集脚本', false, String(e.message).slice(0, 160))
  }
} else {
  step('③ 真跑采集脚本', true, '跳过（--skip-collect）')
}

// ── ④ 解析 ──
const report = collected ? readFileSync(reportPath, 'utf8') : null
if (report) {
  const p = core.parseCollectReport({ report, manifest: gen.data.manifest })
  const missing = p.ok ? (p.data.parseMeta.missingSections || []) : ['(parse failed)']
  step('④ 解析报告', p.ok === true && missing.length === 0, `evidence=${p.ok ? p.data.parseMeta.evidenceCount : '-'} truncated=${p.ok ? p.data.parseMeta.truncated : '-'} missingSections=${JSON.stringify(missing)}`)
  // ── ⑤ 诊断 ──
  if (p.ok) {
    const d = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { description: desc, round: 1 } })
    writeFileSync(join(OUT, 'diagnose.json'), JSON.stringify(d, null, 2))
    step('⑤ 诊断', d.ok === true, `closure=${d.data.closure.closure} rootCauses=${d.data.rootCauses.length} weakSignals=${(d.data.closure.weakSignals || []).length}`)
    console.log(`     summary: ${d.data.summary}`)
  }
} else {
  console.log('[SKIP] ④⑤ 无报告（跳过或用 --skip-collect）')
}

// ── 对照（阳性 + 阴性）──
if (has('--controls')) {
  if (!report) { console.log('[SKIP] --controls 需要一份报告'); } else {
    const ids = (d) => [...d.data.rootCauses, ...(d.data.closure.weakSignals || [])].map((x) => x.id)
    const diagnose = (rep) => {
      const p = core.parseCollectReport({ report: rep, manifest: { sections: [] } })
      return core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1 } })
    }
    const nvHost = ids(diagnose(report)).filter((i) => /^rc-(nv|host)-/.test(i))
    step('阴性对照：真机健康输出零命中新规则', nvHost.length === 0, nvHost.join(', ') || 'none')

    const CASES = [
      ['rc-nv-001', 'nv-device', 'NVRM: GPU has fallen off the bus (this may be a hardware failure)'],
      ['rc-nv-002', 'kernel-log', 'NVRM: Xid (PCI:0000:01:00): 79'],
      ['rc-nv-003', 'nv-ecc', '        Volatile\n            DRAM Uncorrectable                         : 3'],
      ['rc-nv-004', 'nv-driver-matrix', 'Failed to initialize NVML: Driver/library version mismatch'],
      ['rc-nv-005', 'nv-device', 'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB'],
      ['rc-host-001', 'kernel-log', 'Out of memory: Killed process 4242 (python3) total-vm:48291632kB'],
      ['rc-host-002', 'kernel-log', 'page allocation failure: order:4, mode:0x40cc0(GFP_KERNEL)'],
      ['rc-host-003', 'host-limits', 'OSError: [Errno 28] No space left on device'],
      ['rc-host-004', 'host-limits', 'bash: fork: Cannot allocate memory'],
    ]
    let hit = 0
    const missed = []
    for (const [id, section, inject] of CASES) {
      const marker = `=== ${section} ===`
      const idx = report.indexOf(marker)
      if (idx < 0) { missed.push(`${id}(无 ${section} 段)`); continue }
      const at = report.indexOf('\n', idx) + 1
      const rep = report.slice(0, at) + inject + '\n' + report.slice(at)
      if (ids(diagnose(rep)).includes(id)) hit += 1
      else missed.push(id)
    }
    step('阳性对照：注入故障原文必须命中', hit === CASES.length, `${hit}/${CASES.length}${missed.length ? `；未命中 ${missed.join(', ')}` : ''}`)
  }
}

writeFileSync(join(OUT, 'result.json'), JSON.stringify({ dims: DIMS, failures, at: new Date().toISOString() }, null, 2))
rmSync(tmp, { recursive: true, force: true })

console.log(failures.length === 0 ? '\n真机端到端：ALL PASSED' : `\n真机端到端：FAILED → ${failures.join(' | ')}`)
process.exit(failures.length === 0 ? 0 : 1)
