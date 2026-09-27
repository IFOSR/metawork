import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/anyfusion/gateway-client.ts";
import type {
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayReplay,
	GatewayReplayReset,
	GatewayWireClientMessage,
} from "../src/anyfusion/gateway-protocol.ts";
import { GatewaySocketTransport } from "../src/anyfusion/gateway-socket-transport.ts";

async function wireFixture(
	handleAttach: (socket: Socket, message: Extract<GatewayWireClientMessage, { type: "attach" }>, index: number) => void,
	capabilities: string[] = ["bounded_replay_v1"],
) {
	const path = join(tmpdir(), `mw-reset-${randomUUID()}.sock`);
	const sockets = new Set<Socket>();
	const attaches: Array<Extract<GatewayWireClientMessage, { type: "attach" }>> = [];
	const server = createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		// Negotiation must wait for the initial hello, not merely the socket connect.
		setTimeout(() => send(socket, { type: "hello", sessionId: "initial", attached: false, capabilities }), 10);
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const message = JSON.parse(buffer.slice(0, newline)) as GatewayWireClientMessage;
				buffer = buffer.slice(newline + 1);
				if (message.type === "attach") {
					attaches.push(message);
					handleAttach(socket, message, attaches.length);
				}
				newline = buffer.indexOf("\n");
			}
		});
	});
	await new Promise<void>(resolve => server.listen(path, resolve));
	const transport = new GatewaySocketTransport(path);
	const client = new GatewayClient(transport);
	return {
		client, attaches,
		close: async () => {
			client.dispose();
			transport.close();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

function send(socket: Socket, value: unknown): void {
	socket.write(`${JSON.stringify(value)}\n`);
}

function event(sequence: number): GatewayEventEnvelope {
	return {
		protocolVersion: 2, eventId: "reused_event", sequence, accountId: "local-default",
		conversationId: "a", requestId: null, turnId: "turn", kind: "turn_started",
		payload: {}, occurredAt: "2026-09-26T00:00:00Z",
	};
}

const itIfUnix = process.platform === "win32" ? it.skip : it;

describe("bounded replay transport", () => {
	itIfUnix("negotiates reset and uses the attached hello watermark even without events", async () => {
		const h = await wireFixture((socket, message) => {
			send(socket, { type: "hello", sessionId: message.conversationId, attached: true, lastSequence: 17 });
		});
		try {
			await h.client.resume("a");
			expect(h.attaches[0]).toMatchObject({ acceptCursorReset: true });
			expect(h.client.currentSequence).toBe(17);
		} finally { await h.close(); }
	});

	itIfUnix.each([
		{ reason: "cursor_ahead", lastSequence: 3, snapshotSequence: 2 },
		{ reason: "replay_budget_exceeded", lastSequence: 20, snapshotSequence: 8 },
		{ reason: "cursor_expired", lastSequence: 20, snapshotSequence: 8 },
	] as const)(
		"clears replay dedup before snapshots and adopts the cursor on $reason",
		async ({ reason, lastSequence, snapshotSequence }) => {
			const h = await wireFixture((socket, message, index) => {
				if (index === 2) send(socket, {
					type: "replay_reset", conversationId: "a", lastSequence, reason, snapshotVersion: 1,
				});
				if (index <= 2) send(socket, { type: "event", event: event(index === 1 ? 8 : snapshotSequence) });
				send(socket, {
					type: "hello", sessionId: message.conversationId, attached: true,
					lastSequence: index === 1 ? 10 : lastSequence, capabilities: ["bounded_replay_v1"],
				});
			});
			const seen: number[] = [];
			const order: string[] = [];
			const resets: GatewayReplayReset[] = [];
			h.client.onReplayReset(reset => {
				resets.push(reset);
				order.push("reset");
			});
			h.client.onEvent(value => {
				seen.push(value.sequence);
				order.push(`event:${value.sequence}`);
			});
			try {
				await h.client.resume("a");
				await expect(h.client.resume("a")).resolves.toMatchObject({ lastSequence });
				expect(resets).toEqual([expect.objectContaining({ reason, lastSequence, snapshotVersion: 1 })]);
				expect(seen).toEqual([8, snapshotSequence]);
				expect(order).toEqual(["event:8", "reset", `event:${snapshotSequence}`]);
				expect(h.client.currentSequence).toBe(lastSequence);
				await h.client.resume("a");
				expect(h.attaches[2]).toMatchObject({ resumeFromSequence: lastSequence });
			} finally { await h.close(); }
		},
	);

	it("does not let a superseded reconnect failure poison a new Conversation", async () => {
		let disconnect: () => void = () => {};
		let rejectOld!: (error: Error) => void;
		const replay = vi.fn(async (): Promise<GatewayReplay> => ({ lastSequence: 0, snapshot: [], deltas: [] }))
			.mockResolvedValueOnce({ lastSequence: 0, snapshot: [], deltas: [] })
			.mockImplementationOnce(() => new Promise<GatewayReplay>((_resolve, reject) => { rejectOld = reject; }));
		const client = new GatewayClient({
			replay,
			subscribe: () => () => {},
			onDisconnect: listener => { disconnect = listener; return () => {}; },
			submit: async envelope => ({ requestId: envelope.requestId, status: "accepted", conversationId: "b" }),
		});
		try {
			await client.resume("a");
			disconnect();
			await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
			await client.resume("b");
			rejectOld(new Error("Gateway attach was superseded"));
			await expect(client.getConversationHistory("b")).resolves.toMatchObject({ status: "accepted" });
			expect(replay).toHaveBeenCalledTimes(3);
		} finally { client.dispose(); }
	});

	it("keeps the reconnect target when old snapshot events arrive after navigation", async () => {
		let publish: (event: GatewayEventEnvelope) => void = () => {};
		const client = new GatewayClient({
			subscribe: listener => { publish = listener; return () => {}; },
			replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }),
			submit: async envelope => ({ requestId: envelope.requestId, status: "accepted", conversationId: null }),
		});
		try {
			client.onEvent(() => {});
			await client.resume("a");
			await client.resume("b");
			publish(event(8));
			expect(client.currentSequence).toBe(0);
		} finally { client.dispose(); }
	});

	it("keeps the reconnect target when an old query receipt arrives after navigation", async () => {
		let resolve!: (receipt: GatewayCommandReceipt) => void;
		let requestId = "";
		const client = new GatewayClient({
			subscribe: () => () => {},
			replay: async conversationId => ({ lastSequence: conversationId === "a" ? 1 : 2, snapshot: [], deltas: [] }),
			submit: async envelope => {
				requestId = envelope.requestId;
				return new Promise<GatewayCommandReceipt>(done => { resolve = done; });
			},
		});
		try {
			await client.resume("a");
			const history = client.getConversationHistory("a");
			await vi.waitFor(() => expect(requestId).not.toBe(""));
			await client.resume("b");
			resolve({ requestId, status: "accepted", conversationId: "a" });
			await history;
			expect(client.currentSequence).toBe(2);
		} finally { client.dispose(); }
	});

	itIfUnix("omits reset opt-in for an older server and propagates reset-required without fallback", async () => {
		const h = await wireFixture(socket => {
			send(socket, { type: "error", message: "gateway_cursor_reset_required" });
		}, []);
		try {
			await expect(h.client.resume("a")).rejects.toThrow("gateway_cursor_reset_required");
			expect(h.attaches).toHaveLength(1);
			expect(h.attaches[0]).not.toHaveProperty("acceptCursorReset");
		} finally { await h.close(); }
	});

	itIfUnix.each([
		{ lastSequence: -1 }, { lastSequence: Number.MAX_SAFE_INTEGER + 1 },
		{ snapshotVersion: 2 }, { reason: "unknown" }, { conversationId: "" },
	])("rejects malformed reset metadata %j", async invalid => {
		const h = await wireFixture(socket => send(socket, {
			type: "replay_reset", conversationId: "a", lastSequence: 3,
			reason: "cursor_ahead", snapshotVersion: 1, ...invalid,
		}));
		try {
			await expect(h.client.resume("a")).rejects.toMatchObject({ code: "gateway_malformed_frame" });
		} finally { await h.close(); }
	});
});
