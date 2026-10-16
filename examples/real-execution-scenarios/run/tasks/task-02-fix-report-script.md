# 任务 02：修复汇总脚本

附件：`attachments/task-02/generate_report.py`、`attachments/task-02/sales.csv`

当前运行 `python3 generate_report.py sales.csv` 会直接报错。请修复脚本，
使输出符合以下规格：

- 共 5 行，每行格式为 `键: 值`，依次为：
  `records`、`matched_orders`、`total_units`、`total_revenue`、`avg_revenue`
- `records`：CSV 总行数
- `matched_orders`：date 在 2024-01 内且 region 为 emea 的订单数
  （region 匹配不分大小写）
- `total_units`：这些订单的 units 之和（整数）
- `total_revenue`：这些订单的 revenue 之和，保留两位小数
- `avg_revenue`：total_revenue / matched_orders，保留两位小数

约束：

- `sales.csv` 一个字节都不许改
- 只做修复，不许推倒重写成硬编码输出
- 修完自己运行，确认输出与规格一致
