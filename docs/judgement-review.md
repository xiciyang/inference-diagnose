# 规则判据分级清单（80 条，供抽样复核）

> **本文件由 `scripts/gen-judgement-review.mjs` 从 `assets/root-causes/**` 生成，请勿手改。**
> 手改会在门禁 G8（文档单源）上失败：重新生成的结果必须与磁盘上的一致。
>
> 本表列的是**规则文件里的 id**（`rc-*` 与 `rg-*` 两族）。**对外 id 统一加 `rc-` 前缀**
> （缺陷 C8；唯一归一化点在 `src/index.js` 的 `publicRuleId`）：规则文件里的 `rg-qual-003`
> 在 `rootCauses[]`/`weakSignals[]`/`excludedHypotheses[]`/`unmeasuredMetrics[]` 里一律是 `rc-rg-qual-003`。

**口径**：`docs/judgement-rubric.md`（判定顺序 ① `fix:null` → contextual ② 有可算判据 → quantitative ③ `when` 每一分支皆事实本身 → decisive ④ 其余 → contextual）

**分布**：decisive 16 / quantitative 17 / contextual 47（合计 80）

**建议抽样口径（≥30%）**：**全部 16 条 decisive（逐条核 rationale 是否具体到可构造的字段/取值）** + quantitative 全部 17 条 + contextual 中随机抽取。

---

## 一、decisive（16 条，逐条附 decisiveRationale）

### `rc-vllm-008`  <sub>framework-vllm-rules.yaml</sub>

- **when**：`tokenizer\.roundtrip_ok=false`
- **rationale（175 字）**：命中的是探针自动比对的结果字段 `tokenizer.roundtrip_ok=false`：探针把同一段中英混排文本 tokenize→detokenize 回读并逐字比对，false 表示往返**不能还原**，即 token↔文本映射有损。映射无损时往返必然成功，故该取值是"tokenizer 与权重不同源"的充分必要条件，不需要任何其它证据。

### `rc-ascend-001`  <sub>hardware-ascend-arm-rules.yaml</sub>

- **when**：`ECC uncorrectable|Uncorrectable ECC|uncorrectable error`
- **rationale（178 字）**：命中的是 ECC 计数器状态里的 `uncorrectable` 取值（`ECC uncorrectable` / `Uncorrectable ECC`）：corrected/可纠正错误不会带该词，该词直接表示**不可恢复的硬件级错误已发生**。它是既成事实而非诱因，故单行即足够；已收窄正则去掉裸 `HBM ECC`（正常 ECC 日志也会含该字样）。

### `rc-nv-001`  <sub>hardware-nvidia-rules.yaml</sub>

- **when**：`GPU has fallen off the bus`
- **rationale（134 字）**：命中的是内核 NVRM 驱动打印的固定字面量 `GPU has fallen off the bus`：它表示设备已从 PCIe 总线上消失、驱动再也无法与卡通信。这是**既成事实**（设备已不可达），不是诱因也不是推断，且其它规则与探针都不会产出该串，故单行即足够。

### `rc-nv-003`  <sub>hardware-nvidia-rules.yaml</sub>

- **when**：`DRAM Uncorrectable\s*:\s*[1-9]|SRAM Uncorrectable[^:]*:\s*[1-9]|Uncorrectable ECC`
- **rationale（249 字）**：命中的是 ECC 计数器里**带非零取值**的不可纠正计数行（`DRAM Uncorrectable` / `SRAM Uncorrectable …` 后跟 `: [1-9]`）：可纠正错误在 nvidia-smi 里的字段名是 `Corrected`，不会带 "Uncorrectable" 字样；而 `: N/A` 表示该机型未启用 ECC 计数（本机 GB10 即如此），故判据要求取值非零。非零的不可纠正计数直接表示**不可恢复的显存/缓存错误已发生**，是既成事实而非诱因，单行即足够。

### `rc-host-001`  <sub>hardware-host-rules.yaml</sub>

- **when**：`Out of memory: Killed process|oom-kill:constraint`
- **rationale（214 字）**：命中的是内核 OOM killer 的两条固定记账行：`Out of memory: Killed process <pid>` 表示内核**已经**执行了击杀，`oom-kill:constraint=...` 同一事件的结构化伴随行（给出触发的是 cpuset / memory cgroup 还是全局约束）。这两条都只在击杀**发生之后**由内核打印，是既成事实而非诱因，故单行即足够；且探针与其它规则都不会产出这两个串。

### `rc-docker-001`  <sub>runtime-docker-rules.yaml</sub>

- **when**：`OOMKilled|[Oo]ut of memory|ExitCode 137|exit code 137|Exited \(137\)|shm allocation failed`
- **否证条件**：`OOMKilled|[Oo]ut of memory|oom-kill|Killed process|内存不足|shm allocation failed|No space left on device`
- **rationale（272 字）**：命中的是容器运行时状态字段 `OOMKilled`、`ExitCode 137` / `Exited (137)`、`Out of memory`、`shm allocation failed`：前者是内核 OOM-killer 的**动作记录本身**，`Exited (137)` 是 `docker ps -a` 对同一事实的原生渲染，`shm allocation failed` 是共享内存分配失败的事实——都是"已被杀 / 已失败"的既成事实，不是诱因。已收窄正则去掉裸 `137` 与裸 `shm`（会命中任意含该数字/字样的行）。

### `rc-qg-003`  <sub>quality-gibberish-rules.yaml</sub>

- **when**：`quality\.deterministic=false`
- **rationale（153 字）**：命中的是探针自动比对的结果字段 `quality.deterministic=false`：探针以 temp=0 + 固定 seed 连发两次同 prompt 并逐字比对，false 表示两次输出不一致。采样随机性已被 temp=0/固定 seed 消除，故该取值直接指向"非确定性计算路径"，单行即足够。

### `rc-out-001`  <sub>output-anomaly-rules.yaml</sub>

- **when**：`"finish":"?length"?|finish_reason="?length|finish=length|被长度截断|generation.*truncat`
- **rationale（139 字）**：命中的是响应体/指标的 `finish_reason=length`（或 `"finish":"length"`）：这是解码器**自己上报的截断原因**，不是推测；模型正常收尾时该字段为 `stop`，故 length 出现即"输出被 max_tokens 截断"这一事实本身。

### `rc-out-002`  <sub>output-anomaly-rules.yaml</sub>

- **when**：`quality\.content_empty=true|"content":""|content 为空|reasoning.*非空.*content.*空`
- **rationale（134 字）**：命中的是响应体字段 `content` 为空（`"content":""`）或探针给出的 `quality.content_empty=true`：前者是响应结构里的**实际取值**，后者由探针直接解析响应体得出。content 非空时该机制不可能成立，故单行即足够。

### `rc-out-004`  <sub>output-anomaly-rules.yaml</sub>

- **when**：`\\ufffd|�|U\+FFFD|replacement character|mojibake|控制字符|乱码字节`
- **rationale（164 字）**：命中的是响应原文里的替换字符 `U+FFFD`（`�`）：U+FFFD 是解码器在**遇到无法映射的字节序列时才会写入**的替换字符，正常 UTF-8 往返不会产生它，故它的出现直接证明"字节/编码/流解析层发生了损坏"，无需模型侧证据。已收窄正则去掉裸 `surrogate`（会命中 `surrogate=` 这类配置项）。

### `rg-qual-001`  <sub>regression/qualitative-rules.yaml</sub>

- **when**：`num_preemptions_total(\{|[ \t]+[1-9])|DSH-SIGNAL\s+perf\.num_preemptions=[1-9]|preempted|被抢占`
- **rationale（150 字）**：命中的是抢占计数的**取值**（`num_preemptions_total{…} N` 且 N≥1，或 `DSH-SIGNAL perf.num_preemptions=[1-9]`，或 `preempted`）：抢占行为的发生是计数器/日志直接记录的事实，不是配置存在性；计数器为 0 时不命中。

### `rg-qual-002`  <sub>regression/qualitative-rules.yaml</sub>

- **when**：`num_requests_waiting(\{|[ \t]+[1-9])|Waiting:\s*[1-9]|DSH-SIGNAL\s+perf\.num_waiting=[1-9]`
- **rationale（97 字）**：命中的是等待队列的**取值**（`num_requests_waiting{…} N` 且 N≥1，或 `Waiting: N`）：队列非零即"请求正在排队"这一事实本身；队列为 0 时不命中。

### `rc-cons-001`  <sub>consistency/determinism-rules.yaml</sub>

- **when**：`quality\.sample\.\d+=core_hash:\w+\s+\{[^}]*"finish":"?"?length"?`
- **rationale（157 字）**：命中的是采样记录里的 `finish` 字段取值 `length`（`quality.sample.N=core_hash:… {"finish":"length"}`）：这是该次采样**被 max_tokens 截断**的直接记录。截断位置不同的样本指纹必然不同，故该取值单行即足以判定"指纹差异可由截断解释"。

### `rc-cons-002`  <sub>consistency/determinism-rules.yaml</sub>

- **when**：`quality\.deterministic=false`
- **rationale（95 字）**：同 rc-qg-003：命中的是 `quality.deterministic=false`——探针以 temp=0+固定 seed 自动比对两次输出的结果字段，单行即指向非确定性计算路径。

### `rc-cons-003`  <sub>consistency/determinism-rules.yaml</sub>

- **when**：`logits\.prefill_repeat_consistent=false`
- **rationale（176 字）**：命中的是 `logits.prefill_repeat_consistent=false`：探针跑"完整重算#1 → 同 salt 命中 → 换 salt 完整重算#2"三条路径并比对首 token logprob，false 表示**两次完整重算不一致**，即误差产生在采样之前的 prefill/地址路径上。该字段是探针实测比对的结论，单行即足够。

### `rc-cons-004`  <sub>consistency/determinism-rules.yaml</sub>

- **when**：`tokenizer\.roundtrip_ok=false`
- **rationale（104 字）**：命中的是 `tokenizer.roundtrip_ok=false`——探针已实跑 tokenize→detokenize 往返并比对原文，false 是**往返失败**的实测结论；映射无损时往返必然成功。

---

## 二、quantitative（17 条：结论由数值比较得出）

| 规则 | 文件 | 判据字段 | when/metric |
|---|---|---|---|
| `rc-idx-001` | methodology-rules.yaml | computeCheck,causal | `lightning_indexer\|quant_lightning\|QLIV2\|GetKeyScale\(\|kScaleBlkStride\s*[=:]\|page[_-]?stri` |
| `rc-conf-shards-ok` | methodology-rules.yaml | computeCheck | `shards_declared\|shards_present\|分片` |
| `rc-conf-tokenizer-ok` | methodology-rules.yaml | computeCheck | `roundtrip_ok\|roundtrip[=:]` |
| `rc-conf-nondet` | methodology-rules.yaml | computeCheck | `prefill_repeat_consistent\|logits\.\|deterministic` |
| `rc-struct-sliding-eq-block` | methodology-rules.yaml | computeCheck | `sliding_window\|block.?size\|滑窗` |
| `rg-perf-001` | regression/performance-rules.yaml | threshold,causal | `metric:ttft_ms` |
| `rg-perf-002` | regression/performance-rules.yaml | threshold,causal | `metric:e2e_ms` |
| `rg-perf-003` | regression/performance-rules.yaml | threshold,causal | `metric:generation_tokens_per_s` |
| `rg-perf-004` | regression/performance-rules.yaml | threshold,causal | `metric:prefix_cache_hit_rate` |
| `rg-perf-005` | regression/performance-rules.yaml | threshold,causal | `metric:kv_cache_usage_perc` |
| `rg-perf-006` | regression/performance-rules.yaml | threshold,causal | `metric:num_preemptions` |
| `rg-acc-001` | regression/accuracy-rules.yaml | threshold,causal | `metric:accuracy` |
| `rg-acc-002` | regression/accuracy-rules.yaml | threshold,causal | `metric:ppl` |
| `rg-acc-003` | regression/accuracy-rules.yaml | threshold,causal | `metric:kl_divergence` |
| `rg-acc-004` | regression/accuracy-rules.yaml | threshold,causal | `metric:exact_match` |
| `rg-qual-003` | regression/qualitative-rules.yaml | computeCheck,causal | `gpu_cache_usage_perc\{[^}]*\}[ \t]+[0-9.]+\|DSH-SIGNAL\s+perf\.kv_cache_usage=[0-9.]+\|kv[ _` |
| `rc-cons-007` | consistency/determinism-rules.yaml | derivedBy | `DSH-SIGNAL\s+quality\.sample\.\d+=core_hash:` |

---

## 三、contextual（47 条：存在性/上下文关键词；`fix:null` 者恒入主列表）

| 规则 | 文件 | 属性 | when/metric |
|---|---|---|---|
| `rc-vllm-001` | framework-vllm-rules.yaml | — | `--quantization\|quant_method\|kv-cache-dtype\|load_in_8bit\|load_in_4bit\|w8a8\|w4a16\|fp8\|int8` |
| `rc-vllm-002` | framework-vllm-rules.yaml | — | `--max-model-len\|max_position_embeddings\|rope_scaling\|rope_theta\|--rope-scaling\|--rope-thet` |
| `rc-vllm-003` | framework-vllm-rules.yaml | — | `use_v1\|vllm-ascend\|vllm_ascend\|pkg\.vllm=\|pkg\.torch_npu=` |
| `rc-vllm-004` | framework-vllm-rules.yaml | — | `--tensor-parallel-size\|--pipeline-parallel-size\|--data-parallel\|world_size\|distributed-exe` |
| `rc-vllm-005` | framework-vllm-rules.yaml | — | `prefix.?cach\|--enable-chunked-prefill\|--max-num-seqs\|--max-num-batched-tokens\|--block-size` |
| `rc-vllm-006` | framework-vllm-rules.yaml | — | `speculative\|--draft` |
| `rc-vllm-007` | framework-vllm-rules.yaml | — | `--enforce-eager\|--compilation-config\|cudagraph\|torchair\|aclgraph\|ACL_GRAPH\|FULL_DECODE_ONL` |
| `rc-vllm-009` | framework-vllm-rules.yaml | — | `chat_template\.file=\|chat template\|tool-call-parser\|enable-auto-tool-choice\|--chat-templat` |
| `rc-vllm-010` | framework-vllm-rules.yaml | fix:null | `vllm\.proc\.pid=none\|vllm\.log\.candidates=0\|DSH-SIGNAL vllm\.container=$\|quality\.probe=e` |
| `rc-mindie-001` | framework-mindie-rules.yaml | — | `abort\|core dump\|SIGABRT\|RuntimeError` |
| `rc-mindie-003` | framework-mindie-rules.yaml | — | `driver version\|compat\|version mismatch\|HDK` |
| `rc-ascend-002` | hardware-ascend-arm-rules.yaml | fix:null | `temp(erature)?[ =:]+(8[5-9]\|9[0-9]\|[1-9][0-9]{2,})C?\|throttl\|over.?temp` |
| `rc-nv-002` | hardware-nvidia-rules.yaml | — | `Xid[ :=][0-9]+\|NVRM: Xid` |
| `rc-nv-004` | hardware-nvidia-rules.yaml | — | `Driver/library version mismatch\|Failed to initialize NVML` |
| `rc-nv-005` | hardware-nvidia-rules.yaml | — | `CUDA out of memory` |
| `rc-host-002` | hardware-host-rules.yaml | — | `page allocation failure\|Memory cgroup out of memory` |
| `rc-host-003` | hardware-host-rules.yaml | — | `No space left on device\|Disk quota exceeded` |
| `rc-host-004` | hardware-host-rules.yaml | — | `Resource temporarily unavailable\|fork: Cannot allocate memory` |
| `rc-qg-001` | quality-gibberish-rules.yaml | — | `quant_method\|quantization_config\|load_in_8bit\|load_in_4bit\|w8a8\|w4a16\|kv_scale\|amax\|--quan` |
| `rc-qg-002` | quality-gibberish-rules.yaml | — | `rope_scaling\|rope_theta\|max_position_embeddings` |
| `rc-qg-004` | quality-gibberish-rules.yaml | — | `--enable-prefix-caching\|enable_prefix_caching[= ]\|prefix_cache_hit_rate\|--block-size[= ]\|b` |
| `rc-qg-005` | quality-gibberish-rules.yaml | — | `tensor.?parallel\|pipeline.?parallel\|world_size\|tp_size\|num_local_experts\|expert.?parallel` |
| `rc-qg-006` | quality-gibberish-rules.yaml | — | `speculative\|draft` |
| `rc-qg-007` | quality-gibberish-rules.yaml | — | `fallback\|aicore\|overflow\|nan\b\|inf\b\|unsupported\|aclnn\|算子回退\|精度异常` |
| `rc-qg-008` | quality-gibberish-rules.yaml | — | `tokenizer_class\|vocab_size\|add_bos_token\|add_eos_token\|tokenizer_config` |
| `rc-qg-009` | quality-gibberish-rules.yaml | — | `temperature\|top_p\|top_k\|repetition_penalty\|presence_penalty\|frequency_penalty` |
| `rc-evi-001` | quality-gibberish-rules.yaml | fix:null | `evidence\.missing\.` |
| `rc-out-003` | output-anomaly-rules.yaml | — | `repetition[ _-]?penalty\|repetition[ _-]?(rate\|count\|detected)\|repeat_penalty\|复读\|重复率\|n-gram` |
| `rc-out-005` | output-anomaly-rules.yaml | causal | `chat_template\.file=\|chat_template=\|chat template\|模板.{0,24}(不匹配\|错位)\|工具调用.{0,24}(异常\|不匹配\|错位\|` |
| `rc-out-006` | output-anomaly-rules.yaml | — | `truncat\|截断\|incomplete\|partial response\|stream.*abort\|连接被重置\|(?<!write error: )broken pipe` |
| `rc-out-007` | output-anomaly-rules.yaml | fix:null | `DSH-SIGNAL\s+evidence\.missing\.3=response_body\|response_body（\|未落响应正文` |
| `rc-out-008` | output-anomaly-rules.yaml | fix:null | `DSH-SIGNAL\s+evidence\.missing\.1=client_request_params\|未开 --enable-log-requests` |
| `rc-causal-001` | methodology-rules.yaml | fix:null | `DSH-SIGNAL causal\.(revert_repro\|ab_toggle\|binary_sha_match)=true` |
| `rg-qual-004` | regression/qualitative-rules.yaml | causal | `prefix_cache_hit_rate(?:\{[^}]*\})?[ \t]+0(?:\.0+)?(?![0-9.])\|Prefix cache hit rate:?[ \t]` |
| `rg-qual-005` | regression/qualitative-rules.yaml | causal | `spec_decode_num_(accepted\|draft)_tokens_total\{\|speculative_config=\{\|--speculative-config` |
| `rg-qual-006` | regression/qualitative-rules.yaml | causal | `fallback\|unsupported\|aclnn\|aicore\|回退\|boost` |
| `rg-qual-007` | regression/qualitative-rules.yaml | causal | `温度\|throttle\|降频\|thermal\|temp[^a-zA-Z0-9_]\|frequency\|freq_` |
| `rg-qual-008` | regression/qualitative-rules.yaml | fix:null | `DSH-SIGNAL\s+metrics\.unavailable=true\|evidence\.missing\.0=metrics_endpoint` |
| `rg-qual-009` | regression/qualitative-rules.yaml | fix:null | `DSH-SIGNAL\s+evidence\.missing\.` |
| `rc-cons-005` | consistency/determinism-rules.yaml | fix:null | `DSH-SIGNAL\s+quality\.probe=endpoint-unreachable\|DSH-SIGNAL\s+tokenizer\.roundtrip=n/a` |
| `rc-cons-006` | consistency/determinism-rules.yaml | fix:null | `DSH-SIGNAL\s+quality\.sweep\.done=true` |
| `rc-cons-env-001` | consistency/environment-rules.yaml | causal | `DSH-SIGNAL\s+pkg\.\|driver\|firmware\|固件\|ascend.*version\|npu-smi.*version` |
| `rc-cons-env-002` | consistency/environment-rules.yaml | causal | `npu-smi info -t board\|\bboard(?:\s+id)?\s{0,40}[=:]?\s{0,40}[0-9a-fx]\|SOC[^a-zA-Z0-9_]{0,3` |
| `rc-cons-env-003` | consistency/environment-rules.yaml | causal | `max-num-seqs\|max_num_seqs\|tensor-parallel\|data-parallel\|enable-chunked-prefill\|block-size\|` |
| `rc-cons-env-004` | consistency/environment-rules.yaml | causal | `vllm_ascend\|vllm-ascend\|VLLM_USE_V1\|in_container\.(vllm\|torch)\|空构建\|dev\d+\|empty` |
| `rc-cons-env-005` | consistency/environment-rules.yaml | fix:null | `DSH-SIGNAL\s+(vllm\.proc\.pid=none\|vllm\.container=unavailable\|metrics\.unavailable=true\|e` |
| `rc-cons-env-006` | consistency/environment-rules.yaml | fix:null | `DSH-SIGNAL\s+evidence\.missing\.` |

---

## 四、边界裁决记录（已生效，供复核）

共 2 条。每条 = 当时的两难 + 最终裁决 + 支撑证据。

### 1. `rc-conf-oom-trace`（methodology）与 `rc-docker-001`（runtime）主张同一机制

**状态**：已关闭（2026-09-28）

**裁决**：合并为一条，保留 `rc-docker-001`，删除 `rc-conf-oom-trace`。
**判据**：`rc-conf-oom-trace` 的 `when`（`ExitCode 137|exit code 137|OOMKilled`）是 `rc-docker-001` 的**真子集**；
三组输入（真机语料 / docker 原生渲染 / 显式 OOMKilled）实测命中集合**逐条相同** → 同源，按"同机制不留两条 decisive"删除其一。
保留 runtime 维度的那条，因为它对**全部框架组合**可达（mindie+docker 同样命中），而 methodology 簇只被 vllm 组合引用。
`rc-conf-oom-trace` 的否证条件随之迁入 `rc-docker-001`（只有 137 而无 OOM/SHM 痕迹 → 否证），故合并**未损失**可证伪性。
顺带修复该规则的一个真机盲区：`docker ps -a` 的原生渲染是 `Exited (137)`，两条规则原先**都不匹配**——现已并入并加测试（缺陷 #52）。

### 2. `rg-qual-001/002` 判 decisive，而 `rg-qual-003/004` 同类却未判

**状态**：已关闭（2026-09-28）

**裁决**：003 改为 `quantitative` 并携带显式阈值判据；004 保持 `contextual` 但把 `when` 收窄到"命中率为 0"这一无需基线的下限事实。
**003 的阈值来源**：不是新定的领域判断——规则自己的 `relevance` 早已写明"占用率进入 90%+ 区间"，
故用 `computeCheck: usage * (1 + (usage <= 1) * 99)` + `assert: (threshold >= 90)` 把它变成**可算、可审计、可撤回**的判据（0–1 分数与百分数两种形态都归一化）。
**004 的"骤降"归属**：该阈值**本就已存在**于 B 定量规则 `rg-perf-004`（`metric=prefix_cache_hit_rate`，`warnRatio 1.25` / `criticalRatio 1.6`，方向 lower-worse），
故 004 不再重复主张"骤降"，只在 `relevance` 里指名移交——**没有新造任何阈值**。
**连带缺陷**：修 003/004 时发现 `regression/qualitative-rules.yaml` 是唯一把 `\s`/`\{`/`\.` 写成双反斜杠的文件，
在该 YAML 引号约定下这些分支等价于"匹配一个字面反斜杠"，**永远命中不了**（`rg-qual-002` 三条分支全死，任何输入都不触发）→ 缺陷 #54；
并由新增门禁 **G6**（正则字段不得含未声明的双反斜杠）锁死，A 路径同类的 3 处死分支一并修复。

---

## 五、正例覆盖（门禁 G6b：每条规则的 when 必须能被自身正例命中，逐分支覆盖）

**覆盖**：71 条规则 / 280 个正例；**显式豁免** 9 条（证据缺口声明规则）。
逐分支覆盖的含义：`when` 的**每一个顶层分支**都至少被一个正例命中——只写一条正例挡不住"分支死了一条"。

| 规则 | 正例（signalExample） |
|---|---|
| `rc-vllm-001` | `--quantization=compressed-tensors` · `"quant_method": "compressed-tensors"` · `--kv-cache-dtype=auto` · `load_in_8bit=True` · `load_in_4bit=True` · `quantization=w8a8` · `quantization=w4a16` · `quantization=fp8` · `quantization=int8` |
| `rc-vllm-002` | `--max-model-len 8192` · `"max_position_embeddings": 32768` · `"rope_scaling": {"type": "yarn"}` · `"rope_theta": 1000000.0` · `--rope-scaling yarn` · `--rope-theta 1000000` |
| `rc-vllm-003` | `VLLM_USE_V1=1` · `use_v1=True` · `Name: vllm-ascend  Version: 0.9.1` · `import vllm_ascend ok` · `DSH-SIGNAL pkg.vllm=0.23.1rc1` · `DSH-SIGNAL pkg.vllm-ascend=0.9.1` · `DSH-SIGNAL pkg.torch_npu=2.5.1` |
| `rc-vllm-004` | `--tensor-parallel-size 4` · `--pipeline-parallel-size 1` · `--data-parallel-size 2` · `world_size=4` · `distributed-executor-backend=mp` · `"num_local_experts": 8` |
| `rc-vllm-005` | `--enable-prefix-caching` · `enable_prefix_caching=True` · `--enable-chunked-prefill` · `--max-num-seqs 256` · `--max-num-batched-tokens 8192` · `--block-size 128` |
| `rc-vllm-006` | `--speculative-model /models/draft-qwen` · `--num-speculative-tokens 5` · `speculative_config=None` · `--draft-model /models/draft` |
| `rc-vllm-007` | `--enforce-eager` · `--compilation-config {"level": 3}` · `cudagraph_capture_sizes=[1, 96]` · `torchair graph enabled` · `aclgraph mode=2` · `ACL_GRAPH=1` · `FULL_DECODE_ONLY` |
| `rc-vllm-008` | `DSH-SIGNAL tokenizer.roundtrip_ok=false` |
| `rc-vllm-009` | `DSH-SIGNAL chat_template.file=/app/template.jinja` · `chat template mismatch detected` · `--tool-call-parser hermes` · `--enable-auto-tool-choice` · `--chat-template /app/template.jinja` |
| `rc-mindie-001` | `[ERROR] request abort due to device error` · `core dump generated at /var/crash/mindie.core` · `Process exited with SIGABRT` · `RuntimeError: NPU out of memory` |
| `rc-mindie-003` | `driver version: 24.1.rc3` · `compat check failed for cann` · `version mismatch detected` · `HDK 24.1.RC3 installed` |
| `rc-ascend-001` | `HBM ECC uncorrectable` · `Uncorrectable ECC detected on device 0` · `uncorrectable error reported by npu-smi` |
| `rc-ascend-002` | `temperature: 88C` · `thermal throttling detected` · `over temp alarm` · `thermal throttling active` |
| `rc-nv-001` | `NVRM: GPU has fallen off the bus (this may be a hardware fai` |
| `rc-nv-002` | `Xid 79` · `NVRM: Xid (PCI:0000:01:00): 79` · `Xid 48` |
| `rc-nv-003` | `DRAM Uncorrectable                         : 3` · `SRAM Uncorrectable Parity                  : 2` · `Uncorrectable ECC detected on device 0` |
| `rc-nv-004` | `Driver/library version mismatch detected after kernel upgrad` · `nvidia-smi: Failed to initialize NVML: Unknown Error` |
| `rc-nv-005` | `torch.OutOfMemoryError: CUDA out of memory. Tried to allocat` |
| `rc-host-001` | `Out of memory: Killed process 4242 (python3) total-vm:482916` · `oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/` |
| `rc-host-002` | `page allocation failure: order:4, mode:0x40cc0(GFP_KERNEL)` · `Memory cgroup out of memory: Killed process 4242 (python3)` |
| `rc-host-003` | `OSError: [Errno 28] No space left on device` · `Disk quota exceeded while writing /root/.cache/vllm` |
| `rc-host-004` | `EAGAIN: Resource temporarily unavailable while accepting con` · `bash: fork: Cannot allocate memory` |
| `rc-docker-001` | `"OOMKilled": true` · `Out of memory: Killed process 4242` · `ExitCode 137` · `container exit code 137` · `a1b2c3d4e5f6   vllm-svc    Exited (137) 2 hours ago` · `shm allocation failed: No space left on device` |
| `rc-qg-001` | `"quant_method": "ascend"` · `"quantization_config": {...}` · `load_in_8bit=True` · `load_in_4bit=True` · `quantization=w8a8` · `quantization=w4a16` · `kv_scale shape=[1, 128]` · `activation amax tensor computed` · `--quantization compressed-tensors` · `--kv-cache-dtype auto` |
| `rc-qg-002` | `"rope_scaling": {"type": "linear"}` · `"rope_theta": 500000.0` · `"max_position_embeddings": 8192` |
| `rc-qg-003` | `DSH-SIGNAL quality.deterministic=false` |
| `rc-qg-004` | `--enable-prefix-caching` · `enable_prefix_caching=True` · `vllm:prefix_cache_hit_rate 0.42` · `--block-size=128` · `block_size: 128` · `--max-num-seqs=256` · `max_num_seqs: 256` · `kv_cache_dtype: auto` |
| `rc-qg-005` | `tensor_parallel_size=4` · `pipeline_parallel_size=1` · `world_size=8` · `tp_size=4` · `"num_local_experts": 64` · `expert_parallel_size=2` |
| `rc-qg-006` | `speculative_config=None` · `draft_model=/models/draft` · `num_speculative_tokens=5` |
| `rc-qg-007` | `operator fallback to aicpu` · `aicore timeout on stream 3` · `int32 overflow detected` · `attention output contains nan` · `logits contain inf` · `unsupported op type` · `aclnnAddCustom failed` · `算子回退到 CPU 实现` · `检测到精度异常` |
| `rc-qg-008` | `"tokenizer_class": "Qwen2Tokenizer"` · `"vocab_size": 151936` · `"add_bos_token": false` · `"add_eos_token": false` · `tokenizer_config.json found` |
| `rc-qg-009` | `temperature=0.7` · `top_p=0.9` · `top_k=50` · `repetition_penalty=1.1` · `presence_penalty=0.0` · `frequency_penalty=0.0` |
| `rc-out-001` | `"finish":"length"` · `finish_reason="length"` · `finish=length` · `输出被长度截断` · `generation truncated at 512 tokens` |
| `rc-out-002` | `DSH-SIGNAL quality.content_empty=true` · `{"choices":[{"message":{"content":""}}]}` · `content 为空而 reasoning 有内容` · `reasoning 非空但 content 空` |
| `rc-out-003` | `repetition_penalty=1.05` · `repetition_rate=0.62` · `repeat_penalty=1.1` · `疑似复读` · `重复率 62%` · `n-gram overlap detected` · `n_gram repeat count=8` |
| `rc-out-004` | `"content":"\ufffd"` · `content contains �` · `U+FFFD found in response` · `replacement character in output` · `mojibake detected` · `控制字符 0x01 出现在响应` · `乱码字节序列` |
| `rc-out-005` | `DSH-SIGNAL chat_template.file=/app/t.jinja` · `chat_template=/app/t.jinja` · `chat template not applied` · `模板渲染错位` · `工具调用格式不匹配` · `tool_call payload malformed` |
| `rc-out-006` | `response truncated` · `输出被截断` · `incomplete response body` · `received partial response` · `stream aborted by peer` · `连接被重置` · `upstream connect error: Broken pipe` |
| `rc-idx-001` | `lightning_indexer_v2 called` · `quant_lightning kernel` · `QLIV2 vector kernel` · `GetKeyScale(blk)` · `kScaleBlkStride = 73856` · `page_stride = 73856` · `block_table[1024]` · `blockId=29080` |
| `rc-conf-shards-ok` | `DSH-SIGNAL weights.shards_declared=274` · `DSH-SIGNAL weights.shards_present=270` · `模型分片数不完整` |
| `rc-conf-tokenizer-ok` | `DSH-SIGNAL tokenizer.roundtrip_ok=true` · `roundtrip_ok=false` · `roundtrip: ok` |
| `rc-conf-nondet` | `prefill_repeat_consistent=false` · `DSH-SIGNAL logits.salt_supported=1` · `DSH-SIGNAL quality.deterministic=false` |
| `rc-struct-sliding-eq-block` | `"sliding_window": 128` · `--block-size 128` · `滑窗长度等于分块长度` |
| `rc-causal-001` | `DSH-SIGNAL causal.revert_repro=true` · `DSH-SIGNAL causal.ab_toggle=true` · `DSH-SIGNAL causal.binary_sha_match=true` |
| `rg-perf-001` | `DSH-SIGNAL perf.ttft_ms=420` |
| `rg-perf-002` | `DSH-SIGNAL perf.e2e_ms=3600` |
| `rg-perf-003` | `DSH-SIGNAL perf.generation_tokens_per_s=810` |
| `rg-perf-004` | `DSH-SIGNAL perf.prefix_cache_hit_rate=0.3100` |
| `rg-perf-005` | `DSH-SIGNAL perf.kv_cache_usage=0.87` |
| `rg-perf-006` | `DSH-SIGNAL perf.num_preemptions=120` |
| `rg-acc-001` | `DSH-SIGNAL perf.accuracy=0.8120` |
| `rg-acc-002` | `DSH-SIGNAL perf.ppl=8.42` |
| `rg-acc-003` | `DSH-SIGNAL perf.kl_divergence=0.0310` |
| `rg-acc-004` | `DSH-SIGNAL perf.exact_match=0.6420` |
| `rg-qual-001` | `vllm:num_preemptions_total{model="q"} 12` · `DSH-SIGNAL perf.num_preemptions=120` · `request preempted due to KV pressure` · `请求被抢占` |
| `rg-qual-002` | `vllm:num_requests_waiting{model="q"} 40` · `Waiting: 40` · `DSH-SIGNAL perf.num_waiting=40` |
| `rg-qual-003` | `vllm:gpu_cache_usage_perc{model_name="q"} 0.97` · `DSH-SIGNAL perf.kv_cache_usage=0.9713` · `KV cache usage: 96%` |
| `rg-qual-004` | `vllm:prefix_cache_hit_rate{model_name="q"} 0.0` · `Prefix cache hit rate: 0.0%` · `DSH-SIGNAL perf.prefix_cache_hit_rate=0.0000` |
| `rg-qual-005` | `vllm:spec_decode_num_accepted_tokens_total{model="q"} 42` · `speculative_config={"model": "draft"}` · `--speculative-config {"num_speculative_tokens": 5}` · `num_speculative_tokens=5` · `draft_model=/models/draft` · `acceptance_rate=0.42` · `接受率 0.42` |
| `rg-qual-006` | `operator fallback to aicpu` · `unsupported op type` · `aclnnAddCustom failed` · `aicore timeout` · `算子回退` · `boost mode enabled` |
| `rg-qual-007` | `温度过高` · `GPU throttle detected` · `发生降频` · `thermal zone over temp` · `temp=85C` · `frequency 1200MHz` · `freq_cur=1200` |
| `rc-cons-001` | `DSH-SIGNAL quality.sample.1=core_hash:a1b2c3d4 {"c":"x","c_l` |
| `rc-cons-002` | `DSH-SIGNAL quality.deterministic=false` |
| `rc-cons-003` | `DSH-SIGNAL logits.prefill_repeat_consistent=false` |
| `rc-cons-004` | `DSH-SIGNAL tokenizer.roundtrip_ok=false` |
| `rc-cons-006` | `DSH-SIGNAL quality.sweep.done=true (8/8 有效样本)` |
| `rc-cons-007` | `DSH-SIGNAL quality.sample.3=core_hash:e5f6a7b8 {"c":"y","c_l` |
| `rc-cons-env-001` | `DSH-SIGNAL pkg.torch=2.11.0` · `driver version: 24.1.rc3` · `firmware 7.5.0` · `固件版本 7.5.0` · `ascend version 8.0.RC3` · `npu-smi version 24.1.rc3` |
| `rc-cons-env-002` | `npu-smi info -t board` · `Board ID                         0x1a2b` · `SOC 0` · `chip 3` · `批次: A1` · `序列号: SN12345` · `SERIAL=SN12345` · `device_count=8` · `rank=0` |
| `rc-cons-env-003` | `--max-num-seqs=32` · `max_num_seqs: 256` · `--tensor-parallel-size 4` · `--data-parallel-size 2` · `--enable-chunked-prefill` · `--block-size 128` · `concurrency=32` · `并发 32` · `batch_size=32` |
| `rc-cons-env-004` | `import vllm_ascend` · `vllm-ascend 0.9.1` · `VLLM_USE_V1=1` · `DSH-SIGNAL in_container.vllm=0.23.1` · `空构建镜像` · `dev223+ga346d589f` · `empty response` |

### 显式豁免（`when` 匹配的是"证据缺席"标记，规则本身是缺口声明而非成因主张）

| 规则 | 豁免理由 |
|---|---|
| `rc-vllm-010` | when 匹配的是"探针没能取到证据"的缺席标记（pid=none / candidates=0 / container= 空 / endpoint-unreachable / roundtrip=n/a），本规则就是"缺什么"的声明，不主 |
| `rc-evi-001` | when 匹配 evidence.missing.*，是通用证据缺口声明（不主张成因） |
| `rc-out-007` | when 匹配 evidence.missing.3=response_body，声明"响应正文未落盘 ⇒ 输出内容无法从服务端判定" |
| `rc-out-008` | when 匹配 evidence.missing.1=client_request_params，声明"未开请求级日志 ⇒ 客户端采样参数不可见" |
| `rg-qual-008` | when 匹配 metrics.unavailable=true / evidence.missing.0=metrics_endpoint，声明"无指标端点 ⇒ 排队/抢占/KV/缓存这几类机制在原理上不可判定" |
| `rg-qual-009` | when 匹配 DSH-SIGNAL evidence.missing.*，是通用证据缺口声明（与 rg-qual-008 互补） |
| `rc-cons-005` | when 匹配 quality.probe=endpoint-unreachable / tokenizer.roundtrip=n/a，声明"端点不可达或往返不可测 ⇒ 无法做一致性判定" |
| `rc-cons-env-005` | when 匹配 vllm.proc.pid=none / vllm.container=unavailable / metrics.unavailable=true / engine_log=unavailable，声明"环境证据取不到" |
| `rc-cons-env-006` | when 匹配 DSH-SIGNAL evidence.missing.*，是通用证据缺口声明 |

**按 rubric §3 仍未定档的规则：无。** 80 条全部按判定顺序定档。
