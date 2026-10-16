#!/usr/bin/env bash
# task-06 前置：准备一个待卸载的一次性安装（venv + cowsay）。
set -euo pipefail

TARGET=/tmp/metawork-uninstall-demo

rm -rf "$TARGET"
python3 -m venv "$TARGET"
"$TARGET/bin/pip" install --quiet cowsay

echo "prepared: $TARGET"
"$TARGET/bin/cowsay" -t "uninstall me"
