# 结构性重叠分支的语义分析（C12）

**日期**：2026-09-28　**状态**：**已按方案甲执行**——8 条窄分支已删除，删除后命中行数**逐条零变化**（见 §6 复跑证据）
**生成依据**：`scripts/gen-judgement-review.mjs` 的规则清单 + 子集性/惰性双检验（脚本见本文 §4）

---

## 0 结论摘要

| 项 | 值 |
|---|---|
| 结构性重叠（无独占示例）分支 | **8** |
| 涉及规则 | 5（`rc-vllm-003` / `rc-vllm-005` / `rc-vllm-006` / `rc-ascend-002` / `rc-qg-006` / `rc-conf-tokenizer-ok`，共 6 条规则含 8 分支） |
| 判为**冗余** | **8 / 8** |
| 判为**有意** | 0 |
| **红线 3（>3 判为冗余）** | **已触发 → 停下回报，删除未执行** |

**关键事实（决定了"冗余"这个判定不是偷懒而是可证的）**：
`when` 在引擎里是**纯析取匹配**（`evidence.filter(ev => re.test(snippet))`）。
若分支 X 的匹配集合 ⊆ 分支 Y 的匹配集合，则 **X 对该规则的匹配行为贡献恰好为零**——
删掉它，规则的命中集合**逐行不变**。§2 用两个检验对每一对做了实证。

---

## 1 判据与检验方法

**你的判据**：宽泛分支已完全涵盖具体分支的语义、具体分支无额外判别力 → **冗余（删除）**；
具体分支有独立语义（更精确的场景 / 不同的修复方向）→ **有意（保留 + 白名单理由）**。

**本文用的两个可复现检验**：

- **检验 A（子集性）**：搜索"命中窄分支但不命中宽分支"的输入。若**不存在**反例 ⇒ 窄分支 ⊆ 宽分支。
  语料 = `tests/fixtures/corpus/*.txt` + `tests/fixtures/degenerate/*.txt` 的全部行，
  **外加 18 条对抗探针**（专门构造去撞窄分支的形态，如 `VLLM_USE_V1=1`、`--speculative-model /m/d`）。
- **检验 B（惰性）**：把窄分支从 `when` 中删掉，重算该规则在**同一语料**上的命中行数。
  若**逐行不变** ⇒ 删除是行为惰性的。

> **完整性的一个论证**：任何"窄 ⊂ 宽"的分支必然**不可能有独占示例**（它的任何命中都同时命中宽分支），
> 因此 §5.17.3 的独占性扫描**必定**会把它标出来。也就是说——本文的 8 条就是**全部**子集对，
> 不存在"没被扫到"的漏网重叠。

---

## 2 逐对分析（8/8，无"待定"）

| # | 规则 | 分支对（具体 ⊂ 宽泛） | 检验 A 反例 | 检验 B 命中数（删前→删后） | 判定 |
|---|---|---|---|---|---|
| 1 | `rc-vllm-003` | `VLLM_USE_V1` ⊂ `use_v1` | 不存在（严格子集） | 4 → 4（零变化） | **冗余** |
| 2 | `rc-vllm-003` | `pkg\.vllm-ascend=` ⊂ `vllm-ascend` | 不存在（严格子集） | 4 → 4（零变化） | **冗余** |
| 3 | `rc-vllm-005` | `--enable-prefix-caching` ⊂ `prefix.?cach` | 不存在（严格子集） | 12 → 12（零变化） | **冗余** |
| 4 | `rc-vllm-006` | `--speculative-model` ⊂ `speculative` | 不存在（严格子集） | 13 → 13（零变化） | **冗余** |
| 5 | `rc-vllm-006` | `--num-speculative-tokens` ⊂ `speculative` | 不存在（严格子集） | 13 → 13（零变化） | **冗余** |
| 6 | `rc-ascend-002` | `thermal throttling` ⊂ `throttl` | 不存在（严格子集） | 3 → 3（零变化） | **冗余** |
| 7 | `rc-qg-006` | `num_speculative` ⊂ `speculative` | 不存在（严格子集） | 13 → 13（零变化） | **冗余** |
| 8 | `rc-conf-tokenizer-ok` | `tokenizer\.roundtrip_ok` ⊂ `roundtrip_ok` | 不存在（严格子集） | 5 → 5（零变化） | **冗余** |

### 逐条语义分析

**1. `rc-vllm-003`：`VLLM_USE_V1` ⊂ `use_v1`（`i` 标志）**
窄分支要求含字面量 `VLLM_USE_V1`（忽略大小写），该字面量**本身包含** `USE_V1` ⇒ 必然命中宽分支 `use_v1`。
反向不成立（`use_v1=True` 只命中宽分支）。规则的 `hypothesis`/`relevance` 把二者当作**同一个语义**
（"命中 V1 引擎开关"），fix 也不按分支分流 ⇒ 窄分支无判别力。**冗余。**

**2. `rc-vllm-003`：`pkg\.vllm-ascend=` ⊂ `vllm-ascend`**
`pkg.vllm-ascend=0.9.1` 必然含 `vllm-ascend`。窄分支唯一的附加字符是 `pkg.` 前缀与 `=`，
它们不改变"这是 vllm-ascend 版本号"这一判读 ⇒ 无判别力。**冗余。**
（注意与它并列的 `pkg\.vllm=`、`pkg\.torch_npu=` **不**被 `vllm-ascend` 涵盖，故保留。）

**3. `rc-vllm-005`：`--enable-prefix-caching` ⊂ `prefix.?cach`**
`--enable-prefix-caching` 含 `prefix-caching`，`prefix.?cach`（`.` 匹配 `-`）命中它。
宽分支还能命中 `prefix_cache_hit_rate` / `prefix cache` 等形态。规则语义是"启动参数命中缓存/调度项"，
不区分具体拼写 ⇒ **冗余。**

**4./5. `rc-vllm-006`：`--speculative-model` / `--num-speculative-tokens` ⊂ `speculative`**
两个窄分支都含 `speculative` 字面量 ⇒ 都被宽分支涵盖。同规则里 `--draft` **不**被涵盖（保留）。
规则语义是"启动参数命中推测解码" ⇒ 窄分支无判别力。**冗余 ×2。**

**6. `rc-ascend-002`：`thermal throttling` ⊂ `throttl`**
`thermal throttling` 含 `throttl`。宽分支 `throttl` 还能命中 `throttled`/`throttling` 等。
规则语义是"温度超阈触发降频" ⇒ **冗余。**

**7. `rc-qg-006`：`num_speculative` ⊂ `speculative`**
`num_speculative_tokens=5` 含 `speculative` ⇒ 被涵盖。**冗余。**

**8. `rc-conf-tokenizer-ok`：`tokenizer\.roundtrip_ok` ⊂ `roundtrip_ok`**
`DSH-SIGNAL tokenizer.roundtrip_ok=true` 含 `roundtrip_ok` ⇒ 被涵盖。
注意本规则还有第三个分支 `roundtrip[=:]`，它**不**被 `roundtrip_ok` 涵盖（保留）。**冗余。**

> **判为"有意"的为 0 条**：没有任何一对能写出**具体判别力**。可考虑的两种"独立语义"在此都不成立——
> ① "更精确的场景"：规则的 `hypothesis`/`fix` 不按分支分流，5 条规则一律是规则级结论；
> ② "不同修复方向"：`fix` 挂在规则上，不挂分支。
> 唯一剩下的说法是"文档价值/未来若收窄宽分支作为保险"——那属于**无法写出具体判别力**的含糊理由，
> 正是红线 4 要拦的东西，故不采纳。

---

## 3 识别的系统性模式（为什么红线 3 会触发）

8 个重叠来自同一个**撰写习惯**：**把"具体拼写"与"泛化关键词"并列写进同一条 `when`**。

```
rc-vllm-006:  --speculative-model | --num-speculative-tokens | speculative | --draft
              └──── 具体拼写（被涵盖）────┘   └ 泛化关键词 ┘   └ 独立 ┘
```

该习惯**行为上完全惰性**（§2 检验 B 全部零变化），因此：
- **不是**"规则写错了"——规则的命中行为正确，没有任何误报/漏报由此产生；
- **是**"规则冗余"——同一语义被写了两遍，冗长、且让"逐分支覆盖"这类门禁无法机械判定。

**5 条规则**（占 61 条 `when` 规则中的 8.2%）呈现该模式，符合"系统性"而非"偶发笔误"。

---

## 4 复现方式

```bash
# 子集性 + 惰性双检验（8 对逐对输出）
SPEC_ROOT=${SPEC_ROOT:?设计文档仓路径}
node "$SPEC_ROOT/model-check/branch-overlaps-check.mjs"
# 实测输出：8 对全部「反例不存在 → 严格子集」且「删前=删后 → 零变化」
```

> 该脚本与状态机检查器同放 `model-check/`，**不随运行时包发布**（package.json 的 `files` 白名单只有
> assets/lib/model，属既有设计）。

检验脚本逻辑（两段核心）：

```js
// A) 子集性：找"命中窄但不命中宽"的反例
const counterexample = all.find((s) => new RegExp(narrow,'i').test(s) && !new RegExp(broad,'i').test(s))
// B) 惰性：删掉窄分支后重算命中数
const without = when.split('|').filter((a) => a.trim() !== narrow).join('|')
```

---

## 5 裁决结果与执行（方案甲）

按裁决书红线 3，本文判定 **8/8 冗余（>3）** 时**停下回报**（触发正确：若直接删 8 条，
"系统性写作习惯"这个诊断就不会浮现，会被当成 8 次笔误）。
裁决结果：**选方案甲——删除 8 条窄分支**，白名单保持**空集**。

**两种处置方案（请择一）**：

| 方案 | 动作 | 影响 |
|---|---|---|
| **甲：删除 8 条窄分支** | 从 5 条规则的 `when` 里删掉窄分支（保留 `rc-vllm-003` 的 `pkg\.vllm=`/`pkg\.torch_npu=`、`rc-vllm-006` 的 `--draft`、`rc-conf-tokenizer-ok` 的 `roundtrip[=:]`） | **零行为变化**（§2 检验 B 已证）；规则更精简；C12 修订版变体可直接落地，白名单可留空 |
| **乙：保留 + 白名单登记** | 8 条全部保留，写入白名单并逐条给出理由 | 需要为每条写出**具体判别力**理由——但本文分析认为**写不出**；若坚持保留，白名单理由只能是"文档价值"，属红线 4 所指的含糊理由 |

**已执行方案甲**（零行为变化 + 一次消灭全部重叠 + 白名单空集）。

### 5.1 实际删除记录

| 规则 | 删除的分支 | 保留的独立分支（未被涵盖） |
|---|---|---|
| `rc-vllm-003` | `VLLM_USE_V1`、`pkg\.vllm-ascend=` | `use_v1` / `vllm-ascend` / `vllm_ascend` / `pkg\.vllm=` / `pkg\.torch_npu=` |
| `rc-vllm-005` | `--enable-prefix-caching` | `prefix.?cach` / `--enable-chunked-prefill` / `--max-num-seqs` / `--max-num-batched-tokens` / `--block-size` |
| `rc-vllm-006` | `--speculative-model`、`--num-speculative-tokens` | `speculative` / `--draft` |
| `rc-ascend-002` | `thermal throttling` | 温度阈值式 / `throttl` / `over.?temp` |
| `rc-qg-006` | `num_speculative` | `speculative` / `draft` |
| `rc-conf-tokenizer-ok` | `tokenizer\.roundtrip_ok` | `roundtrip_ok` / `roundtrip[=:]` |

删除后顶层分支总数：**250 → 242**；规则数不变（71）。

---

## 6 删除后的复跑证据（红线 3 校验）

**校验 1：命中行数逐条不变**（同语料 = 全部夹具行 + 18 条对抗探针）

```
$ node model-check/branch-overlaps-check.mjs        # 对 8 对逐对
$ node <hit-check>.mjs                              # 对全部 61 条 when 规则
红线 3 校验：比较 61 条规则的语料命中行数
  变化：0 条  ✓ 全部零变化 → 子集性判定成立
  受影响的 6 条规则命中数：
    rc-vllm-003           4 → 4  ✓
    rc-vllm-005           12 → 12  ✓
    rc-vllm-006           13 → 13  ✓
    rc-ascend-002         3 → 3  ✓
    rc-qg-006             13 → 13  ✓
    rc-conf-tokenizer-ok  5 → 5  ✓
```

**校验 2：G6b 修订版变体**（独占性 + 三分类）

```
G6b-2 分支三分类：可分离 242 / 结构性重叠 0 / 合成失败 0；白名单 0 条（空集为目标形态）
```

**校验 3：变体有牙齿（变异测试）**

| 变异 | 预期 | 实测 |
|---|---|---|
| 把 `--enable-prefix-caching` 加回 `rc-vllm-005` | FAIL（结构性重叠未登记） | **FAIL**（三分类立刻变成"结构性重叠 1"） |
| 把 `HBM ECC uncorrectable` 改回 `... error count: 3` | FAIL（可分离分支缺独占示例） | **FAIL** |
| 恢复 | PASS | **PASS（267 断言）** |

---

## 7 写作习惯记录（给后续规则作者的规范）

> **本次识别的冗余模式 = "具体拼写与泛化关键词并列"。**
>
> 行为**惰性**（不产生误报/漏报），但降低规则可读性、增加维护面：同一语义被写了两遍，
> 且让"逐分支覆盖"这类门禁无法机械判定。
>
> **未来规则编写参考**：`when` 中若同时出现某关键词的**具体拼写**与**泛化形式**，
> **二者择一**（保留泛化，除非具体拼写有独立判别力——即**能写出它单独命中、其它分支不命中的场景**）。
>
> 反例（本次修掉的形态）：
> ```
> --speculative-model | --num-speculative-tokens | speculative | --draft
> └──── 具体拼写（被 speculative 完全涵盖）────┘   └ 泛化 ┘   └ 独立 ┘
> ```
> 正例（修后）：
> ```
> speculative | --draft
> ```
>
> **比例依据**：该模式占 61 条 `when` 规则的 8.2%（5 条规则 / 8 个分支），
> 足以构成**习惯**而非个例，故写进规范；下一批规则可按此自查，避免重复引入。
>
> **机械化兜底**：即使作者忘了这条规范，门禁 **G6b-2** 会在下一次提交时直接 FAIL
> （"结构性重叠分支必须显式登记"），因此规范是"提前避免"，门禁是"事后拦截"，两者不互相替代。
