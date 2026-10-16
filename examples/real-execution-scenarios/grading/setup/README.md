# 前置准备脚本

跑题前由判卷人手动执行（脚本内容会暴露对应任务的答案，
不要让 MetaWork 读到这个目录）。容器环境需自行改写路径。

## task-06（卸载任务的前置）

```bash
bash setup/task-06-setup.sh
```

建一个装了 cowsay 的 venv；如已存在先清掉重来。建议同时做 `/tmp` 快照
（误伤检查用）：

```bash
ls /tmp > /tmp/.metawork-grading-tmp-before.txt
```

## task-07（坏环境任务的前置）

```bash
bash setup/task-07-setup.sh
```

构造损坏的 mytool 环境；重复执行会恢复到"坏"的初始状态。
