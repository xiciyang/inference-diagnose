/**
 * audit —— append-only 审计 + sha256 哈希链（A3）。
 *
 * 契约（**2026-09-28 实测更正：四个插件不是一个算法，是两个**）：
 *   - 每个记录带 `prevHash`（同文件上一条的 `hash`）与自己的 `hash`
 *   - 本插件采用的变体 = `canonical-json`：`hash = sha256(canonicalJson(record 去掉 hash 字段))`
 *     —— 与 `inference-tuning` 相同
 *   - `inference-serving` / `inference-quantization` 采用 `prevhash-canonical-json`：
 *     `hash = sha256(prevHash + "\n" + canonicalJson(record 去掉 hash 字段))`
 *   两者各自内部自洽，但**同名同目录同格式却用不同的哈希函数**。
 *   本条不是推测：长任务 1 阶段 B 用 `@ai-infra/audit-core` 独立复算四个包的线上分片
 *   （678 条）时查出，不指定变体时 serving/quantization 的每条都报"内容被改动"。
 *   本文件此前写的"与另两包同构"是**错的**，已按实测更正；跨包不一致登记在
 *   `SHARED_LIBS_CONTRACT.md` §"跨包实测不一致"。
 *   - 键序稳定：同一逻辑值同一哈希（这一条四插件一致）
 *   - 落盘用 O_APPEND + 0600（"只追加不可改"在 POSIX 下的直接表达）
 *   - 复算整链：改过/插过/重排任何一条都会被发现（尾部截断检不出，见共享库契约的诚实边界）
 *   - 每个日期一个分片 `<YYYY-MM-DD>.jsonl`；**分片之间各自独立成链**（四插件一致）
 *   - 落点：`<root>/logs/audit/inference-diagnose/<date>.jsonl`，root 默认 `~/.ai-infra`
 *
 * 为什么**只读操作也留痕**（A3 的明确要求）：
 *   本插件五个工具都不改用户系统，但这不代表"无需留痕" —— 恰恰相反，
 *   诊断结论会被拿去改生产配置，事后必须能回答"哪一次调用、基于哪一版资产/规则、
 *   输入摘要是什么、结论码是什么"。没有不可改的证据链，这类问题只能靠记忆。
 *
 * 明文纪律（与 §2.5 同一条不变量）：
 *   审计记录**只存参数摘要**（sha256）与**参数名列表**，绝不存参数值 ——
 *   报告文本里可能带未脱敏内容，把它写进审计文件等于把"不落盘"这条不变量
 *   从后门破坏掉。`tests/unit/governance.spec.mjs` 用真实明文串做落盘扫描来锁死这条。
 *
 * 审计失败不阻塞诊断：写不进去时把失败**如实**写进返回信封的 `governance.audit`，
 * 而不是静默吞掉（静默 = 让"没有留痕"看起来像"没有发生"）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const AUDIT_SCHEMA = 'inference-diagnose/audit@1'
export const GENESIS = '0'.repeat(64)
export const PKG_NAME = 'inference-diagnose'

/** 审计根目录：`INFERENCE_DIAGNOSE_ROOT` 覆盖（测试与多实例隔离用），默认 `~/.ai-infra`。 */
export function auditRootFromEnv(env = process.env) {
  return env.INFERENCE_DIAGNOSE_ROOT || join(homedir(), '.ai-infra')
}

export function auditDirFor(root) {
  return join(root, 'logs', 'audit', PKG_NAME)
}

export function auditFileFor(root, date = new Date()) {
  return join(auditDirFor(root), `${date.toISOString().slice(0, 10)}.jsonl`)
}

/** sha256 十六进制摘要。 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * 稳定序列化：对象键排序后序列化，保证同一逻辑值产出同一字符串。
 * 与三插件的 `util/hash.mjs::canonicalJson` **逐字同算法** ——
 * 两套实现差一个字符就会算出不同的链，届时"跨包校验同一条链"无从谈起。
 */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue
      out[k] = sortDeep(v[k])
    }
    return out
  }
  return v
}

async function appendLine(p, line) {
  await fs.mkdir(dirname(p), { recursive: true, mode: 0o700 })
  const fh = await fs.open(p, 'a', 0o600)
  try {
    const buf = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8')
    await fh.write(buf)
    return buf.length
  } finally {
    await fh.close()
  }
}

async function readText(p, fallback = null) {
  try {
    return await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}

async function lastHashOf(file) {
  const raw = await readText(file, null)
  if (!raw) return GENESIS
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const rec = JSON.parse(lines[i])
      if (typeof rec.hash === 'string') return rec.hash
    } catch { /* 跳过损坏行 */ }
  }
  return GENESIS
}

/** 参数摘要：**只**产出 sha256 与键名列表，绝不返回原文。 */
export function digestArgs(args) {
  const a = args && typeof args === 'object' ? args : {}
  return {
    argsDigest: `sha256:${sha256(canonicalJson(a))}`,
    argsKeys: Object.keys(a).sort(),
  }
}

/**
 * 追加一条审计记录。
 * @returns {Promise<{file, seq, hash, prevHash, auditId}>}
 */
export async function appendAudit(root, entry, { date = new Date(), pkgVersion = '0.0.0' } = {}) {
  const file = auditFileFor(root, date)
  const prevHash = await lastHashOf(file)
  const raw = await readText(file, null)
  const seq = raw ? raw.split('\n').filter((l) => l.trim() !== '').length + 1 : 1
  const body = {
    schema: AUDIT_SCHEMA,
    seq,
    ts: new Date().toISOString(),
    pkg: PKG_NAME,
    pkgVersion,
    ...entry,
    prevHash,
  }
  const hash = sha256(canonicalJson(body))
  const record = { ...body, hash }
  await appendLine(file, JSON.stringify(record))
  return { file, seq, hash, prevHash, auditId: `aud_${hash.slice(0, 12)}` }
}

export async function readAudit(root, { date = new Date(), limit = 0 } = {}) {
  const file = auditFileFor(root, date)
  const raw = await readText(file, null)
  if (!raw) return { file, records: [], parseErrors: 0 }
  const records = []
  let parseErrors = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try { records.push(JSON.parse(line)) } catch { parseErrors += 1 }
  }
  return { file, records: limit > 0 ? records.slice(-limit) : records, parseErrors }
}

/**
 * 复算整链。任何一条被改动、删除、重排都会失败。
 * @returns {{ok, checked, brokenAt, reason, parseErrors, file, head?}}
 */
export async function verifyAuditChain(root, { date = new Date() } = {}) {
  const { file, records, parseErrors } = await readAudit(root, { date })
  if (parseErrors > 0) {
    return { ok: false, checked: records.length, brokenAt: null, reason: `${parseErrors} 行不是合法 JSON（记录被破坏或截断）`, parseErrors, file }
  }
  let prev = GENESIS
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]
    const { hash, ...body } = rec
    if (body.prevHash !== prev) {
      return { ok: false, checked: records.length, brokenAt: i + 1, reason: `第 ${i + 1} 条的 prevHash 与上一条的 hash 不符（链断了）`, parseErrors, file }
    }
    const recomputed = sha256(canonicalJson(body))
    if (recomputed !== hash) {
      return { ok: false, checked: records.length, brokenAt: i + 1, reason: `第 ${i + 1} 条内容被改动（重算哈希不一致）`, parseErrors, file }
    }
    prev = hash
  }
  return { ok: true, checked: records.length, brokenAt: null, reason: null, parseErrors, file, head: prev }
}

export async function listAuditFiles(root) {
  try {
    const files = await fs.readdir(auditDirFor(root))
    return files.filter((f) => f.endsWith('.jsonl')).sort()
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
}

/** 校验所有日期分片（跨文件不建链，各自独立成链）。 */
export async function verifyAllAuditChains(root) {
  const files = await listAuditFiles(root)
  const results = []
  for (const f of files) {
    const day = f.replace(/\.jsonl$/, '')
    // eslint-disable-next-line no-await-in-loop
    const r = await verifyAuditChain(root, { date: new Date(`${day}T00:00:00Z`) })
    results.push({ day, ...r })
  }
  return { ok: results.every((r) => r.ok), files: results.length, results }
}

/**
 * 工具调用留痕。**绝不抛**：审计写不进去时返回 `{ok:false, reason}`，
 * 由调用方写进信封的 `governance.audit` 里如实暴露。
 */
export async function recordToolCall(root, { tool, args, envelope, durationMs, pkgVersion, assets, rules, risk }, opts = {}) {
  try {
    const appended = await appendAudit(root, {
      capability: tool,
      action: 'tool-call',
      phase: 'end',
      ...digestArgs(args),
      resultOk: envelope?.ok === true,
      resultCode: envelope?.code ?? 'UNKNOWN',
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      risk: risk ?? 'read',
      sandbox: 'none',
      confirmation: 'not-required',
      assets: assets ?? null,
      rules: rules ?? null,
    }, { ...opts, pkgVersion })
    return { ok: true, ...appended }
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e).slice(0, 200) }
  }
}

/** 便于测试与自检：流式算文件 sha256（大文件不吃内存）。 */
export function hashFileStreaming(path) {
  return new Promise((resolvePromise, reject) => {
    const h = createHash('sha256')
    let size = 0
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })
    stream.on('data', (c) => { size += c.length; h.update(c) })
    stream.on('error', reject)
    stream.on('end', () => resolvePromise({ size, hash: h.digest('hex') }))
  })
}

export { randomBytes }
