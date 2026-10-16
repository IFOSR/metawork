# 判卷：任务 11（分页爬取）

## 答案

共 3 页、8 条，sku 为 S-101…S-108（fixture `page.html` 内置数据）。

## 验收命令

```bash
python3 - <<'EOF'
import json
rows = json.load(open("items.json"))
assert len(rows) == 8, f"expect 8, got {len(rows)}"
skus = [r["sku"] for r in rows]
assert len(set(skus)) == 8, f"duplicates: {skus}"
assert set(skus) == {f"S-1{i:02d}" for i in range(1, 9)}
assert next(r for r in rows if r["sku"] == "S-108")["qty"] == 5   # 第三页只有 2 条
print("task-11 PASS")
EOF
```

## 判分要点

- 漏第三页（只有 2 条的那页）= 翻页终止条件错 = fail
- 条目重复 = fail
- 硬编码 `page=1..3` 碰巧全对：结果记 pass，但要求它在 stats.md 里写明
  翻页方式；自述"跟随下一页链接"而实际硬编码的，发现即降级备注
