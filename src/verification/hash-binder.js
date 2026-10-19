/**
 * hash-binder —— §1.11 四元组版本绑定 {plugin, schema, rules, assets}。
 *
 * 每个工具返回都携带四元组；结论据此与"当时的规则/资产"绑定，供 §4.4 失效判定。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export function sha256File(path) {
  if (!existsSync(path)) return null
  return 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 32)
}

export function sha256Text(text) {
  return 'sha256:' + createHash('sha256').update(String(text)).digest('hex').slice(0, 32)
}

export function createHashBinder({ pkgRoot, schemaVersion = '2' }) {
  let pluginVersion = '0.0.0'
  try {
    pluginVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    /* 版本读不到时保留默认值（不阻塞主流程） */
  }

  function bind({ rules, assets }) {
    return { plugin: pluginVersion, schema: schemaVersion, rules: rules || 'unknown', assets: assets || 'unknown' }
  }

  return { bind, pluginVersion, schemaVersion }
}
