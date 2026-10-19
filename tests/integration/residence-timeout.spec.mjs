/**
 * residence-timeout.spec —— A-§3-5 / A-§4-2（A14 驻留限时提醒）出口门禁。
 *
 * 契约（§2.1 notices[] 通道 + §3.2 I7 + §4.4）：
 *   ① 未超时：不产生任何 residence-timeout 声明（不误报）
 *   ② 超时：下次调用该 session 的工具时，在**既有 notices[] 通道**追加 residence-timeout
 *   ③ 用户响应（新证据/闭环）→ 驻留计时重置，旧提醒不再出现
 *   ④ 多会话各自独立计时，互不串扰
 *   ⑤ 通道合规：不新增顶层字段、不动 degradations、优先级落在 version-drift 之后
 *   ⑥ 出口自动置位：需补采 → AWAITING_COLLECTION；REFUSE → REFUSED
 */
import { mkdtempSync, cpSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCore } from '../../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIMS = { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' }
const SEC = (n, body) => `=== ${n} ===\n--- cmd: probe-${n}\n${body}\n=== end:${n} ===`
const REPORT = [
  SEC('mindie-log', '[ERROR] RuntimeError: infer failed, abort\n[ERROR] driver version 24.1.RC2 != required 24.1.RC3 (compat check failed)'),
  SEC('npu-status', 'NPU 0 health OK'),
  SEC('npu-driver-matrix', 'driver 24.1.RC2\nboard 0x2c OK'),
  SEC('container-state', 'mindie-svc Exited (137) 2 hours ago\nExitCode 137 OOMKilled shm 64m'),
  SEC('container-log', 'shm allocation failed: out of memory'),
  SEC('npu-metrics', 'temp 92C (throttle threshold 85C)'),
  SEC('kernel-log', '[ 4821.13] HBM ECC uncorrectable error on device 3, rank 3'),
].join('\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const codes = (res) => (res.data.notices || []).map((n) => n.code)

export const NAME = 'residence-timeout（A14：未超时不报 / 超时报 / 响应即重置 / 多会话独立）'

export async function run(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-residence-'))
  cpSync(join(PKG_ROOT, 'assets'), join(tmp, 'assets'), { recursive: true })
  cpSync(join(PKG_ROOT, 'model'), join(tmp, 'model'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-residence', version: '0.0.1' }))
  const THRESH = 60
  const core = createCore({
    pkgRoot: tmp,
    storageDir: join(tmp, 'sessions'),
    persist: true,
    residenceTimeoutMs: THRESH,
  })
  core.hotloader.init()

  const g = core.generateCollectScript({ description: '推理服务崩溃，温度高、ECC 报错、容器 137', dimensions: DIMS })
  const p = core.parseCollectReport({ report: REPORT, manifest: g.data.manifest })

  // ── ① 未超时：不产生 residence-timeout ──
  const sA = 'res-A'
  core.tracker.markResidence(sA, 'AWAITING_COLLECTION')
  t.assert(core.residence.of(sA).state === 'AWAITING_COLLECTION', '① 驻留态登记（AWAITING_COLLECTION）')
  const dA1 = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: sA } })
  t.assert(dA1.ok === true, '① 未超时诊断正常返回')
  t.assert(!codes(dA1).includes('residence-timeout'), `① 未超时**不**报 residence-timeout（实际 ${JSON.stringify(codes(dA1))}）`)
  t.assert(core.residence.of(sA) === null || core.residence.of(sA).state === 'AWAITING_COLLECTION', '① 未超时驻留计时不被误清（仍在等待）')

  // ── ② 出口自动置位：需补采 → AWAITING_COLLECTION ──
  const sAuto = 'res-auto'
  core.tracker.markResidence(sAuto, 'AWAITING_COLLECTION')
  const dAuto = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: sAuto } })
  const needs = dAuto.data.rootCauses.filter((r) => r.additionalCollection).length
  if (needs > 0) {
    t.assert(core.residence.of(sAuto)?.state === 'AWAITING_COLLECTION', '② 有补采项 → 驻留态自愈为 AWAITING_COLLECTION')
  } else {
    t.assert(core.residence.of(sAuto) === null, '② 无补采项（全闭环）→ 驻留态被清除')
  }

  // ── ③ REFUSE → 驻留 REFUSED（且异常仍照常抛出，不被吞）──
  const sR = 'res-refuse'
  let threw = null
  try { core.diagnoseService({ context: { round: 1, sessionId: sR } }) } catch (e) { threw = e }
  t.assert(threw !== null && threw.name === 'ToolError' && threw.code === 'ERR_MISSING_PARAM', `③ 缺证据 → 硬拒绝 ERR_MISSING_PARAM（错误未被吞，实际 ${threw && threw.code}）`)
  t.assert(core.residence.of(sR)?.state === 'REFUSED', '③ REFUSE 出口登记驻留态 REFUSED')

  // ── ④ 超时：下次调用该会话工具即报（走既有 notices[] 通道）──
  await sleep(THRESH + 60)
  const dA2 = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: sA } })
  t.assert(dA2.ok === true, '④ 超时后诊断仍正常返回（提醒不阻断）')
  t.assert(codes(dA2).includes('residence-timeout'), `④ 超时 → 报 residence-timeout（实际 ${JSON.stringify(codes(dA2))}）`)
  const n = dA2.data.notices.find((x) => x.code === 'residence-timeout')
  t.assert(typeof n.text === 'string' && /(秒|分钟)/.test(n.text), '④ 提醒文案含耗时量纲（秒/分钟，不把 <1 分钟谎报成 0 分钟）')
  t.assert(!/已 0 分钟/.test(n.text), '④ 文案不得出现「已 0 分钟」（亚分钟阈值按秒呈现）')
  t.assert(n.text.includes('驻留态') && n.text.includes('动作'), '④ 提醒文案说清「等什么 / 要做什么」')
  t.assert(!n.text.includes('（进程内计时）'), '④ A 形态（持久化）：文案**不含**「进程内计时」限定词 —— 所示时长即真实驻留时长')

  // ── ⑤ 通道合规：不新增顶层字段、不动 degradations、排序在 version-drift 之后 ──
  const topKeys = Object.keys(dA2).sort()
  t.assert(
    JSON.stringify(topKeys) === JSON.stringify(['code', 'data', 'ok', 'versions']),
    `⑤ 信封顶层字段不变：code/data/ok/versions（实际 ${JSON.stringify(topKeys)}）`,
  )
  const degs = dA2.data.degradations
  t.assert(degs === undefined || Array.isArray(degs), `⑤ degradations 通道语义未变（本输入下 ${degs === undefined ? '缺省' : '存在'}）`)
  t.assert(!Array.isArray(degs) || !degs.some((d) => d.kind === 'residence-timeout'), '⑤ residence-timeout 不进 degradations（不是能力降级）')
  t.assert(core.residence.of(sA) !== null, '⑤ 超时后未响应 → 驻留态仍在（提醒重复出现是设计行为）')
  const dA3 = core.diagnoseService({
    evidence: p.data.evidence,
    dimensions: DIMS,
    context: {
      round: 2,
      sessionId: sA,
      priorRound: {
        evidenceHashesBefore: p.data.probeHashes,
        fixApplied: '待验证修复',
        assets: 'sha256:drifted-generation',
      },
    },
  })
  const seq = dA3.data.notices.map((x) => x.code)
  t.assert(seq.includes('version-drift') && seq.includes('residence-timeout'), `⑤ 两类声明可共存于同一 notices[]（实际 ${JSON.stringify(seq)}）`)
  t.assert(seq.indexOf('version-drift') < seq.indexOf('residence-timeout'), '⑤ 优先级：version-drift(2) 在 residence-timeout(3) 之前')

  // ── ⑥ 用户响应（闭环 → 清除）→ 立刻重置，旧提醒不再出现 ──
  t.assert(core.residence.clear(sA).cleared === true, '⑥ 用户响应 → 清除驻留计时')
  core.tracker.markResidence('res-cleared', 'AWAITING_COLLECTION')
  t.assert(core.residence.clear('res-cleared').cleared === true && core.residence.of('res-cleared') === null, '⑥ 显式清除即从驻留态移除')
  const dA4 = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: sA } })
  t.assert(!codes(dA4).includes('residence-timeout'), '⑥ 重置后不再报（已响应）')

  // 闭环会话：clearResidence 已由出口自动完成
  const sC = 'res-closed'
  core.tracker.markResidence(sC, 'AWAITING_COLLECTION')
  const dC = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: sC } })
  if (dC.data.rootCauses.every((r) => !r.additionalCollection)) {
    t.assert(core.residence.of(sC) === null, '⑥ 全闭环 → 出口自动清除驻留态')
  } else {
    t.skip('⑥ 该输入含补采项，闭环自动清除路径由 ② 覆盖')
  }

  // ── ⑦ 多会话独立计时 ──
  const sOld = 'res-old'
  const sNew = 'res-new'
  core.tracker.markResidence(sNew, 'AWAITING_COLLECTION')
  core.tracker.markResidence(sOld, 'AWAITING_COLLECTION')
  await sleep(THRESH + 60)
  core.tracker.markResidence(sOld, 'AWAITING_COLLECTION') // 幂等：不刷新起点
  const dNew = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: sNew } })
  t.assert(codes(dNew).includes('residence-timeout'), '⑦ 超时会话（new）报提醒')
  core.tracker.markResidence(sNew, 'AWAITING_COLLECTION')
  t.assert(core.residence.of(sNew).ageMs >= THRESH, '⑦ markResidence 幂等：重复登记不刷新起点（超时不会永不触发）')
  const dOld = core.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: sOld } })
  t.assert(codes(dOld).includes('residence-timeout'), '⑦ 另一超时会话（old）同样报提醒')
  const list = core.residence.list().map((x) => x.sessionId)
  t.assert(Array.isArray(list) && list.length >= 1, `⑦ 多会话驻留清单可枚举（${list.length} 条）`)
  t.assert(list.includes(sOld) && list.includes(sNew), `⑦ 两个超时会话都在驻留清单（${list.join(',')}）`)
  t.assert(!list.includes('never-seen-session'), '⑦ 未登记会话不在清单中（无幽灵条目）')

  // ── ⑧ 跨进程持久化：新 core 实例仍能看到驻留态（侧车文件）──
  t.assert(existsSync(join(tmp, 'sessions', '_residence.json')), '⑧ 驻留计时落侧车文件 _residence.json（不动 RoundRecord 白名单）')
  const core2 = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'sessions'), persist: true, residenceTimeoutMs: THRESH })
  core2.hotloader.init()
  t.assert(core2.residence.list().length >= 1, '⑧ 新实例读回驻留态（跨进程可见）')

  // ── ⑨ 形态对齐（§4.4 A/B1/B2）：驻留侧车走与 _stale.json **完全相同**的形态门 ──
  //   裁决依据（§4.4 已确认）："当轮"声明不依赖持久化，形态 B 下照常生效；
  //   只有**跨进程**状态依赖持久化 —— 该限制属**部署能力清单**，不进 degradations[]/notices[]。
  const b1dir = join(tmp, 'b1sessions')
  const b1 = createCore({ pkgRoot: tmp, storageDir: b1dir, persist: false, inProcessStore: true, residenceTimeoutMs: THRESH })
  b1.hotloader.init()
  b1.tracker.markResidence('res-b1', 'AWAITING_COLLECTION')
  await sleep(THRESH + 60)
  const dB1 = b1.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: 'res-b1' } })
  t.assert(codes(dB1).includes('residence-timeout'), '⑨ B1（仅进程内）：当轮超时提醒照常生效（不依赖持久化）')
  t.assert(!existsSync(join(b1dir, '_residence.json')), '⑨ B1：不落侧车文件（与 _stale.json 同一形态门）')
  const b1b = createCore({ pkgRoot: tmp, storageDir: b1dir, persist: false, inProcessStore: true, residenceTimeoutMs: THRESH })
  b1b.hotloader.init()
  t.assert(b1b.residence.list().length === 0, '⑨ B1 跨进程：新实例读不到驻留态（计时不跨进程 → 部署能力清单，非本轮输出契约）')
  const dB1b = b1b.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: 'res-b1' } })
  t.assert(!codes(dB1b).includes('residence-timeout'), '⑨ B1 跨进程：重启后不报（起点丢失，而非"整个功能静默失效"）')
  if (dB1b.data.rootCauses.some((r) => r.additionalCollection)) {
    t.assert(b1b.residence.of('res-b1')?.state === 'AWAITING_COLLECTION', '⑨ B1 跨进程：出口重新登记驻留 → 计时重置后提醒功能继续可用')
  } else {
    t.skip('⑨ B1 出口未登记（本输入已闭环）；"功能继续可用"路径由 ② 覆盖')
  }
  t.assert(!(dB1b.data.degradations || []).some((d) => /residence/.test(JSON.stringify(d))), '⑨ 不新增 degradations 条目（不扩 capability/effects 词表）')
  // D3：计时口径从"跨进程"变为"进程内"是**当轮输出的语义改变** → 必须在文案里穷尽声明（不改 code/priority/词表）
  const b1n = (dB1.data.notices || []).find((x) => x.code === 'residence-timeout')
  t.assert(!!b1n && b1n.text.includes('（进程内计时）'), '⑨ B1 形态：文案含「进程内计时」限定词（D3 语义改变声明）')

  const b2 = createCore({ pkgRoot: tmp, storageDir: join(tmp, 'b2sessions'), persist: false, inProcessStore: false, residenceTimeoutMs: THRESH })
  b2.hotloader.init()
  b2.tracker.markResidence('res-b2', 'REFUSED')
  await sleep(THRESH + 60)
  const dB2 = b2.diagnoseService({ evidence: p.data.evidence, dimensions: DIMS, context: { round: 1, sessionId: 'res-b2' } })
  t.assert(codes(dB2).includes('residence-timeout'), '⑨ B2（无存储）：当轮提醒仍生效（驻留态在进程内对象）')
  t.assert(!existsSync(join(tmp, 'b2sessions', '_residence.json')), '⑨ B2：不落侧车文件')
  t.assert(!(dB2.data.degradations || []).some((d) => /residence/.test(JSON.stringify(d))), '⑨ B2：不新增降级条目（多轮限制已在既有 cross-round-evidence-diff 通道声明）')
  const b2notice = (dB2.data.notices || []).find((x) => x.code === 'residence-timeout')
  t.assert(!!b2notice && b2notice.text.includes('（进程内计时）'), '⑨ B2 形态：文案含「进程内计时」限定词（D3 语义改变声明）')
  t.assert(
    b1n.code === b2notice.code && b1n.code === 'residence-timeout' && b2notice.text.includes('（进程内计时）'),
    '⑨ B1/B2 共用同一 notice code + 同一限定词（不因形态分裂出新码/新通道）',
  )

  rmSync(tmp, { recursive: true, force: true })
}
