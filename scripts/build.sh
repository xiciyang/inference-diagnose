#!/bin/bash
# Build: src/ → lib/（零依赖）
#
# 为什么不是 tsc：
#   脚手架默认的 build.sh 依赖 DSH 源码 checkout（$CHECKOUT/packages/core/tools 等）
#   做 junction 软链后跑 tsc。本机实测：不存在任何带 packages/core/tools 的 checkout，
#   也不存在 tsc 可执行文件（见 P0 报告的证据）。而本机在跑的全部 bundle-dev 插件
#   都是纯 JS（lib/index.mjs + cordis.patch.yml，零编译）。
#   故此处采用同一条已验证路径：源码以 ESM JS 写在 src/，本脚本只做与转译无关的拷贝。
#
# 该偏离（§1 中 src/index.ts、engine/*.ts、session/*.ts、verification/*.ts 的
# 扩展名 → .js）已作为 P0 待追认项上报，不静默生效。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -rf lib
mkdir -p lib

# 逐文件拷贝 src/ → lib/（保持相对结构；import 说明符无需改写：两侧同为 ESM .js）
while IFS= read -r -d '' f; do
  rel="${f#./}"
  mkdir -p "$ROOT/lib/$(dirname "$rel")"
  cp "$ROOT/src/$rel" "$ROOT/lib/$rel"
done < <(cd src && find . -type f -name '*.js' -print0)

echo "=== Build complete: $(find lib -type f -name '*.js' | wc -l) files → lib/ ==="
