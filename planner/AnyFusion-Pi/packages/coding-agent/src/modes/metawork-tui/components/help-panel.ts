/**
 * MetaWork TUI 帮助面板：显示实际终端可识别的绑定，不显示未实现的能力。
 */

import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../../interactive/theme/theme.ts";

export const METAWORK_TUI_KEY_HELP: ReadonlyArray<{ keys: string; effect: string }> = [
	{ keys: "Enter", effect: "提交消息或斜杠命令" },
	{ keys: "\\ + Enter", effect: "换行（多行输入）" },
	{ keys: "Tab", effect: "编辑器内补全候选" },
	{ keys: "Escape", effect: "关闭候选/弹层（不取消 Server 工作）" },
	{ keys: "Ctrl+C / Ctrl+D", effect: "退出客户端（不取消 Server 工作）" },
	{ keys: "F1", effect: "本帮助" },
	{ keys: "F4", effect: "权限面板（a 允许 / x 拒绝）" },
	{ keys: "F5", effect: "加载更早的历史 Turn" },
	{ keys: "F6", effect: "Task 面板焦点" },
	{ keys: "F7 / F8", effect: "选择上一个 / 下一个 Turn" },
	{ keys: "F9", effect: "展开 / 收起过程与产物" },
	{ keys: "PgUp / PgDn", effect: "滚动对话和执行详情（保留编辑器焦点）" },
	{ keys: "鼠标滚轮 / 触控板", effect: "上下滚动对话和执行结果" },
	{ keys: "Fn+↑ / Fn+↓", effect: "Mac 键盘翻页；也支持 Shift+PgUp/PgDn" },
	{ keys: "/workspace <path>", effect: "选择 Workspace" },
	{ keys: "/conversations", effect: "打开会话目录（Enter 选择 / n 新建）" },
	{ keys: "/cancel", effect: "请求取消当前 Turn（以服务端状态为准）" },
];

export class MetaWorkHelpPanel implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [
			truncateToWidth(theme.fg("accent", theme.bold("MetaWork 快捷键")), safeWidth),
			truncateToWidth(theme.fg("dim", "业务操作一律提交 Gateway；本地键位只控制界面"), safeWidth),
			"",
		];
		for (const item of METAWORK_TUI_KEY_HELP) {
			lines.push(truncateToWidth(
				`  ${theme.fg("text", item.keys.padEnd(16))} ${theme.fg("dim", item.effect)}`,
				safeWidth,
			));
		}
		lines.push("");
		lines.push(truncateToWidth(theme.fg("dim", "Esc 或 F1 关闭"), safeWidth));
		return lines;
	}
}
