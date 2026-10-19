/**
 * closure-tracker —— §3.3 跨轮次状态持久化 + §4.4 三形态（A / B1 / B2）。
 *
 * 形态判定（§4.4）：
 *   A  宿主提供可写持久化（默认 <DSH_HOME>/inference-diagnose/sessions/）
 *   B1 仅进程内存储（配置 persist:false，或目录不可写但进程内 Map 可用）
 *   B2 无任何存储（配置 store:false 且进程内禁用）→ 多轮请求降级为单轮语义
 *
 * 硬约束（§3.3）：
 *   - 只存白名单字段；恒不存原始报告文本或明文
 *   - 每轮一次原子提交（临时文件 + rename）；失败回滚，不允许半写
 *   - 主键 (sessionId, round)：同轮重复提交按 upsert 处理（幂等）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname as dirnameOf } from 'node:path'

/**
 * 伪文件系统拒绝表（2026-09-18 实测缺陷）：
 * 对 /proc 之类伪文件系统执行 `mkdirSync(..., {recursive:true})` 在部分内核/沙箱组合下会
 * **无限阻塞**（实测 `timeout 6 node -e "fs.mkdirSync('/proc/x/y',{recursive:true})"` → 超时被 kill）。
 * 形态探测因此可能把宿主进程挂死——比"探测失败"严重得多。
 * 策略：明确拒绝这些前缀，直接判定为"不可持久化"，不尝试创建。
 * 残余风险（未关闭）：阻塞型网络文件系统（如挂死的 NFS）仍可能卡住同步探测，
 * 彻底解决需把形态探测改为"异步 + 超时"（见 §5.x 未关闭项）。
 */
const PSEUDO_FS_RE = /^\/(proc|sys|dev)(\/|$)/

function probeWritable(dir) {
  if (PSEUDO_FS_RE.test(String(dir))) return { ok: false, reason: 'pseudo-fs-refused' }
  try {
    const parent = dirnameOf(dir)
    if (existsSync(parent)) {
      const st = statSync(parent)
      if (!st.isDirectory()) return { ok: false, reason: 'parent-not-a-directory' }
    }
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.write-probe')
    writeFileSync(probe, String(Date.now()))
    rmSync(probe, { force: true })
    return { ok: true, reason: 'writable' }
  } catch (e) {
    return { ok: false, reason: String(e.code || e.message).slice(0, 60) }
  }
}

const WHITELIST = [
  'sessionId',
  'round',
  'ts',
  'dims',
  'probesCollected',
  'evidenceHashes',
  'missingSections',
  'fixApplied',
  'fixState',
  'outcome',
]

export const FORM = Object.freeze({ A: 'A', B1: 'B1', B2: 'B2' })

function sanitize(rec) {
  const out = {}
  for (const k of WHITELIST) if (rec[k] !== undefined) out[k] = rec[k]
  out.evidenceHashes = (rec.evidenceHashes || []).map((h) => ({ probe: h.probe, section: h.section, hash: h.hash }))
  return out
}

export function createTracker({ storageDir = null, persist = true, inProcessStore = true } = {}) {
  const memory = new Map() // sessionId → [records]
  let form = FORM.B2
  let dir = null

  let probeReason = 'persist-disabled'
  if (persist && storageDir) {
    const probe = probeWritable(storageDir)
    probeReason = probe.reason
    if (probe.ok) {
      dir = storageDir
      form = FORM.A
    } else {
      dir = null
      form = inProcessStore ? FORM.B1 : FORM.B2
    }
  } else {
    form = inProcessStore ? FORM.B1 : FORM.B2
  }

  const fileOf = (sessionId) => join(dir, `${encodeURIComponent(sessionId)}.json`)
  const STALE_FILE = '_stale.json'
  const RESIDENCE_FILE = '_residence.json'
  let staleMemory = null // B1/B2：进程内；A：落盘 _stale.json

  function readStale() {
    if (staleMemory) return staleMemory
    if (form === FORM.A && dir) {
      const p = join(dir, STALE_FILE)
      if (existsSync(p)) {
        try {
          staleMemory = JSON.parse(readFileSync(p, 'utf8'))
          return staleMemory
        } catch {
          /* 损坏按空处理 */
        }
      }
    }
    staleMemory = {}
    return staleMemory
  }

  function commitStale(obj) {
    staleMemory = obj
    if (form !== FORM.A || !dir) return { ok: true, persisted: false }
    const target = join(dir, STALE_FILE)
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmp, JSON.stringify(obj, null, 2))
      renameSync(tmp, target)
      return { ok: true, persisted: true }
    } catch (e) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
      return { ok: false, persisted: false, error: String(e.message).slice(0, 120) }
    }
  }

  /**
   * 已知会话 id（用于热更新后扫描活跃 + 近期 closed session）。
   *
   * 侧车文件**不是会话**：`_stale.json` 与 `_residence.json` 都必须排除。
   * 2026-09-28 实测缺陷：`_residence.json` 未被排除 → 它以 `_residence` 之名进入会话列表，
   * 进而被 `markAllStale` 当成一个会话写进 `_stale.json`（脏标记），并出现在状态输出里。
   * 判据统一为"以 `_` 开头的文件是侧车/元数据，永不是会话"（`.migrated-from` 之类同理）。
   */
  function listSessions() {
    const ids = new Set(memory.keys())
    if (form === FORM.A && dir) {
      try {
        for (const f of readdirSync(dir)) {
          if (f.startsWith('_') || f.endsWith('.tmp') || !f.endsWith('.json')) continue
          ids.add(decodeURIComponent(f.replace(/\.json$/, '')))
        }
      } catch { /* ignore */ }
    }
    return [...ids].sort()
  }

  // ── 驻留计时（A14）：进入驻留态时记起点，用户响应/闭环时清除 ──
  // 用独立侧车文件（与 _stale.json 同法），因此**不需要改动 RoundRecord 白名单**（§3.3 CT-I1）。
  let residenceMemory = null

  function readResidence() {
    if (residenceMemory) return residenceMemory
    if (form === FORM.A && dir) {
      const p = join(dir, RESIDENCE_FILE)
      if (existsSync(p)) {
        try { residenceMemory = JSON.parse(readFileSync(p, 'utf8')); return residenceMemory } catch { /* 损坏按空处理 */ }
      }
    }
    residenceMemory = {}
    return residenceMemory
  }

  function commitResidence(obj) {
    residenceMemory = obj
    if (form !== FORM.A || !dir) return { ok: true, persisted: false }
    const target = join(dir, RESIDENCE_FILE)
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmp, JSON.stringify(obj, null, 2))
      renameSync(tmp, target)
      return { ok: true, persisted: true }
    } catch (e) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
      return { ok: false, persisted: false, error: String(e.message).slice(0, 120) }
    }
  }

  /** 幂等：已在驻留态时不刷新起点（否则超时永远不触发）。 */
  function markResidence(sessionId, state, now = Date.now()) {
    const obj = { ...readResidence() }
    const cur = obj[sessionId]
    if (!cur || cur.state !== state) obj[sessionId] = { state, since: now }
    return commitResidence(obj)
  }

  function clearResidence(sessionId) {
    const obj = { ...readResidence() }
    if (!(sessionId in obj)) return { ok: true, persisted: false, cleared: false }
    delete obj[sessionId]
    const r = commitResidence(obj)
    return { ...r, cleared: true }
  }

  /** 返回 { state, since, ageMs } 或 null。 */
  function residenceOf(sessionId, now = Date.now()) {
    const cur = readResidence()[sessionId]
    if (!cur) return null
    return { state: cur.state, since: cur.since, ageMs: Math.max(0, now - cur.since) }
  }

  function listResidence() {
    return Object.entries(readResidence()).map(([sessionId, v]) => ({ sessionId, ...v }))
  }

  /** 把会话结论标记为 stale（内容版本已变）。 */
  function markStale(sessionId, info) {
    const obj = { ...readStale() }
    obj[sessionId] = {
      at: new Date().toISOString(),
      generation: info && info.generation,
      reason: (info && info.reason) || 'assets-or-rules-updated',
      to: (info && info.to) || null,
      cleared: false,
    }
    return commitStale(obj)
  }

  function markAllStale(info) {
    const ids = listSessions()
    const r = markStale('#all', info)
    for (const id of ids) markStale(id, info)
    return { marked: ids, ...r }
  }

  /**
   * 读取某会话的失效标记。
   * 语义：会话自身的条目优先（显式 cleared 视为"已复评，不再提示"）；
   *       没有自身条目时退回 #all 级标记（覆盖标记时点之前创建的会话）。
   */
  function staleFor(sessionId) {
    const obj = readStale()
    const own = obj[sessionId]
    if (own) return own.cleared ? null : own
    const all = obj['#all']
    if (!all) return null
    return all.cleared ? null : all
  }

  /** 用户已复评 / 显式确认 → 清除提示（写 cleared 而非删除，避免退回 #all 级）。 */
  function clearStale(sessionId) {
    const obj = { ...readStale() }
    if (sessionId) {
      obj[sessionId] = { ...(obj[sessionId] || {}), cleared: true, clearedAt: new Date().toISOString() }
    } else {
      obj['#all'] = { ...(obj['#all'] || {}), cleared: true, clearedAt: new Date().toISOString() }
      for (const k of Object.keys(obj)) if (k !== '#all') obj[k] = { ...obj[k], cleared: true }
    }
    return commitStale(obj)
  }

  function read(sessionId) {
    if (memory.has(sessionId)) return memory.get(sessionId)
    if (form === FORM.A && dir) {
      const p = fileOf(sessionId)
      if (existsSync(p)) {
        try {
          const recs = JSON.parse(readFileSync(p, 'utf8'))
          memory.set(sessionId, recs)
          return recs
        } catch {
          /* 损坏记录按不存在处理（不静默"半读"） */
        }
      }
    }
    return []
  }

  /** 原子提交：写临时文件 → rename；失败则保留旧内容。 */
  function commit(sessionId, recs) {
    const cleaned = recs.map(sanitize)
    memory.set(sessionId, cleaned)
    if (form !== FORM.A || !dir) return { ok: true, persisted: false }
    const target = fileOf(sessionId)
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmp, JSON.stringify(cleaned, null, 2))
      renameSync(tmp, target)
      return { ok: true, persisted: true }
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      return { ok: false, persisted: false, error: String(e.message).slice(0, 120) }
    }
  }

  function currentRound(sessionId) {
    const recs = read(sessionId)
    return recs.length === 0 ? 0 : Math.max(...recs.map((r) => r.round))
  }

  function beginRound(sessionId, dims) {
    const recs = read(sessionId)
    if (recs.length > 0) return { round: currentRound(sessionId), resumed: true, form }
    const rec = sanitize({ sessionId, round: 1, ts: new Date().toISOString(), dims, probesCollected: [], evidenceHashes: [], missingSections: [] })
    commit(sessionId, [rec])
    return { round: 1, resumed: false, form }
  }

  /** 幂等 upsert：同一 (sessionId, round) 重复提交不追加轮次。 */
  function upsert(sessionId, round, patch) {
    const recs = read(sessionId)
    const idx = recs.findIndex((r) => r.round === round)
    if (idx >= 0) recs[idx] = sanitize({ ...recs[idx], ...patch, sessionId, round })
    else recs.push(sanitize({ sessionId, round, ts: new Date().toISOString(), ...patch }))
    recs.sort((a, b) => a.round - b.round)
    return commit(sessionId, recs)
  }

  const recordParsed = (sessionId, round, p) =>
    upsert(sessionId, round, {
      evidenceHashes: p.evidenceHashes || [],
      missingSections: p.missingSections || [],
      probesCollected: p.probesCollected || [],
    })
  const recordDiagnosis = (sessionId, round, p) => upsert(sessionId, round, { fixState: p.fixState })
  const recordFixApplied = (sessionId, round, p) => upsert(sessionId, round, { fixApplied: p.fixApplied, outcome: p.outcome })
  const closeSession = (sessionId, outcome) => upsert(sessionId, currentRound(sessionId), { outcome })

  /**
   * §2.4 / §3.3 diff 规则：
   *   对比域 = 上轮探针证据 ∩ 两轮 section 交集；本轮缺失段不参与对比
   *   （"未采集" ≠ "证据消失"）
   */
  function diffWithPrevious(sessionId, current) {
    const recs = read(sessionId)
    if (recs.length < 2) return { available: false, reason: '没有上一轮记录（形态 ' + form + '）' }
    const prev = recs[recs.length - 2]
    const curEq = current.evidenceHashes || []
    const curSections = new Set(curEq.map((h) => h.section))
    const missingNow = new Set(current.missingSections || [])
    const changed = []
    const unchanged = []
    const notCollected = []
    for (const h of prev.evidenceHashes || []) {
      if (missingNow.has(h.section)) {
        notCollected.push({ probe: h.probe, section: h.section, why: '本轮未采集该段（不算证据消失）' })
        continue
      }
      if (!curSections.has(h.section)) {
        notCollected.push({ probe: h.probe, section: h.section, why: '两轮 section 无交集（超出对比域）' })
        continue
      }
      const now = curEq.find((c) => c.probe === h.probe && c.section === h.section)
      if (!now) notCollected.push({ probe: h.probe, section: h.section, why: '本轮该探针无证据' })
      else if (now.hash !== h.hash) changed.push({ probe: h.probe, section: h.section, before: h.hash, after: now.hash })
      else unchanged.push({ probe: h.probe, section: h.section })
    }
    const prevProbes = new Set((prev.evidenceHashes || []).map((h) => `${h.probe}|${h.section}`))
    const added = curEq.filter((h) => !prevProbes.has(`${h.probe}|${h.section}`))
    const stall = changed.length === 0 && added.length === 0
    return { available: true, form, prevRound: prev.round, changed, unchanged, notCollected, added, stall }
  }

  return {
    form: () => form,
    probeReason: () => probeReason,
    storageDir: () => dir,
    beginRound,
    recordParsed,
    recordDiagnosis,
    recordFixApplied,
    closeSession,
    diffWithPrevious,
    currentRound,
    listSessions,
    markResidence,
    clearResidence,
    residenceOf,
    listResidence,
    markStale,
    markAllStale,
    staleFor,
    clearStale,
    rounds: (sessionId) => read(sessionId).map((r) => ({ round: r.round, outcome: r.outcome, fixState: r.fixState })),
  }
}
