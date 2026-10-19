/**
 * stale-visibility.spec —— P6 出口门禁之三（§4.4 细化 2：失效可见性，含终态 session）。
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'
import { FORM } from '../../src/session/closure-tracker.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }
const EV = (id, section, line, snippet, sourceFile) => ({ id, section, line, snippet, sourceFile, hash: `sha256:${id}` })
const EVIDENCE = [
  EV('ev-1', 'kernel-log', 10, 'HBM ECC uncorrectable error on device 3', 'dmesg'),
  EV('ev-2', 'container-state', 14, 'ExitCode 137 OOMKilled shm 64m', 'docker inspect'),
]

export const NAME = 'stale-visibility（热更新后扫描活跃+终态会话 / 下次访问必见 / 跨进程边界）'

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-stale-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-stale', version: '0.0.1' }))
  const storage = join(tmp, 'sessions')
  const core = createCore({ pkgRoot: tmp, storageDir: storage, persist: true })
  core.hotloader.init()

  // 造两个会话：一个活跃（刚出结论）、一个已终态（closed）
  core.tracker.beginRound('active-1', DIMS)
  core.tracker.recordParsed('active-1', 1, { evidenceHashes: [{ probe: 'kernel-log', section: 'kernel-log', hash: 'sha256:a' }], missingSections: [] })
  core.tracker.beginRound('closed-1', DIMS)
  core.tracker.recordParsed('closed-1', 1, { evidenceHashes: [], missingSections: [] })
  core.tracker.closeSession('closed-1', 'fix_succeeded')
  t.assert(core.tracker.listSessions().includes('active-1') && core.tracker.listSessions().includes('closed-1'), '两个会话都在存储里（活跃 + 终态）')
  // 2026-09-28 实测缺陷：侧车文件（_stale.json / _residence.json）被当成会话 id 列进 listSessions()
  core.tracker.markResidence('active-1', 'AWAITING_COLLECTION')
  const ids = core.tracker.listSessions()
  t.assert(!ids.includes('_residence') && !ids.includes('_stale'), `侧车文件不得被当作会话（实际 ${ids.join(',')}）`)
  t.assert(ids.every((x) => !x.startsWith('_')), '会话 id 不以 _ 开头（侧车/元数据一律排除）')

  // 热更新（真变化 → 接受）→ 扫描并标记
  writeFileSync(join(tmp, 'assets', 'verification', 'checks.yaml'), 'id: checks\nversion: 2\nchecks: []\n')
  const r = core.hotloader.reloadIfChanged()
  t.assert(r.changed === true, '热更新被接受')
  const marked = core.markStaleAndInvalidate(['verification/checks.yaml'], { reason: 'assets-or-rules-updated', generation: r.generation })
  t.assert(marked.marked.includes('active-1') && marked.marked.includes('closed-1'), '标记覆盖活跃会话与**终态会话**（§4.4 细化 2 的关键）')

  // 下次访问：两个会话都必须看到提示（不主动推送，但保证可见）
  for (const sid of ['active-1', 'closed-1']) {
    core.tracker.beginRound(sid, DIMS)
    const res = core.diagnoseService({ evidence: EVIDENCE, dimensions: DIMS, context: { round: 1, sessionId: sid } })
    const n = (res.data.notices || []).filter((x) => x.code === 'version-drift')
    t.assert(n.length >= 1, `${sid}: 下次访问顶部出现失效提示`)
    t.assert(/可能需复评/.test(n[0].text), `${sid}: 提示文案含复评要求`)
  }

  // 复评后清除 → 不再提示（cleared 优先于 #all）
  core.tracker.clearStale('active-1')
  const after = core.diagnoseService({ evidence: EVIDENCE, dimensions: DIMS, context: { round: 1, sessionId: 'active-1' } })
  t.assert((after.data.notices || []).filter((x) => x.code === 'version-drift').length === 0, '复评清除后不再提示')

  // 跨进程：A 形态新实例能看到标记（提示不丢）
  const core2 = createCore({ pkgRoot: tmp, storageDir: storage, persist: true })
  t.assert(core2.tracker.form() === FORM.A, '新实例仍为 A 形态')
  t.assert(core2.tracker.staleFor('closed-1') !== null, '新实例（跨进程）仍能读到终态会话的失效标记')
  const cross = core2.diagnoseService({ evidence: EVIDENCE, dimensions: DIMS, context: { round: 1, sessionId: 'closed-1' } })
  t.assert((cross.data.notices || []).some((n) => n.code === 'version-drift'), '跨进程访问终态会话仍见提示（"下次访问"真的可达）')

  // 跨进程边界（B1）：内存标记不跨实例 —— 显式声明为部署能力限制，不是缺陷
  const b1a = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'b1'), persist: false })
  b1a.tracker.markStale('s-x', { generation: 1, reason: 'x' })
  const b1b = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'b1'), persist: false })
  t.assert(b1a.tracker.staleFor('s-x') !== null, 'B1：同实例内标记可见')
  t.assert(b1b.tracker.staleFor('s-x') === null, 'B1：新实例（模拟重启）不保留标记 —— 跨进程能力缺失（已在 §4.4 声明）')
  // B2：无任何存储
  const b2 = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'b2'), persist: false, inProcessStore: false })
  t.assert(b2.tracker.form() === FORM.B2 && b2.tracker.listSessions().length === 0, 'B2：无存储、无会话列表（stale 扫描不适用）')

  rmSync(tmp, { recursive: true, force: true })
}
