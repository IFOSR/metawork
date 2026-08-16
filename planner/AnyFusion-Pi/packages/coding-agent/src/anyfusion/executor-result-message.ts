import type { ExecutorResultNotification } from "./planner-host-client.ts";

export const ANYFUSION_EXECUTOR_RESULT_CUSTOM_TYPE = "anyfusion-executor-result";

export interface ExecutorResultMessageDetails {
	schemaVersion: 1;
	publicationId: string;
	completedAt: string;
	taskId: string;
	subtaskId: string;
	attemptId: string;
	executorName: string;
}

export class AnyFusionExecutorResultInbox {
	private readonly pending: ExecutorResultNotification[] = [];
	private readonly queuedPublicationIds = new Set<string>();
	private readonly displayedPublicationIds = new Set<string>();
	private flushing = false;
	private readonly deps: {
		isBusy(): boolean;
		deliver(result: ExecutorResultNotification): Promise<void>;
		onError(error: unknown): void;
	};

	constructor(deps: {
		isBusy(): boolean;
		deliver(result: ExecutorResultNotification): Promise<void>;
		onError(error: unknown): void;
	}) {
		this.deps = deps;
	}

	seed(publicationIds: Iterable<string>): void {
		this.displayedPublicationIds.clear();
		for (const publicationId of publicationIds) this.displayedPublicationIds.add(publicationId);
	}

	enqueue(result: ExecutorResultNotification): boolean {
		if (
			this.displayedPublicationIds.has(result.publicationId) ||
			this.queuedPublicationIds.has(result.publicationId)
		) {
			return false;
		}
		this.pending.push(result);
		this.queuedPublicationIds.add(result.publicationId);
		void this.flush();
		return true;
	}

	async flush(): Promise<void> {
		if (this.flushing || this.deps.isBusy()) return;
		this.flushing = true;
		try {
			while (this.pending.length > 0) {
				if (this.deps.isBusy()) return;
				const result = this.pending[0]!;
				if (this.displayedPublicationIds.has(result.publicationId)) {
					this.removeFirst(result.publicationId);
					continue;
				}
				try {
					await this.deps.deliver(result);
				} catch (error) {
					this.deps.onError(error);
					return;
				}
				this.removeFirst(result.publicationId);
				this.displayedPublicationIds.add(result.publicationId);
			}
		} finally {
			this.flushing = false;
		}
	}

	private removeFirst(publicationId: string): void {
		this.pending.shift();
		this.queuedPublicationIds.delete(publicationId);
	}
}

export function executorResultDetails(result: ExecutorResultNotification): ExecutorResultMessageDetails {
	return {
		schemaVersion: 1,
		publicationId: result.publicationId,
		completedAt: result.completedAt,
		taskId: result.taskId,
		subtaskId: result.subtaskId,
		attemptId: result.attemptId,
		executorName: result.executorName,
	};
}

export function formatExecutorResultMessage(result: ExecutorResultNotification): string {
	const lines = [
		`## Executor result: ${result.subtaskTitle}`,
		"",
		`- **Executor:** ${inlineCode(result.executorName)}`,
		`- **Task:** ${escapeMarkdown(result.taskTitle)} (${inlineCode(result.taskId)})`,
		`- **Subtask:** ${escapeMarkdown(result.subtaskTitle)} (${inlineCode(result.subtaskId)})`,
		`- **Attempt:** ${inlineCode(result.attemptId)}`,
		`- **Integrated commit:** ${result.integrationCommit ? inlineCode(result.integrationCommit) : "Unavailable"}`,
		"",
		"### Summary",
		"",
		result.report.trim() || "Executor did not provide a human-readable summary.",
	];
	if (result.warnings.length > 0) {
		lines.push("", "### Warnings", "", ...result.warnings.map((warning) => `- ${escapeMarkdown(warning)}`));
	}
	lines.push("", "### Result files", "");
	if (result.artifacts.length === 0) {
		lines.push("No result files were reported.");
	} else {
		lines.push(...result.artifacts.map((artifact) => `- ${inlineCode(artifact)}`));
	}
	return lines.join("\n");
}

export function publicationIdFromCustomEntry(value: unknown): string | null {
	if (!isRecord(value) || value.type !== "custom_message") return null;
	if (value.customType !== ANYFUSION_EXECUTOR_RESULT_CUSTOM_TYPE || !isRecord(value.details)) return null;
	return typeof value.details.publicationId === "string" && value.details.publicationId
		? value.details.publicationId
		: null;
}

function inlineCode(value: string): string {
	return `\`${value.replaceAll("`", "\\`")}\``;
}

function escapeMarkdown(value: string): string {
	return value.replace(/([\\`*_{}[\]()#+.!|>-])/g, "\\$1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
