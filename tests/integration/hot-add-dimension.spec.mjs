/**
 * hot-add-dimension.spec —— P1 出口门禁之一（§3.1 扩展流程 + §4.2 世代切换语义）。
 *
 * 断言两件事：
 *   ① 不重启即可新增维度（加数据文件 + 注册 → 新一代 → 三工具认得它）
 *   ② 安全闸门：坏世代被拒绝时**保留旧代并继续服务**（不是把工具打成 REFUSE）
 */
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const FIXTURES = join(HERE, '..', 'fixtures')

export const NAME = 'hot-add-dimension（不重启新增维度 + 拒绝世代保留旧代）'

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-hotadd-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-hotadd', version: '0.0.1' }))

  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sessions'), persist: true })
  core.hotloader.init()
  const gen1 = core.hotloader.generation
  const hash1 = core.hotloader.assetsHash
  t.assert(gen1 === 1 && /^sha256:/.test(hash1), `初始世代=1 且 assetsHash 就绪（gen=${gen1}）`)

  const real = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }
  const before = core.generateCollectScript({ description: '热加载前基线', dimensions: real })
  t.assert(before.ok === true, '基线：真实组合可生成脚本')

  // 未知维度此时必须被拒（取值越界）
  const newDims = { framework: 'fake-framework', runtime: 'docker', hardware: 'fake-hardware' }
  let preCode = null
  try {
    core.generateCollectScript({ description: 'x', dimensions: newDims })
  } catch (e) {
    preCode = e.code
  }
  t.assert(preCode === 'ERR_MISSING_PARAM', `新增前：未注册维度被拒（实际 ${preCode}）`)

  // ---- ① 热新增：加两个数据文件 + 注册（不改任何 src/ 代码，不重启）----
  const assetsRoot = join(tmp, 'assets')
  cpSync(join(FIXTURES, 'fake-hardware.yaml'), join(assetsRoot, 'dimensions', 'hardware', 'fake-hardware.yaml'))
  cpSync(join(FIXTURES, 'fake-framework.yaml'), join(assetsRoot, 'dimensions', 'framework', 'fake-framework.yaml'))
  cpSync(join(FIXTURES, 'fake-hardware-rules.yaml'), join(assetsRoot, 'root-causes', 'fake-hardware-rules.yaml'))
  const dimsPath = join(assetsRoot, 'config', 'dims.json')
  const dims = JSON.parse(readFileSync(dimsPath, 'utf8'))
  dims.kinds.hardware.push('fake-hardware')
  dims.kinds.framework.push('fake-framework')
  writeFileSync(dimsPath, JSON.stringify(dims, null, 2))

  const r1 = core.hotloader.reloadIfChanged()
  t.assert(r1.changed === true, '新增维度后检测到变化')
  t.assert(r1.generation === gen1 + 1, `世代单调递增（${gen1} → ${r1.generation}）`)
  t.assert(r1.assetsHash !== hash1, 'assetsHash 随内容变化')

  // 模拟 index.js 的接线：仅在**接受**新代时失效 loader 缓存
  core.layer.invalidate()
  const after = core.generateCollectScript({ description: '热加载后：新维度', dimensions: newDims })
  t.assert(after.ok === true, '热新增后同一进程即可用（不重启）')
  t.assert(after.data.script.includes('fake-health'), '新维度的探针进入脚本')
  t.assert(after.data.manifest.sections.includes('fake-errors'), '新维度的 section 进入 manifest')

  // ---- ② 安全闸门：rules/ 被删 → 拒绝切代 + 保留旧代继续服务 ----
  const rulesDir = join(assetsRoot, 'rules')
  const stash = join(tmp, 'rules-stash')
  cpSync(rulesDir, stash, { recursive: true })
  rmSync(rulesDir, { recursive: true, force: true })

  const r2 = core.hotloader.reloadIfChanged()
  t.assert(r2.changed === false, '脱敏规则缺失 → 拒绝切换世代')
  t.assert(Array.isArray(r2.problems) && r2.problems.some((p) => /rules\//.test(p)), '拒绝原因指向 rules/（安全闸门）')
  t.assert(r2.generation === r1.generation && r2.keptGeneration === r1.generation, '保留旧代：世代号不变')

  // 关键：拒绝之后，工具仍以**上一代**继续服务（不是被打成 REFUSE）
  const survived = core.generateCollectScript({ description: '拒绝世代后仍服务', dimensions: real })
  t.assert(survived.ok === true, '坏更新被拒后，工具继续服务上一代（§4.2 保留旧代）')
  t.assert(core.currentRules().ok === true, 'currentRules 仍返回上一代的可用规则集')

  // ---- ③ 恢复同内容 → 内容 hash 相同 ⇒ 正确判定"无变化"（幂等，不空切世代）----
  cpSync(stash, rulesDir, { recursive: true })
  const r3 = core.hotloader.reloadIfChanged()
  t.assert(r3.changed === false, '恢复为与当前世代相同的内容 → 幂等无变化（不空切世代）')
  t.assert(r3.assetsHash === r2.assetsHash, '内容相同则 assetsHash 相同')
  t.assert(core.generateCollectScript({ description: '恢复后', dimensions: real }).ok === true, '恢复后真实组合可用')

  // ---- ③' 真实变更 → 再次切代 ----
  writeFileSync(join(assetsRoot, 'verification', 'checks.yaml'),
    readFileSync(join(assetsRoot, 'verification', 'checks.yaml'), 'utf8') + '\n# hot-add probe marker\n')
  const r3b = core.hotloader.reloadIfChanged()
  t.assert(r3b.changed === true && r3b.generation === r1.generation + 1, `真实变更后切代（→ ${r3b.generation}）`)
  core.layer.invalidate()
  const final = core.generateCollectScript({ description: '切代后', dimensions: newDims })
  t.assert(final.ok === true, '切代后新维度组合仍可用')

  // ---- ④ 坏 YAML 世代同样被拒 ----
  writeFileSync(join(assetsRoot, 'dimensions', 'framework', 'fake-framework.yaml'), 'id: fake-framework\nkind: framework\n  bad: indent\n')
  const r4 = core.hotloader.reloadIfChanged()
  t.assert(r4.changed === false && r4.problems.some((p) => /YAML|解析/.test(p)), '坏 YAML → 拒绝切代并给出解析原因')
  t.assert(core.hotloader.generation === r3b.generation, '坏 YAML 不推进世代号')

  rmSync(tmp, { recursive: true, force: true })
}
