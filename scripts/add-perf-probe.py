#!/usr/bin/env python3
# 一次性资产编辑脚本（2026-09-28）：
#   ① 给 framework/vllm.yaml 与 framework/mindie.yaml 的 probes 追加 perf-snapshot 探针
#      （B 范式"性能劣化"需要当前值来源；探针只读、不改任何配置、不改服务）
#   ② 给两者的 ruleRefs 追加 root-causes/output-anomaly-rules.yaml（A 范式输出异常扩面）
# 用法：python3 scripts/add-perf-probe.py
import os
import re
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── perf-snapshot 探针命令（单行；不含单引号，便于 YAML 标量安全引用） ──
CMD = (
    'EP="${VLLM_BASE:-http://127.0.0.1:8000}"; M="${MODEL_NAME:-}"; '
    '[ -z "$M" ] && M=$(timeout 10 curl -s --connect-timeout 3 --max-time 8 "$EP/v1/models" 2>/dev/null '
    '| grep -o "\\"id\\":\\"[^\\"]*\\"" | head -1 | cut -d"\\"" -f4); '
    'if [ -z "$M" ]; then '
    'echo "DSH-SIGNAL perf.unavailable=true (端点无 /v1/models 响应：未测到任何性能指标，不臆断)"; '
    'else '
    'CH="$EP/v1/chat/completions"; P="[{\\"role\\":\\"user\\",\\"content\\":\\"用一句话说明什么是张量并行。\\"}]"; '
    'echo "DSH-SIGNAL perf.model=$M"; echo "DSH-SIGNAL perf.max_tokens=64"; '
    'T0=$(date +%s%3N); '
    'R=$(timeout 120 curl -s --connect-timeout 3 --max-time 90 "$CH" -H "Content-Type: application/json" '
    '-d "{\\"model\\":\\"$M\\",\\"messages\\":$P,\\"temperature\\":0,\\"max_tokens\\":64,\\"seed\\":7}" 2>&1); '
    'T1=$(date +%s%3N); E2E=$((T1-T0)); echo "DSH-SIGNAL perf.e2e_ms=$E2E"; '
    'CT=$(printf "%s" "$R" | python3 -c "import json,sys;d=json.load(sys.stdin);u=d.get(\\"usage\\") or {};print(u.get(\\"completion_tokens\\") or 0)" 2>/dev/null); '
    '[ -n "$CT" ] && echo "DSH-SIGNAL perf.completion_tokens=$CT"; '
    'FT=""; '
    'timeout 90 curl -s -N --connect-timeout 3 --max-time 80 "$CH" -H "Content-Type: application/json" '
    '-d "{\\"model\\":\\"$M\\",\\"messages\\":$P,\\"temperature\\":0,\\"max_tokens\\":64,\\"stream\\":true,\\"seed\\":7}" 2>/dev/null '
    '| while IFS= read -r L; do if [ -z "$FT" ]; then case "$L" in *content*) FT=$(date +%s%3N); '
    'echo "DSH-SIGNAL perf.ttft_ms=$((FT-T0))";; esac; fi; done; '
    'MM=$(timeout 20 curl -s --connect-timeout 3 --max-time 15 "$EP/metrics" 2>/dev/null); '
    'if [ -n "$MM" ]; then '
    'KV=$(printf "%s" "$MM" | grep -m1 "^vllm:gpu_cache_usage_perc" | grep -o "[0-9.]*$"); '
    '[ -n "$KV" ] && echo "DSH-SIGNAL perf.kv_cache_usage=$KV"; '
    'PH=$(printf "%s" "$MM" | grep -m1 "^vllm:prefix_cache_hits_total" | grep -o "[0-9.]*$"); '
    'PQ=$(printf "%s" "$MM" | grep -m1 "^vllm:prefix_cache_queries_total" | grep -o "[0-9.]*$"); '
    '[ -n "$PH" ] && [ -n "$PQ" ] && [ "$PQ" != "0" ] && python3 -c "print(\\"DSH-SIGNAL perf.prefix_cache_hit_rate=%.4f\\" % ($PH/$PQ))"; '
    'NP=$(printf "%s" "$MM" | grep -m1 "^vllm:num_preemptions_total" | grep -o "[0-9.]*$"); '
    '[ -n "$NP" ] && echo "DSH-SIGNAL perf.num_preemptions=$NP"; '
    'else echo "DSH-SIGNAL perf.metrics=unavailable"; fi; '
    'fi'
)
assert "'" not in CMD, "perf-snapshot 命令不得含单引号（YAML 标量安全前提）"

NEW_REFS = ['root-causes/output-anomaly-rules.yaml']


def yaml_scalar(s):
    d = yaml.safe_dump({'command': s}, allow_unicode=True, default_flow_style=False, width=100000)
    return d[len('command: '):].rstrip('\n')


def edit_probes(path):
    txt = open(path, encoding='utf-8').read()
    if 'id: perf-snapshot' in txt:
        return 'skip(probe 已存在)'
    lines = txt.split('\n')
    # 定位 probes: 段
    start = next((i for i, l in enumerate(lines) if l.rstrip() == 'probes:'), None)
    if start is None:
        raise SystemExit('未找到 probes: 段 in %s' % path)
    end = next((i for i in range(start + 1, len(lines))
                if lines[i] and not lines[i].startswith(' ') and not lines[i].startswith('-')), len(lines))
    block = [
        '  - id: perf-snapshot',
        '    section: perf-snapshot',
        '    command: ' + yaml_scalar(CMD),
    ]
    lines[end:end] = block
    open(path, 'w', encoding='utf-8').write('\n'.join(lines))
    return 'probe 已插入（probes 段 %d..%d）' % (start, end)


def edit_rule_refs(path):
    txt = open(path, encoding='utf-8').read()
    lines = txt.split('\n')
    start = next((i for i, l in enumerate(lines) if l.rstrip() == 'ruleRefs:'), None)
    if start is None:
        raise SystemExit('未找到 ruleRefs: 段 in %s' % path)
    end = next((i for i in range(start + 1, len(lines)) if not lines[i].startswith('  - ')), len(lines))
    existing = [lines[i].strip()[2:] for i in range(start + 1, end)]
    added = []
    for ref in NEW_REFS:
        if ref not in existing:
            lines.insert(end, '  - ' + ref)
            end += 1
            added.append(ref)
    open(path, 'w', encoding='utf-8').write('\n'.join(lines))
    return 'ruleRefs 追加 %s' % (added or '无')


for rel in ('assets/dimensions/framework/vllm.yaml', 'assets/dimensions/framework/mindie.yaml'):
    p = os.path.join(ROOT, rel)
    print('%-42s %s | %s' % (rel, edit_probes(p), edit_rule_refs(p)))

# 复读校验：文件必须仍是合法 YAML，且探针数 +1
for rel in ('assets/dimensions/framework/vllm.yaml', 'assets/dimensions/framework/mindie.yaml'):
    p = os.path.join(ROOT, rel)
    doc = yaml.safe_load(open(p, encoding='utf-8'))
    ids = [q['id'] for q in doc['probes']]
    assert 'perf-snapshot' in ids, rel
    assert 'root-causes/output-anomaly-rules.yaml' in doc['ruleRefs'], rel
    print('校验 %-34s probes=%d 末项=%s ruleRefs=%s' % (rel.split('/')[-1], len(ids), ids[-1], doc['ruleRefs']))
