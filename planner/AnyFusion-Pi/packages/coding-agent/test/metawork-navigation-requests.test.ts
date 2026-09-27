import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../src/anyfusion/gateway-client.ts";
import type {
	GatewayCommandEnvelope,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayReplay,
	GatewayReplayReset,
} from "../src/anyfusion/gateway-protocol.ts";
import { MetaWorkTuiController } from "../src/modes/metawork-tui/controller.ts";

interface PendingRequest {
	envelope: GatewayCommandEnvelope;
	resolve: (receipt: GatewayCommandReceipt) => void;
	reject: (error: Error) => void;
}

const controllers: MetaWorkTuiController[] = [];
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.stop();
});

function harness() {
	let listener: (event: GatewayEventEnvelope) => void = () => {};
	let sequence = 0;
	let holdHistory = false;
	let holdSubmissions = false;
	let holdReplay = false;
	let resetListener: (reset: GatewayReplayReset) => void = () => {};
	let disconnectListener: () => void = () => {};
	const replayCalls: string[] = [];
	const replayWaiters: Array<(replay: GatewayReplay) => void> = [];
	const pending: PendingRequest[] = [];
	const commands: GatewayCommandEnvelope[] = [];
	const emit = (kind: GatewayEventEnvelope["kind"], payload: unknown, requestId: string | null = null,
		conversationId = "directory", turnId: string | null = null) => {
		sequence += 1;
		listener({
			protocolVersion: 2, eventId: `event_${sequence}`, sequence, accountId: "local-default",
			conversationId, requestId, turnId, kind, payload, occurredAt: "2026-09-26T00:00:00Z",
		});
	};
	const receipt = (envelope: GatewayCommandEnvelope, reason?: string): GatewayCommandReceipt => ({
		requestId: envelope.requestId, status: reason ? "rejected" : "accepted",
		conversationId: envelope.scope.kind === "conversation" && envelope.scope.selection.mode === "attach"
			? envelope.scope.selection.conversationId : null,
		...(reason ? { reason } : {}),
	});
	const page = (request: PendingRequest, id: string, nextCursor: string | null = null) => {
		const command = request.envelope.command;
		if (command.kind !== "list_workspace_conversations") throw new Error("not_directory");
		emit("workspace_directory_snapshot", {
			workspaceId: command.workspaceId, query: command.query ?? "", requestedCursor: command.cursor ?? null,
			page: { items: [{ conversationId: id, workspaceId: command.workspaceId, title: id }], nextCursor },
		}, request.envelope.requestId);
	};
	const history = (request: PendingRequest, id: string, fragmented = false) => {
		const command = request.envelope.command;
		if (command.kind !== "get_conversation_history") throw new Error("not_history");
		const payload = {
			turns: [{ id, status: "completed", userInput: id }],
			previousCursor: command.cursor ?? null, nextCursor: "older",
		};
		if (!fragmented) return [() => emit("conversation_history_page", payload,
			request.envelope.requestId, command.conversationId)];
		const body = Buffer.from(JSON.stringify(payload));
		const encoded = body.toString("base64");
		const split = Math.floor(encoded.length / 8) * 4;
		return [encoded.slice(0, split), encoded.slice(split)].map((data, index) => () => {
			emit("conversation_history_page", { transfer: {
				id: request.envelope.requestId, index, count: 2, byteLength: body.length,
				hash: createHash("sha256").update(body).digest("hex"), data,
			} }, request.envelope.requestId, command.conversationId);
		});
	};
	const gateway = new GatewayClient({
		subscribe: callback => { listener = callback; return () => {}; },
		replay: async conversationId => {
			replayCalls.push(conversationId);
			if (holdReplay) return new Promise<GatewayReplay>(resolve => replayWaiters.push(resolve));
			return { lastSequence: 0, snapshot: [], deltas: [] };
		},
		onReplayReset: callback => { resetListener = callback; return () => {}; },
		onDisconnect: callback => { disconnectListener = callback; return () => {}; },
		getServerCapabilities: () => ["history_page_fragments_v1"],
		submit: async envelope => {
			commands.push(envelope);
			if (envelope.command.kind === "list_workspace_conversations"
				|| (envelope.command.kind === "user_message" && holdSubmissions)
				|| (envelope.command.kind === "get_conversation_history" && holdHistory)) {
				return new Promise<GatewayCommandReceipt>((resolve, reject) => {
					pending.push({ envelope, resolve, reject });
				});
			}
			if (envelope.command.kind === "get_conversation_history") {
				emit("conversation_history_page", {
					turns: [{ id: `seed_${envelope.command.conversationId}`, status: "completed" }], nextCursor: "older",
				}, envelope.requestId, envelope.command.conversationId);
			}
			return receipt(envelope);
		},
	});
	const controller = new MetaWorkTuiController({ gateway });
	controllers.push(controller);
	return {
		controller, commands, pending, emit, page, history, replayCalls,
		holdHistory: () => { holdHistory = true; },
		holdSubmissions: (value = true) => { holdSubmissions = value; },
		holdReplay: () => { holdReplay = true; },
		reset: (conversationId: string) => {
			sequence = 0;
			resetListener({ conversationId, lastSequence: 3, reason: "cursor_ahead", snapshotVersion: 1 });
		},
		disconnect: () => disconnectListener(),
		finishReplay: () => {
			holdReplay = false;
			sequence = Math.max(sequence, 3);
			for (const resolve of replayWaiters.splice(0)) resolve({ lastSequence: 3, snapshot: [], deltas: [] });
		},
		finish: (request: PendingRequest, reason?: string) => request.resolve(receipt(request.envelope, reason)),
		workspace: () => emit("workspace_directory_snapshot", {
			workspaceId: "ws", workspace: { id: "ws", path: "/repo" }, page: { items: [], nextCursor: null },
		}),
	};
}

describe("navigation request correlation", () => {
	it("resets only the affected projection before snapshots and refreshes history after reconnect", async () => {
		const h = harness();
		await h.controller.start();
		h.workspace();
		await h.controller.attachConversation("other", false);
		await h.controller.attachConversation("a", false);
		h.holdSubmissions();
		const submit = h.controller.submit("pending");
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		h.pending[0]!.reject(new Error("lost receipt"));
		await submit;
		h.holdSubmissions(false);
		h.controller.setDraft("keep draft");
		const before = h.controller.getView().client;
		const historyCount = h.commands.filter(item => item.command.kind === "get_conversation_history").length;
		h.holdReplay();
		h.disconnect();
		await vi.waitFor(() => expect(h.replayCalls.length).toBeGreaterThan(2));
		h.reset("a");
		expect(h.controller.getView().visibleTurns).toEqual([]);
		const resetState = h.controller.getView().client;
		expect(resetState.ui.drafts.a).toBe("keep draft");
		expect(resetState.pendingSubmissions[h.pending[0]!.envelope.requestId]?.envelope)
			.toEqual(h.pending[0]!.envelope);
		expect(resetState.conversations.other).toEqual(before.conversations.other);
		expect(resetState.activeWorkspace).toEqual(before.activeWorkspace);
		h.emit("turn_started", { commandKind: "user_message" }, null, "a", "snapshot_turn");
		expect(h.controller.getView().visibleTurns.map(turn => turn.id)).toEqual(["snapshot_turn"]);
		h.finishReplay();
		await vi.waitFor(() => expect(h.controller.getView().client.connection).toBe("ready"));
		expect(h.replayCalls).toEqual(["other", "a", "a"]);
		const history = h.commands.filter(item => item.command.kind === "get_conversation_history");
		expect(history).toHaveLength(historyCount + 1);
		expect(history.at(-1)?.command).not.toHaveProperty("cursor");
	});

	it("ignores pre-reset history errors and starts a fresh newest-page request", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdHistory();
		const older = h.controller.loadOlderHistory();
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		h.holdReplay();
		h.disconnect();
		await vi.waitFor(() => expect(h.replayCalls.length).toBeGreaterThan(1));
		h.reset("a");
		h.finishReplay();
		await vi.waitFor(() => expect(h.pending).toHaveLength(2));
		h.history(h.pending[1]!, "fresh")[0]!();
		h.finish(h.pending[1]!);
		h.pending[0]!.reject(new Error("pre-reset failure"));
		await older;
		await vi.waitFor(() => expect(h.controller.getView().client.connection).toBe("ready"));
		expect(h.controller.getView().historyStatus).toBe("partial");
		expect(h.controller.getView().visibleTurns.map(turn => turn.id)).toEqual(["fresh"]);
	});

	it("does not change the selected Conversation or Workspace for a reset of another stream", async () => {
		const h = harness();
		await h.controller.start();
		h.workspace();
		await h.controller.attachConversation("other", false);
		await h.controller.attachConversation("a", false);
		const before = h.controller.getView();
		h.reset("other");
		expect(h.controller.getView().conversationId).toBe("a");
		expect(h.controller.getView().visibleTurns).toEqual(before.visibleTurns);
		expect(h.controller.getView().client.activeWorkspace).toEqual(before.client.activeWorkspace);
		expect(h.controller.getView().client.conversations.other?.turnOrder).toEqual([]);
	});

	it("finishes reconnecting when navigation supersedes the recovering Conversation", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdReplay();
		h.disconnect();
		await vi.waitFor(() => expect(h.replayCalls).toHaveLength(2));
		const attach = h.controller.attachConversation("b", false);
		expect(h.controller.getView().conversationId).toBe("b");
		h.reset("a");
		h.finishReplay();
		await attach;
		expect(h.controller.getView().conversationId).toBe("b");
		expect(h.controller.getView().client.connection).toBe("ready");
	});

	it("coalesces repeated older-history loads", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdHistory();
		const first = h.controller.loadOlderHistory();
		const second = h.controller.loadOlderHistory();
		await vi.waitFor(() => expect(h.pending.length).toBeGreaterThan(0));
		expect(h.pending).toHaveLength(1);
		for (const frame of h.history(h.pending[0]!, "older", true)) frame();
		h.finish(h.pending[0]!);
		await Promise.all([first, second]);
		expect(h.controller.getView().visibleTurns.map(turn => turn.id)).toContain("older");
		expect(h.controller.getView().client.notices).toEqual([]);
	});

	it("serializes a newest-page refresh behind an older-page transfer", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdHistory();
		const older = h.controller.loadOlderHistory();
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		const frames = h.history(h.pending[0]!, "older", true);
		frames[0]!();
		const submit = h.controller.submit("hello");
		await vi.waitFor(() => expect(h.commands.some(item => item.command.kind === "user_message")).toBe(true));
		expect(h.pending).toHaveLength(1);
		frames[1]!();
		h.finish(h.pending[0]!);
		await older;
		await vi.waitFor(() => expect(h.pending).toHaveLength(2));
		expect(h.pending[1]!.envelope.command).toMatchObject({ kind: "get_conversation_history" });
		expect(h.pending[1]!.envelope.command).not.toHaveProperty("cursor");
		for (const frame of h.history(h.pending[1]!, "newest", true)) frame();
		h.finish(h.pending[1]!);
		await submit;
		expect(h.controller.getView().visibleTurns.map(turn => turn.id)).toEqual(["older", "seed_a", "newest"]);
		expect(h.controller.getView().client.notices).toEqual([]);
	});

	it("coalesces fresh reads requested during an in-flight newest page into one follow-up", async () => {
		const h = harness();
		await h.controller.start();
		h.holdHistory();
		const attach = h.controller.attachConversation("a", false);
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		const one = h.controller.submit("one");
		const two = h.controller.submit("two");
		await vi.waitFor(() => expect(h.commands.filter(item => item.command.kind === "user_message")).toHaveLength(2));
		expect(h.pending).toHaveLength(1);
		h.history(h.pending[0]!, "before_submit")[0]!();
		h.finish(h.pending[0]!);
		await vi.waitFor(() => expect(h.pending).toHaveLength(2));
		h.history(h.pending[1]!, "after_submit")[0]!();
		h.finish(h.pending[1]!);
		await Promise.all([attach, one, two]);
		expect(h.pending).toHaveLength(2);
		expect(h.controller.getView().visibleTurns.map(turn => turn.id)).toContain("after_submit");
	});

	it("does not navigate back or refresh history when a submission receipt outlives its selection", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdSubmissions();
		const submit = h.controller.submit("hello");
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		await h.controller.attachConversation("b", false);
		const before = h.commands.length;
		h.finish(h.pending[0]!);
		await submit;
		expect(h.controller.getView().conversationId).toBe("b");
		expect(h.commands).toHaveLength(before);
	});

	it.each([
		["rejected", "b"], ["thrown", "b"], ["rejected", "a"], ["thrown", "a"],
	] as const)("ignores %s history errors after attaching %s in a new generation", async (mode, target) => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdHistory();
		const old = h.controller.loadOlderHistory();
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		const attach = h.controller.attachConversation(target, false);
		await vi.waitFor(() => expect(h.pending).toHaveLength(2));
		h.history(h.pending[1]!, "b")[0]!();
		h.finish(h.pending[1]!);
		await attach;
		if (mode === "thrown") h.pending[0]!.reject(new Error("late failure"));
		else h.finish(h.pending[0]!, "history_unavailable");
		await old;
		expect(h.controller.getView().conversationId).toBe(target);
		expect(h.controller.getView().historyStatus).toBe("partial");
	});

	it("drops frames from the previous A generation during A/B/A navigation", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdHistory();
		const old = h.controller.loadOlderHistory();
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		const oldFrames = h.history(h.pending[0]!, "stale", true);
		oldFrames[0]!();
		const b = h.controller.attachConversation("b", false);
		await vi.waitFor(() => expect(h.pending).toHaveLength(2));
		const a = h.controller.attachConversation("a", false);
		await vi.waitFor(() => expect(h.pending).toHaveLength(3));
		const frames = h.history(h.pending[2]!, "fresh", true);
		frames[0]!();
		h.emit("conversation_history_page", { transfer: null }, h.pending[0]!.envelope.requestId, "a");
		oldFrames[0]!();
		oldFrames[1]!();
		frames[1]!();
		h.finish(h.pending[2]!);
		h.finish(h.pending[1]!);
		h.finish(h.pending[0]!);
		await Promise.all([old, b, a]);
		expect(h.controller.getView().visibleTurns.map(turn => turn.id)).toEqual(["seed_a", "fresh"]);
		expect(h.controller.getView().client.notices).toEqual([]);
	});

	it("abandons a queued newest-page refresh when its navigation generation changes", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdHistory();
		const older = h.controller.loadOlderHistory();
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		const submit = h.controller.submit("hello");
		await vi.waitFor(() => expect(h.commands.some(item => item.command.kind === "user_message")).toBe(true));
		const attach = h.controller.attachConversation("b", false);
		await vi.waitFor(() => expect(h.pending).toHaveLength(2));
		h.finish(h.pending[0]!);
		await Promise.all([older, submit]);
		expect(h.pending).toHaveLength(2);
		expect(h.controller.getView().navigationPending).toBe(true);
		h.history(h.pending[1]!, "b")[0]!();
		h.finish(h.pending[1]!);
		await attach;
		expect(h.controller.getView().conversationId).toBe("b");
	});

	it("does not let an old attach completion clear a newer navigation", async () => {
		const h = harness();
		await h.controller.start();
		h.holdHistory();
		const a = h.controller.attachConversation("a", false);
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		const b = h.controller.attachConversation("b", false);
		await vi.waitFor(() => expect(h.pending).toHaveLength(2));
		h.finish(h.pending[0]!);
		await a;
		expect(h.controller.getView().navigationPending).toBe(true);
		expect(h.controller.getView().operation).not.toBeNull();
		h.finish(h.pending[1]!);
		await b;
	});

	it("correlates ABA directory queries and accepts page events before receipts", async () => {
		const h = harness();
		await h.controller.start();
		h.workspace();
		const old = h.controller.refreshConversationDirectory("a");
		const other = h.controller.refreshConversationDirectory("b");
		const current = h.controller.refreshConversationDirectory("a");
		await vi.waitFor(() => expect(h.pending).toHaveLength(3));
		h.page(h.pending[2]!, "first", "next");
		expect(h.controller.getView().client.conversationSummaries.map(item => item.conversationId)).toEqual(["first"]);
		h.finish(h.pending[2]!);
		await current;
		const more = h.controller.loadMoreConversations();
		await vi.waitFor(() => expect(h.pending).toHaveLength(4));
		h.page(h.pending[3]!, "second");
		h.finish(h.pending[3]!);
		await more;
		h.page(h.pending[0]!, "stale");
		h.finish(h.pending[0]!);
		h.finish(h.pending[1]!);
		await Promise.all([old, other]);
		expect(h.controller.getView().client.conversationSummaries.map(item => item.conversationId).sort())
			.toEqual(["first", "second"]);
	});

	it("keeps newer directory paging locked when an old query page fails", async () => {
		const h = harness();
		await h.controller.start();
		h.workspace();
		const first = h.controller.refreshConversationDirectory("a");
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		h.page(h.pending[0]!, "first", "next_a");
		h.finish(h.pending[0]!);
		await first;
		const oldMore = h.controller.loadMoreConversations();
		await vi.waitFor(() => expect(h.pending).toHaveLength(2));
		const search = h.controller.refreshConversationDirectory("b");
		await vi.waitFor(() => expect(h.pending).toHaveLength(3));
		h.page(h.pending[2]!, "new", "next_b");
		h.finish(h.pending[2]!);
		await search;
		const more = h.controller.loadMoreConversations();
		await vi.waitFor(() => expect(h.pending).toHaveLength(4));
		h.finish(h.pending[1]!, "stale_directory_cursor");
		await oldMore;
		await h.controller.loadMoreConversations();
		expect(h.pending).toHaveLength(4);
		h.page(h.pending[3]!, "new_second");
		h.finish(h.pending[3]!);
		await more;
		expect(h.controller.getView().client.conversationDirectoryQuery).toBe("b");
		expect(h.controller.getView().client.conversationSummaries.map(item => item.conversationId).sort())
			.toEqual(["new", "new_second"]);
	});

	it("ignores directory errors from a superseded query", async () => {
		const h = harness();
		await h.controller.start();
		h.workspace();
		const old = h.controller.refreshConversationDirectory("old");
		const current = h.controller.refreshConversationDirectory("current");
		await vi.waitFor(() => expect(h.pending).toHaveLength(2));
		h.pending[0]!.reject(new Error("late error"));
		await old;
		expect(h.controller.getView().operation).not.toContain("late error");
		h.page(h.pending[1]!, "current");
		h.finish(h.pending[1]!);
		await current;
		expect(h.controller.getView().operation).toBeNull();
	});
});
