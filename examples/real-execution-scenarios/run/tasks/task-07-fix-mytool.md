# 任务 07：修复损坏的命令

本机 `/tmp/metawork-case7/bin/mytool` 运行 `mytool --version` 会失败
（执行时 PATH 需包含 `/tmp/metawork-case7/bin`）。

要求：

1. **先查明真实根因并记录下来**，再动手修
2. 只做最小修复，不许推倒重写
3. 修好的标准：`mytool --version` 输出 `mytool 1.2.0`
