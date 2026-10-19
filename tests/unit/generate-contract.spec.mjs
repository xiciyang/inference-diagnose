/**
 * generate-contract.spec —— P2 出口门禁之二（§2.2 返回结构专项，与 no-plaintext-disk 职责分离）。
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')

export const NAME = 'generate-contract（§2.2 返回结构 / fail-closed / N-A 声明）'

function tree() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-gen-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-gen', version: '0.0.1' }))
  return tmp
}
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }
function attempt(fn) {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    return { ok: false, code: e.code, body: e.body }
  }
}

export async function run(t) {
  const tmp = tree()
  const core = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sessions'), persist: true })

  // ---- 正常返回结构 ----
  const r = core.generateCollectScript({ description: '契约测试：服务崩溃', dimensions: DIMS })
  t.assert(r.ok === true && r.code === 'OK', '正常返回 ok:true / code:OK')
  t.assert(typeof r.data.script === 'string' && r.data.script.startsWith('#!/usr/bin/env bash'), 'script 是可执行 bash')
  const m = r.data.manifest
  t.assert(m && typeof m === 'object', 'manifest 存在')
  for (const k of ['templateId', 'dims', 'sections', 'probes', 'rules', 'assets', 'generatedAt']) {
    t.assert(m[k] !== undefined, `manifest 含 ${k}`)
  }
  t.assert(Array.isArray(m.sections) && m.sections.length > 0, 'manifest.sections 非空')
  t.assert(m.probes.every((p) => p.probe && p.section), 'manifest.probes 每项含 probe/section')
  t.assert(m.dims.framework === DIMS.framework && m.dims.hardware === DIMS.hardware, 'manifest.dims 回显三维')
  t.assert(r.versions && r.versions.plugin && r.versions.schema && r.versions.rules && r.versions.assets, 'versions 四元组齐备')
  t.assert(r.versions.assets === m.assets, 'versions.assets 与 manifest.assets 一致')
  // 脚本内容与 manifest 一致
  for (const s of m.sections) t.assert(r.data.script.includes(`=== ${s} ===`) || r.data.script.includes(`emit "${s}"`), `脚本包含 section ${s} 的采集块`)
  const emitCount = (r.data.script.match(/^emit /gm) || []).length
  t.assert(emitCount === m.probes.length, `emit 次数(${emitCount}) == manifest.probes(${m.probes.length})`)
  t.assert(!r.data.degradations && !r.data.notices, '正常路径不携带 degradations/notices')

  // ---- ERR_MISSING_PARAM ----
  const e1 = attempt(() => core.generateCollectScript({ description: '   ', dimensions: DIMS }))
  t.assert(!e1.ok && e1.code === 'ERR_MISSING_PARAM', `空描述 → ERR_MISSING_PARAM（实际 ${e1.code}）`)
  t.assert(e1.body.missing.includes('description') && e1.body.recoverable === true, 'missing 指明 description 且可恢复')

  // ---- ERR_DIMENSIONS_NOT_LOADED（fail-closed：不发脚本）----
  const t2 = tree()
  rmSync(join(t2, 'assets', 'config', 'dims.json'))
  const c2 = createCore({ pkgRoot: t2, storageDir: join(t2, 's'), persist: false })
  const e2 = attempt(() => c2.generateCollectScript({ description: 'x', dimensions: DIMS }))
  t.assert(!e2.ok && e2.code === 'ERR_DIMENSIONS_NOT_LOADED' && e2.body.policy === 'REFUSE', '注册表缺失 → ERR_DIMENSIONS_NOT_LOADED + REFUSE')
  t.assert(!('value' in e2), 'fail-closed：未产出任何脚本')

  // ---- ERR_TEMPLATE_NOT_LOADED ----
  const t3 = tree()
  rmSync(join(t3, 'assets', 'templates'), { recursive: true })
  const c3 = createCore({ pkgRoot: t3, storageDir: join(t3, 's'), persist: false })
  const e3 = attempt(() => c3.generateCollectScript({ description: 'x', dimensions: DIMS }))
  t.assert(!e3.ok && e3.code === 'ERR_TEMPLATE_NOT_LOADED' && e3.body.policy === 'REFUSE', '模板缺失 → ERR_TEMPLATE_NOT_LOADED + REFUSE')

  // ---- ERR_DESENSITIZE_RULES_NOT_LOADED（不变量：绝不发无脱敏脚本）----
  const t4 = tree()
  rmSync(join(t4, 'assets', 'rules'), { recursive: true })
  const c4 = createCore({ pkgRoot: t4, storageDir: join(t4, 's'), persist: false })
  const e4 = attempt(() => c4.generateCollectScript({ description: 'x', dimensions: DIMS }))
  t.assert(!e4.ok && e4.code === 'ERR_DESENSITIZE_RULES_NOT_LOADED' && e4.body.policy === 'REFUSE', '脱敏规则缺失 → REFUSE（不发无脱敏脚本）')
  t.assert(/fail-closed/.test(e4.body.hint), 'hint 说明 fail-closed 理由')

  // ---- ERR_ROOTCAUSE_RULES_NOT_LOADED 对本工具为 N/A ----
  const t5 = tree()
  rmSync(join(t5, 'assets', 'root-causes'), { recursive: true })
  const c5 = createCore({ pkgRoot: t5, storageDir: join(t5, 's'), persist: false })
  const r5 = attempt(() => c5.generateCollectScript({ description: '根因规则缺失不影响生成', dimensions: DIMS }))
  t.assert(r5.ok && r5.value.ok === true, '根因规则缺失 → 仍可生成（N/A：不依赖根因规则）')

  // ---- ERR_REPORT_CORRUPT / ERR_DESENSITIZE_MISS 对本工具为 N/A ----
  t.assert(!/report/.test(JSON.stringify(m)), 'generate 不接触报告（ERR_REPORT_CORRUPT N/A）')

  for (const d of [tmp, t2, t3, t4, t5]) rmSync(d, { recursive: true, force: true })
}
