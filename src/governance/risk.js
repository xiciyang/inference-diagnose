/**
 * risk —— 风险分级（A2）。**单一真源**：工具面、风险档、确认要求、资源声明。
 *
 * 为什么需要它（长任务 1 / A2 的由来）：
 *   本插件此前**没有任何风险分级体系** —— 全 `src/` 检索 `riskClass` / `R0`–`R2` /
 *   `riskTier` 零命中（`inference-integration/INFERENCE_DIAGNOSE_FACTS.md` §3.3 实测）。
 *   而推理侧三插件（serving / quantization / tuning）都已固化同一套分档（见各自
 *   `manifest.yaml`，语义完全一致）。同一台机器、同一套资产规则，却有一个插件没有
 *   声明面 —— 审计时无法区分"未声明所以拒绝"与"设计上不需要"。
 *
 * 分档沿用三插件已固化的定义（**不新造词**）：
 *   read   = R0/R1 只读业务动作，无沙箱要求，**不需要确认令牌**
 *   write  = R1/R2 写操作，需容器级沙箱，需确认令牌
 *   system = R4 系统级，需 VM 级沙箱（本机无 VM 沙箱 → 一律拒绝）
 *
 * 本插件五个工具全部落在 `read`：
 *   它们只**读**用户贴进来的报告文本与本地资产，产出一份内存中的诊断结论；
 *   不碰被诊断的机器、不建容器、不写用户的任何数据（唯一副作用是本地的
 *   append-only 审计留痕，见 audit.mjs —— 它写的是插件自己的日志目录，
 *   不是被诊断系统）。因此 `confirmation: 'not-required'`：
 *   对只读动作索要确认令牌只会训练用户盲目点确认（`inference-tuning` 的
 *   manifest 把 `analyze` / `health` / `audit_verify` 同样定为 `read` 且无令牌）。
 *
 * **本文件与 `manifest.yaml` 必须一致**：`tests/unit/governance.spec.mjs` 断言
 * 两者逐工具相等，且与 `src/index.js` 实际注册的工具名相等 ——
 * 声明面漂移（改了工具忘了改声明）是这套机制唯一真正的失败模式。
 */

/** 风险档闭集（与三插件的 manifest 词表一致）。 */
export const RISK_TIERS = Object.freeze(['read', 'write', 'system'])

/** 沙箱档闭集（本机实测：process ✗ / container ✓ / vm ✗）。 */
export const SANDBOX_TIERS = Object.freeze(['none', 'process', 'container', 'vm'])

/**
 * 五个工具的逐条声明。`resources` 里出现的都是**本插件自己**要动的东西：
 *   state:write —— 跨轮会话落盘（${DSH_HOME}/inference-diagnose/sessions）
 *   disk:write  —— 本地 append-only 审计留痕（~/.ai-infra/logs/audit/inference-diagnose/）
 *   model:read  —— 读本地资产树（dims / 规则 / 模板 / 状态机真源）
 * 刻意**没有** gpu / port / network：本插件不建端点、不起容器、不出网。
 */
export const TOOL_RISK = Object.freeze({
  generate_collect_script: {
    risk: 'read',
    sandbox: 'none',
    idempotent: true,
    confirmation: 'not-required',
    resources: ['model:read', 'disk:write'],
    note: '只生成一段文本脚本（内存中），不执行它；执行发生在用户自己的机器上，不在本插件权限内',
  },
  parse_collect_report: {
    risk: 'read',
    sandbox: 'none',
    idempotent: true,
    confirmation: 'not-required',
    resources: ['model:read', 'disk:write'],
    note: '全程内存：报告文本不落盘、不日志、不回显（§2.5 不变量）',
  },
  diagnose_service: {
    risk: 'read',
    sandbox: 'none',
    idempotent: true,
    confirmation: 'not-required',
    resources: ['model:read', 'state:write', 'disk:write'],
    note: 'A 范式诊断；state:write 仅写跨轮会话白名单字段',
  },
  diagnose_regression: {
    risk: 'read',
    sandbox: 'none',
    idempotent: true,
    confirmation: 'not-required',
    resources: ['model:read', 'state:write', 'disk:write'],
    note: 'B 范式诊断；客户基线只读、不落盘、不缓存',
  },
  diagnose_consistency: {
    risk: 'read',
    sandbox: 'none',
    idempotent: true,
    confirmation: 'not-required',
    resources: ['model:read', 'state:write', 'disk:write'],
    note: 'C 范式诊断；复用 A 的状态机，不新建拓扑',
  },
})

/** 全部风险档都为 read ⇒ 全插件不需要确认令牌。由测试断言，不由注释保证。 */
export function requiresConfirmation(toolName) {
  const decl = TOOL_RISK[toolName]
  if (!decl) throw new Error(`未声明的工具：${toolName}（风险声明必须覆盖全部工具）`)
  return decl.confirmation !== 'not-required'
}

/** 机器可读的声明面（供测试与 `governance` 信封块消费）。 */
export function riskManifest() {
  return {
    schema: 'inference-diagnose/risk@1',
    tiers: { read: 'R0/R1 只读，无沙箱要求，无需确认令牌', write: 'R1/R2 写操作，需容器级沙箱', system: 'R4 系统级，需 VM 级沙箱' },
    tools: Object.fromEntries(Object.entries(TOOL_RISK).map(([k, v]) => [k, { ...v, resources: [...v.resources] }])),
    confirmationRequiredFor: Object.keys(TOOL_RISK).filter((n) => requiresConfirmation(n)),
  }
}

/** 校验：档位越界 / 工具名缺失即抛（fail-closed，装配期就报，不留到运行期）。 */
export function assertRiskDeclarations(toolNames) {
  const problems = []
  for (const n of toolNames) if (!TOOL_RISK[n]) problems.push(`工具 ${n} 没有风险声明`)
  for (const n of Object.keys(TOOL_RISK)) if (!toolNames.includes(n)) problems.push(`风险声明 ${n} 没有对应工具（声明漂移）`)
  for (const [n, d] of Object.entries(TOOL_RISK)) {
    if (!RISK_TIERS.includes(d.risk)) problems.push(`${n}: risk 越界 "${d.risk}"`)
    if (!SANDBOX_TIERS.includes(d.sandbox)) problems.push(`${n}: sandbox 越界 "${d.sandbox}"`)
    if (!Array.isArray(d.resources)) problems.push(`${n}: resources 必须是数组`)
  }
  if (problems.length > 0) throw new Error(`风险声明不合法（fail-closed）：${problems.join('；')}`)
  return true
}
