#!/usr/bin/env bash
# 全部门禁一键执行（CI 与本地共用）。
#   门禁 1  插件侧 spec 套件（30 spec / 1900+ 项断言），内含并列的规则质量门禁：
#             G1 每条规则有合法 judgement        G2 decisive 必带具体 rationale（加载期 fail-closed）
#             G3 单规则语料命中 >20 行即判过宽    G4 when 不得命中探针自述文本
#             G5 contextual 候选不得得「已证明」  G6 正则字段不得含未声明的双反斜杠（死分支）
#             G6b 每条规则必须有能被自身 when 命中的正例（**逐分支覆盖**，见下）
#             G6b-2（C12 变体）**独占性 + 三分类**：可分离分支必须有"只命中它"的独占示例；
#                   结构性重叠分支必须显式登记（白名单**空集**为目标形态）；合成器失败即 FAIL
#             G7 quantitative 规则的阈值判据必须真的可算
#             G8 docs/judgement-review.md 必须由 assets 生成（文档单源）
#           G6b 的存在理由：G3 查"命中太多"、G4 查"命中自述文本"、G6 查"静态双反斜杠"，
#           **没有一条问"这条规则还能不能命中"**——命中 0 行（死分支）正是它们的共同盲区。
#   门禁 2  模型检查 —— **两台状态机各自独立门禁**：
#             2a  A 范式 loop-controller（崩溃→诊断→修复闭环）
#             2b  B 范式 regression-controller（基线对比闭环；模式隔离，独立真源）
#           两机共用同一个通用检查器 machine-check.py，
#           并做「错误码闭集 = 各机错误域之并集」的跨机校验。
#   门禁 3  验证块汇总一致性（防手写漂移）
#   门禁 4  双跑一致性：本地机械检查器 vs logicprobe 管道（投影模型的结构项必须一致）
#   门禁 5  **六个共享库契约测试**（@ai-infra/{testing,data,state,audit,sandbox,training}-core）
#           —— 长任务 1「约束 3」的落点：契约测试必须进 CI，后续改动导致契约失败即阻断。
#           与门禁 2–4 同构：脚本在**工作区仓**（CONTRACTS_ROOT），缺失即 FAIL，**不静默跳过**
#           （静默跳过会让"没跑"看起来像"过了"）。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPEC_ROOT="${SPEC_ROOT:-}"
# 兄弟仓（共享库 / 契约层）只在本地全栈里存在；发布仓里没有就显式 SKIP，不伪造通过。
CONTRACTS_ROOT="${CONTRACTS_ROOT:-}"
SHARED_RUNNER="$CONTRACTS_ROOT/inference-training/shared/run-all.mjs"
CONTRACTS_RUNNER="$CONTRACTS_ROOT/inference-contracts/checks/run-all.mjs"
fail=0
run() { echo "── $1"; shift; "$@" || { echo "   ✗ FAIL"; fail=1; }; }

run "门禁 1 · spec 套件（node tests/run.mjs；含 G1–G8 + G6b）" node "$ROOT/tests/run.mjs"
if [ -n "$SPEC_ROOT" ] && [ -d "$SPEC_ROOT/model-check" ]; then
  run "门禁 2a · A 范式状态机（loop-controller-model.py）" python3 "$SPEC_ROOT/model-check/loop-controller-model.py"
  run "门禁 2b · B 范式状态机（regression-model.py）" python3 "$SPEC_ROOT/model-check/regression-model.py"
  run "门禁 3 · 汇总一致性（verification-count.py）" python3 "$SPEC_ROOT/model-check/verification-count.py"
  run "门禁 4 · 双跑一致性（dual-run-consistency.py）" python3 "$SPEC_ROOT/model-check/dual-run-consistency.py"
else
  echo "── 门禁 2–4 SKIP：未设置 SPEC_ROOT（设计文档仓不在本仓库；设置后才会跑）"
fi

echo "── 门禁 5 · 六个共享库契约测试（CONTRACTS_ROOT=$CONTRACTS_ROOT）"
if [ -z "$CONTRACTS_ROOT" ] || [ ! -f "$SHARED_RUNNER" ]; then
  echo "   SKIP —— 未设置 CONTRACTS_ROOT（兄弟仓不在本仓库；设置后缺失即为 FAIL）"
else
  run "   5a · 六库契约（run-all.mjs）" node "$SHARED_RUNNER"
  if [ -f "$CONTRACTS_RUNNER" ]; then
    run "   5b · 契约层 C1–C14（run-all.mjs）" node "$CONTRACTS_RUNNER"
  else
    echo "   ! 5b SKIP：契约层入口不存在（$CONTRACTS_RUNNER）"
  fi
fi

if [ "$fail" = 0 ]; then echo; echo "ALL GATES PASSED"; else echo; echo "GATE FAILURES"; fi
exit $fail
