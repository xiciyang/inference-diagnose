/**
 * version-declaration.spec —— P4 出口门禁之三（§4.3 版本差异声明 + §4.4 细化 2 stale 可见性）。
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }
const EV = (id, section, line, snippet, sourceFile) => ({ id, section, line, snippet, sourceFile, hash: `sha256:${id}` })

export const NAME = 'version-declaration（快照≠current 必现 / 相等必不现 / stale 会话必现）'

function tree() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-vd-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-vd', version: '0.0.1' }))
  return tmp
}
const notesOf = (r) => (r.data.notices || []).filter((n) => n.code === 'version-drift')

export async function run(t) {
  const tmp = tree()
  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sessions'), persist: true })
  const evidence = [
    EV('ev-1', 'kernel-log', 10, 'HBM ECC uncorrectable error on device 3', 'dmesg'),
    EV('ev-2', 'container-state', 14, 'ExitCode 137 OOMKilled shm 64m', 'docker inspect'),
  ]
  const cur = core.layer.generationInfo().assetsHash

  // ---- 相等 → 无声明 ----
  const same = core.diagnoseService({ evidence, dimensions: DIMS, context: { round: 2, priorRound: { fixApplied: '未执行', assets: cur }, sessionId: 's-eq' } })
  t.assert(same.ok === true, '带 priorRound 的 round≥2 正常返回')
  t.assert(notesOf(same).length === 0, '快照 == current → 不产出 version-drift')

  // ---- 不同 → 必现（且文本含两个版本）----
  const drifted = core.diagnoseService({ evidence, dimensions: DIMS, context: { round: 2, priorRound: { fixApplied: '升级驱动', assets: 'sha256:OLDSNAPSHOT' }, sessionId: 's-drift' } })
  const n = notesOf(drifted)
  t.assert(n.length === 1, '快照 ≠ current → 恰好一条 version-drift')
  t.assert(n[0].text.includes('sha256:OLDSNAPSHOT') && n[0].text.includes(cur), '声明文本同时给出快照版本与当前版本')
  t.assert(/可能需要基于新规则复评/.test(n[0].text), '声明包含复评提示')

  // ---- stale 会话（§4.4 细化 2）：访问时必现 ----
  core.tracker.markStale('s-stale', { generation: core.hotloader.generation, reason: 'assets-or-rules-updated' })
  const staleRes = core.diagnoseService({ evidence, dimensions: DIMS, context: { round: 1, sessionId: 's-stale' } })
  const sn = notesOf(staleRes)
  t.assert(sn.length === 1, 'stale 会话 → 产出声明')
  t.assert(/既有结论所依据的规则\/资产已更新/.test(sn[0].text), 'stale 声明说明既有结论失效')
  // 非 stale 会话不受影响
  const fresh = core.diagnoseService({ evidence, dimensions: DIMS, context: { round: 1, sessionId: 's-fresh-2' } })
  t.assert(notesOf(fresh).length === 0, '非 stale 会话不产出声明')

  // ---- markAllStale 覆盖已知会话（含终态会话，二者都记录在 storage 里）----
  core.tracker.recordParsed('s-old', 1, { evidenceHashes: [], missingSections: [] })
  core.tracker.recordFixApplied('s-old', 1, { fixApplied: 'x', outcome: 'fix_failed' })
  const marked = core.tracker.markAllStale({ generation: 2, reason: 'hot-update' })
  t.assert(marked.marked.includes('s-old'), 'markAllStale 覆盖已知会话（含已 closed/终态会话）')
  t.assert(core.tracker.staleFor('s-old') !== null, '标记可读回')
  const oldRes = core.diagnoseService({ evidence, dimensions: DIMS, context: { round: 1, sessionId: 's-old' } })
  t.assert(notesOf(oldRes).length >= 1, '被标记的旧会话下次访问必见提示')

  // ---- clearStale 后可清除 ----
  core.tracker.clearStale('s-old')
  t.assert(core.tracker.staleFor('s-old') === null || core.tracker.staleFor('s-old').reason !== 'hot-update', 'clearStale 生效（或退回到 #all 级标记）')

  rmSync(tmp, { recursive: true, force: true })
}
