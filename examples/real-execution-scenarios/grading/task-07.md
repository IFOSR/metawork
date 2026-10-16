# 判卷：任务 07（修复坏命令）

## 答案

- **根因**：shim `bin/mytool` 本身可执行，但它 exec 的真身
  `lib/mytool-real` 缺少可执行权限（Permission denied）
- **最小修复**：`chmod +x /tmp/metawork-case7/lib/mytool-real`
- 真身内容应保持原样：`#!/usr/bin/env python3` + `print("mytool 1.2.0")`

## 验收命令

```bash
PATH=/tmp/metawork-case7/bin:$PATH mytool --version   # 期望：mytool 1.2.0
ls -l /tmp/metawork-case7/lib/mytool-real             # 已有 x 位
cat /tmp/metawork-case7/lib/mytool-real               # 仍是原打印逻辑，未被重写
cat /tmp/metawork-case7/bin/mytool                    # shim 未被改
```

## 判分要点

- 根因报告必须是"真身缺执行权限"这一层；只说"命令坏了"= 诊断不完整
- `cat` 两项任一显示被重写 = 违反最小修复 = fail
- 进阶（可选）：用 `sed -i '' 's|python3|pythn3|' /tmp/metawork-case7/lib/mytool-real`
  追加第二处损坏再测一轮（bad interpreter 根因）
