# 规则判据分级口径（judgement rubric）

**版本**：2（2026-09-28）
**v2 变更**：① 新增 G6（正则死分支）/ G7（可算阈值判据）/ G8（文档单源）三条门禁；
② `rc-docker-001` 与 `rc-conf-oom-trace` 合并（同机制不留两条 decisive，见 §2.1 正例）；
③ `rg-qual-003` 由 contextual 升为 quantitative 并携带显式阈值判据（原为 §2.2 反例，现改判）。
**适用对象**：`assets/root-causes/**` 下所有根因规则的 `judgement` 字段。
**强制**：每条规则**必须**声明 `judgement`；判 `decisive` 的**必须**同时给出 `decisiveRationale`。
缺字段、值越界、或 decisive 缺理由 → **加载即 REFUSE**（`ERR_ROOTCAUSE_RULES_NOT_LOADED`，fail-closed）。

---

## 0 为什么需要这套口径

2026-09-28 在一台**健康**服务器上跑出 22 条候选。逐条归因后发现问题不在输出层，而在**规则判据粒度不齐**：

- 有的规则是"决定性信号"——`HBM ECC uncorrectable` 一行出现，机制就成立；
- 有的规则是"存在性关键词"——配置里出现 `--tensor-parallel-size=4` 就报，而健康服务器**必然**有这些配置；
- 还有规则的正则**过宽**（单条命中 126 行）或**命中探针自己写给用户的提示行**。

若不先把"判据强度"显式化，任何分层/门槛都只能靠感觉排序。本 rubric 就是那把尺子：
**先按结构特征机械判定，再在少数边界情形上按明确规则裁决**，不允许"凭感觉分档"。

## 1 判定顺序（**必须按序执行，先命中先定档**）

```
① 该规则 fix === null                        → contextual   （证据缺口声明，见 §2.4）
② 有可算判据：computeCheck | derivedBy
   | warnRatio/criticalRatio（数值比较）      → quantitative （见 §2.2）
③ 上面都不满足，且 when 的**每一个**可选分支
   都指"故障事实本身"                         → decisive     （见 §2.1）
④ 其余                                       → contextual   （见 §2.3）
```

> **为什么 `causal` 不参与分档**：`causal` 是**置信度上限**（缺闭环证据不得称"已证明"），
> 不是判据方式。一个"关键词存在性"规则加上 `causal` 依然是关键词规则。

## 2 三档定义、正例与反例

### 2.1 `decisive` —— 单行即定性

**判据（全部满足）**：

1. `when` 的**每一个**分支都描述**故障事实本身**：该分支命中时，机制**必然**成立；
2. 该行**删除后**假设不再成立（即它是结论的承载行，不是"顺带提到"）；
3. 规则自身的 `relevance` **没有**声明"需要与其它证据交叉才能判定机制"。

**边界裁决（必须按此，不得例外）**：

| 情形 | 裁决 | 理由 |
|---|---|---|
| `when` 含**裸词**分支（如 `abort`、`137`、`shm`、`HBM ECC`），可能命中非事实行 | **不得判 decisive**（要么收窄正则使其合格，要么降为 contextual） | 正则宽松 ⇒ 存在非事实命中路径 |
| `relevance` 说"需与 X 交叉/需现场确认**机制**" | 不得判 decisive | 规则自己承认单行不足以定性 |
| `relevance` 说"需确认**修复的子原因**"（如"是限额过低还是泄露"） | **可以**判 decisive | 待确认的是下一步怎么做，不是本步机制是否成立 |

**正例**

- `rc-ascend-001`：`when: ECC uncorrectable|uncorrectable error|Uncorrectable ECC`
  → rationale：`ECC 计数器中 "uncorrectable" 的取值直接表示**不可纠正**错误；corrected/可纠正错误不会带该词，故该行出现即"硬件级不可恢复错误已发生"，不需要任何其它证据。`
- `rc-docker-001`：`when: OOMKilled|out of memory|ExitCode 137|exit code 137|Exited \(137\)|shm allocation failed`
  → rationale：`容器状态里的 OOMKilled 标志（或 ExitCode=137 且带 OOM 字样 / docker ps -a 的 Exited (137)）就是内核 OOM-killer 的动作记录本身；它记录的是"进程已被内核杀掉"这一既成事实，不是诱因。`
  → **合并且带否证**：与 `rc-conf-oom-trace`（其 `when` 是本条真子集，实测命中集合逐条相同）合并为一条 decisive，
  否证条件"只有 137 而无任何 OOM/SHM 痕迹 ⇒ 排除"随迁。同机制**不得**留两条 decisive。
- `rc-vllm-008`：`when: tokenizer\.roundtrip_ok=false`
  → rationale：`探针已把同一段中英混排文本 tokenize 后再 detokenize 回读并逐字比对；false 表示往返**不能还原**，即 token↔文本映射有损。映射无损时往返必然成功，故该行出现是映射有损的充分必要条件。`

**反例**

- `rc-vllm-001`（`--quantization|quant_method|...`）：**配置字段存在** ≠ 量化错配。
  → 健康服务器上 `quantization=compressed-tensors` 必然出现。**contextual**。
- `rc-mindie-001`（`abort|core dump|SIGABRT|RuntimeError`）：`abort` 是裸词，且 `relevance` 明说"需结合 NPU 与内核日志定位触发源"。
  → **contextual**。
- `rc-out-004` 的旧形态含裸 `surrogate`（可能命中 `surrogate=` 配置项）→ 收窄后才可判 decisive。

### 2.2 `quantitative` —— 结论由数值比较得出

**判据**：规则声明了 `computeCheck`（可算判据）、`derivedBy`（数据驱动槽），
或 B 范式的 `warnRatio`/`criticalRatio`（基线比值阈值）。
特征：**把关键词换成数字**——即使文字变了，只要数字关系不变，结论就不变。

**正例**

- `rc-conf-shards-ok`：`expr: declared - present`，`assert: (threshold > 0)` —— "分片齐全"这个数字事实直接否证该假设。
- `rc-struct-sliding-eq-block`：`expr: blk - sw`，`assert: (threshold == 0)` —— 只有**恰好相等**才成立。
- `rg-perf-001`：`current / baseline` 与 `warnRatio` 比较 —— 结论是比值，不是"出现了 ttft 字段"。

**反例**

- ~~`rg-qual-003`（`gpu_cache_usage_perc\{…\}[ \t]+[0-9.]+`）：匹配**任意**占用率数值，而假设是"接近打满"。
  数值出现了，但没有**比较** ⇒ 不是 quantitative。~~ **已改判（v2）**：补上 `computeCheck`
  （`usage * (1 + (usage <= 1) * 99)` + `assert: (threshold >= 90)`）后，数值**真的被比较**了 ⇒ 判 **quantitative**。
  这条从反例变成正例，说明"没有比较"是可修的，不是该类规则的天性。
- `rc-qg-004`（`kv.?cache|block_size|...`）：只是词面出现，无数值关系。→ **contextual**。

### 2.3 `contextual` —— 存在性/上下文关键词

**判据**：该行的出现**只是提示方向**——既不充分也不必要。删掉它结论不成立，但它出现时结论也未必成立。

**正例**

- `rc-vllm-004`（并行配置出现）：TP 配置存在 ≠ 切分错位；判据是"TP=1 是否正常"的对照。
- `rc-cons-env-001`（驱动/固件版本矩阵出现）：版本**出现** ≠ 版本**不同**；判据是与"正常环境"逐项比对。
- `rc-out-006`（`truncat|截断|incomplete|...`）：`incomplete` 可出现在任意日志文本里。

**反例（不得降级到这里蒙混）**

- 若一条规则**无法按 §3 的"无法判定"流程给出明确档位**，**停下回报**，不得塞进 `contextual`。
- 若规则的判据其实是数值比较（§2.2），不得因为"懒得写 computeCheck"而降为 contextual。

### 2.4 `contextual` 的一个**结构子类**：证据缺口声明（`fix: null`）

`fix: null` 的规则（如 `rc-evi-001`、`rc-out-007`、`rc-cons-005`）语义是"**缺证据 ⇒ 不可判定**"，
它们不是成因主张，而是**不确定性声明**。故：

- 档位按 §1 第 ① 步机械判为 `contextual`，**不需要**（也不允许）判 decisive；
- 但**恒入主列表**——把"不可判定"折叠进弱信号区等于隐藏不确定性（违反 D3）。

## 3 无法判定时怎么办

若一条规则按 §1 走完四步仍无法定档（例如：`when` 一半是事实一半是关键词，收窄会改变语义），
**停下回报**，附上：规则 id、`when`、你的两难、以及两个候选档位各自的影响面。
**不允许**默认塞进 `contextual`。

## 4 机器强制的四条不变量（门禁）

| # | 不变量 | 违反后果 |
|---|---|---|
| G1 | 每条规则都有 `judgement ∈ {decisive, quantitative, contextual}` | 加载 REFUSE |
| G2 | `judgement === 'decisive'` ⟹ 有非空 `decisiveRationale`，且 ≥40 字、含"具体字段/取值"描述（不是"这表明硬件故障"这类空话） | 加载 REFUSE + 门禁 FAIL |
| G3 | 单条规则在**语料**上命中的证据行数 **> 20** ⇒ 判过宽 | 门禁 FAIL |
| G4 | `when` 不得命中**插件自己产出的标签/提示文本**（探针自述语料） | 门禁 FAIL |
| G5 | `judgement === 'contextual'` 的候选**不得**得到「已证明」 | 由 `confidence.grade` 强制 + 门禁 FAIL |
| G6 | 正则字段（`when`/`pattern`/`requires.when`/`falsifiedBy.when`/`computeCheck.inputs.pattern`/`causal.closurePattern`）**不得含未声明的双反斜杠**——在该 YAML 引号约定下它等价于"匹配一个字面反斜杠"，是**死分支**。确需匹配字面反斜杠者须显式声明 `literalBackslash: true`（当前唯一豁免：`rc-out-004` 的 `\ufffd`） | 门禁 FAIL |
| G7 | 判 `quantitative` 的定性规则必须携带**真的可算**的阈值判据（`rg-qual-003` 的 `computeCheck.assert` 含阈值；`rg-qual-004` 的 `when` 不得再匹配任意数值） | 门禁 FAIL |
| G8 | `docs/judgement-review.md` 必须等于由 `scripts/gen-judgement-review.mjs` 重新生成的结果（**禁止手写第二真源**） | 门禁 FAIL |

> **G6 的由来（缺陷 #54）**：`regression/qualitative-rules.yaml` 曾是唯一把 `\s`/`\{`/`\.` 写成
> `\\s`/`\\{`/`\\.` 的文件——`rg-qual-002` 的三条分支**全部是死分支**，该规则在任何输入下都不会触发，
> 而 G3/G4 都查不出来（G3 是"命中太多"，G4 是"命中自述文本"，**没有一条门禁问"这条规则还能不能命中"**）。
> 更强的形态是"每条规则必须给出一个能被自身 `when` 命中的正例"（G6b，**下一轮**），
> 它能一次性覆盖所有死分支（含未来的字符类写错、锚点写错），本轮的 G6 只覆盖静态可判的那一半。

> G3/G4 的语料来源见 `tests/unit/rule-quality-gates.spec.mjs`：G3 用
> `tests/fixtures/corpus/*.txt`（含真实端点报告）＋ 退化夹具；G4 的语料**从维度 YAML 的探针命令里自动抽取**
> （不手抄，因此探针改了标签、门禁自动跟上）。

## 5 与输出分层的关系

- 主列表 `rootCauses[]` = `decisive` + `quantitative` + **全部 `fix: null` 的缺口声明**
- 弱信号 `closure.weakSignals[]` = 其余 `contextual`（**携带完整证据与修复，不是摘要**）
- `summary` 显式给出分层计数，弱信号**折叠但不隐藏**
