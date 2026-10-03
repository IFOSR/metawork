import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/anyfusion/gateway-client.ts";
import type {
	GatewayCommandEnvelope,
	GatewayEventEnvelope,
	GatewayWireClientMessage,
} from "../src/anyfusion/gateway-protocol.ts";
import { GatewaySocketTransport } from "../src/anyfusion/gateway-socket-transport.ts";

function fixture() {
	const submitted: GatewayCommandEnvelope[] = [];
	let publish: (event: GatewayEventEnvelope) => void = () => undefined;
	let disconnect: () => void = () => undefined;
	const subscribe = vi.fn((listener: (event: GatewayEventEnvelope) => void) => {
		publish = listener;
		return () => undefined;
	});
	let id = 0;
	const client = new GatewayClient({
		submit: async (envelope) => {
			submitted.push(envelope);
			return {
				requestId: envelope.requestId,
				status: "accepted",
				conversationId: "conv_native",
			};
		},
		subscribe,
		onDisconnect: (listener) => {
			disconnect = listener;
			return () => undefined;
		},
		createId: (prefix) => `${prefix}_${++id}`,
	});
	return {
		client,
		submitted,
		subscribe,
		disconnect: () => disconnect(),
		publish: (event: GatewayEventEnvelope) => publish(event),
	};
}

describe("GatewayClient", () => {
	it("selects the startup Workspace through the Workspace scope", async () => {
		const { client, submitted } = fixture();

		await client.initializeWorkspace("/workspace /repo-a");

		expect(submitted[0]?.command).toEqual({
			kind: "select_workspace",
			path: "/repo-a",
		});
		expect(submitted[0]?.scope).toEqual({ kind: "workspace" });
	});

	it("submits permission decisions as versioned Gateway commands", async () => {
		const { client, submitted } = fixture();

		await client.submitWithEnvelope(
			{
				kind: "permission_resolution_v2",
				requestId: "permission_1",
				resolution: "approve",
				requestRevision: "revision",
				expectedExecutionGeneration: "generation",
			},
			{ kind: "conversation", selection: { mode: "attach", conversationId: "conv_native" } },
		);

		expect(submitted[0]?.command).toEqual({
			kind: "permission_resolution_v2",
			requestRevision: "revision",
			expectedExecutionGeneration: "generation",
			requestId: "permission_1",
			resolution: "approve",
		});
		expect(submitted[0]?.protocolVersion).toBe(2);
	});

	it("uses one transport subscription for multiple view listeners", () => {
		const { client, subscribe, publish } = fixture();
		const first = vi.fn();
		const second = vi.fn();
		client.onEvent(first);
		client.onEvent(second);

		publish({
			protocolVersion: 2,
			eventId: "event_1",
			sequence: 1,
			accountId: "local-default",
			conversationId: "conv_native",
			requestId: null,
			turnId: null,
			kind: "trace_delta",
			payload: {},
			occurredAt: "2026-08-19T00:00:00.000Z",
		});

		expect(subscribe).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});

	const itIfUnix = process.platform === "win32" ? it.skip : it;

	itIfUnix("rejects malformed inbound JSONL as a structured transport failure", async () => {
		const socketPath = join(tmpdir(), `anyfusion-gateway-malformed-${process.pid}-${Date.now()}.sock`);
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.setEncoding("utf8");
			socket.write(
				`${JSON.stringify({
					type: "hello",
					sessionId: "connection_fresh",
					attached: false,
				})}\n`,
			);
			readJsonLines(socket, (message) => {
				if (message.type === "command") socket.write("{not-json}\n");
			});
		});
		server.listen(socketPath);
		await once(server, "listening");
		const transport = new GatewaySocketTransport(socketPath, 256);
		try {
			await expect(transport.submit(commandEnvelope("malformed"))).rejects.toMatchObject({
				name: "GatewayFrameError",
				code: "gateway_malformed_frame",
			});
		} finally {
			transport.close();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(socketPath, { force: true });
		}
	});

	itIfUnix("accepts workspace_changed events from the Server", async () => {
		const socketPath = join(tmpdir(), `anyfusion-gateway-workspace-${process.pid}-${Date.now()}.sock`);
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.setEncoding("utf8");
			socket.write(
				`${JSON.stringify({
					type: "hello",
					sessionId: "connection_fresh",
					attached: false,
				})}\n`,
			);
			readJsonLines(socket, (message) => {
				if (message.type !== "command") return;
				socket.write(
					`${JSON.stringify({
						type: "event",
						event: {
							protocolVersion: 2,
							eventId: "event_workspace_1",
							sequence: 1,
							accountId: "local-default",
							conversationId: "conv_native",
							requestId: "req_workspace_1",
							turnId: null,
							kind: "workspace_changed",
							payload: { path: "/tmp/workspace" },
							occurredAt: "2026-08-27T00:00:00.000Z",
						},
					})}\n`,
				);
				socket.write(
					`${JSON.stringify({
						type: "hello",
						sessionId: "conv_native",
						attached: true,
					})}\n`,
				);
			});
		});
		server.listen(socketPath);
		await once(server, "listening");
		const transport = new GatewaySocketTransport(socketPath);
		const events: GatewayEventEnvelope[] = [];
		transport.subscribe((event) => events.push(event));
		try {
			void transport.submit(commandEnvelope("workspace")).catch(() => undefined);
			await vi.waitFor(() => expect(events).toHaveLength(1));
			expect(events).toEqual([
				expect.objectContaining({
					eventId: "event_workspace_1",
					kind: "workspace_changed",
				}),
			]);
		} finally {
			transport.close();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(socketPath, { force: true });
		}
	});

	itIfUnix("rejects an oversized inbound JSONL frame without an uncaught socket callback error", async () => {
		const socketPath = join(tmpdir(), `anyfusion-gateway-oversized-${process.pid}-${Date.now()}.sock`);
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.setEncoding("utf8");
			socket.write(
				`${JSON.stringify({
					type: "hello",
					sessionId: "connection_fresh",
					attached: false,
				})}\n`,
			);
			readJsonLines(socket, (message) => {
				if (message.type === "attach") {
					socket.write(
						`${JSON.stringify({
							type: "hello",
							sessionId: message.conversationId,
							attached: true,
						})}\n`,
					);
				}
				if (message.type === "command") socket.write("x".repeat(257));
			});
		});
		server.listen(socketPath);
		await once(server, "listening");
		const transport = new GatewaySocketTransport(socketPath, 256);
		try {
			await transport.connect();
			await expect(transport.submit(commandEnvelope("req_oversized"))).rejects.toMatchObject({
				name: "GatewayFrameError",
				code: "gateway_frame_too_large",
			});
		} finally {
			transport.close();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(socketPath, { force: true });
		}
	});

	it("exposes completion and task view queries as versioned commands", async () => {
		const { client, submitted } = fixture();

		// Workspace scope 补全：targetConversationId 为 null 语义。
		await client.completeCommand("/wo", 3);
		expect(submitted.at(-1)?.command).toEqual({
			kind: "complete_command",
			text: "/wo",
			cursor: 3,
		});
		expect(submitted.at(-1)?.scope).toEqual({ kind: "workspace" });

		// Conversation scope 补全必须显式 attach。
		await client.completeCommand("/task", undefined, "conv_native");
		expect(submitted.at(-1)?.command).toEqual({
			kind: "complete_command",
			text: "/task",
		});
		expect(submitted.at(-1)?.scope).toEqual({
			kind: "conversation",
			selection: { mode: "attach", conversationId: "conv_native" },
		});

		await client.getTaskView("conv_native", "turn_1", "task_1");
		expect(submitted.at(-1)?.command).toEqual({
			kind: "get_task_view",
			conversationId: "conv_native",
			turnId: "turn_1",
			taskId: "task_1",
		});
	});

	it("replays an unconfirmed submission with the identical envelope", async () => {
		const { client, submitted } = fixture();

		const { envelope, receipt } = await client.submitWithEnvelope(
			{ kind: "user_message", text: "hello", attachments: [] },
			{
				kind: "conversation",
				selection: { mode: "attach", conversationId: "conv_native" },
			},
		);
		expect(receipt.status).toBe("accepted");

		// 断线丢 receipt 后重放：同一 requestId / idempotencyKey / 目标与内容。
		const replayed = await client.resubmitEnvelope(envelope);
		expect(replayed.status).toBe("accepted");
		expect(submitted).toHaveLength(2);
		expect(submitted[1]).toEqual(envelope);
		expect(submitted[1]?.requestId).toBe(envelope.requestId);
		expect(submitted[1]?.idempotencyKey).toBe(envelope.idempotencyKey);
	});

	it("exposes server capabilities reported by the transport hello", async () => {
		const { client } = fixture();
		expect(client.serverCapabilities).toEqual([]);
		expect(client.hasServerCapability("task_view_v1")).toBe(false);

		const withCapabilities = new GatewayClient({
			submit: async (envelope) => ({
				requestId: envelope.requestId,
				status: "accepted",
				conversationId: null,
			}),
			subscribe: () => () => undefined,
			getServerCapabilities: () => ["command_completion_v1", "task_view_v1"],
		});
		expect(withCapabilities.serverCapabilities).toEqual(["command_completion_v1", "task_view_v1"]);
		expect(withCapabilities.hasServerCapability("task_view_v1")).toBe(true);
	});
});

function commandEnvelope(requestId: string): GatewayCommandEnvelope {
	return {
		protocolVersion: 2,
		requestId,
		idempotencyKey: `idem_${requestId}`,
		connectionId: "tui",
		scope: {
			kind: "conversation",
			selection: { mode: "attach", conversationId: "conv_native" },
		},
		command: { kind: "user_message", text: "hello", attachments: [] },
		clientCapabilities: ["trace_v1"],
	};
}

function readJsonLines(socket: Socket, listener: (message: GatewayWireClientMessage) => void): void {
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) listener(JSON.parse(line) as GatewayWireClientMessage);
			newline = buffer.indexOf("\n");
		}
	});
}
