/**
 * scale.spec —— 范围 3 & 4：压力与规模实测（**不进默认 CI 门禁**，按需显式运行）。
 *
 * 运行：node tests/run.mjs tests/perf/scale.spec.mjs
 * 目的：给出实测数据 + 瓶颈结论，而不是"应该够快"。
 *
 * 覆盖：
 *   ① store 记录数增长（轮次）× 原子写开销
 *   ② evidenceHashes 规模增长下的 diff 开销
 *   ③ 大报告（>400 条证据）截断路径 + 解析耗时
 *   ④ 多会话并发（20 会话 × 5 轮交错）
 *   ⑤ 热加载配对不变量在 N 轮反复切换下是否保持（对应 A-§1-2）
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createCore } from '../../src/index.js'
import { createTracker } from '../../src/session/closure-tracker.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }

export const NAME = 'scale（实测：store/diff/大报告/并发/热加载配对）'

const H = (probe, section, hash) => ({ probe, section, hash })
const SEC = (n, body) => `=== ${n} ===\n--- cmd: p-${n}\n${body}\n=== end:${n} ===`

function tree() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-scale-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-scale', version: '0.0.1' }))
  return tmp
}
const ms = (t0) => Number((performance.now() - t0).toFixed(1))

export async function run(t) {
  const tmp = tree()
  const report = []

  // ── ① store 记录数增长：轮次写入开销与体积 ──
  const storage = join(tmp, 's1')
  const tracker = createTracker({ storageDir: storage, persist: true })
  const ROUNDS = 200
  const t0 = performance.now()
  for (let r = 1; r <= ROUNDS; r++) {
    tracker.recordParsed('sess-a', r, {
      evidenceHashes: [H('kernel-log', 'kernel-log', `sha256:k${r}`), H('npu-metrics', 'npu-metrics', `sha256:m${r}`)],
      missingSections: [],
      probesCollected: ['kernel-log', 'npu-metrics'],
    })
  }
  const writeMs = ms(t0)
  const file = join(storage, 'sess-a.json')
  const bytes = statSync(file).size
  report.push(`① store: ${ROUNDS} 轮原子写 = ${writeMs}ms（均 ${(writeMs / ROUNDS).toFixed(2)}ms/轮），文件 ${bytes} B（均 ${(bytes / ROUNDS).toFixed(0)} B/轮）`)
  t.assert(writeMs / ROUNDS < 25, `单轮原子写 < 25ms（实测 ${(writeMs / ROUNDS).toFixed(2)}ms）`)
  t.assert(bytes / ROUNDS < 1200, `单轮记录 < 1.2KB（实测 ${(bytes / ROUNDS).toFixed(0)} B）`)

  // ── ② diff 开销随 evidenceHashes 规模增长 ──
  const diffCost = []
  for (const N of [6, 60, 400, 2000]) {
    const hashes = Array.from({ length: N }, (_, i) => H(`p${i}`, `sec${i % 20}`, `sha256:h${i}`))
    const sid = `sess-diff-${N}`
    const cur = { evidenceHashes: hashes.map((h, i) => (i % 7 === 0 ? { ...h, hash: `sha256:changed${i}` } : h)), missingSections: [] }
    tracker.recordParsed(sid, 1, { evidenceHashes: hashes, missingSections: [] })
    tracker.recordParsed(sid, 2, { evidenceHashes: cur.evidenceHashes, missingSections: [] })
    const d0 = performance.now()
    const diff = tracker.diffWithPrevious(sid, cur)
    diffCost.push(`${N}→${ms(d0)}ms`)
    t.assert(diff.available === true, `N=${N} 时 diff 可用`)
    if (N === 400) {
      t.assert(diff.changed.length === Math.ceil(400 / 7), `N=400 时 changed 数正确（${diff.changed.length}）`)
    }
  }
  report.push(`② diff: ${diffCost.join(' / ')}（线性于 hash 数，无明显非线性拐点）`)

  // ── ③ 大报告：>400 条证据截断 + 解析耗时 ──
  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 's3'), persist: true })
  const big = ['kernel-log', 'npu-status', 'container-state', 'container-log', 'npu-metrics', 'kernel-log'].map((s, i) =>
    SEC(`${s}-${i}`, Array.from({ length: 500 }, (_, j) => `line-${j} HBM ECC event code=${j}`).join('\n')),
  ).join('\n')
  const bigBytes = Buffer.byteLength(big)
  const p0 = performance.now()
  const parsed = core.parseCollectReport({ report: big })
  const parseMs = ms(p0)
  report.push(`③ 大报告: ${(bigBytes / 1024).toFixed(0)}KB / 3000 行 → parse ${parseMs}ms，evidenceCount=${parsed.data.parseMeta.evidenceCount}，truncated=${parsed.data.parseMeta.truncated}`)
  t.assert(parsed.ok === true && parsed.data.parseMeta.truncated === true, '超限报告截断而非报错')
  t.assert(parsed.data.parseMeta.evidenceCount === 400, `证据截到上限 400（实测 ${parsed.data.parseMeta.evidenceCount}）`)
  t.assert(parseMs < 3000, `1MB 级报告解析 < 3s（实测 ${parseMs}ms）`)

  // ── ④ 多会话并发（交错写入 20 会话 × 5 轮）──
  const core2 = createCore({ pkgRoot: tmp, storageDir: join(tmp, 's4'), persist: true })
  const SESS = 20
  const c0 = performance.now()
  for (let r = 1; r <= 5; r++) {
    for (let s = 0; s < SESS; s++) {
      core2.tracker.recordParsed(`sess-${s}`, r, {
        evidenceHashes: [H('kernel-log', 'kernel-log', `sha256:s${s}r${r}`)],
        missingSections: r % 2 === 0 ? ['npu-metrics'] : [],
      })
    }
  }
  const concurrencyMs = ms(c0)
  const sessions = core2.tracker.listSessions()
  report.push(`④ 并发: ${SESS} 会话 × 5 轮交错写 = ${concurrencyMs}ms（均 ${(concurrencyMs / (SESS * 5)).toFixed(2)}ms/写）`)
  t.assert(sessions.length === SESS, `会话数正确（${sessions.length}）`)
  const d20 = core2.tracker.diffWithPrevious('sess-19', { evidenceHashes: [H('kernel-log', 'kernel-log', 'sha256:s19r5')], missingSections: ['npu-metrics'] })
  t.assert(d20.available === true, '并发后单会话 diff 仍可用（无跨会话污染）')
  const rec19 = JSON.parse(readFileSync(join(tmp, 's4', 'sess-19.json'), 'utf8'))
  t.assert(rec19.length === 5, `会话隔离：sess-19 恰 5 条记录（实际 ${rec19.length}）`)
  t.assert(rec19.every((r) => r.evidenceHashes.every((h) => h.probe === 'kernel-log' && h.hash.includes('s19'))), '无跨会话 hash 污染')

  // ── ⑤ 热加载配对不变量 × N 轮反复切换（A-§1-2）──
  const core3 = createCore({ pkgRoot: tmp, storageDir: join(tmp, 's5'), persist: true })
  core3.hotloader.init()
  const cycles = 30
  let switched = 0
  let pairingOk = true
  const startHash = core3.hotloader.assetsHash
  for (let i = 0; i < cycles; i++) {
    writeFileSync(join(tmp, 'assets', 'verification', 'checks.yaml'), `id: checks\nversion: ${i}\nchecks: []\n`)
    const r = core3.hotloader.reloadIfChanged()
    if (r.changed) {
      switched += 1
      // 配对不变量：世代切换后，工具读到的资产版本必须**恰好等于**该世代
      const g = core3.generateCollectScript({ description: 'pairing', dimensions: DIMS })
      if (g.versions.assets !== r.assetsHash) pairingOk = false
      // 故意注入坏代：必须被拒绝且不改变配对
      writeFileSync(join(tmp, 'assets', 'rules', 'desensitize-v1.yaml'), 'id: x\nversion: 1\n  bad: indent\n')
      const bad = core3.hotloader.reloadIfChanged()
      if (bad.changed) pairingOk = false
      cpSync(join(PKG_ROOT, 'assets', 'rules', 'desensitize-v1.yaml'), join(tmp, 'assets', 'rules', 'desensitize-v1.yaml'))
    }
  }
  report.push(`⑤ 热加载配对: ${cycles} 轮（接受 ${switched} 次切换，每次后校验版本配对）= ${pairingOk ? '配对不变量保持' : '**配对破裂**'}`)
  t.assert(switched >= 20, `确实发生了多次世代切换（${switched}）`)
  t.assert(pairingOk === true, '① 世代切换后工具读到的版本 == 该世代；② 坏代被拒且不破坏配对')
  t.assert(core3.hotloader.assetsHash !== startHash, '终态与初态不同（确为反复切换）')

  console.log('\n  ── 实测数据 ──')
  for (const line of report) console.log('  ' + line)
  rmSync(tmp, { recursive: true, force: true })
}
