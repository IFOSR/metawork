import { describe, expect, it, vi } from "vitest";
import { AnyFusionPermissionInbox, formatPermissionRequest } from "../src/anyfusion/permission-review.ts";
import type { PermissionRequestNotification } from "../src/anyfusion/planner-host-client.ts";

describe("AnyFusion permission inbox", () => {
	it("sorts, deduplicates, snoozes, resumes, and expires requests", () => {
		const inbox = new AnyFusionPermissionInbox();
		expect(inbox.enqueue(request("b", "2026-08-04T00:00:01.000Z"))).toBe(true);
		expect(inbox.enqueue(request("a", "2026-08-04T00:00:00.000Z"))).toBe(true);
		expect(inbox.enqueue(request("a", "2026-08-04T00:00:00.000Z"))).toBe(false);
		expect(inbox.peek(Date.parse("2026-08-04T12:00:00.000Z"))?.permissionRequestId).toBe("a");
		inbox.snooze();
		expect(inbox.peek(Date.parse("2026-08-04T12:00:00.000Z"))).toBeNull();
		inbox.resumeAfterUserInput();
		expect(inbox.remove("a")).toBe(true);
		expect(inbox.removeExpired(Date.parse("2026-08-06T00:00:00.000Z"))).toHaveLength(1);
		expect(inbox.peek()).toBeNull();
	});

	it("formats all approval identity and request details", () => {
		const output = formatPermissionRequest(request("request-1", "2026-08-04T00:00:00.000Z"));
		expect(output).toContain("Task: Task title (task-1)");
		expect(output).toContain("Executor: codex-cli · restricted-coding");
		expect(output).toContain("Resource: https://example.com");
		expect(output).toContain("Kernel: explicit approval required");
	});

	it("removes a snoozed request when its local expiry timer elapses", () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-08-04T23:59:59.000Z");
		const inbox = new AnyFusionPermissionInbox();
		inbox.enqueue(request("request-1", "2026-08-04T00:00:00.000Z"));
		inbox.snooze();
		const expired: string[] = [];
		setTimeout(() => {
			expired.push(...inbox.removeExpired().map((candidate) => candidate.permissionRequestId));
		}, 1000);
		vi.advanceTimersByTime(1000);
		expect(expired).toEqual(["request-1"]);
		expect(inbox.peek()).toBeNull();
		vi.useRealTimers();
	});
});

function request(permissionRequestId: string, createdAt: string): PermissionRequestNotification {
	return {
		schemaVersion: 1,
		permissionRequestId,
		taskId: "task-1",
		taskTitle: "Task title",
		generationId: "generation-1",
		subtaskId: "subtask-1",
		subtaskTitle: "Subtask title",
		attemptId: "attempt-1",
		executorName: "codex-cli",
		permissionProfileId: "restricted-coding",
		capability: "network",
		resource: "https://example.com",
		operation: "GET",
		reason: "fetch documentation",
		suggestedScope: "once",
		escalationReason: "explicit approval required",
		createdAt,
		expiresAt: "2026-08-05T00:00:00.000Z",
	};
}
