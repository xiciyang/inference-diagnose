/**
 * governance.spec —— 长任务 1 / A2（风险分级）+ A3（审计哈希链）+ A5（命名空间）出口门禁。
 *
 * 三条纪律，各自都有"看起来做了其实没做"的失败模式，所以都落成机器判据：
 *   A2  声明面 ⇄ 工具面必须**互相**覆盖（少声明 / 多声明都算漂移）；
 *       并且"无需确认令牌"要由 `confirmation: not-required` 推出，不能只写在注释里。
 *   A3  链必须**可复算**：改动、删除、重排都要被检出；
 *       审计文件里**不得**出现任何参数明文（只存摘要），否则 §2.5"不落盘"不变量从后门被破坏。
 *   A5  命名空间冲突要**去兄弟包源码里抓真实工具名**做交集，而不是靠人眼比对注释。
 */
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore, apply, TOOL_NAMES } from '../../src/index.js'
import { TOOL_RISK, RISK_TIERS, SANDBOX_TIERS, riskManifest, requiresConfirmation } from '../../src/governance/risk.js'
import { appendAudit, verifyAuditChain, verifyAllAuditChains, readAudit, auditDirFor, canonicalJson } from '../../src/governance/audit.js'
import { parse } from '../../src/primitives/yaml-lite.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
// 跨包命名空间检查需要兄弟仓库；没有就显式 skip（不伪造通过）。
const WORKSPACE = process.env.INFERENCE_WORKSPACE || null

export const NAME = 'governance（A2 风险声明 / A3 审计哈希链 / A5 命名空间）'

function tree() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-gov-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-gov', version: '0.0.1' }))
  return tmp
}

function scanDirFor(dir, needle, out = []) {
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) scanDirFor(p, needle, out)
    else {
      try { if (readFileSync(p).includes(Buffer.from(needle))) out.push(p) } catch { /* 跳过 */ }
    }
  }
  return out
}

/** 用"像 DSH 一样挑刺"的 mock ctx 真跑一遍 apply()，把注册到的工具抓下来。 */
function registerViaApply(env) {
  const tmp = env.root
  const prevHome = process.env.DSH_HOME
  const prevRoot = process.env.INFERENCE_DIAGNOSE_ROOT
  process.env.DSH_HOME = join(tmp, 'dsh-home')
  process.env.INFERENCE_DIAGNOSE_ROOT = join(tmp, 'ai-infra')
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return d },
    get() { return undefined },
    on() { return () => {} },
    tools: {
      register(tool) {
        if (!tool.output || !tool.output.schema || typeof tool.output.render !== 'function') {
          throw new Error(`tool "${tool.name}" must declare output { schema, render, presentationMeta? }`)
        }
        registered.push(tool)
        return () => {}
      },
    },
  }
  let threw = null
  try { apply(ctx) } catch (e) { threw = String(e.message) }
  return {
    registered, threw, ctx,
    restore() {
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome
      if (prevRoot === undefined) delete process.env.INFERENCE_DIAGNOSE_ROOT; else process.env.INFERENCE_DIAGNOSE_ROOT = prevRoot
    },
  }
}

export async function run(t) {
  // ════════════════════════ A2：风险分级声明面 ════════════════════════
  const env = { root: tree() }
  const reg = registerViaApply(env)
  const registeredNames = reg.registered.map((x) => x.name)
  t.assert(reg.threw === null, `apply() 在 mock ctx 下不抛错（实际：${reg.threw}）`)
  t.assert(JSON.stringify(registeredNames) === JSON.stringify([...TOOL_NAMES]),
    `注册的工具面与 TOOL_NAMES 逐条一致（实际 ${registeredNames.join(', ')}）`)
  t.assert(Object.keys(TOOL_RISK).length === 5, `风险声明覆盖 5 个工具（实际 ${Object.keys(TOOL_RISK).length}）`)
  for (const n of registeredNames) t.assert(!!TOOL_RISK[n], `${n} 有风险声明`)
  for (const n of Object.keys(TOOL_RISK)) t.assert(registeredNames.includes(n), `风险声明 ${n} 有对应工具（不多声明）`)
  for (const [n, d] of Object.entries(TOOL_RISK)) {
    t.assert(RISK_TIERS.includes(d.risk), `${n}: risk 在闭集内`)
    t.assert(SANDBOX_TIERS.includes(d.sandbox), `${n}: sandbox 在闭集内`)
    t.assert(d.risk === 'read' && d.sandbox === 'none', `${n}: 只读且无需沙箱（实际 ${d.risk}/${d.sandbox}）`)
    t.assert(requiresConfirmation(n) === false, `${n}: 无需确认令牌`)
    t.assert(Array.isArray(d.resources) && d.resources.length > 0, `${n}: 声明了资源面`)
  }
  t.assert(riskManifest().confirmationRequiredFor.length === 0, '全插件无任何需要确认令牌的工具')

  // manifest.yaml 与 risk.mjs 必须逐工具一致
  const mf = parse(readFileSync(join(PKG_ROOT, 'manifest.yaml'), 'utf8'))
  const mfIds = (mf.capabilities || []).map((c) => c.id)
  t.assert(JSON.stringify([...mfIds].sort()) === JSON.stringify([...registeredNames].sort()),
    `manifest.yaml capabilities 与工具面一致（实际 ${mfIds.join(', ')}）`)
  for (const c of mf.capabilities || []) {
    const d = TOOL_RISK[c.id] || {}
    t.assert(c.risk === d.risk, `manifest ${c.id}: risk 与 risk.mjs 一致（${c.risk} vs ${d.risk}）`)
    t.assert(c.sandbox === d.sandbox, `manifest ${c.id}: sandbox 与 risk.mjs 一致`)
    t.assert(c.confirmation === d.confirmation, `manifest ${c.id}: confirmation 与 risk.mjs 一致`)
  }
  t.assert(Array.isArray(mf.not_provided) && mf.not_provided.length >= 3, 'manifest 显式声明 not_provided（区分"未声明所以拒绝"与"设计上不做"）')
  t.assert((mf.not_provided || []).some((x) => x.id === 'execute_collect_script'), 'not_provided 含"不代执行采集脚本"')

  // ════════════════════════ A3：审计哈希链 ════════════════════════
  const root = join(env.root, 'ai-infra')
  const date = new Date('2026-01-02T00:00:00Z') // 刻意不用今天：工具调用留痕会写今天的分片，两者必须隔离
  const a1 = await appendAudit(root, { capability: 't', action: 'tool-call', seqNote: 1 }, { date, pkgVersion: '0.0.1' })
  const a2 = await appendAudit(root, { capability: 't', action: 'tool-call', seqNote: 2 }, { date, pkgVersion: '0.0.1' })
  const a3 = await appendAudit(root, { capability: 't', action: 'tool-call', seqNote: 3 }, { date, pkgVersion: '0.0.1' })
  t.assert(a1.seq === 1 && a2.seq === 2 && a3.seq === 3, 'seq 单调递增')
  t.assert(a1.prevHash === '0'.repeat(64), '首条 prevHash = GENESIS')
  t.assert(a2.prevHash === a1.hash && a3.prevHash === a2.hash, 'prevHash 首尾相接（链成立）')
  const v0 = await verifyAuditChain(root, { date })
  t.assert(v0.ok === true && v0.checked === 3, `整链复算通过（checked=${v0.checked}）`)

  // 改动任意一条 → 检出，并指出位置
  const file = join(auditDirFor(root), '2026-01-02.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  const tampered = JSON.parse(lines[1]); tampered.action = 'tool-call-EDITED'
  const l2 = [...lines]; l2[1] = JSON.stringify(tampered)
  writeFileSync(file, l2.join('\n') + '\n')
  const v1 = await verifyAuditChain(root, { date })
  t.assert(v1.ok === false && v1.brokenAt === 2, `改内容被检出且定位到第 2 条（实际 ok=${v1.ok} brokenAt=${v1.brokenAt}）`)
  t.assert(/被改动/.test(String(v1.reason)), '原因说明是"内容被改动"')

  // 删除中间一条 → 检出
  const l3 = [lines[0], lines[2]]
  writeFileSync(file, l3.join('\n') + '\n')
  const v2 = await verifyAuditChain(root, { date })
  t.assert(v2.ok === false, '删除记录被检出（prevHash 断链）')

  // 恢复 + 跨分片（跨进程一致性：另起一次 append 读的是磁盘上的 head，不是内存态）
  writeFileSync(file, lines.join('\n') + '\n')
  const other = new Date('2026-01-03T00:00:00Z')
  const b1 = await appendAudit(root, { capability: 't', action: 'tool-call', seqNote: 'next-day' }, { date: other, pkgVersion: '0.0.1' })
  t.assert(b1.prevHash === '0'.repeat(64), '新日期分片独立成链（prevHash = GENESIS）')
  const va = await verifyAllAuditChains(root)
  t.assert(va.ok === true && va.files === 2, `全部分片复算通过（files=${va.files}）`)
  // 跨进程：子进程重新读盘复算，结果必须一致（不能依赖父进程的内存态）
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(process.execPath, ['-e',
    `import(${JSON.stringify(join(PKG_ROOT, 'src/governance/audit.js'))}).then(async (m)=>{const r=await m.verifyAllAuditChains(${JSON.stringify(root)});process.stdout.write(JSON.stringify({ok:r.ok,files:r.files}))})`,
  ], { encoding: 'utf8', timeout: 60000 })
  t.assert(out.includes('"ok":true'), `跨进程复算一致（子进程输出 ${out.slice(0, 80)}）`)

  // 只追加：文件模式必须是 0600（不是 0644 —— 审计记录含资产/结果元数据）
  const mode = (statSync(file).mode & 0o777).toString(8)
  t.assert(mode === '600', `审计文件权限 0600（实际 ${mode}）`)

  // ════════════════════════ A3：真工具调用留痕 + 明文零落盘 ════════════════════════
  const PLAINTEXT = '10.201.33.7'
  const tool = reg.registered.find((x) => x.name === 'generate_collect_script')
  const out1 = await tool.execute({ description: `现场设备 ${PLAINTEXT} 崩溃`, dimensions: { framework: 'vllm', runtime: 'docker', hardware: 'gb10' } })
  t.assert(out1.ok === true, '工具经 apply() 注册后可真调用并返回 ok')
  t.assert(!!out1.governance && out1.governance.risk === 'read' && out1.governance.confirmationRequired === false,
    '返回信封带 governance 块（risk/confirmationRequired）')
  t.assert(out1.governance.audit && out1.governance.audit.ok === true, '审计写入成功并回传 file/seq/hash')
  t.assert(typeof out1.governance.audit.hash === 'string' && out1.governance.audit.hash.length === 64, '回传 64 位 sha256 链哈希')
  // 只读操作也留痕：错误路径同样留痕
  const out2 = await tool.execute({ dimensions: { framework: 'vllm', runtime: 'docker', hardware: 'gb10' } })
  t.assert(out2.ok === false, '缺 description → 失败信封')
  t.assert(out2.governance && out2.governance.audit && out2.governance.audit.ok === true, '失败的只读调用同样留痕')
  t.assert(out2.governance.audit.seq > out1.governance.audit.seq, '审计 seq 递增（失败调用也占一条）')
  // 明文零落盘
  const hits = scanDirFor(join(env.root, 'ai-infra'), PLAINTEXT)
  t.assert(hits.length === 0, `审计目录内不得出现参数明文（命中 ${hits.map((h) => h.replace(env.root, '')).join(', ') || 'none'}）`)
  const au = await readAudit(join(env.root, 'ai-infra'), { date: new Date() })
  t.assert(au.records.length === 2, `本次两个调用各留一条痕（实际 ${au.records.length}）`)
  t.assert(au.records.every((r) => typeof r.argsDigest === 'string' && r.argsDigest.startsWith('sha256:')), '每条记录带参数摘要')
  t.assert(au.records.every((r) => Array.isArray(r.argsKeys) && !JSON.stringify(r.argsKeys).includes(PLAINTEXT)), '只记参数名，不记参数值')
  t.assert(au.records.every((r) => r.schema === 'inference-diagnose/audit@1'), '审计记录 schema 标识一致')
  const av = await verifyAuditChain(join(env.root, 'ai-infra'), { date: new Date() })
  t.assert(av.ok === true && av.checked === 2, '真调用产生的链可复算')
  // canonicalJson 稳定性（同一逻辑值同一哈希 —— 与三插件同算法）
  t.assert(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }) === canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }), 'canonicalJson 键序稳定')

  // core 侧自检入口（不新增工具，A2/A5 把工具面钉死在 5 个）
  const core = createCore({ pkgRoot: PKG_ROOT, storageDir: join(env.root, 's'), persist: false })
  t.assert(typeof core.governance.verifyChain === 'function' && typeof core.governance.verifyAll === 'function', 'core 暴露审计自检入口')
  t.assert(typeof core.risk === 'function' && Object.keys(core.risk().tools).length === 5, 'core 暴露风险声明真源')

  reg.restore()

  // ════════════════════════ A5：命名空间（去兄弟包源码抓真实工具名）════════════════════════
  const siblings = WORKSPACE ? [
    ['inference-serving', join(WORKSPACE, 'inference-serving', 'src', 'tools.mjs')],
    ['inference-quantization', join(WORKSPACE, 'inference-quantization', 'src', 'tools.mjs')],
    ['inference-tuning', join(WORKSPACE, 'inference-tuning', 'src', 'index.mjs')],
  ] : []
  const present = siblings.filter(([, p]) => existsSync(p))
  if (WORKSPACE) {
    t.assert(present.length === 3, `三个兄弟包源码可读（实际 ${present.length}/3；WORKSPACE=${WORKSPACE}）`)
  } else {
    t.skip('未设置 INFERENCE_WORKSPACE：跳过「与三个兄弟插件的工具名不重名」检查（不是通过）')
  }
  const siblingNames = []
  for (const [pkg, p] of present) {
    const text = readFileSync(p, 'utf8')
    const found = [...text.matchAll(/name:\s*'(inference_[a-z_]+)'/g)].map((m) => m[1])
    t.assert(found.length > 0, `${pkg} 抓到工具名（${found.length} 个）`)
    siblingNames.push(...found)
  }
  const overlap = TOOL_NAMES.filter((n) => siblingNames.includes(n))
  t.assert(overlap.length === 0, `本插件 5 个裸名与三插件工具面无交集（实际重叠：${overlap.join(', ') || 'none'}）`)
  t.assert(siblingNames.every((n) => n.startsWith('inference_')), '三插件工具名一律带 inference_ 前缀（前缀纪律）')
  t.assert(TOOL_NAMES.every((n) => !n.startsWith('inference_')), '本插件五个工具一律裸名（无前缀纪律）')

  rmSync(env.root, { recursive: true, force: true })
}
