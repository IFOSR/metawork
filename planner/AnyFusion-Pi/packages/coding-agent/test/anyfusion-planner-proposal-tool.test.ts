import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanningProposalTool } from "../src/anyfusion/planner-proposal-tool.ts";
import { createPlannerProposalSubmissionId } from "../src/anyfusion/planner-proposal-types.ts";

const previousEnv = { ...process.env };

afterEach(() => {
	process.env = { ...previousEnv };
});

describe("submit_planning_proposal tool", () => {
	it("injects runtime turn identity and terminates on the authoritative accepted result", async () => {
		const suffix = `${process.pid}-${Date.now()}`;
		const socketPath = join(tmpdir(), `proposal-tool-${suffix}.sock`);
		const schemaPath = join(tmpdir(), `proposal-schema-${suffix}.json`);
		await writeFile(
			schemaPath,
			JSON.stringify({
				type: "object",
				required: ["id", "schemaVersion"],
				properties: { id: { type: "string" }, schemaVersion: { const: 7 } },
			}),
			"utf8",
		);
		let proposalRequest: Record<string, unknown> | undefined;
		const server = createServer((socket) =>
			handleConnection(socket, (request) => {
				proposalRequest = request;
			}),
		);
		server.listen(socketPath);
		await once(server, "listening");
		process.env.ANYFUSION_BRIDGE_SOCKET = socketPath;
		process.env.ANYFUSION_PLANNER_SESSION_ID = "session-1";
		process.env.ANYFUSION_PLANNER_TURN_PURPOSE = "kernel";
		const plan = { id: "plan-1", schemaVersion: 7 };
		const tool = createPlanningProposalTool(schemaPath);

		try {
			const result = await tool.execute("call-1", { plan }, undefined, undefined, {
				mode: "rpc",
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							id: "entry-user-1",
							parentId: null,
							timestamp: new Date().toISOString(),
							message: {
								role: "user",
								content: [{ type: "text", text: "create hello.py" }],
								timestamp: Date.now(),
							},
						},
					],
				},
			} as never);

			expect(result.terminate).toBe(true);
			expect(result.details).toMatchObject({ status: "accepted", outcome: "task_authorized" });
			expect(proposalRequest).toMatchObject({
				type: "proposal_submit",
				sessionId: "session-1",
				turnId: "turn_entry-user-1",
				userInput: "create hello.py",
				purpose: "kernel",
				plan,
				submissionId: createPlannerProposalSubmissionId("session-1", "turn_entry-user-1", plan),
			});
		} finally {
			server.close();
		}
	});

	it("reports a disconnected host as transport_uncertain without terminating the agent turn", async () => {
		const suffix = `${process.pid}-${Date.now()}`;
		const schemaPath = join(tmpdir(), `proposal-schema-${suffix}.json`);
		await writeFile(schemaPath, JSON.stringify({ type: "object" }), "utf8");
		process.env.ANYFUSION_BRIDGE_SOCKET = join(tmpdir(), `missing-proposal-host-${suffix}.sock`);
		process.env.ANYFUSION_PLANNER_SESSION_ID = "session-uncertain";
		const tool = createPlanningProposalTool(schemaPath);

		const result = await tool.execute(
			"call-uncertain",
			{ plan: { id: "plan-uncertain", schemaVersion: 7 } },
			undefined,
			undefined,
			{
				mode: "rpc",
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							id: "entry-user-uncertain",
							parentId: null,
							timestamp: new Date().toISOString(),
							message: {
								role: "user",
								content: [{ type: "text", text: "create a task" }],
								timestamp: Date.now(),
							},
						},
					],
				},
			} as never,
		);

		expect(result.terminate).toBe(false);
		expect(result.details).toMatchObject({
			status: "transport_uncertain",
			turnId: "turn_entry-user-uncertain",
			submissionId: createPlannerProposalSubmissionId("session-uncertain", "turn_entry-user-uncertain", {
				id: "plan-uncertain",
				schemaVersion: 7,
			}),
			retryableByReplay: true,
		});
	});
});

function handleConnection(socket: Socket, onProposal: (request: Record<string, unknown>) => void): void {
	socket.setEncoding("utf8");
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
			buffer = buffer.slice(newline + 1);
			if (request.type === "hello") {
				socket.write(
					`${JSON.stringify({ protocolVersion: 2, type: "hello", requestId: request.requestId, accepted: true, capabilities: [] })}\n`,
				);
			} else if (request.type === "proposal_submit") {
				onProposal(request);
				socket.write(
					`${JSON.stringify({
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
					})}\n`,
				);
			}
			newline = buffer.indexOf("\n");
		}
	});
}
