import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnyFusionPlannerHostClient } from "../src/anyfusion/planner-host-client.ts";

const itIfUnix = process.platform === "win32" ? it.skip : it;

describe("AnyFusion Planner host client", () => {
	itIfUnix("performs v2 hello, subscription, and structured proposal correlation over JSONL", async () => {
		const socketPath = join(tmpdir(), `anyfusion-planner-client-${process.pid}-${Date.now()}.sock`);
		const server = createServer((socket) => handleConnection(socket));
		server.listen(socketPath);
		await once(server, "listening");
		const client = new AnyFusionPlannerHostClient(socketPath, "session-1", "test");
		const snapshots: unknown[] = [];
		const executorResults: unknown[] = [];
		const permissions: unknown[] = [];
		try {
			await client.connect();
			expect(client.supportsExecutorResults()).toBe(true);
			expect(client.supportsPermissionRequests()).toBe(true);
			await client.subscribe(
				(snapshot) => snapshots.push(snapshot),
				(result) => executorResults.push(result),
				(request) => permissions.push(request),
			);
			const completion = await client.completeCommand("/task ", 6);
			expect(completion.suggestions[0]?.replacement.text).toBe("list");
			const result = await client.submitProposal({
				turnId: "turn-1",
				userInput: "Create a task",
				submissionId: "proposal-1",
				purpose: "kernel",
				plan: {},
			});
			expect(result).toMatchObject({
				status: "accepted",
				planId: "plan-1",
				outcome: "task_authorized",
			});
			const command = await client.submitCommand("/help");
			expect(command).toEqual({ exitRequested: false, output: ["> /help", "MetaClaw command result"] });
			expect(snapshots).toEqual([{ taskPool: [] }]);
			expect(executorResults).toEqual([
				expect.objectContaining({ publicationId: "publication-1", report: "Implemented and verified." }),
			]);
			expect(permissions).toEqual([expect.objectContaining({ permissionRequestId: "permission-1" })]);
			await expect(client.resolvePermission("permission-1", "approve")).resolves.toMatchObject({
				status: "resolved",
				resolution: "approve",
			});
		} finally {
			client.close();
			server.close();
			await rm(socketPath, { force: true });
		}
	});
});

function handleConnection(socket: Socket): void {
	socket.setEncoding("utf8");
	let buffer = "";
	const writeMessage = (message: Record<string, unknown>) => socket.write(`${JSON.stringify(message)}\n`);
	socket.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const request = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			if (request.type === "hello") {
				writeMessage({
					protocolVersion: 2,
					type: "hello",
					requestId: request.requestId,
					accepted: true,
					capabilities: ["executor_result", "permission_request"],
				});
			} else if (request.type === "snapshot_subscribe") {
				writeMessage({
					protocolVersion: 2,
					type: "executor_result",
					requestId: null,
					result: { schemaVersion: 1 },
				});
				writeMessage({
					protocolVersion: 2,
					type: "executor_result",
					requestId: null,
					result: {
						schemaVersion: 1,
						publicationId: "publication-1",
						taskId: "task-1",
						taskTitle: "Ship result",
						subtaskId: "subtask-1",
						subtaskTitle: "Implement",
						attemptId: "attempt-1",
						executorName: "codex-cli",
						report: "Implemented and verified.",
						artifacts: ["/workspace/result.md"],
						warnings: [],
						integrationCommit: "abc123",
						completedAt: "2026-08-04T00:00:00.000Z",
						reportTruncated: false,
					},
				});
				writeMessage({ protocolVersion: 2, type: "subscribed", requestId: request.requestId });
				writeMessage({
					protocolVersion: 2,
					type: "permission_request",
					requestId: null,
					permission: {
						schemaVersion: 1,
						permissionRequestId: "permission-1",
						taskId: "task-1",
						taskTitle: "Task",
						generationId: "generation-1",
						subtaskId: "subtask-1",
						subtaskTitle: "Subtask",
						attemptId: "attempt-1",
						executorName: "codex-cli",
						permissionProfileId: "restricted-coding",
						capability: "network",
						resource: "https://example.com",
						operation: "GET",
						reason: "fetch docs",
						suggestedScope: "once",
						escalationReason: "approval required",
						createdAt: "2026-08-04T00:00:00.000Z",
						expiresAt: "2026-08-05T00:00:00.000Z",
					},
				});
				writeMessage({ protocolVersion: 2, type: "snapshot", requestId: null, snapshot: { taskPool: [] } });
			} else if (request.type === "command_complete") {
				writeMessage({
					protocolVersion: 2,
					type: "command_completion",
					requestId: request.requestId,
					completion: {
						state: "incomplete",
						suggestions: [
							{
								value: "list",
								label: "list",
								description: "List tasks",
								replacement: { start: 6, end: 6, text: "list" },
							},
						],
						hint: "/task <list|show>",
						error: null,
					},
				});
			} else if (request.type === "proposal_submit") {
				writeMessage({
					protocolVersion: 2,
					type: "proposal_result",
					requestId: request.requestId,
					result: {
						status: "accepted",
						turnId: request.turnId,
						submissionId: request.submissionId,
						planId: "plan-1",
						outcome: "task_authorized",
						displayText: "Task created",
						taskId: "task-1",
						kernel: { decisionId: "decision-1", action: "authorize_task_plan", reason: "accepted" },
					},
				});
			} else if (request.type === "command_submit") {
				writeMessage({
					protocolVersion: 2,
					type: "command_result",
					requestId: request.requestId,
					accepted: true,
					exitRequested: false,
					output: [`> ${request.command}`, "MetaClaw command result"],
				});
			} else if (request.type === "permission_resolve") {
				writeMessage({
					protocolVersion: 2,
					type: "permission_result",
					requestId: request.requestId,
					result: { status: "resolved", resolution: request.resolution, message: "recorded" },
				});
			}
			newline = buffer.indexOf("\n");
		}
	});
}
