import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it, vi } from "vitest";
import { GatewayClient } from "../src/anyfusion/gateway-client.ts";
import type { GatewayWireClientMessage } from "../src/anyfusion/gateway-protocol.ts";
import { GatewaySocketTransport } from "../src/anyfusion/gateway-socket-transport.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { MetaWorkActionBar } from "../src/modes/metawork-tui/components/status-bar.ts";
import { MetaWorkTuiController } from "../src/modes/metawork-tui/controller.ts";
import { baselineFrame, turn } from "./helpers/observation-fixture.ts";

const itIfUnix = process.platform === "win32" ? it.skip : it;

itIfUnix("clears the ENOENT footer after a real socket restart", async () => {
	initTheme("dark");
	const path = join(tmpdir(), `mw-rc-${randomUUID().slice(0, 12)}.sock`);
	const sockets = new Set<Socket>();
	const listen = async () => {
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			const send = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
			const emit = (sequence: number, kind: string, payload: unknown, requestId: string | null = null) =>
				send({
					type: "event",
					event: {
						protocolVersion: 2,
						eventId: `${kind}_${requestId ?? sequence}`,
						sequence,
						accountId: "local-default",
						conversationId: "conv_reconnect",
						turnId: "completed_turn",
						requestId,
						kind,
						payload,
						occurredAt: "2026-09-27T00:00:00Z",
					},
				});
			send({ type: "hello", sessionId: "initial", attached: false, capabilities: [] });
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const message = JSON.parse(buffer.slice(0, newline)) as GatewayWireClientMessage;
					buffer = buffer.slice(newline + 1);
					if (message.type === "observe") {
						send({
							type: "observation",
							frame: baselineFrame("conv_reconnect", message.observationId, {
								head: { epoch: "epoch", revision: 1, journalSequence: 3 },
								turns: [
									{
										...turn("conv_reconnect", "completed_turn"),
										status: "completed",
										answer: "completed answer",
									},
								],
								nextCursor: null,
							}),
						});
					} else if (message.type === "command") {
						if (message.envelope.command.kind === "get_conversation_resource") {
							emit(
								3,
								"conversation_resource",
								{
									page: {
										id: "conv_reconnect",
										workspaceId: "workspace",
										workspace: {
											id: "workspace",
											path: "/bound/workspace",
											displayName: "Bound workspace",
											availability: "available",
										},
									},
								},
								message.envelope.requestId,
							);
						}
						send({
							type: "receipt",
							receipt: {
								requestId: message.envelope.requestId,
								status: "accepted",
								conversationId: "conv_reconnect",
							},
						});
					}
					newline = buffer.indexOf("\n");
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(path, resolve));
		return server;
	};
	let server = await listen();
	const stopServer = async () => {
		const closed = new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		for (const socket of sockets) socket.destroy();
		await closed;
	};
	const transport = new GatewaySocketTransport(path);
	const controller = new MetaWorkTuiController({
		gateway: new GatewayClient(transport),
		conversationId: "conv_reconnect",
	});
	const action = new MetaWorkActionBar(() => {
		const view = controller.getView();
		return {
			operation: view.operation,
			commandHint: null,
			permissionSummary: null,
			submitting: view.submitting,
			awaitingReceipt: view.awaitingReceipt,
			cancelling: view.cancelling,
			cancelResult: view.cancelResult,
			notice: view.client.notices.at(-1) ?? null,
			silence: null,
			focus: "editor",
		};
	});
	const footer = () => stripVTControlCharacters(action.render(300).join("\n"));
	try {
		await controller.start();
		await vi.waitFor(() => expect(controller.getView().selectedTurn?.id).toBe("completed_turn"));
		expect(controller.getView().client.activeWorkspace).toMatchObject({ id: "workspace", path: "/bound/workspace" });
		controller.setDraft("keep draft");
		await stopServer();
		await vi.waitFor(() => expect(footer()).toContain("connect ENOENT"));
		server = await listen();
		await vi.waitFor(() => expect(controller.getView().client.connection).toBe("ready"));
		expect(controller.getView().selectedTurn).toMatchObject({ id: "completed_turn", status: "completed" });
		expect(controller.getView().client.ui.drafts.conv_reconnect).toBe("keep draft");
		expect(footer()).not.toContain("重连失败");
		expect(footer()).not.toContain("ENOENT");
	} finally {
		controller.stop();
		transport.close();
		if (server.listening) await stopServer();
	}
});
