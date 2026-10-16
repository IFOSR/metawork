# 判卷：任务 03（重构保行为）

## 答案（官方基线，重构后输出必须逐字一致）

- `expected/task-03-sample.txt` — 对 sample.log
- `expected/task-03-second.txt` — 对 second_input.log

## 验收命令

```bash
cd <产物所在目录>
node stats.cjs sample.log       | diff - ../../grading/expected/task-03-sample.txt
node stats.cjs second_input.log | diff - ../../grading/expected/task-03-second.txt
test -f stat_lib.cjs && echo lib-ok
grep -nE '\bvar\b' stats.cjs stat_lib.cjs || echo no-var
```

## 判分要点

- **两个输入都必须过**。second_input 的词频并列、空行、行号边界与 sample
  不同，硬编码第一组输出必然在第二组翻车
- `stat_lib.cjs` 真的是可复用纯函数，不是换个文件的同一坨（抽查）
- 它是否自己先跑了原版记基线（题目有此要求，不做说明过程不完整，酌情记）
- 改了行为（空行统计、排序、末尾空元素）= fail
