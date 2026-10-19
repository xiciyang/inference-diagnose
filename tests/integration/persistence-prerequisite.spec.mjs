/**
 * persistence-prerequisite.spec —— P5 出口门禁之二（§4.4 三形态 A/B1/B2 + 声明按调用时实际降级判定）。
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'
import { createTracker, FORM } from '../../src/session/closure-tracker.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }
const EV = (id, section, line, snippet, sourceFile) => ({ id, section, line, snippet, sourceFile, hash: `sha256:${id}` })
const EVIDENCE = [
  EV('ev-1', 'kernel-log', 10, 'HBM ECC uncorrectable error on device 3', 'dmesg'),
  EV('ev-2', 'container-state', 14, 'ExitCode 137 OOMKilled shm 64m', 'docker inspect'),
]

export const NAME = 'persistence-prerequisite（A/B1/B2 形态 + 降级声明按实际降级判定）'

function tree() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-persist-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-persist', version: '0.0.1' }))
  return tmp
}
const degsOf = (r) => r.data.degradations || []
const notesOf = (r) => r.data.notices || []

export async function run(t) {
  const tmp = tree()

  // ---- 形态判定 ----
  const A = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sA'), persist: true })
  t.assert(A.tracker.form() === FORM.A, `可写目录 → 形态 A（实际 ${A.tracker.form()}）`)
  const B1 = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sB1'), persist: false })
  t.assert(B1.tracker.form() === FORM.B1, `persist:false → 形态 B1（实际 ${B1.tracker.form()}）`)
  const B2 = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sB2'), persist: false, inProcessStore: false })
  t.assert(B2.tracker.form() === FORM.B2, `无任何存储 → 形态 B2（实际 ${B2.tracker.form()}）`)
  // 伪文件系统：**必须快速拒绝**（实测对该前缀 mkdir 会无限阻塞 → 属宿主挂死级缺陷）
  const t0 = Date.now()
  const unwritable = createCore({ pkgRoot: tmp, storageDir: '/proc/dsh-nope/sessions', persist: true })
  const elapsed = Date.now() - t0
  t.assert(unwritable.tracker.form() === FORM.B1, `伪文件系统 → 直接退化 B1（实际 ${unwritable.tracker.form()}）`)
  t.assert(elapsed < 2000, `形态探测在 2s 内返回（实际 ${elapsed}ms，防宿主挂死）`)
  t.assert(unwritable.tracker.probeReason() === 'pseudo-fs-refused', '判定原因标注 pseudo-fs-refused')
  // 父路径是文件（ENOTDIR）：也应快速失败并退化
  writeFileSync(join(tmp, 'not-a-dir'), 'x')
  const notdir = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'not-a-dir', 'sessions'), persist: true })
  t.assert(notdir.tracker.form() === FORM.B1 && notdir.tracker.probeReason() === 'parent-not-a-directory', '父路径是文件 → 快速退化 B1')
  t.assert(typeof A.tracker.listSessions === 'function', 'tracker 暴露 listSessions（供热更新扫描）')

  // ---- A 形态：带 priorRound 的 round≥2 正常，不产生降级 ----
  const a2 = A.diagnoseService({ evidence: EVIDENCE, dimensions: DIMS, context: { round: 2, priorRound: { fixApplied: 'x', assets: A.layer.generationInfo().assetsHash }, sessionId: 'sa' } })
  t.assert(a2.ok === true && a2.data.effectiveRound === 2, 'A 形态 round=2 生效（effectiveRound=2）')
  t.assert(degsOf(a2).length === 0, 'A 形态不产生 capability 降级')
  t.assert(notesOf(a2).filter((n) => n.code === 'capability-degraded').length === 0, 'A 形态不产生 capability-degraded 声明')

  // ---- B1 同进程：有历史 → round≥2 可用（不降级）----
  B1.tracker.recordParsed('sb1', 1, { evidenceHashes: [{ probe: 'kernel-log', section: 'kernel-log', hash: 'sha256:old' }], missingSections: [] })
  const b1 = B1.diagnoseService({ evidence: EVIDENCE, dimensions: DIMS, context: { round: 2, priorRound: { fixApplied: 'x', assets: B1.layer.generationInfo().assetsHash }, sessionId: 'sb1' } })
  t.assert(b1.ok === true && b1.data.effectiveRound === 2, 'B1 同进程有历史 → round=2 生效')
  t.assert(degsOf(b1).length === 0, 'B1 同进程不产生降级')

  // ---- B1 重启后（模拟：新实例、无内存历史）→ 按"实际降级"判定并声明 ----
  const B1restart = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sB1b'), persist: false })
  const b1r = B1restart.diagnoseService({ evidence: EVIDENCE, dimensions: DIMS, context: { round: 2, sessionId: 'sb1' } })
  t.assert(b1r.ok === true, 'B1 重启后 round≥2 **不拒绝**（降级为单轮语义）')
  t.assert(b1r.data.effectiveRound === 1 && b1r.data.requestedRound === 2, 'effectiveRound=1 且保留 requestedRound=2')
  const d1 = degsOf(b1r)[0]
  t.assert(d1 && d1.kind === 'capability-unavailable' && d1.capability === 'cross-round-evidence-diff', '降级通道记 capability-unavailable')
  t.assert(d1.reason === 'history-missing' && d1.effects.includes('round-reset-1'), 'B1 重启的原因是 history-missing（不是 no-persistent-store）')
  t.assert(notesOf(b1r).some((n) => n.code === 'capability-degraded'), '并投影为用户可见声明')

  // ---- B2：任意 round≥2 → 降级（正常返回，非 REFUSE，不新增错误码）----
  const b2 = B2.diagnoseService({ evidence: EVIDENCE, dimensions: DIMS, context: { round: 2, sessionId: 'sb2' } })
  t.assert(b2.ok === true && b2.code === 'OK', 'B2 round≥2 → **正常返回**（不是 REFUSE）')
  t.assert(b2.data.effectiveRound === 1, 'B2 降级为单轮语义')
  const d2 = degsOf(b2)[0]
  t.assert(d2.reason === 'no-persistent-store' && d2.effects.includes('recollection-degraded'), 'B2 原因 no-persistent-store + recollection-degraded')
  // 补采 reason 不得引用"证据变化/消失"（无 diff 输入）
  for (const rc of b2.data.rootCauses) {
    for (const n of (rc.additionalCollection && rc.additionalCollection.needed) || []) {
      t.assert(!/证据(变化|消失)/.test(n.reason), `${rc.id}: 补采 reason 不引用证据变化（无 diff 输入）`)
    }
  }
  // 单轮结果仍完整
  t.assert(b2.data.rootCauses.length > 0, 'B2 下单轮诊断仍然产出根因')
  t.assert(b2.data.rootCauses.every((rc) => rc.evidence.length >= 1), 'B2 下证据链仍非空')

  // ---- B2 的 round=1 完全可用 ----
  const b2r1 = B2.diagnoseService({ evidence: EVIDENCE, dimensions: DIMS, context: { round: 1, sessionId: 'sb2' } })
  t.assert(b2r1.ok === true && b2r1.data.effectiveRound === 1 && degsOf(b2r1).length === 0, 'B2 下 round=1 无降级、正常可用')

  // ---- tracker 三形态的持久化差异（跨实例读回）----
  const A2 = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sA'), persist: true })
  A.tracker.beginRound('shared', DIMS)
  A.tracker.recordParsed('shared', 1, { evidenceHashes: [], missingSections: [] })
  t.assert(A2.tracker.listSessions().includes('shared'), 'A 形态：新实例能看到已落盘的会话')
  const helper = createTracker({ storageDir: join(tmp, 'sB1'), persist: false })
  t.assert(helper.listSessions().length === 0, 'B1 形态：新 tracker 实例看不到别的进程/实例的内存记录（跨进程不可用）')
  t.assert(B2.tracker.listSessions().length === 0, 'B2 形态：无存储，列表为空')

  for (const x of [tmp]) rmSync(x, { recursive: true, force: true })
}
