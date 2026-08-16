import { type Component, Loader, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type PlannerDashboardConnectionState = "connecting" | "connected" | "stale" | "unavailable";

interface PlannerSubtaskSnapshot {
	id: string;
	title: string;
	status: string;
	preferredAgentClassList: string[];
}

interface PlannerTaskSnapshot {
	id: string;
	title: string;
	goal: string;
	status: string;
	blockingReason: string | null;
	subtasks: PlannerSubtaskSnapshot[];
}

interface PlannerExecutorSnapshot {
	id: string;
	enabled: boolean;
	verification: string;
	driver: string;
	binaryPath: string;
	classHealth: string;
}

interface PlannerSmokeAuditSnapshot {
	runId: string;
	scenario: string;
	result: string;
	completedAt: string;
}

interface PlannerDashboardSnapshot {
	schemaVersion: 1;
	session: {
		focusedTask: { id: string; title: string; status: string } | null;
		runtimeState: {
			runningExecutorName: string | null;
			lastEvent: string | null;
		};
		plannerState: { status: string };
	};
	taskPool: PlannerTaskSnapshot[];
	executorStatuses: PlannerExecutorSnapshot[];
	smokeRunAudits: PlannerSmokeAuditSnapshot[];
}

const MIN_DASHBOARD_WIDTH = 96;
const MEDIUM_DASHBOARD_WIDTH = 34;
const WIDE_DASHBOARD_WIDTH = 42;
const WIDE_LAYOUT_WIDTH = 136;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseSubtask(value: unknown): PlannerSubtaskSnapshot | null {
	if (!isRecord(value)) return null;
	const id = stringValue(value.id);
	const title = stringValue(value.title);
	const status = stringValue(value.status);
	if (!id || !title || !status) return null;
	return {
		id,
		title,
		status,
		preferredAgentClassList: stringArray(value.preferredAgentClassList),
	};
}

function parseTask(value: unknown): PlannerTaskSnapshot | null {
	if (!isRecord(value)) return null;
	const id = stringValue(value.id);
	const title = stringValue(value.title);
	const status = stringValue(value.status);
	if (!id || !title || !status) return null;
	return {
		id,
		title,
		goal: stringValue(value.goal),
		status,
		blockingReason: nullableString(value.blockingReason),
		subtasks: Array.isArray(value.subtasks)
			? value.subtasks.map(parseSubtask).filter((item): item is PlannerSubtaskSnapshot => item !== null)
			: [],
	};
}

function parseExecutor(value: unknown): PlannerExecutorSnapshot | null {
	if (!isRecord(value)) return null;
	const id = stringValue(value.id);
	const classHealth = stringValue(value.classHealth);
	const verification = stringValue(value.verification);
	const driver = stringValue(value.driver);
	const binaryPath = stringValue(value.binaryPath);
	if (!id || !classHealth || !verification || !driver || !binaryPath || typeof value.enabled !== "boolean")
		return null;
	return { id, enabled: value.enabled, verification, driver, binaryPath, classHealth };
}

function parseSmokeAudit(value: unknown): PlannerSmokeAuditSnapshot | null {
	if (!isRecord(value)) return null;
	const runId = stringValue(value.runId);
	const scenario = stringValue(value.scenario);
	const result = stringValue(value.result);
	const completedAt = stringValue(value.completedAt);
	if (!runId || !scenario || !result || !completedAt) return null;
	return { runId, scenario, result, completedAt };
}

export function parsePlannerDashboardSnapshot(value: unknown): PlannerDashboardSnapshot | null {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.session)) return null;
	const session = value.session;
	const focusedTaskValue = session.focusedTask;
	let focusedTask: PlannerDashboardSnapshot["session"]["focusedTask"] = null;
	if (focusedTaskValue !== null && focusedTaskValue !== undefined) {
		if (!isRecord(focusedTaskValue)) return null;
		const id = stringValue(focusedTaskValue.id);
		const title = stringValue(focusedTaskValue.title);
		const status = stringValue(focusedTaskValue.status);
		if (!id || !title || !status) return null;
		focusedTask = { id, title, status };
	}
	const runtimeState = isRecord(session.runtimeState) ? session.runtimeState : {};
	const plannerState = isRecord(session.plannerState) ? session.plannerState : {};
	return {
		schemaVersion: 1,
		session: {
			focusedTask,
			runtimeState: {
				runningExecutorName: nullableString(runtimeState.runningExecutorName),
				lastEvent: nullableString(runtimeState.lastEvent),
			},
			plannerState: { status: stringValue(plannerState.status, "unknown") },
		},
		taskPool: Array.isArray(value.taskPool)
			? value.taskPool.map(parseTask).filter((item): item is PlannerTaskSnapshot => item !== null)
			: [],
		executorStatuses: Array.isArray(value.executorStatuses)
			? value.executorStatuses.map(parseExecutor).filter((item): item is PlannerExecutorSnapshot => item !== null)
			: [],
		smokeRunAudits: Array.isArray(value.smokeRunAudits)
			? value.smokeRunAudits.map(parseSmokeAudit).filter((item): item is PlannerSmokeAuditSnapshot => item !== null)
			: [],
	};
}

function displayStatus(status: string): string {
	return status.replaceAll("_", " ");
}

function statusGlyph(status: string): string {
	if (status === "done" || status === "healthy") return "●";
	if (status === "running" || status === "ready") return "◆";
	if (status === "blocked" || status === "error" || status === "disabled") return "!";
	if (status === "parked" || status === "awaiting_decision" || status === "awaiting_integration") return "◇";
	return "·";
}

function colorStatus(status: string, text: string): string {
	if (status === "done" || status === "healthy") return theme.fg("success", text);
	if (status === "running" || status === "ready") return theme.fg("accent", text);
	if (status === "blocked" || status === "error" || status === "disabled") return theme.fg("warning", text);
	return theme.fg("muted", text);
}

function fitLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(1, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export interface PlannerDashboardSummary {
	connectionState: PlannerDashboardConnectionState;
	plannerStatus: string;
	focusedTask: { title: string; status: string } | null;
	taskCount: number;
	runningExecutorName: string | null;
}

export class AnyFusionTaskDashboardComponent implements Component {
	private connectionState: PlannerDashboardConnectionState = "connecting";
	private snapshot: PlannerDashboardSnapshot | null = null;
	private executionLoader: Loader | undefined;
	private runningExecutorName: string | null = null;
	private readonly ui: TUI;

	constructor(ui: TUI) {
		this.ui = ui;
	}

	setConnectionState(state: PlannerDashboardConnectionState): void {
		this.connectionState = state;
		if (state !== "connected") this.stopExecutionLoader();
	}

	setSnapshot(value: unknown): boolean {
		const snapshot = parsePlannerDashboardSnapshot(value);
		if (!snapshot) {
			this.connectionState = "stale";
			this.stopExecutionLoader();
			return false;
		}
		this.snapshot = snapshot;
		this.connectionState = "connected";
		this.syncExecutionLoader(snapshot.session.runtimeState.runningExecutorName);
		return true;
	}

	dispose(): void {
		this.stopExecutionLoader();
	}

	getSummary(): PlannerDashboardSummary {
		return {
			connectionState: this.connectionState,
			plannerStatus: this.snapshot?.session.plannerState.status ?? "waiting",
			focusedTask: this.snapshot?.session.focusedTask
				? {
						title: this.snapshot.session.focusedTask.title,
						status: this.snapshot.session.focusedTask.status,
					}
				: null,
			taskCount: this.snapshot?.taskPool.length ?? 0,
			runningExecutorName: this.snapshot?.session.runtimeState.runningExecutorName ?? null,
		};
	}

	invalidate(): void {
		// Rendering is derived directly from current snapshot and theme.
	}

	render(width: number): string[] {
		const panelWidth = Math.max(18, width);
		const innerWidth = Math.max(1, panelWidth - 2);
		const content: string[] = [];
		content.push(this.connectionLine());
		if (!this.snapshot) {
			content.push("");
			content.push(
				theme.fg(
					"muted",
					this.connectionState === "connecting"
						? "Waiting for MetaClaw snapshot"
						: "Conversation remains available",
				),
			);
			return this.frame(content, panelWidth, innerWidth);
		}

		const snapshot = this.snapshot;
		const focusedId = snapshot.session.focusedTask?.id ?? null;
		const focusedTask = focusedId ? (snapshot.taskPool.find((task) => task.id === focusedId) ?? null) : null;
		content.push("");
		content.push(theme.bold(theme.fg("accent", "Focused task")));
		if (snapshot.session.focusedTask) {
			content.push(
				colorStatus(
					snapshot.session.focusedTask.status,
					`${statusGlyph(snapshot.session.focusedTask.status)} ${snapshot.session.focusedTask.title}`,
				),
			);
			content.push(theme.fg("muted", `  ${displayStatus(snapshot.session.focusedTask.status)}`));
		} else {
			content.push(theme.fg("muted", "No focused task"));
		}

		if (this.executionLoader) {
			content.push("");
			content.push(theme.bold(theme.fg("accent", "Executing")));
			content.push(...this.executionLoader.render(innerWidth).slice(1));
		}

		if (focusedTask?.blockingReason) {
			content.push(theme.fg("warning", `  Blocked: ${focusedTask.blockingReason}`));
		}
		if (focusedTask?.subtasks.length) {
			content.push(theme.fg("dim", "  Subtasks"));
			for (const subtask of focusedTask.subtasks.slice(0, 6)) {
				const executor = subtask.preferredAgentClassList[0];
				content.push(
					colorStatus(
						subtask.status,
						`  ${statusGlyph(subtask.status)} ${subtask.title}${executor ? ` · ${executor}` : ""}`,
					),
				);
			}
			if (focusedTask.subtasks.length > 6)
				content.push(theme.fg("dim", `  +${focusedTask.subtasks.length - 6} more`));
		}

		content.push("");
		content.push(theme.bold(theme.fg("accent", `Task pool (${snapshot.taskPool.length})`)));
		for (const task of snapshot.taskPool.slice(0, 6)) {
			content.push(
				colorStatus(task.status, `${statusGlyph(task.status)} ${task.title} · ${displayStatus(task.status)}`),
			);
		}
		if (snapshot.taskPool.length > 6) content.push(theme.fg("dim", `+${snapshot.taskPool.length - 6} more tasks`));

		content.push("");
		content.push(theme.bold(theme.fg("accent", "Executors")));
		if (snapshot.executorStatuses.length === 0) {
			content.push(theme.fg("muted", "No executor status yet"));
		} else {
			for (const executor of snapshot.executorStatuses.slice(0, 5)) {
				const status = !executor.enabled
					? "disabled"
					: executor.verification === "verified"
						? executor.classHealth
						: executor.verification;
				content.push(
					colorStatus(
						status,
						`${statusGlyph(status)} ${executor.id} · ${displayStatus(status)} · ${executor.driver}`,
					),
				);
			}
		}
		if (snapshot.smokeRunAudits.length > 0) {
			const latest = snapshot.smokeRunAudits[0]!;
			content.push("");
			content.push(theme.bold(theme.fg("accent", "Latest smoke")));
			content.push(
				colorStatus(
					latest.result === "passed" || latest.result === "success" ? "done" : "error",
					`${statusGlyph(latest.result === "passed" || latest.result === "success" ? "done" : "error")} ${latest.scenario} · ${latest.result}`,
				),
			);
		}
		if (snapshot.session.runtimeState.lastEvent) {
			content.push("");
			content.push(theme.fg("dim", `Last event: ${snapshot.session.runtimeState.lastEvent}`));
		}
		return this.frame(content, panelWidth, innerWidth);
	}

	private connectionLine(): string {
		if (this.connectionState === "connected") return theme.fg("success", "● MetaClaw connected");
		if (this.connectionState === "connecting") return theme.fg("muted", "◇ Connecting to MetaClaw");
		if (this.connectionState === "stale") return theme.fg("warning", "! Snapshot unavailable or stale");
		return theme.fg("warning", "! MetaClaw bridge unavailable");
	}

	private syncExecutionLoader(executorName: string | null): void {
		if (!executorName) {
			this.stopExecutionLoader();
			return;
		}
		if (this.executionLoader && this.runningExecutorName === executorName) return;
		this.stopExecutionLoader();
		this.runningExecutorName = executorName;
		this.executionLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(message) => theme.fg("muted", message),
			`${executorName} 执行中`,
		);
	}

	private stopExecutionLoader(): void {
		this.executionLoader?.stop();
		this.executionLoader = undefined;
		this.runningExecutorName = null;
	}

	private frame(content: string[], width: number, innerWidth: number): string[] {
		const top = theme.fg("borderAccent", `┌─ AnyFusion Tasks ${"─".repeat(Math.max(0, innerWidth - 18))}┐`);
		const bottom = theme.fg("borderMuted", `└${"─".repeat(innerWidth)}┘`);
		const body = content.map(
			(line) => `${theme.fg("borderMuted", "│")}${fitLine(` ${line}`, innerWidth)}${theme.fg("borderMuted", "│")}`,
		);
		return [fitLine(top, width), ...body, fitLine(bottom, width)];
	}
}

export class AnyFusionPlannerWorkspaceComponent implements Component {
	private conversation: Component;
	private dashboard: Component;

	constructor(conversation: Component, dashboard: Component) {
		this.conversation = conversation;
		this.dashboard = dashboard;
	}

	invalidate(): void {
		this.conversation.invalidate();
		this.dashboard.invalidate();
	}

	render(width: number): string[] {
		if (width < MIN_DASHBOARD_WIDTH) return this.conversation.render(width);
		const dashboardWidth = width >= WIDE_LAYOUT_WIDTH ? WIDE_DASHBOARD_WIDTH : MEDIUM_DASHBOARD_WIDTH;
		const dividerWidth = 1;
		const conversationWidth = Math.max(20, width - dashboardWidth - dividerWidth);
		const conversationLines = this.conversation.render(conversationWidth);
		const dashboardLines = this.dashboard.render(dashboardWidth);
		const lineCount = Math.max(conversationLines.length, dashboardLines.length);
		const dashboardOffset = Math.max(0, lineCount - dashboardLines.length);
		const divider = theme.fg("borderMuted", "│");
		const output: string[] = [];
		for (let index = 0; index < lineCount; index += 1) {
			const left = fitLine(conversationLines[index] ?? "", conversationWidth);
			const dashboardIndex = index - dashboardOffset;
			const right = fitLine(dashboardIndex >= 0 ? (dashboardLines[dashboardIndex] ?? "") : "", dashboardWidth);
			output.push(`${left}${divider}${right}`);
		}
		return output;
	}
}
