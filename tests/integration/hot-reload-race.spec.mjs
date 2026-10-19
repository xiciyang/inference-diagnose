/**
 * hot-reload-race.spec —— P6 出口门禁之二（§4.3 入口快照语义 / A2 竞态 / A6 资源注入）。
 *
 * 核心命题：**一次调用的输出只绑定它入口时的那一代**，与"热更新发生在调用前/中/后"无关。
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }

export const NAME = 'hot-reload-race（入口快照语义 / A2 顺序无关 / A6 资源注入）'

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-race-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-race', version: '0.0.1' }))
  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sessions'), persist: true })
  core.hotloader.init()
  const gen1Hash = core.hotloader.assetsHash

  const call = () => core.generateCollectScript({ description: '竞态测试', dimensions: DIMS })

  // ---- 调用前的基线 ----
  const before = call()
  t.assert(before.versions.assets === gen1Hash, '调用返回入口世代的 assetsHash')

  // ---- 磁盘已变但**未接受新代** → 调用仍绑定旧代（证明不中途重读磁盘）----
  writeFileSync(join(tmp, 'assets', 'verification', 'checks.yaml'), 'id: checks\nversion: 9\nchecks: []\n')
  const during = call()
  t.assert(during.versions.assets === gen1Hash, '磁盘已变但世代未切换 → 调用仍返回旧代 hash（快照语义）')
  t.assert(during.data.script === before.data.script.replace(/problem=.*/, during.data.script.match(/problem=.*/)[0]), '同世代下脚本除时间戳外一致')

  // ---- 接受新代后 → 调用绑定新代 ----
  const r = core.hotloader.reloadIfChanged()
  t.assert(r.changed === true, '内容变化被接受')
  core.markStaleAndInvalidate([], { reason: 'hot-update', generation: r.generation })
  const after = call()
  t.assert(after.versions.assets === r.assetsHash && after.versions.assets !== gen1Hash, '切换后调用绑定新代 hash')

  // ---- A2 顺序无关：两次调用各自只看到一个世代（不存在跨代混合结果）----
  const seq = [call(), (() => { core.hotloader.reloadIfChanged(); core.layer.invalidate(); return null })(), call()].filter(Boolean)
  t.assert(seq.every((x) => /^sha256:/.test(x.versions.assets)), '每个结果都带单一 assetsHash（无混合）')
  t.assert(seq[0].versions.assets === seq[0].data.manifest.assets, '结果内部自洽：versions 与 manifest 同代')
  t.assert(seq[1].versions.assets === seq[1].data.manifest.assets, '第二个结果内部同样自洽')

  // ---- A6 资源注入：资产解析失败不崩，退化路径明确 ----
  const bad = createCore({ pkgRoot: join(tmp, 'no-such-root'), storageDir: join(tmp, 's2'), persist: false })
  let code = null
  try { bad.generateCollectScript({ description: 'x', dimensions: DIMS }) } catch (e) { code = e.code }
  t.assert(code === 'ERR_DIMENSIONS_NOT_LOADED', `资产缺失 → 明确错误码而非崩溃（实际 ${code}）`)

  // hotloader 初始校验失败也不抛到调用方（fail-soft 装配）
  const badHot = createCore({ pkgRoot: join(tmp, 'no-such-root'), storageDir: join(tmp, 's3'), persist: false })
  let initThrew = false
  try { badHot.hotloader.init() } catch { initThrew = true }
  t.assert(initThrew === true, 'hotloader.init 对坏资产 fail-loud（由 apply 捕获后仍可提供 fail-closed 工具）')

  // ---- 定向补采路径在快照语义下也一致 ----
  const ev = [
    { id: 'ev-1', section: 'npu-metrics', line: 22, snippet: 'temp 92C (throttle threshold 85C)', sourceFile: 'npu-metrics', hash: 'sha256:t' },
  ]
  const dg = core.diagnoseService({ evidence: ev, dimensions: DIMS, context: { round: 1, sessionId: 'race' } })
  t.assert(dg.ok === true && dg.versions.assets === core.hotloader.assetsHash, 'diagnose 同样绑定当前世代')

  rmSync(tmp, { recursive: true, force: true })
}
