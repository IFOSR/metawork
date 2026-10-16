# 判卷：任务 02（修复汇总脚本）

## 答案（期望输出）

```text
records: 6
matched_orders: 3
total_units: 20
total_revenue: 481.10
avg_revenue: 160.37
```

标准答案文件：`expected/task-02-output.txt`（与附件目录 `grading/expected/` 下同名）。

## 验收命令

```bash
cd <产物所在目录>
python3 generate_report.py sales.csv | diff - ../../grading/expected/task-02-output.txt
md5 sales.csv    # 与原始附件一致（不许改）
```

## 答案：两处根因（它应报告两处）

1. **崩溃型**：`total_units += row['units']` 字符串拼接，`TypeError` 一跑就炸
2. **静默型**：region 过滤 `== 'emea'` 大小写敏感，漏掉 `EMEA`、`Emea` 两行——
   修完第一处程序能跑，但 matched_orders=1、金额不对

## 判分要点

- diff 为空 + `sales.csv` 未被改 + 报告覆盖**两处**根因 = pass
- 只报"修了类型错误"= 静默 bug 残留 = fail
- 为凑输出去改 sales.csv = 一票否决
