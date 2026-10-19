/**
 * assets-hotloader.spec —— P6 出口门禁之一（§4.2 原子切换 / fail-soft / 安全闸门不降级）。
 */
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHotloader } from '../../src/primitives/assets-hotloader.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')

export const NAME = 'assets-hotloader（原子切换 / 拒绝即保留旧代 / 安全闸门 / disposer）'

function tree() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-hot-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  return tmp
}
const A = (t) => join(t, 'assets')

export async function run(t) {
  const tmp = tree()
  const hl = createHotloader({ assetsRoot: A(tmp), pollMs: 50 })
  t.assert(hl.status() === null, '未 init 时 status() 为 null')
  const gen1 = hl.init()
  t.assert(gen1.generation === 1 && /^sha256:/.test(gen1.assetsHash), 'init 建立世代 1 并算出 assetsHash')
  t.assert(gen1.files.some((f) => f.startsWith('config/')) && gen1.files.some((f) => f.startsWith('rules/')), 'files 覆盖 config/rules')
  t.assert(hl.status().files > 5 && hl.status().ok === true, 'status() 报告文件数与 ok')

  // ---- 无变化 → changed:false ----
  const r0 = hl.reloadIfChanged()
  t.assert(r0.changed === false && r0.generation === 1, '内容未变 → 不切代（幂等）')

  // ---- 真变化 → 原子切换，世代单调 +1 ----
  writeFileSync(join(A(tmp), 'verification', 'checks.yaml'), 'id: checks\nversion: 1\nchecks: []\n')
  const r1 = hl.reloadIfChanged()
  t.assert(r1.changed === true && r1.generation === 2 && r1.previous === 1, '内容变化 → 切到世代 2（记录 previous）')
  t.assert(r1.assetsHash !== gen1.assetsHash, 'assetsHash 随内容变化')
  t.assert(hl.generation === 2 && hl.assetsHash === r1.assetsHash, 'getter 与返回值一致')

  // ---- 坏 YAML → 拒绝，保留旧代 ----
  const badFile = join(A(tmp), 'dimensions', 'framework', 'mindie.yaml')
  const goodContent = (await import('node:fs')).readFileSync(badFile, 'utf8')
  writeFileSync(badFile, 'id: mindie\nkind: framework\n  bad: indent\n')
  const r2 = hl.reloadIfChanged()
  t.assert(r2.changed === false, '坏 YAML → 拒绝切换')
  t.assert(r2.problems.some((p) => /YAML|解析/.test(p)), '拒绝原因标注解析失败')
  t.assert(r2.keptGeneration === 2 && hl.generation === 2, '保留旧代：世代号不变')
  t.assert(hl.assetsHash === r1.assetsHash, '保留旧代：assetsHash 不变（旧代仍可服务）')
  writeFileSync(badFile, goodContent)

  // ---- 安全闸门：rules/ 缺失 → 绝不切到"无规则世代" ----
  const rulesBackup = join(tmp, 'rules-backup')
  cpSync(join(A(tmp), 'rules'), rulesBackup, { recursive: true })
  rmSync(join(A(tmp), 'rules'), { recursive: true, force: true })
  const r3 = hl.reloadIfChanged()
  t.assert(r3.changed === false, '规则目录缺失 → 拒绝切换（安全闸门）')
  t.assert(r3.problems.some((p) => /rules\//.test(p) && /无规则世代|安全闸门/.test(p)), '拒绝原因明确指向安全闸门')
  t.assert(hl.generation === 2 && hl.assetsHash === r1.assetsHash, '安全闸门触发后仍服务旧代')
  cpSync(rulesBackup, join(A(tmp), 'rules'), { recursive: true })

  // ---- 恢复同内容 → 幂等（hash 相同）----
  const r4 = hl.reloadIfChanged()
  t.assert(r4.changed === false, '恢复为与当前世代相同的内容 → 幂等无变化')

  // ---- 坏 JSON（dims.json）也拒绝 ----
  const dimsPath = join(A(tmp), 'config', 'dims.json')
  const dimsGood = (await import('node:fs')).readFileSync(dimsPath, 'utf8')
  writeFileSync(dimsPath, '{ not json')
  const r5 = hl.reloadIfChanged()
  t.assert(r5.changed === false && r5.problems.some((p) => /JSON/.test(p)), '坏 JSON → 拒绝并标注')
  writeFileSync(dimsPath, dimsGood)

  // ---- disposer：watchAndPoll 返回可清理的 disposer，且不产生游离监听 ----
  let events = 0
  const dispose = hl.watchAndPoll(() => { events += 1 })
  t.assert(typeof dispose === 'function', 'watchAndPoll 返回 disposer')
  writeFileSync(join(A(tmp), 'verification', 'checks.yaml'), 'id: checks\nversion: 2\nchecks: []\n')
  await new Promise((r) => setTimeout(r, 400))
  const before = events
  dispose()
  writeFileSync(join(A(tmp), 'verification', 'checks.yaml'), 'id: checks\nversion: 3\nchecks: []\n')
  await new Promise((r) => setTimeout(r, 400))
  t.assert(events === before, `disposer 后轮询停止（事件数 ${events} 未再增长）`)
  t.assert(before >= 1, 'disposer 之前确实观察到了变化（不是空跑）')

  // ═══ 缺陷 #57：versions.assets 必须**只有一个算法** ═══
  // 历史坑：hotloader 哈希 6 个 SCAN_ROOT 的全部资产，dimension-loader 只哈希"已加载的维度文件"
  // ⇒ 同一份资产两个值（长驻实例 vs 一次性进程），version-drift 的"可比较"假设被破坏。
  {
    const t6 = tree()
    const hl6 = createHotloader({ assetsRoot: A(t6) })
    hl6.init()
    const viaHotloader = hl6.assetsHash

    const { createLoader } = await import('../../src/primitives/dimension-loader.js')
    const { hashAssetsTree, ASSET_SCAN_ROOTS } = await import('../../src/primitives/assets-hash.js')
    const viaFallback = createLoader({ assetsRoot: A(t6) }).generationInfo().assetsHash
    const viaPure = hashAssetsTree(A(t6))

    t.assert(!!viaHotloader && !!viaFallback, '两条路径都产出了 assets 值')
    t.assert(viaHotloader === viaFallback,
      `#57 长驻路径（hotloader）与兜底路径（dimension-loader）对同一份资产产出**相同** assets（${viaHotloader} vs ${viaFallback}）`)
    t.assert(viaHotloader === viaPure, '#57 纯函数 hashAssetsTree 与 hotloader 逐字节一致（单一实现）')
    t.assert(Array.isArray(ASSET_SCAN_ROOTS) && ASSET_SCAN_ROOTS.length === 6,
      `#57 参与哈希的 SCAN_ROOT 恰好 6 个（实际 ${ASSET_SCAN_ROOTS.length}：${ASSET_SCAN_ROOTS.join(',')}）`)

    // 改一个**非维度**资产文件（root-causes）也必须同时改变两条路径的值——
    // 这正是旧实现漏掉的一类（dimension-loader 完全不看 root-causes）
    writeFileSync(join(A(t6), 'root-causes', 'runtime-docker-rules.yaml'),
      readFileSync(join(A(t6), 'root-causes', 'runtime-docker-rules.yaml'), 'utf8') + '\n# touched\n')
    const hl6b = createHotloader({ assetsRoot: A(t6) })
    hl6b.init()
    const afterFallback = createLoader({ assetsRoot: A(t6) }).generationInfo().assetsHash
    t.assert(hl6b.assetsHash !== viaHotloader, '#57 改 root-causes 后 hotloader 值改变')
    t.assert(afterFallback === hl6b.assetsHash,
      '#57 改 root-causes 后兜底值同步改变且与 hotloader 相等（旧实现看不到 root-causes 变化）')
    rmSync(t6, { recursive: true, force: true })
  }

  rmSync(tmp, { recursive: true, force: true })
}
