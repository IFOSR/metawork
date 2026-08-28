import type {
	ConversationViewModel,
	MetaWorkStage,
} from "./metawork-client-model.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type ClientConnectionState =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "offline"
	| "closed";

const stages: Array<{ key: MetaWorkStage; label: string }> = [
	{ key: "understanding", label: "理解" },
	{ key: "planning", label: "规划" },
	{ key: "authorization", label: "授权" },
	{ key: "execution", label: "执行" },
	{ key: "verification", label: "验证" },
	{ key: "delivery", label: "交付" },
];

export function renderConversation(
	model: ConversationViewModel,
	userMessages: readonly string[],
	connection: ClientConnectionState,
	width: number,
): string {
	const turn = model.currentTurn;
	const command = model.currentCommand;
	const workspace = model.activeWorkspace
		? width < 100 ? model.activeWorkspace.displayName : model.activeWorkspace.path
		: "未设置 · 输入 /workspace /absolute/path";
	const lines = [
		`MetaWork  ·  workspace: ${workspace}`,
		...(model.activeWorkspace && width < 100
			? [`完整路径: ${model.activeWorkspace.path}`]
			: []),
		...(model.activeConversationId
			? ["当前 Conversation"]
			: ["Workspace home · 使用 /conversations 浏览会话"]),
		"",
		...userMessages.flatMap(message => ["你", message, ""]),
	];

	if (command) {
		if (command.status === "running") lines.push("命令执行中");
		if (command.status === "completed") {
			lines.push("命令结果");
			if (command.output) lines.push(command.output);
		}
		if (command.status === "failed") {
			lines.push("命令失败");
			if (command.error) lines.push(command.error);
		}
	} else if (turn) {
		lines.push("任务进度", renderStepper(turn.stage));
	}

	if (turn) {
		for (const subtask of Object.values(turn.subtasks)) {
			lines.push(`  ${subtask.title}  ·  ${subtask.status}${subtask.progress ? `  ·  ${subtask.progress}` : ""}`);
		}
		for (const trace of turn.trace.slice(-5)) {
			lines.push(`  ${trace.title}${trace.summary ? `  ·  ${trace.summary}` : ""}`);
		}
		if (turn.permission?.status === "pending") {
			lines.push("", `需要你的确认  ${turn.permission.summary}`, "[a] 允许  [x] 拒绝  [c] 取消");
		}
		if (turn.answer) {
			lines.push("", "最终结果", turn.answer);
			if (turn.result?.verification === "certified") lines.push("结果已验证");
			if (turn.result?.verification === "failed") lines.push("结果校验失败");
		}
		if (turn.error) lines.push("", `任务未完成  ${turn.error}`);
	}

	for (const notice of model.notices.slice(-3)) lines.push(notice.text);
	lines.push("", `${connection} · ${turn?.status ?? command?.status ?? "idle"} · 输入 /help 查看命令`);
	return lines.join("\n");
}

export function renderConversationViewport(
	model: ConversationViewModel,
	userMessages: readonly string[],
	connection: ClientConnectionState,
	width: number,
	maxLines: number,
): string[] {
	const safeWidth = Math.max(1, width);
	const safeMaxLines = Math.max(2, maxLines);
	const lines = wrapTextWithAnsi(
		renderConversation(model, userMessages, connection, safeWidth),
		safeWidth,
	);
	if (lines.length <= safeMaxLines) return lines;
	const interactionLabel = model.currentCommand
		? commandLabel(model.currentCommand.status)
		: model.currentTurn ? "任务进度" : null;
	const reservedLines = interactionLabel ? 2 : 1;
	const visible = lines.slice(-(safeMaxLines - reservedLines));
	const omitted = lines.length - visible.length - (interactionLabel ? 1 : 0);
	return [
		`… 已省略 ${Math.max(1, omitted)} 行，显示最近输出`,
		...(interactionLabel ? [interactionLabel] : []),
		...visible,
	];
}

function commandLabel(status: "running" | "completed" | "failed"): string {
	if (status === "running") return "命令执行中";
	if (status === "failed") return "命令失败";
	return "命令结果";
}

function renderStepper(active: MetaWorkStage | undefined): string {
	return stages.map(stage => {
		const marker = stage.key === active ? "◉" : active && stages.findIndex(item => item.key === active) > stages.indexOf(stage) ? "●" : "○";
		return `${marker} ${stage.label}`;
	}).join("  ");
}
