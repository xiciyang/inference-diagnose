# @xiciyang/inference-diagnose

**Diagnose an inference service from evidence, not guesswork — and say "unconfirmed" when the evidence is not there.**

Generate a collection script → parse the sanitized report offline → produce a ranked root cause with a fix →
if the fix fails, re-collect only the missing probes and diff against the previous round.
Offline, de-identified, hash-chained audit, and fail-closed when a rule for the
`framework × runtime × hardware` combination is missing.

- **No cloud round-trip** for your logs: collection runs on the user's machine; parsing and diagnosis happen in memory.
- **Evidence-driven**: every conclusion carries severity, confidence and a falsifier; "not confirmed" is a valid verdict.
- **Three modes**: service failure (A), regression against a customer baseline (B), consistency / non-determinism (C).
- **Five tools, all `risk: read`** — no writes, no sandbox requirement, no confirmation token.

## 安装

```bash
git clone https://github.com/xiciyang/inference-diagnose.git
cd inference-diagnose && bash scripts/build.sh
dsh plugin --profile <name> add .
```

> 尚未发布到 npm；上面的源码路径装完重启生效。

要求 **Node ≥ 20**，已在本机 DSH **0.2.0-rc.2** 上验证。

从源码构建：

```bash
bash scripts/build.sh      # 27 个文件 → lib/
node tests/run.mjs         # 30 spec，无 GPU / 无容器 / 无网络
```

## 用法

在会话里直接调用五个工具（裸名，无 `inference_` 前缀）：

| 工具 | 作用 |
|---|---|
| `generate_collect_script` | 生成内嵌脱敏的采集脚本（在**用户自己的机器**上执行，本插件不代执行） |
| `parse_collect_report` | 解析已脱敏报告 → 结构化证据（全程内存，明文不落盘） |
| `diagnose_service` | A 范式：服务异常（崩溃/启动失败/挂起/被外部杀/资源耗尽/输出异常） |
| `diagnose_regression` | B 范式：相对客户基线的性能/精度劣化（无基线则退化为定性诊断） |
| `diagnose_consistency` | C 范式：一致性/非确定性 |

典型链路：`generate_collect_script` → 用户在目标机执行 → `parse_collect_report` → `diagnose_service`；
修复失败后用返回的 `nextSteps` 只补采缺失探针，再调一次 `diagnose_service`（带 `priorRound`）看 diff。

## 配置

| 变量 | 作用 | 默认 |
|---|---|---|
| `INFERENCE_DIAGNOSE_ROOT` | 审计链与运行状态根 | `~/.ai-infra` |
| `DSH_HOME` | 会话存储根 | `~/.dsh` |
| `INFERENCE_WORKSPACE` | 跑「与兄弟插件工具名不重名」检查时的源码目录 | 未设置则跳过该检查 |
| `SPEC_ROOT` | 设计文档仓（门禁 2–4） | 未设置则跳过 |

三维词表是 L1 数据：`assets/config/dims.json` + `assets/dimensions/<kind>/<id>.yaml`。
新增一个维度取值 = 加一个 YAML + 在 `dims.json` 登记 + 配规则文件；缺规则文件会让该组合
**fail-closed**（`ERR_ROOTCAUSE_RULES_NOT_LOADED`），不会静默降级。

`framework`：`mindie`（Ascend）· `vllm`；`runtime`：`docker`；
`hardware`：`ascend-arm` · `gb10` · `nvidia` · `cpu`。

## 治理面

- **风险分级**：五个工具全部 `risk: read` / `sandbox: none` / `confirmation: not-required`。
  声明面在 `manifest.yaml`（给人/审计看）与 `src/governance/risk.js`（给代码看），
  由 `tests/unit/governance.spec.mjs` 断言逐工具相等，并与实际注册工具名双向一致。
- **审计哈希链**：每次调用追加到 `$INFERENCE_DIAGNOSE_ROOT/logs/audit/inference-diagnose/<YYYY-MM-DD>.jsonl`；
  `hash = sha256(canonicalJson(record 去掉 hash))`，`prevHash` 首尾相接，只追加（O_APPEND + 0600）。
  记录只存参数摘要与参数名，绝不存参数值。
- **复算**：`node scripts/verify-audit.mjs [--root R] [--day D] [--tail N]`，链损坏 exit 1。

## 兼容与门禁

- DSH bundle：`dsh.bundle.patch` + `engines.dsh` 已声明；entry id `inference-diagnose`，npm 名 `@xiciyang/inference-diagnose`。
- `node tests/run.mjs`：**30 spec 全过**（本机实测），只收集 `tests/unit/` 与 `tests/integration/`。
- `bash scripts/verify-all.sh`：spec 套件 +（可选）状态机穷举与兄弟仓契约；缺少外部仓时显式 SKIP，不伪造通过。
- 真机端到端脚本在 `tests/realmachine/`，**不进 CI**（见其 README）。

## 许可

BSD-3-Clause。见 `LICENSE`。
