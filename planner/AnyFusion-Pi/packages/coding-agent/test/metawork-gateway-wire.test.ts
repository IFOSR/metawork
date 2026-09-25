import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GatewaySocketTransport } from "../src/anyfusion/gateway-socket-transport.ts";
import { GatewayClient } from "../src/anyfusion/gateway-client.ts";

describe("MetaWork query wire responses", () => {
	it.each(["command_completion", "task_view_snapshot", "usage_billing_projection"] as const)(
		"accepts %s before receipt without disconnecting or changing the replay target",
		async kind => {
			const path = join(tmpdir(), `mw-${randomUUID()}.sock`);
			const sockets = new Set<import("node:net").Socket>();
			const attachments: string[] = [];
			const server = createServer(socket => {
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
				socket.write(`${JSON.stringify({ type: "hello", sessionId: "initial", attached: false })}\n`);
				let buffer = "";
				socket.on("data", chunk => {
					buffer += chunk.toString();
					let newline: number;
					while ((newline = buffer.indexOf("\n")) >= 0) {
						const frame = JSON.parse(buffer.slice(0, newline));
						buffer = buffer.slice(newline + 1);
						if (frame.type === "attach") {
							attachments.push(frame.conversationId);
							socket.write(`${JSON.stringify({ type: "hello", sessionId: frame.conversationId, attached: true })}\n`);
						}
						if (frame.type !== "command") continue;
						const requestId = frame.envelope.requestId;
						socket.write(`${JSON.stringify({
							type: "event", event: {
								protocolVersion: 2, eventId: "query", sequence: 99, accountId: "a",
								conversationId: "client_connection_x", turnId: null, requestId,
								kind, payload: {}, occurredAt: "2026-09-20T00:00:00Z",
							},
						})}\n`);
						socket.write(`${JSON.stringify({
							type: "receipt", receipt: { requestId, status: "accepted", conversationId: null },
						})}\n`);
					}
				});
			});
			await new Promise<void>(resolve => server.listen(path, resolve));
			const transport = new GatewaySocketTransport(path);
			const client = new GatewayClient(transport);
			const received: string[] = [];
			client.onEvent(event => received.push(event.kind));
			try {
				await client.connect();
				await client.resume("conversation");
				await expect(kind === "usage_billing_projection"
					? client.getQueryBillForTurn("turn_1")
					: client.completeCommand("/wo", 3)).resolves.toMatchObject({ status: "accepted" });
				expect(received).toEqual([kind]);
				expect(client.currentSequence).toBe(0);
				for (const socket of sockets) socket.destroy();
				await vi.waitFor(() => expect(attachments).toHaveLength(2));
				expect(attachments).toEqual(["conversation", "conversation"]);
			} finally {
				client.dispose();
				transport.close();
				for (const socket of sockets) socket.destroy();
				await new Promise<void>(resolve => server.close(() => resolve()));
			}
		},
	);
});
