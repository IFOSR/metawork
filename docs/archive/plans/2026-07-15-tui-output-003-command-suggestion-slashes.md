# TUI-OUTPUT-003：统一命令建议的斜杠层级

- 状态：completed
- 计划日期：2026-07-15
- 完成日期：2026-07-15
- 实施提交：本计划的 closing commit

## 目标

- 由 `CommandCatalog` 统一产出 command-node suggestion 的展示 label 和 Tab replacement。
- 只有根级 command token 带 `/`；二级及更深层 group、action、参数和动态候选都不带 `/`。
- 保持 command tree、解析、帮助、参数校验和执行语义不变。

## 实现决策

- `CommandCatalog.nodeSuggestion()` 以 replacement 是否从索引 `0` 开始作为唯一根级判断，并保证 command-node suggestion 的 label 与 replacement text 一致。
- `CommandSuggestion` 类型保持不变；动态引用候选仍可使用人类可读 label。
- TUI 删除自有的斜杠推断 formatter，直接渲染 Catalog 输出的 label。
- 不注册 `/register`、`/patch` alias，不改变 nested group fallback action 或 `/help` command-path 补全。

## 测试与验证

- Catalog 契约覆盖根 group/action、nested group/action、更深节点以及根/嵌套 typo replacement。
- 真实默认 Catalog 覆盖 `/executor `、`/learning `、`/executor register ` 与非法根命令。
- Ink TUI 覆盖根级展示、nested group 展示与 Tab 写入。
- 运行 `npm run lint`、`npm run build`、Docker focused tests、Docker 测试镜像构建和 Docker 全量测试。

## 完成记录

- `CommandCatalog` 现以 replacement 起点作为 command-node suggestion 的唯一根级判断，label 与 replacement text 使用同一规范化 token。
- 根级 group/action 统一带 `/`；nested group/action 以及更深节点统一不带 `/`，包括 `register`、`patch`、`wizard` 和 `approve`。
- TUI 已删除重复的 `formatCommandSuggestionLabel()`，命令菜单直接渲染 Catalog label，Tab 继续应用同一 suggestion 的 replacement。
- `/register` 和 `/patch` 仍不是根命令；command tree、fallback action、帮助和执行语义未改变。

验证结果：

- TDD tracer bullet：确认旧实现对根 action `config` 产出错误 label，修复后通过。
- Docker focused regression：3 个文件、38 个测试通过。
- `npm run lint`：通过。
- `npm run build`：通过。
- `docker build -f Dockerfile.test -t metaclaw-test .`：通过。
- `docker run --rm metaclaw-test`：172 个测试文件通过、2 个跳过；760 个测试通过、4 个跳过。
- 未重启当前 `metaclaw-shell`；新镜像部署后可再做 SSH TUI 实机复查。
