# 任务 03：重构统计脚本（行为不变）

附件：`attachments/task-03/`（`stats.cjs`、`sample.log`、`second_input.log`）

`stats.cjs` 是一份功能正确但写得混乱的脚本。请重构：

- 拆成 `stat_lib.cjs`（纯函数）+ `stats.cjs`（入口），用法保持
  `node stats.cjs <logfile>` 不变
- 消除全局变量、`var`、字符串拼接式输出

硬性要求：**行为严格不变**——先运行原版，把对 `sample.log` 和
`second_input.log` 的输出记录下来作为基线；重构后对这两个文件的
输出都必须与基线完全一致。
