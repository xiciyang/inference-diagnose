/**
 * dimension-loader.spec —— P1 出口门禁之一（§3.1 三维抽象层 API 契约 + 错误映射 + schema 校验）。
 */
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createLoader, scanDimensionFiles, KINDS } from '../../src/primitives/dimension-loader.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const FIXTURES = join(HERE, '..', 'fixtures')

export const NAME = 'dimension-loader（§3.1 API / 错误映射 / schema 校验）'

function tmpTree() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-dims-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  return tmp
}

function codeOf(fn) {
  try {
    fn()
    return null
  } catch (e) {
    return { code: e.code, body: e.body }
  }
}

export async function run(t) {
  const real = join(PKG_ROOT, 'assets')
  const L = createLoader({ assetsRoot: real })

  // ---- 正常路径 ----
  const vocab = L.listDimensions()
  t.assert(Array.isArray(vocab.framework) && vocab.framework.includes('mindie'), '词表列出已注册 framework')
  t.assert(KINDS.every((k) => Array.isArray(vocab[k])), '三个维度（framework/runtime/hardware）都在词表内')

  const combo = L.resolveCombo({ framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' })
  t.assert(combo.probes.length === new Set(combo.probes.map((p) => p.probe)).size, '探针集按 probe id 去重')
  t.assert(combo.probes.every((p) => p.probe && p.section), '每个探针都有 probe/section')
  t.assert(combo.ruleFiles.length === combo.ruleFilesSorted.length, 'ruleFiles 去重后与排序版等长')
  t.assert(combo.ruleFilesSorted.every((f) => /^root-causes\//.test(f)), 'ruleFiles 为 assets 相对路径')
  t.assert(/^sha256:[0-9a-f]{32}$/.test(combo.assetsHash), `assetsHash 形态正确（${combo.assetsHash}）`)

  const filtered = L.probeCatalog(combo, ['npu-thermal-history'])
  t.assert(filtered.length === 1 && filtered[0].probe === 'npu-thermal-history', 'probeCatalog 按 probe id 过滤')
  t.assert(L.probeCatalog(combo).length === combo.probes.length, 'probeCatalog 不带过滤时返回全量')

  const secs = L.sections(combo)
  t.assert(secs.length === new Set(secs).size, 'sections 去重')
  t.assert(secs.includes('kernel-log'), 'sections 覆盖硬件维度贡献的段')

  t.assert(L.generationInfo().assetsHash === combo.assetsHash, 'generationInfo 与 combo 的 assetsHash 一致')
  t.assert(scanDimensionFiles(real).length >= 3, 'scanDimensionFiles 能列出维度文件（不经过注册表）')

  // ---- 错误映射：缺项 / 越界 / 组合非法 → ERR_MISSING_PARAM ----
  const e1 = codeOf(() => L.resolveCombo({ framework: 'mindie', runtime: 'docker' }))
  t.assert(e1 && e1.code === 'ERR_MISSING_PARAM', `缺项 → ERR_MISSING_PARAM（实际 ${e1 && e1.code}）`)
  t.assert(e1.body.missing.includes('dimensions.hardware'), '缺项 body.missing 指明缺哪个维度')
  t.assert(/可用取值/.test(e1.body.hint), '缺项 hint 列出可用取值')

  const e2 = codeOf(() => L.resolveCombo({ framework: 'no-such-fw', runtime: 'docker', hardware: 'ascend-arm' }))
  t.assert(e2 && e2.code === 'ERR_MISSING_PARAM', '取值越界 → ERR_MISSING_PARAM')
  t.assert(/no-such-fw/.test(e2.body.hint) && /mindie/.test(e2.body.hint), '越界 hint 同时给出错误值与可用值')

  // 组合非法：需要"已注册但不被接受"的硬件，故在临时树里注册一个夹具硬件
  const t0 = tmpTree()
  cpSync(join(FIXTURES, 'fake-hardware.yaml'), join(t0, 'assets', 'dimensions', 'hardware', 'fake-hardware.yaml'))
  const d0 = JSON.parse(readFileSync(join(t0, 'assets', 'config', 'dims.json'), 'utf8'))
  d0.kinds.hardware.push('fake-hardware')
  writeFileSync(join(t0, 'assets', 'config', 'dims.json'), JSON.stringify(d0, null, 2))
  const e3 = codeOf(() => createLoader({ assetsRoot: join(t0, 'assets') }).resolveCombo({ framework: 'mindie', runtime: 'docker', hardware: 'fake-hardware' }))
  t.assert(e3 && e3.code === 'ERR_MISSING_PARAM', `组合非法（requires 不满足）→ ERR_MISSING_PARAM（实际 ${e3 && e3.code}）`)
  t.assert(e3.body.hint.includes('组合不合法') && e3.body.hint.includes('hardware'), '组合非法 hint 指明是组合约束（不是取值越界）')
  rmSync(t0, { recursive: true, force: true })

  // ---- schema 校验：破损资产一律 ERR_DIMENSIONS_NOT_LOADED（REFUSE）----
  const L2 = createLoader({ assetsRoot: join(PKG_ROOT, 'no-such-assets-root') })
  const e4 = codeOf(() => L2.listDimensions())
  t.assert(e4 && e4.code === 'ERR_DIMENSIONS_NOT_LOADED', `注册表缺失 → ERR_DIMENSIONS_NOT_LOADED（实际 ${e4 && e4.code}）`)
  t.assert(e4.body.policy === 'REFUSE', '注册表缺失带 policy:REFUSE（fail-closed）')
  t.assert(/dims\.json/.test(e4.body.hint), 'hint 指向 assets/config/dims.json')

  // 维度文件缺失但仍在注册表里
  const t1 = tmpTree()
  rmSync(join(t1, 'assets', 'dimensions', 'framework', 'mindie.yaml'))
  const e5 = codeOf(() => createLoader({ assetsRoot: join(t1, 'assets') }).listDimensions())
  t.assert(e5 && e5.code === 'ERR_DIMENSIONS_NOT_LOADED', '维度文件缺失 → ERR_DIMENSIONS_NOT_LOADED')
  t.assert(/缺 dimensions\/framework\/mindie\.yaml/.test(e5.body.hint), 'hint 指明缺哪个文件')

  // 维度文件 YAML 非法
  const t2 = tmpTree()
  writeFileSync(join(t2, 'assets', 'dimensions', 'framework', 'mindie.yaml'), 'id: mindie\nkind: framework\n  bad: indent\n')
  const e6 = codeOf(() => createLoader({ assetsRoot: join(t2, 'assets') }).listDimensions())
  t.assert(e6 && e6.code === 'ERR_DIMENSIONS_NOT_LOADED', 'YAML 非法 → ERR_DIMENSIONS_NOT_LOADED')

  // 文件内 id/kind 与注册表不一致
  const t3 = tmpTree()
  writeFileSync(join(t3, 'assets', 'dimensions', 'framework', 'mindie.yaml'), 'id: wrong-id\nkind: runtime\nprobes: []\n')
  const e7 = codeOf(() => createLoader({ assetsRoot: join(t3, 'assets') }).listDimensions())
  t.assert(e7 && e7.code === 'ERR_DIMENSIONS_NOT_LOADED', 'id/kind 不一致 → ERR_DIMENSIONS_NOT_LOADED')
  t.assert(/id="wrong-id"/.test(e7.body.hint) && /kind="runtime"/.test(e7.body.hint), 'hint 指明不一致的具体字段')

  // 注册表 JSON 非法
  const t4 = tmpTree()
  writeFileSync(join(t4, 'assets', 'config', 'dims.json'), '{ not json')
  const e8 = codeOf(() => createLoader({ assetsRoot: join(t4, 'assets') }).listDimensions())
  t.assert(e8 && e8.code === 'ERR_DIMENSIONS_NOT_LOADED', '注册表 JSON 非法 → ERR_DIMENSIONS_NOT_LOADED')

  // ---- invalidate 语义：改盘后需 invalidate 才重读 ----
  const t5 = tmpTree()
  const L5 = createLoader({ assetsRoot: join(t5, 'assets') })
  const before = L5.generationInfo().assetsHash
  writeFileSync(join(t5, 'assets', 'dimensions', 'hardware', 'ascend-arm.yaml'),
    readFileSync(join(t5, 'assets', 'dimensions', 'hardware', 'ascend-arm.yaml'), 'utf8') + '\n# touched\n')
  t.assert(L5.generationInfo().assetsHash === before, '未 invalidate 时缓存生效（世代未切换不重读）')
  L5.invalidate()
  t.assert(L5.generationInfo().assetsHash !== before, 'invalidate 后重读并产生新 assetsHash')

  for (const d of [t1, t2, t3, t4, t5]) rmSync(d, { recursive: true, force: true })
}
