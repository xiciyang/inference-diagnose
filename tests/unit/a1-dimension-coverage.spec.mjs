/**
 * a1-dimension-coverage.spec —— 长任务 1 / A1 出口门禁。
 *
 * 覆盖两件此前**没有任何门禁**管的事：
 *   ① 新维度（gb10 / nvidia / cpu）真的能组出组合，且探针集确实包含该硬件的证据源；
 *      —— 只往 dims.json 里加个 id 而忘了配框架/规则文件，会让新维度成为"死条目"
 *      （注册在词表里但 resolveCombo 永远 MISSING_PARAM），此前无人可发现。
 *   ② 新规则的**已知阳性对照 + 已知阴性对照**。
 *      —— 阳性：把规则自带的 signalExample 注进报告，规则必须命中（"仪表有阳性对照"）。
 *      —— 阴性：本机 GB10 的**真实健康输出**（nvidia-smi 表头 `Volatile Uncorr. ECC`、
 *      ECC 计数 `: N/A`）不得触发任何新规则（否则新维度一上线就每次误报硬件故障）。
 *
 * 阴性对照的语料逐字取自 /tmp 真机采集报告（2026-09-28，GB10 + nvidia-smi 580.126.09），
 * 不是构造的假想串。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'
import { createLoader } from '../../src/primitives/dimension-loader.js'
import { parse } from '../../src/primitives/yaml-lite.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')

export const NAME = 'a1-dimension-coverage（新硬件维度可组组合 / 探针覆盖 / 新规则阳性+阴性对照）'

const NEW_RULE_FILES = ['hardware-nvidia-rules.yaml', 'hardware-host-rules.yaml']
const NEW_DIMENSIONS = { hardware: ['gb10', 'nvidia', 'cpu'] }

/** 逐字取自真机报告（GB10，健康态）——这些行**不得**触发任何新规则。 */
const REAL_HEALTHY_GB10 = [
  'DSH-SIGNAL nv.smi.available=true',
  '| NVIDIA-SMI 580.126.09             Driver Version: 580.126.09     CUDA Version: 13.0 |',
  '| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |',
  '|   0  NVIDIA GB10                    On  |   0000000F:01:00.0     On |                  N/A |',
  'DSH-SIGNAL nv.driver.version=580.126.09',
  'DSH-SIGNAL nv.gpu.name=NVIDIA GB10',
  'DSH-SIGNAL nv.compute_cap=12.1',
  '        Current                                        : N/A',
  '            SRAM Uncorrectable Parity                  : N/A',
  '            SRAM Uncorrectable SEC-DED                 : N/A',
  '            DRAM Uncorrectable                         : N/A',
  'DSH-SIGNAL nv.thermal.samples=2 interval=2s',
  '49, Not Active, 12.43 W',
  'DSH-SIGNAL mem.total_kb=131596288',
  'DSH-SIGNAL mem.available_kb=103121408',
  'DSH-SIGNAL ulimit.nofile=1048576',
  'DSH-SIGNAL cgroup.memory.max=max',
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/nvme0n1p2  916G  297G  573G  35% /',
]

const SEC = (name, lines) => `=== ${name} ===\n${lines.join('\n')}\n=== end:${name} ===`

function loadNewRules() {
  const out = []
  for (const rel of NEW_RULE_FILES) {
    const doc = parse(readFileSync(join(PKG_ROOT, 'assets', 'root-causes', rel), 'utf8'))
    for (const r of doc.rules || []) out.push({ ...r, _file: rel })
  }
  return out
}

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-a1-'))
  const core = createCore({ pkgRoot: PKG_ROOT, storageDir: join(tmp, 's'), persist: false })
  const L = createLoader({ assetsRoot: join(PKG_ROOT, 'assets') })
  const vocab = L.listDimensions()

  // ── ① 词表登记 ──
  for (const id of NEW_DIMENSIONS.hardware) {
    t.assert(vocab.hardware.includes(id), `hardware 词表含 ${id}（实际 ${vocab.hardware.join(', ')}）`)
  }
  t.assert(vocab.hardware.includes('ascend-arm'), '新增维度不得挤掉既有维度 ascend-arm')
  t.assert(vocab.runtime.includes('docker'), 'runtime 词表仍覆盖 docker（A1：确认 docker 覆盖）')

  // ── ② GB10 组合可解析且探针覆盖到位 ──
  const gb = L.resolveCombo({ framework: 'vllm', runtime: 'docker', hardware: 'gb10' })
  const probeIds = gb.probes.map((p) => p.probe)
  for (const need of ['nv-device', 'nv-driver-matrix', 'nv-ecc', 'nv-thermal', 'nv-xid', 'nv-topology', 'host-mem', 'host-limits', 'kernel-log']) {
    t.assert(probeIds.includes(need), `gb10 组合含硬件探针 ${need}`)
  }
  for (const need of ['vllm-version', 'vllm-endpoint', 'vllm-log', 'precision-log', 'quality-probe', 'evidence-gaps']) {
    t.assert(probeIds.includes(need), `gb10 组合含框架探针 ${need}（硬件维度不得替换掉框架证据）`)
  }
  t.assert(probeIds.includes('container-state') && probeIds.includes('container-log'), 'gb10 组合含 docker 运行时探针')
  t.assert(gb.ruleFiles.includes('root-causes/hardware-nvidia-rules.yaml') && gb.ruleFiles.includes('root-causes/hardware-host-rules.yaml'),
    'gb10 组合引用两条新规则簇')

  // ── ③ 纯 CPU 组合：有宿主探针、**没有**加速卡探针（不制造噪声证据）──
  const cpu = L.resolveCombo({ framework: 'vllm', runtime: 'docker', hardware: 'cpu' })
  const cpuProbes = cpu.probes.map((p) => p.probe)
  for (const need of ['host-mem', 'host-limits', 'kernel-log', 'cpu-info']) t.assert(cpuProbes.includes(need), `cpu 组合含 ${need}`)
  t.assert(!cpuProbes.some((p) => p.startsWith('nv-') || p.startsWith('npu-')), 'cpu 组合不含任何加速卡探针')
  t.assert(!cpu.ruleFiles.includes('root-causes/hardware-nvidia-rules.yaml'), 'cpu 组合不引用 NVIDIA 规则簇')

  // ── ④ 阳性对照：每条新规则必须能被自己的 signalExample 命中 ──
  const rules = loadNewRules()
  t.assert(rules.length === 9, `新规则 9 条（nvidia 5 + host 4；实际 ${rules.length}）`)
  for (const r of rules) {
    const exs = Array.isArray(r.signalExample) ? r.signalExample : [r.signalExample]
    t.assert(exs.every((e) => typeof e === 'string' && e.length > 0), `${r.id} 声明了非空 signalExample`)
    const report = SEC(`synthetic-${r.id}`, exs)
    const p = core.parseCollectReport({ report, manifest: { sections: [`synthetic-${r.id}`] } })
    const d = core.diagnoseService({ evidence: p.data.evidence, dimensions: { framework: 'vllm', runtime: 'docker', hardware: 'gb10' }, context: { round: 1 } })
    const ids = [...d.data.rootCauses, ...(d.data.closure.weakSignals || [])].map((x) => x.id)
    t.assert(ids.includes(r.id), `${r.id} 阳性对照命中（样例 ${JSON.stringify(exs[0]).slice(0, 60)}）`)
  }

  // ── ⑤ 阴性对照：真实健康 GB10 输出不得触发任何新规则 ──
  const healthy = SEC('nv-device', REAL_HEALTHY_GB10.slice(0, 12)) + '\n'
    + SEC('nv-ecc', REAL_HEALTHY_GB10.slice(7, 12)) + '\n'
    + SEC('host-mem', REAL_HEALTHY_GB10.slice(13)) + '\n'
    + SEC('host-limits', REAL_HEALTHY_GB10.slice(15)) + '\n'
    + SEC('kernel-log', ['[    0.000000] Linux version 6.14.0-generic (buildd@lcy02)'])
  const ph = core.parseCollectReport({ report: healthy, manifest: { sections: [] } })
  const dh = core.diagnoseService({ evidence: ph.data.evidence, dimensions: { framework: 'vllm', runtime: 'docker', hardware: 'gb10' }, context: { round: 1 } })
  const hitIds = [...dh.data.rootCauses, ...(dh.data.closure.weakSignals || [])].map((x) => x.id).filter((i) => /^rc-(nv|host)-/.test(i))
  t.assert(hitIds.length === 0, `健康 GB10 输出零命中新规则（实际命中：${hitIds.join(', ') || 'none'}）`)
  // 阴性对照的阳性哨兵：确认这条链路**真的**能出候选（否则"零命中"可能只是因为整条链路没跑）
  t.assert(ph.data.evidence.length > 0, '阴性对照报告确实产生了证据（否则零命中无意义）')

  rmSync(tmp, { recursive: true, force: true })
}
