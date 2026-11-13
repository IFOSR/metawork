# Executor Pi 打包入口修复

- 日期 / 本地完成日期：2026-10-23
- 状态：本地修复、DMG 构建及自动验收完成；等待用户安装验证
- 关闭提交：未提交；未发布远端 Release

## 根因与交付

本地测试包的 `desktop-tools/executor/bin/pi` 错误转发到定制
`planner/packages/coding-agent/dist/cli.js`。普通 Executor 的 Provider/Model
参数因此被 Planner 策略拒绝。两个组件应独立；不修改 Planner 的限制。

新包从本机普通 Pi Agent 1.4.0 的安装发行目录复制程序与依赖，不复制个人
配置、凭据或会话。Executor 启动器使用随包 Node 和独立 Executor 程序。
Desktop 仍按现有受管理 Pi 契约运行，不改成依赖客户全局 PATH。

工具准备及 Runtime 打包阶段增加真实 CLI 参数验证：JSON、无会话、工具选择、
Provider、Model 与 help 必须可用；错误 Planner 启动器被拒绝。
安装 smoke 同样验证部署后的 Executor 入口。

## 验证及边界

- 主项目及 Desktop TypeScript 检查通过。
- Desktop 10 个测试文件、26 个测试通过，包括错误入口拒绝回归。
- Server/Web、Planner offline、Desktop 构建通过。
- 真实错误启动器被新打包检查拒绝；修复后的产物检查通过。
- 独立 HOME 和受限 PATH 下干净安装、设置激活、菜单、认证 Web 与
  Desktop 退出后的 Server 存活 smoke 通过。
- 使用打包资源中的 Node/Pi 与本地模拟 OpenAI-compatible 服务运行
  `executor-runtime-parity.test.ts`：真实 Pi 进程及 MetaWork adapter
  的文件读写、命令、回环 HTTP、结果通道与配置篡改拒绝通过（1 例）。
  其余协议用例未执行；没有付费模型或完整用户任务验收。
- DMG `hdiutil verify` 通过。

## 本地产物

- 文件：`apps/desktop/release/MetaWork-darwin-arm64-pi-executor-fix.dmg`
- Desktop：0.1.19
- Release ID：`0.1.19-internal-task-slot-fix-20261023-pi-executor-fix2`
- 字节数：369410369
- SHA-256：`e95368217aecf73d9dc99656434cc7c94ef8810e20c0f8bb11fb97a7c51362e7`
- 内部开发签名；用户尚未安装验收，不代表公开发布。
