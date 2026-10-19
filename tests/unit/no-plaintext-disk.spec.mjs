/**
 * no-plaintext-disk.spec —— P2 出口门禁之一：全链路无明文落盘（§2.5 不变量）。
 *
 * 三层验证：
 *   ① 采集脚本内嵌的脱敏函数**真的能脱敏**（用 bash 实跑 shim，断言明文消失）
 *   ② 二次校验命中时**拒绝**，且内存中的原始内容不落盘（跑完扫描磁盘找标记串）
 *   ③ 跨轮持久化只写白名单字段（不含原始报告文本/明文）
 */
import { mkdtempSync, cpSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')

export const NAME = 'no-plaintext-disk（① shim 真脱敏 ② 拒绝不落盘 ③ 持久化白名单）'

const PLAINTEXT = '10.201.33.7'
const PLAINTEXT2 = '210235A4KQ11Z'

function scanDirFor(dir, needle, out = []) {
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) scanDirFor(p, needle, out)
    else {
      try {
        const buf = readFileSync(p)
        if (buf.includes(Buffer.from(needle))) out.push(p)
      } catch { /* 二进制/权限：跳过 */ }
    }
  }
  return out
}

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-plain-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-plain', version: '0.0.1' }))
  const storage = join(tmp, 'sessions')
  const core = createCore({ pkgRoot: tmp, storageDir: storage, persist: true })
  const dims = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }

  // ---- ① shim 真脱敏（跑 bash，断言明文被替换）----
  const g = core.generateCollectScript({ description: `现场设备 ${PLAINTEXT} 序列号 ${PLAINTEXT2} 崩溃`, dimensions: dims })
  // 按行提取函数体：不能按字符找第一个 '}'（正则里的 {1,3} 会先命中）
  const sLines = g.data.script.split('\n')
  const startIdx = sLines.findIndex((l) => l.startsWith('dsh_desensitize() {'))
  let endIdx = -1
  for (let i = startIdx + 1; i < sLines.length; i++) {
    if (sLines[i] === '}') { endIdx = i; break }
  }
  t.assert(startIdx >= 0 && endIdx > startIdx, '能从生成脚本里提取出脱敏函数体')
  const shimBody = sLines.slice(startIdx, endIdx + 1).join('\n')
  const probe = `device ${PLAINTEXT} serial ${PLAINTEXT2} user /Users/alice/svc key sk-abcdefgh12345`
  const outPath = join(tmp, 'shim-out.txt')
  writeFileSync(join(tmp, 'shim.sh'), `${shimBody}\nprintf '%s\\n' "$1" | dsh_desensitize > "$2"\n`)
  execFileSync('bash', [join(tmp, 'shim.sh'), probe, outPath])
  const shimmed = readFileSync(outPath, 'utf8')
  t.assert(!shimmed.includes(PLAINTEXT), `shim 抹掉 IPv4（输出：${shimmed.trim()}）`)
  t.assert(!shimmed.includes(PLAINTEXT2), 'shim 抹掉序列号')
  t.assert(!shimmed.includes('alice'), 'shim 抹掉含用户名路径')
  t.assert(!shimmed.includes('sk-abcdefgh'), 'shim 抹掉凭据前缀')
  t.assert(shimmed.includes('<IP>') && shimmed.includes('<SERIAL>'), 'shim 用占位符替换（而非删除整行）')

  // ---- ② 二次校验命中 → 拒绝 + 磁盘无明文 ----
  const leakyReport = [
    '=== kernel-log ===',
    `--- cmd: dmesg`,
    `[ 4821.13] error on device ${PLAINTEXT} serial ${PLAINTEXT2}`,
    '=== end:kernel-log ===',
  ].join('\n')
  let missBody = null
  let missCode = null
  try {
    core.parseCollectReport({ report: leakyReport, manifest: { sections: ['kernel-log'] } })
  } catch (e) {
    missCode = e.code
    missBody = e.body
  }
  t.assert(missCode === 'ERR_DESENSITIZE_MISS', `含明文报告被拒（实际 ${missCode}）`)
  t.assert(missBody.hits.length >= 2, '命中记录 ≥2（IPv4 与序列号）')
  t.assert(missBody.hits.every((h) => !String(h.maskedSnippet).includes(PLAINTEXT) && !String(h.maskedSnippet).includes(PLAINTEXT2)), 'hits 中的片段已打码，不含明文')
  const leaked = scanDirFor(tmp, PLAINTEXT, []).concat(scanDirFor(storage, PLAINTEXT, []))
  t.assert(leaked.length === 0, `拒绝后磁盘无明文残留（扫描 ${tmp} 与 storage，命中：${leaked.join(', ') || '无'}）`)

  // ---- ③ 跨轮持久化白名单：只存 hash/结构，不存报告原文 ----
  const clean = [
    '=== kernel-log ===', '--- cmd: dmesg', '[ 4821.13] HBM ECC uncorrectable error', '=== end:kernel-log ===',
    '=== npu-metrics ===', '--- cmd: npu-smi info -t temp -c 0', 'temp 92C (throttle threshold 85C)', '=== end:npu-metrics ===',
  ].join('\n')
  const p = core.parseCollectReport({ report: clean, manifest: { sections: ['kernel-log', 'npu-metrics'] } })
  core.tracker.beginRound('s1', dims)
  core.tracker.recordParsed('s1', 1, {
    evidenceHashes: p.data.probeHashes,
    missingSections: p.data.parseMeta.missingSections,
    probesCollected: p.data.probeHashes.map((h) => h.probe),
  })
  const recPath = join(storage, 's1.json')
  t.assert(existsSync(recPath), 'A 形态下落盘了轮次记录')
  const rec = readFileSync(recPath, 'utf8')
  t.assert(!rec.includes('HBM ECC uncorrectable'), '持久化不含证据原文（snippet）')
  t.assert(!rec.includes('temp 92C'), '持久化不含第二条证据原文')
  t.assert(/sha256:/.test(rec), '持久化含探针 hash')
  const keys = Object.keys(JSON.parse(rec)[0])
  const WHITELIST = ['sessionId', 'round', 'ts', 'dims', 'probesCollected', 'evidenceHashes', 'missingSections', 'fixApplied', 'fixState', 'outcome']
  t.assert(keys.every((k) => WHITELIST.includes(k)), `记录字段全部在白名单内（实际 ${keys.join(',')}）`)

  rmSync(tmp, { recursive: true, force: true })
}
