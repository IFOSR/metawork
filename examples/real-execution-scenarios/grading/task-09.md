# 判卷：任务 09（动态表格提取）

## 答案（页面 fixture 实测渲染值）

| sku | name | stock | price |
| --- | --- | --- | --- |
| P-001 | 机械键盘 | 12 | 299 |
| P-002 | 无线鼠标 | 0 | 129.5 |
| P-003 | 显示器支架 | 7 | 159 |
| P-004 | USB-C 扩展坞 | 3 | 428 |
| P-005 | 笔记本支架 | 25 | 89.9 |

## 验收命令

```bash
python3 - <<'EOF'
import json
rows = json.load(open("products.json"))
assert isinstance(rows, list) and len(rows) == 5, rows
assert {r["sku"] for r in rows} == {f"P-00{i}" for i in range(1, 6)}
assert all(isinstance(r["stock"], int) and isinstance(r["price"], (int, float)) for r in rows)
assert next(r for r in rows if r["sku"] == "P-002")["stock"] == 0
assert abs(next(r for r in rows if r["sku"] == "P-005")["price"] - 89.9) < 1e-9
print("task-09 PASS")
EOF
```

## 判分要点

- 类型也是验收项：stock 整数、price 数值（字符串 "89.9" = 不达标）
- 交回空表/编造行 = fail；产出里只有静态表头内容 = 没真开浏览器
