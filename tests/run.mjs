#!/usr/bin/env node
/**
 * 极简测试驱动（零依赖，与构建路径一致）。
 * 用法：node tests/run.mjs [spec 文件相对路径...]
 */
import { readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

function collect(dir) {
  const out = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) out.push(...collect(p))
    else if (f.endsWith('.spec.mjs')) out.push(p)
  }
  return out.sort()
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => join(ROOT, p))
  : [...collect(join(HERE, 'unit')), ...collect(join(HERE, 'integration'))]
let failed = 0
let passed = 0

for (const file of targets) {
  const mod = await import(pathToFileURL(file).href)
  const label = mod.NAME || file.split('/').slice(-2).join('/')
  let asserts = 0
  const failures = []
  const skipped = []
  const t = {
    assert(cond, msg) {
      asserts += 1
      if (!cond) failures.push(msg)
    },
    // 跳过通道：**不计入断言数**。用于"该路径已由别的用例覆盖 / 本机不适用"的显式登记。
    // 不允许用 `assert(true, …)` 表达跳过 —— 那会给断言数灌水，让证据数字变成不可复现值。
    skip(msg) { skipped.push(msg) },
  }
  console.log(`\n=== ${label} ===`)
  try {
    await mod.run(t)
  } catch (e) {
    failures.push(`抛出异常：${String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)}`)
  }
  for (const s of skipped) console.log(`SKIP  ${s}`)
  if (failures.length === 0) {
    passed += 1
    console.log(`PASS  ${asserts} 项断言${skipped.length ? `（另有 ${skipped.length} 项跳过，不计入）` : ''}`)
  } else {
    failed += 1
    console.log(`FAIL  ${failures.length}/${asserts} 项断言未通过：`)
    for (const f of failures) console.log(`  - ${f}`)
  }
}

console.log(`\n${failed === 0 ? 'ALL SPECS PASSED' : 'SPEC FAILURES'}: ${passed} passed / ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
