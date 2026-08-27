import type {
	ConversationViewModel,
	MetaWorkStage,
} from "./metawork-client-model.ts";

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
	const workspace = model.activeWorkspace
		? width < 100 ? model.activeWorkspace.displayName : model.activeWorkspace.path
		: "未设置 · 输入 /workspace /absolute/path";
	const lines = [
		`MetaWork  ·  ${connection}  ·  workspace: ${workspace}`,
		...(model.activeWorkspace && width < 100
			? [`完整路径: ${model.activeWorkspace.path}`]
			: []),
		...(model.activeConversationId
			? [`conversation: ${model.activeConversationId}`]
			: ["Workspace home · 使用 /conversations 浏览会话"]),
		"",
		...userMessages.flatMap(message => ["你", message, ""]),
		"任务进度",
		renderStepper(turn?.stage),
	];

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
	lines.push("", `${connection} · ${turn ? turn.status : "idle"} · 输入 /help 查看命令`);
	return lines.join("\n");
}

function renderStepper(active: MetaWorkStage | undefined): string {
	return stages.map(stage => {
		const marker = stage.key === active ? "◉" : active && stages.findIndex(item => item.key === active) > stages.indexOf(stage) ? "●" : "○";
		return `${marker} ${stage.label}`;
	}).join("  ");
}
