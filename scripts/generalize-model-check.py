#!/usr/bin/env python3
# 把 loop-controller-model.py 泛化为 machine-check.py（2026-09-28）：
#   - 机器路径/标签/文档锚点/哈希键 全部由 CLI 传入
#   - 错误码闭集改为「从插件 envelope.js 取真源」+「跨机器并集校验」，不再硬编码重复一份
#   - A3 副作用配对的事件名由 YAML 的 a3_pair 给定（B 的回填事件不是 PASTE_REPORT）
# 用法：python3 scripts/generalize-model-check.py
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.join(os.path.expanduser("~"), "deepseek_harness", "docs", "superpowers", "specs", "model-check")
SRC = os.path.join(SPEC, "loop-controller-model.py")
DST = os.path.join(SPEC, "machine-check.py")

src = open(SRC, encoding="utf-8").read()

# ── A. 头部：CLI 参数 ──
old_head = '''HERE = os.path.dirname(os.path.abspath(__file__))'''
new_head = '''import argparse

_ap = argparse.ArgumentParser(description="通用状态机机械检查器（守卫真源 = --machine 指向的 YAML）")
_ap.add_argument("--machine", required=True, help="状态机 YAML（单一真源）")
_ap.add_argument("--label", required=True, help="机器标签（输出用）")
_ap.add_argument("--hash-key", default="machineHash", help="设计文档里记录该机器 sha256 的键名")
_ap.add_argument("--table-start", default="**转移表（", help="设计文档转移表起始行前缀")
_ap.add_argument("--table-end", default="**完备性约定", help="设计文档转移表结束行前缀")
_ap.add_argument("--union-machine", action="append", default=[], help="参与错误码并集校验的其它机器 YAML（可重复）")
_ARGS = _ap.parse_args()

HERE = os.path.dirname(os.path.abspath(__file__))'''
assert old_head in src
src = src.replace(old_head, new_head, 1)

# ── B. 机器路径参数化 ──
old_path = '''YAML_PATH = os.path.join(os.path.expanduser("~"), ".dsh", "bundle-dev",
                         "inference-diagnose", "model", "loop-controller.machine.yaml")'''
assert old_path in src
src = src.replace(old_path, 'YAML_PATH = os.path.abspath(_ARGS.machine)', 1)

# ── C. 哈希键参数化 ──
old_hash = """_m = re.search(r'machineHash:\\s*"(sha256:[0-9a-f]{64})"', _doc_txt)"""
assert old_hash in src, "hash regexp not found"
src = src.replace(
    old_hash,
    """_m = re.search(_ARGS.hash_key + r':\\s*"(sha256:[0-9a-f]{64})"', _doc_txt)""",
    1)
src = src.replace('"single source: doc-recorded machineHash matches actual',
                  '"single source: doc-recorded %s matches actual' % "%s", 1)
src = src.replace('      % (bool(_m) and _m.group(1) == _actual,',
                  '      % (_ARGS.hash_key, bool(_m) and _m.group(1) == _actual,', 1)

# ── D. 错误码闭集：从 envelope.js 取真源 + 并集校验 ──
old_err = src[src.index("CONTRACT_ERR = ["):src.index("# --------------------------------------------------- C0 文档 × YAML 交叉验证")]
new_err = '''ENVELOPE = os.path.join(os.path.expanduser("~"), ".dsh", "bundle-dev", "inference-diagnose",
                        "src", "protocol", "envelope.js")
if not os.path.exists(ENVELOPE):
    print("FAIL: 插件信封缺失，无法取得错误码闭集真源：%s" % ENVELOPE)
    sys.exit(1)
_closed = sorted(set(re.findall(r"'((?:ERR_[A-Z_]+))'", open(ENVELOPE, encoding="utf-8").read())))
yaml_err = sorted(e for e in EVENTS if e.startswith("ERR_"))
extra = sorted(set(yaml_err) - set(_closed))
check(not extra,
      "S5 closed event set (%s): %d/%d codes declared; outside-closed-set=%s"
      % (_ARGS.label, len(yaml_err), len(_closed), extra or "none"))

# 跨机器并集：闭集里每个码都必须至少被一台机器建模（否则是"漏建模"，不是"没用到"）
UNION = set(yaml_err)
for p in _ARGS.union_machine:
    _other = yaml.safe_load(open(os.path.abspath(p), encoding="utf-8"))
    UNION |= set(e for e in _other["events"] if e.startswith("ERR_"))
check(UNION == set(_closed),
      "S5 error-scope union across machines == envelope closed set: union=%d closed=%d missing=%s unknown=%s"
      % (len(UNION), len(_closed), sorted(set(_closed) - UNION) or "none", sorted(UNION - set(_closed)) or "none"))

'''
src = src.replace(old_err, new_err, 1)

# ── E. A3 副作用配对：事件名取自 YAML ──
src = src.replace('pair = ["PASTE_REPORT", "EXIT"]',
                  'pair = M.get("a3_pair", ["PASTE_REPORT", "EXIT"])', 1)
src = src.replace('    if (s, "PASTE_REPORT") not in T:',
                  '    if (s, pair[0]) not in T:', 1)
src = src.replace('"A3 side-effect pair (PASTE_REPORT,EXIT): terminal-identical (invariant-check not claimed)"',
                  '"A3 side-effect pair (%s): terminal-identical (invariant-check not claimed)" % ",".join(pair)', 1)

# ── F. 文档转移表锚点参数化 ──
src = src.replace('start = next((i for i, l in enumerate(lines) if l.startswith("**转移表（")), None)',
                  'start = next((i for i, l in enumerate(lines) if l.startswith(_ARGS.table_start)), None)', 1)
src = src.replace('end = next((i for i, l in enumerate(lines) if l.startswith("**完备性约定")), None)',
                  'end = next((i for i, l in enumerate(lines) if l.startswith(_ARGS.table_end)), None)', 1)

# ── G. 输出标签 ──
src = src.replace('print("=== loop-controller model check (guards from loop-controller.machine.yaml) ===")',
                  'print("=== %s model check (guards from %s) ===" % (_ARGS.label, os.path.basename(YAML_PATH)))', 1)
src = src.replace('''print("source=%s" % os.path.relpath(YAML_PATH, os.path.dirname(HERE)))''',
                  '''print("source=%s" % os.path.relpath(YAML_PATH, os.path.dirname(HERE)))''', 1)
src = src.replace('print("REFUSED@<origin> RETRY 出边（追问 1 取证）：")',
                  'print("%s@<origin> RETRY 出边（追问 1 取证）：" % PARAM["prefix"])', 1)
src = src.replace('print("计数口径（澄清 255 / 51 / %d）：" % triples_total)',
                  'print("计数口径（%s）：" % _ARGS.label)', 1)

open(DST, "w", encoding="utf-8").write(src)
print("written %s (%d lines)" % (DST, src.count("\n") + 1))
