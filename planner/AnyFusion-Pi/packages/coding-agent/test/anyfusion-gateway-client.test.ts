import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/anyfusion/gateway-client.ts";
import { GatewaySocketTransport } from "../src/anyfusion/gateway-socket-transport.ts";
import type {
	GatewayCommandEnvelope,
	GatewayEventEnvelope,
	GatewayReplay,
	GatewayWireClientMessage,
} from "../src/anyfusion/gateway-protocol.ts";

function fixture() {
	const submitted: GatewayCommandEnvelope[] = [];
	let publish: (event: GatewayEventEnvelope) => void = () => undefined;
	let disconnect: () => void = () => undefined;
	const replay = vi.fn(async (_conversationId: string, afterSequence = 0) => ({
		lastSequence: afterSequence,
		snapshot: [],
		deltas: [],
	}));
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
		replay,
		subscribe,
		onDisconnect: (listener) => {
			disconnect = listener;
			return () => undefined;
		},
		createId: (prefix) => `${prefix}_${++id}`,
	});
	return {
		client,
		replay,
		submitted,
		subscribe,
		disconnect: () => disconnect(),
		publish: (event: GatewayEventEnvelope) => publish(event),
	};
}

describe("GatewayClient", () => {
	it("marks automatic Workspace initialization as initialize-if-unset", async () => {
		const { client, submitted } = fixture();

		await client.initializeWorkspace(
			"/workspace /repo-a",
			{ mode: "attach", conversationId: "conv_native" },
		);

		expect(submitted[0]?.command).toEqual({
			kind: "slash_command",
			text: "/workspace /repo-a",
			workspaceMutation: "initialize_if_unset",
		});
	});

	it("submits permission decisions as versioned Gateway commands", async () => {
		const { client, submitted } = fixture();

		await client.submitPermissionResolution(
			"permission_1",
			"approve",
			{ mode: "attach", conversationId: "conv_native" },
		);

		expect(submitted[0]?.command).toEqual({
			kind: "permission_resolution",
			requestId: "permission_1",
			resolution: "approve",
		});
		expect(submitted[0]?.protocolVersion).toBe(1);
	});

	it("uses one transport subscription for multiple view listeners", () => {
		const { client, subscribe, publish } = fixture();
		const first = vi.fn();
		const second = vi.fn();
		client.onEvent(first);
		client.onEvent(second);

		publish({
			protocolVersion: 1,
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

	it("reconnects the active Conversation from the last delivered cursor", async () => {
		const { client, disconnect, publish, replay } = fixture();
		client.onEvent(() => undefined);
		await client.resume("conv_native");
		publish({
			protocolVersion: 1,
			eventId: "event_7",
			sequence: 7,
			accountId: "local-default",
			conversationId: "conv_native",
			requestId: null,
			turnId: null,
			kind: "trace_delta",
			payload: {},
			occurredAt: "2026-08-19T00:00:00.000Z",
		});

		disconnect();
		await vi.waitFor(() => expect(replay).toHaveBeenLastCalledWith("conv_native", 7));
	});

	it("waits for reconnect replay before submitting to the active Conversation", async () => {
		let disconnect: () => void = () => undefined;
		const replayGate = deferred<GatewayReplay>();
		const submit = vi.fn(async (envelope: GatewayCommandEnvelope) => ({
			requestId: envelope.requestId,
			status: "accepted" as const,
			conversationId: "conv_native",
		}));
		const replay = vi.fn()
			.mockResolvedValueOnce({ lastSequence: 0, snapshot: [], deltas: [] })
			.mockImplementationOnce(() => replayGate.promise);
		const client = new GatewayClient({
			submit,
			replay,
			subscribe: () => () => undefined,
			onDisconnect: (listener) => {
				disconnect = listener;
				return () => undefined;
			},
		});
		await client.resume("conv_native");

		disconnect();
		const pending = client.submitUserInput(
			"after reconnect",
			{ mode: "attach", conversationId: "conv_native" },
		);
		await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
		expect(submit).not.toHaveBeenCalled();

		replayGate.resolve({ lastSequence: 4, snapshot: [], deltas: [] });
		await expect(pending).resolves.toMatchObject({ status: "accepted" });
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("retries a temporary reconnect failure on the next input", async () => {
		let disconnect: () => void = () => undefined;
		const submit = vi.fn(async (envelope: GatewayCommandEnvelope) => ({
			requestId: envelope.requestId,
			status: "accepted" as const,
			conversationId: "conv_native",
		}));
		const replay = vi.fn()
			.mockResolvedValueOnce({ lastSequence: 0, snapshot: [], deltas: [] })
			.mockRejectedValueOnce(new Error("temporary replay failure"))
			.mockResolvedValueOnce({ lastSequence: 5, snapshot: [], deltas: [] });
		const client = new GatewayClient({
			submit,
			replay,
			subscribe: () => () => undefined,
			onDisconnect: (listener) => {
				disconnect = listener;
				return () => undefined;
			},
		});
		await client.resume("conv_native");

		disconnect();
		await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await expect(client.submitUserInput(
			"retry after failure",
			{ mode: "attach", conversationId: "conv_native" },
		)).resolves.toMatchObject({ status: "accepted" });
		expect(replay).toHaveBeenCalledTimes(3);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	const itIfUnix = process.platform === "win32" ? it.skip : it;

	itIfUnix("writes attach before command on every replacement socket", async () => {
		const socketPath = join(
			tmpdir(),
			`anyfusion-gateway-client-${process.pid}-${Date.now()}.sock`,
		);
		const sockets = new Set<Socket>();
		const secondSocketMessages: GatewayWireClientMessage[] = [];
		let connectionCount = 0;
		let firstSocket: Socket | null = null;
		let secondSocket: Socket | null = null;
		const releaseSecondAttach = deferred<void>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			connectionCount += 1;
			const connectionNumber = connectionCount;
			if (connectionNumber === 1) firstSocket = socket;
			if (connectionNumber === 2) secondSocket = socket;
			socket.setEncoding("utf8");
			socket.write(`${JSON.stringify({
				type: "hello",
				sessionId: `conv_fresh_${connectionNumber}`,
			})}\n`);
			readJsonLines(socket, (message) => {
				if (connectionNumber === 2) secondSocketMessages.push(message);
				if (message.type === "attach") {
					const acknowledge = () => socket.write(`${JSON.stringify({
						type: "hello",
						sessionId: message.conversationId,
					})}\n`);
					if (connectionNumber === 2) {
						void releaseSecondAttach.promise.then(acknowledge);
					} else {
						acknowledge();
					}
				}
				if (message.type === "command") {
					socket.write(`${JSON.stringify({
						type: "receipt",
						receipt: {
							requestId: message.envelope.requestId,
							status: "accepted",
							conversationId: "conv_native",
						},
					})}\n`);
				}
			});
		});
		server.listen(socketPath);
		await once(server, "listening");
		const transport = new GatewaySocketTransport(socketPath);
		try {
			await transport.replay("conv_native", 3);
			const disconnected = new Promise<void>((resolve) => {
				transport.onDisconnect(resolve);
			});
			firstSocket?.destroy();
			await disconnected;

			const replay = transport.replay("conv_native", 3);
			const receipt = transport.submit(commandEnvelope("req_after_reconnect"));
			await vi.waitFor(() => {
				expect(secondSocketMessages[0]).toMatchObject({
					type: "attach",
					conversationId: "conv_native",
					resumeFromSequence: 3,
				});
			});
			expect(secondSocketMessages.some((message) => message.type === "command")).toBe(false);

			releaseSecondAttach.resolve();
			await replay;
			await expect(receipt).resolves.toMatchObject({
				status: "accepted",
				conversationId: "conv_native",
			});
			expect(secondSocketMessages.map((message) => message.type)).toEqual([
				"attach",
				"command",
			]);
			expect(secondSocket).not.toBeNull();
		} finally {
			transport.close();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(socketPath, { force: true });
		}
	});

	itIfUnix("rejects malformed inbound JSONL as a structured transport failure", async () => {
		const socketPath = join(
			tmpdir(),
			`anyfusion-gateway-malformed-${process.pid}-${Date.now()}.sock`,
		);
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.setEncoding("utf8");
			socket.write(`${JSON.stringify({ type: "hello", sessionId: "conv_fresh" })}\n`);
			readJsonLines(socket, (message) => {
				if (message.type === "attach") socket.write("{not-json}\n");
			});
		});
		server.listen(socketPath);
		await once(server, "listening");
		const transport = new GatewaySocketTransport(socketPath, 256);
		try {
			await expect(transport.replay("conv_native", 4)).rejects.toMatchObject({
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
		const socketPath = join(
			tmpdir(),
			`anyfusion-gateway-workspace-${process.pid}-${Date.now()}.sock`,
		);
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.setEncoding("utf8");
			socket.write(`${JSON.stringify({ type: "hello", sessionId: "conv_fresh" })}\n`);
			readJsonLines(socket, (message) => {
				if (message.type !== "attach") return;
				socket.write(`${JSON.stringify({
					type: "event",
					event: {
						protocolVersion: 1,
						eventId: "event_workspace_1",
						sequence: 1,
						accountId: "local-default",
						conversationId: message.conversationId,
						requestId: "req_workspace_1",
						turnId: null,
						kind: "workspace_changed",
						payload: { path: "/tmp/workspace" },
						occurredAt: "2026-08-27T00:00:00.000Z",
					},
				})}\n`);
				socket.write(`${JSON.stringify({
					type: "hello",
					sessionId: message.conversationId,
				})}\n`);
			});
		});
		server.listen(socketPath);
		await once(server, "listening");
		const transport = new GatewaySocketTransport(socketPath);
		const events: GatewayEventEnvelope[] = [];
		transport.subscribe((event) => events.push(event));
		try {
			await transport.replay("conv_native", 0);
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
		const socketPath = join(
			tmpdir(),
			`anyfusion-gateway-oversized-${process.pid}-${Date.now()}.sock`,
		);
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.setEncoding("utf8");
			socket.write(`${JSON.stringify({ type: "hello", sessionId: "conv_fresh" })}\n`);
			readJsonLines(socket, (message) => {
				if (message.type === "attach") {
					socket.write(`${JSON.stringify({
						type: "hello",
						sessionId: message.conversationId,
					})}\n`);
				}
				if (message.type === "command") socket.write("x".repeat(257));
			});
		});
		server.listen(socketPath);
		await once(server, "listening");
		const transport = new GatewaySocketTransport(socketPath, 256);
		try {
			await transport.replay("conv_native", 0);
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
});

function commandEnvelope(requestId: string): GatewayCommandEnvelope {
	return {
		protocolVersion: 1,
		requestId,
		idempotencyKey: `idem_${requestId}`,
		connectionId: "tui",
		conversation: { mode: "attach", conversationId: "conv_native" },
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

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
