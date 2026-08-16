import { describe, expect, it } from "vitest";
import {
	ANYFUSION_EXECUTOR_RESULT_CUSTOM_TYPE,
	AnyFusionExecutorResultInbox,
	executorResultDetails,
	formatExecutorResultMessage,
	publicationIdFromCustomEntry,
} from "../src/anyfusion/executor-result-message.ts";
import type { ExecutorResultNotification } from "../src/anyfusion/planner-host-client.ts";

const result: ExecutorResultNotification = {
	schemaVersion: 1,
	publicationId: "publication-1",
	taskId: "task-1",
	taskTitle: "Ship result",
	subtaskId: "subtask-1",
	subtaskTitle: "Implement projection",
	attemptId: "attempt-1",
	executorName: "codex-cli",
	report: "Implemented and verified.",
	artifacts: ["/workspace/result.md", "/workspace/output.json"],
	warnings: ["Review generated output"],
	integrationCommit: "abc123",
	completedAt: "2026-08-04T00:00:00.000Z",
	reportTruncated: false,
};

describe("AnyFusion Executor result message", () => {
	it("formats the report and every artifact as a visible Markdown message", () => {
		const message = formatExecutorResultMessage(result);
		expect(message).toContain("Executor result: Implement projection");
		expect(message).toContain("Implemented and verified.");
		expect(message).toContain("`/workspace/result.md`");
		expect(message).toContain("`/workspace/output.json`");
		expect(message).toContain("Review generated output");
	});

	it("stores stable publication metadata and recovers its deduplication key", () => {
		const details = executorResultDetails(result);
		expect(details.publicationId).toBe("publication-1");
		expect(
			publicationIdFromCustomEntry({
				type: "custom_message",
				customType: ANYFUSION_EXECUTOR_RESULT_CUSTOM_TYPE,
				details,
			}),
		).toBe("publication-1");
		expect(publicationIdFromCustomEntry({ type: "custom_message", customType: "other" })).toBeNull();
	});

	it("uses explicit placeholders for empty reports and artifact lists", () => {
		const message = formatExecutorResultMessage({ ...result, report: "", artifacts: [], warnings: [] });
		expect(message).toContain("did not provide a human-readable summary");
		expect(message).toContain("No result files were reported");
	});

	it("queues while Planner is busy, then delivers once without triggering duplicate publications", async () => {
		let busy = true;
		const delivered: string[] = [];
		const errors: unknown[] = [];
		const inbox = new AnyFusionExecutorResultInbox({
			isBusy: () => busy,
			deliver: async (item) => {
				delivered.push(item.publicationId);
			},
			onError: (error) => errors.push(error),
		});
		expect(inbox.enqueue(result)).toBe(true);
		expect(inbox.enqueue(result)).toBe(false);
		expect(delivered).toEqual([]);

		busy = false;
		await inbox.flush();
		expect(delivered).toEqual(["publication-1"]);
		expect(inbox.enqueue(result)).toBe(false);
		expect(errors).toEqual([]);
	});

	it("seeds persisted publication IDs so replay does not add them again", () => {
		const inbox = new AnyFusionExecutorResultInbox({
			isBusy: () => false,
			deliver: async () => {},
			onError: () => {},
		});
		inbox.seed(["publication-1"]);
		expect(inbox.enqueue(result)).toBe(false);
	});

	it("replaces persisted publication IDs when the active branch changes", () => {
		const inbox = new AnyFusionExecutorResultInbox({
			isBusy: () => true,
			deliver: async () => {},
			onError: () => {},
		});
		inbox.seed(["publication-1"]);
		inbox.seed(["publication-2"]);

		expect(inbox.enqueue(result)).toBe(true);
		expect(inbox.enqueue({ ...result, publicationId: "publication-2" })).toBe(false);
	});
});
