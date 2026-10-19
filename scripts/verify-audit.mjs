#!/usr/bin/env node
/**
 * verify-audit.mjs —— 审计哈希链复算入口（A3 的"如何复算"落地）。
 *
 * 为什么不做成第 6 个工具：A2/A5 把工具面钉死在**五个裸名**上
 * （`TOOL_NAMES` + `manifest.yaml` 双向断言）。为一次自检再加一个工具，
 * 会同时破坏"5 个工具"这条声明面与命名空间断言。故复算走脚本 + `core.governance.*`。
 *
 * 用法：
 *   node scripts/verify-audit.mjs                 # 复算全部分片（默认 ~/.ai-infra）
 *   node scripts/verify-audit.mjs --root /tmp/x   # 指定审计根
 *   node scripts/verify-audit.mjs --day 2026-09-28
 *   node scripts/verify-audit.mjs --tail 5        # 顺带打印最后 5 条（仍**不回显**参数值）
 *
 * 退出码：0 = 链完整；1 = 链损坏或读取失败（可直接用于 CI/巡检）。
 */
import { auditRootFromEnv, auditDirFor, verifyAuditChain, verifyAllAuditChains, readAudit, listAuditFiles } from '../src/governance/audit.js'

const argv = process.argv.slice(2)
const argOf = (k, d = null) => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const root = argOf('--root') || auditRootFromEnv()
const day = argOf('--day')
const tail = Number(argOf('--tail', '0')) || 0

const dir = auditDirFor(root)
console.log(`审计根：${root}`)
console.log(`分片目录：${dir}`)
const files = await listAuditFiles(root)
console.log(`分片：${files.length} 个${files.length ? `（${files.join(', ')}）` : ''}`)

let ok = true
if (day) {
  const r = await verifyAuditChain(root, { date: new Date(`${day}T00:00:00Z`) })
  ok = r.ok
  console.log(`${r.ok ? 'OK  ' : 'BAD '} ${day}：checked=${r.checked} head=${String(r.head || '').slice(0, 16)} ${r.reason || ''}`)
  if (tail > 0) {
    const { records } = await readAudit(root, { date: new Date(`${day}T00:00:00Z`), limit: tail })
    for (const rec of records) {
      // 只打印**元数据**：审计记录本身不含参数值（只有 argsDigest / argsKeys）
      console.log(`  seq=${rec.seq} ${rec.ts} ${rec.capability} ${rec.resultCode} hash=${String(rec.hash).slice(0, 12)}`)
    }
  }
} else {
  const all = await verifyAllAuditChains(root)
  ok = all.ok
  for (const r of all.results) {
    console.log(`${r.ok ? 'OK  ' : 'BAD '} ${r.day}：checked=${r.checked} ${r.reason || ''}`)
  }
  console.log(all.ok ? `\n链完整：${all.files} 个分片全部通过复算` : '\n链已损坏：见上方 BAD 行')
}

process.exit(ok ? 0 : 1)
