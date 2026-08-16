import { basename } from "node:path";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import type { PlannerDashboardSummary } from "./anyfusion-task-dashboard.ts";

const PIXEL_LOGO = [
	" ███  █   █ █   █ █████ █   █  ███  █████  ███  █   █",
	"█   █ ██  █  █ █  █     █   █ █       █   █   █ ██  █",
	"█████ █ █ █   █   ████  █   █  ███    █   █   █ █ █ █",
	"█   █ █  ██   █   █     █   █     █   █   █   █ █  ██",
	"█   █ █   █   █   █      ███   ███    █    ███  █   █",
];

export interface AnyFusionWelcomeOptions {
	version: string;
	getWorkspace: () => string;
	getModel: () => string;
	getDashboardSummary: () => PlannerDashboardSummary;
	compactInstructions: string;
	expandedInstructions: string;
	onboarding: string;
	expanded?: boolean;
}

function connectionLabel(state: PlannerDashboardSummary["connectionState"]): string {
	if (state === "connected") return theme.fg("success", "● MetaClaw connected");
	if (state === "connecting") return theme.fg("muted", "◇ MetaClaw connecting");
	if (state === "stale") return theme.fg("warning", "! MetaClaw snapshot stale");
	return theme.fg("warning", "! MetaClaw unavailable");
}

function clipped(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "");
}

export class AnyFusionWelcomeComponent implements Component {
	private readonly options: AnyFusionWelcomeOptions;
	private expanded: boolean;

	constructor(options: AnyFusionWelcomeOptions) {
		this.options = options;
		this.expanded = options.expanded ?? false;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {
		// Rendering is derived from current Planner/dashboard state and theme.
	}

	render(width: number): string[] {
		const summary = this.options.getDashboardSummary();
		const lines: string[] = [];
		if (width >= 68) {
			for (const row of PIXEL_LOGO) lines.push(theme.bold(theme.fg("accent", row)));
		} else {
			lines.push(theme.bold(theme.fg("accent", "◆ ANYFUSION")));
		}
		lines.push(
			`${theme.bold("Planner")} ${theme.fg("dim", `v${this.options.version}`)}  ${connectionLabel(summary.connectionState)}`,
		);
		lines.push(
			theme.fg(
				"muted",
				`${basename(this.options.getWorkspace())} · ${this.options.getModel()} · planner ${summary.plannerStatus}`,
			),
		);
		const focus = summary.focusedTask
			? `${summary.focusedTask.title} · ${summary.focusedTask.status}`
			: "no focused task";
		const executor = summary.runningExecutorName ? ` · executor ${summary.runningExecutorName}` : "";
		lines.push(theme.fg("dim", `Tasks ${summary.taskCount} · ${focus}${executor}`));
		lines.push("");
		lines.push(...(this.expanded ? this.options.expandedInstructions : this.options.compactInstructions).split("\n"));
		if (this.expanded) {
			lines.push("");
			lines.push(theme.fg("dim", this.options.onboarding));
		}
		return lines.map((line) => clipped(line, width));
	}
}
