/**
 * degradation-channel.spec —— P4 出口门禁之二（§2.1 `degradations[]` / `notices[]` 通道契约）。
 */
import { assertDegradations, VOCAB, NOTICE_PRIORITY, DEGRADATION_NOTICE, ok, sortNotices, degradationsToNotices } from '../../src/protocol/envelope.js'

export const NAME = 'degradation-channel（词表 / 1:1 投影 / 叠加顺序 / note 不断言）'

const V = { plugin: '0.0.1', schema: '2', rules: 'desensitize-v1', assets: 'sha256:x' }

export async function run(t) {
  // ---- 受控词表：越界即拒（契约违规）----
  const bad = [
    [{ kind: 'capability-unavailable', capability: 'no-such-cap', reason: 'no-persistent-store', effects: ['round-reset-1'] }, 'capability 越界'],
    [{ kind: 'capability-unavailable', capability: 'cross-round-evidence-diff', reason: 'made-up', effects: ['round-reset-1'] }, 'reason 越界'],
    [{ kind: 'capability-unavailable', capability: 'cross-round-evidence-diff', reason: 'no-persistent-store', effects: ['nope'] }, 'effects 越界'],
    [{ kind: 'unknown-kind', capability: 'cross-round-evidence-diff', reason: 'no-persistent-store', effects: ['round-reset-1'] }, 'kind 越界'],
    [{ kind: 'check-skipped', check: 'not-a-check', reason: 'desensitize-rules-unavailable', effects: ['assurance-reduced'] }, 'check 越界'],
    [{ kind: 'check-skipped', check: 'desensitize-recheck', reason: 'desensitize-rules-unavailable', effects: [] }, 'effects 为空'],
  ]
  for (const [entry, label] of bad) {
    let threw = false
    try { assertDegradations([entry]) } catch { threw = true }
    t.assert(threw, `词表校验拒绝：${label}`)
  }
  // 准入规则：targeted-recollection / stale-visibility 不在 capability 表内
  t.assert(!VOCAB.capability.includes('targeted-recollection'), 'capability 表不含 targeted-recollection（是 diff 失效的后果）')
  t.assert(!VOCAB.capability.includes('stale-visibility'), 'capability 表不含 stale-visibility（属部署能力清单）')
  // 2026-09-28 扩面：performance-baseline-diff 同样满足准入规则（能独立失效 + 单次调用可断言）
  t.assert(
    VOCAB.capability.length === 2 &&
      VOCAB.capability.includes('cross-round-evidence-diff') &&
      VOCAB.capability.includes('performance-baseline-diff'),
    'capability 表恰含两项（cross-round-evidence-diff / performance-baseline-diff）',
  )
  t.assert(VOCAB.reason.includes('baseline-unavailable'), 'reason 表含 baseline-unavailable（B 范式降级根因）')
  t.assert(VOCAB.effects.includes('qualitative-mode'), 'effects 表含 qualitative-mode（B 范式降级后果）')
  t.assert(!VOCAB.effects.includes('stale-scan-limited'), 'effects 表已随 stale-visibility 移出该项')

  // 合法组合通过
  const goodCap = { kind: 'capability-unavailable', capability: 'cross-round-evidence-diff', reason: 'no-persistent-store', effects: ['round-reset-1', 'recollection-degraded'], note: '自由文本' }
  const goodSkip = { kind: 'check-skipped', check: 'desensitize-recheck', reason: 'desensitize-rules-unavailable', effects: ['assurance-reduced'] }
  // B 范式的降级条目：无基线 → 定性诊断（**不是** REFUSE，见 §2.1 D0–D3）
  const goodBaseline = { kind: 'capability-unavailable', capability: 'performance-baseline-diff', reason: 'baseline-unavailable', effects: ['qualitative-mode'], note: '未提供基线' }
  let okThrew = false
  try { assertDegradations([goodCap, goodSkip, goodBaseline]) } catch { okThrew = true }
  t.assert(!okThrew, '合法 degradation 通过词表校验（含 B 范式的基线降级）')
  let badBaselineThrew = false
  try {
    assertDegradations([{ kind: 'capability-unavailable', capability: 'performance-baseline-diff', reason: 'no-persistent-store', effects: ['qualitative-mode'] }])
  } catch { badBaselineThrew = true }
  // 诚实边界：词表门禁只做**成员资格**校验，不做 capability↔reason **配对**校验
  // （reason 是跨能力共享的受控词表）。配对由生产端保证：B 范式的降级只由
  // baseline-loader 返回 null 时产生，reason 恒为 baseline-unavailable。
  t.assert(!badBaselineThrew, '词表门禁是成员资格校验，不含 capability↔reason 配对（配对由生产端保证）')

  // ---- 1:1 投影：每条 degradation 恰产生一条对应 notice ----
  const projected = degradationsToNotices([goodCap, goodSkip])
  t.assert(projected.length === 2, '投影条数 == degradation 条数')
  t.assert(projected[0].code === DEGRADATION_NOTICE['capability-unavailable'], 'capability-unavailable → capability-degraded')
  t.assert(projected[1].code === DEGRADATION_NOTICE['check-skipped'], 'check-skipped → assurance-reduced')
  t.assert(projected.every((n) => typeof n.text === 'string' && n.text.length > 0), '投影出的 notice 都带文本')
  // D3：降级文案必须同时给出"语义改变"与"恢复路径"
  const baselineNotice = degradationsToNotices([goodBaseline])[0]
  t.assert(/定性诊断/.test(baselineNotice.text), 'B 降级 notice 声明语义改变（降级为定性诊断）')
  t.assert(/baseline/.test(baselineNotice.text) && /重跑|恢复/.test(baselineNotice.text), 'B 降级 notice 给出恢复路径（提供 baseline 后重跑）')

  // ---- 叠加顺序：渲染顺序 = 数组顺序 = 固定优先级 ----
  const mixed = ok(
    { payload: true },
    V,
    {
      degradations: [goodCap, goodSkip],
      notices: [
        { code: 'report-incomplete', text: '缺段' },
        { code: 'version-drift', text: '版本漂移' },
      ],
    },
  )
  const codes = mixed.data.notices.map((n) => n.code)
  const expected = ['capability-degraded', 'version-drift', 'assurance-reduced', 'report-incomplete']
  t.assert(JSON.stringify(codes) === JSON.stringify(expected), `四类声明按固定优先级排序（实际 ${codes.join(' > ')}）`)
  t.assert(codes.every((c, i) => i === 0 || NOTICE_PRIORITY[codes[i - 1]] <= NOTICE_PRIORITY[c]), '顺序满足优先级单调不减')
  t.assert(mixed.data.notices.length === 4, '四类声明**不得合并**为更少条目')

  // ---- 同类多条按 code 字典序稳定 ----
  const two = sortNotices([{ code: 'report-incomplete', text: 'b' }, { code: 'report-incomplete', text: 'a' }])
  t.assert(two.length === 2, '同类多条不被合并')

  // ---- note 是自由文本：字段存在但不参与断言（不改变结构）----
  const withNote = ok({}, V, { degradations: [{ ...goodCap, note: '任意自由文本 —— 含 : 与 " 引号' }] })
  t.assert(withNote.data.degradations[0].note.includes('任意自由文本'), 'note 原样保留')
  t.assert(withNote.data.notices[0].text !== withNote.data.degradations[0].note, 'notice 文本与 note 无关（note 不驱动投影）')

  // ---- 无 degradation 时 ok() 不产生 degradations/notices 字段 ----
  const plain = ok({ x: 1 }, V)
  t.assert(!('degradations' in plain.data) && !('notices' in plain.data), '无降级时两个字段都不出现')
  // 仅有非降级 notice 时：notices 出现、degradations 不出现
  const onlyNotice = ok({ x: 1 }, V, { notices: [{ code: 'report-incomplete', text: 't' }] })
  t.assert(onlyNotice.data.notices.length === 1 && !('degradations' in onlyNotice.data), '仅状态声明时 degradations 不出现')
}
