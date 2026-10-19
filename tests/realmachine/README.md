# tests/realmachine —— 真机测试（**不进 CI**）

## 为什么要分家（长任务 1 / 报告要求第 3 项）

`tests/run.mjs` 只递归收集 `tests/unit/` 与 `tests/integration/`。
**本目录不在其中**，这是刻意的：`scripts/verify-all.sh`（CI 与本地共用）跑的是 `tests/run.mjs`，
因此下面这些测试**永远不会**在 CI 里被跑到。

| | CI（`tests/unit` + `tests/integration`） | 真机（本目录） |
|---|---|---|
| GPU | 不需要 | **需要**（`nvidia-smi` 能列出设备） |
| 容器 | 不需要 | 需要（`docker ps` 可执行；本机 runtime 探针会用到） |
| 网络 | 不需要 | 本机测试不需要出网；`serve-model / 加载模型` 之类才需要 |
| 真实模型 | 不需要 | 需要（≤0.5B 小模型 + serving 加载器） |
| 触发方式 | 每次 `git push` / `npm test` / `verify-all.sh` | **手动**（见下），发布前与真机排查后各跑一次 |
| 失败后果 | 阻断（红即不许发布） | 人不看就是没跑 —— 故每一步都把证据写到 `out/` |

**跳过机制**：不靠标记、不靠环境变量 —— 靠**目录不被收集**。
这比 `@skip-if-no-gpu` 更强：一个 agent 忘了带标记也不会把真机测试拖进 CI。
CLI 的 `--json` 与 `out/*.json` 是给"人工复跑"和"发布前对账"用的。

## 怎么跑

```bash
# A1 出口：本机（GB10）端到端可诊断 + 新规则的阳性/阴性对照
node tests/realmachine/gb10-end-to-end.mjs

# 只跑对照，不跑采集（无容器/无 docker 权限时）
node tests/realmachine/gb10-end-to-end.mjs --skip-collect

# 换维度组合
INFERENCE_DIMS=ascend-arm node tests/realmachine/gb10-end-to-end.mjs
```

产物落在 `tests/realmachine/out/`（报告、采集脚本、诊断 JSON、对照结论）。
`out/` 里的报告**已脱敏**（采集端就脱敏），但仍按"可能含现场信息"对待。

## 已覆盖

| 脚本 | 覆盖 | 出口判据 |
|---|---|---|
| `gb10-end-to-end.mjs` | ① 组合可解析 ② 生成脚本 ③ **真跑脚本**（真机采集） ④ 解析 ⑤ 诊断 | 五步全过；且 `parseMeta.missingSections` 为空（"报告里有证据"必须等于"分析侧看得见"） |
| 同上（`--controls`） | 新规则的**已知阳性对照**（注入故障原文必须命中）与**已知阴性对照**（真机健康输出必须 0 命中） | 9/9 阳性 + 0 阴性误报 |
