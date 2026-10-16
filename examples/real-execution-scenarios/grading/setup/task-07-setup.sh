#!/usr/bin/env bash
# task-07 前置：构造损坏的 mytool 环境。
# 结构：bin/mytool（shim，可执行）exec 真身 lib/mytool-real，
# 真身缺少可执行权限 —— 这就是待诊断的根因。
set -euo pipefail

ROOT=/tmp/metawork-case7
rm -rf "$ROOT"
mkdir -p "$ROOT/bin" "$ROOT/lib"

printf '#!/bin/bash\nexec /tmp/metawork-case7/lib/mytool-real\n' > "$ROOT/bin/mytool"
chmod +x "$ROOT/bin/mytool"

printf '#!/usr/bin/env python3\nprint("mytool 1.2.0")\n' > "$ROOT/lib/mytool-real"
# 故意不加执行权限

echo "prepared (broken): $ROOT"
PATH="$ROOT/bin:$PATH" mytool --version || true
