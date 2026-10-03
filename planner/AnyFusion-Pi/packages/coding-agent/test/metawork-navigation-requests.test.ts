import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationObservationFrame } from "../src/anyfusion/conversation-observation-protocol.ts";
import { GatewayClient } from "../src/anyfusion/gateway-client.ts";
import type {
	GatewayCommandEnvelope,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
} from "../src/anyfusion/gateway-protocol.ts";
import { MetaWorkTuiController } from "../src/modes/metawork-tui/controller.ts";
import { baselineFrame, turn } from "./helpers/observation-fixture.ts";

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
	let observation: (frame: ConversationObservationFrame) => void = () => {};
	let disconnected = () => {};
	let sequence = 0;
	let holdHistory = false;
	let holdSubmissions = false;
	let holdObservation = false;
	const pending: PendingRequest[] = [];
	const commands: GatewayCommandEnvelope[] = [];
	const observations: Array<{ id: string; conversationId: string }> = [];
	const releases: string[] = [];
	const emit = (
		kind: GatewayEventEnvelope["kind"],
		payload: unknown,
		requestId: string | null = null,
		conversationId = "directory",
	) => {
		sequence++;
		listener({
			protocolVersion: 2,
			eventId: `event_${sequence}`,
			sequence,
			accountId: "local-default",
			conversationId,
			requestId,
			turnId: null,
			kind,
			payload,
			occurredAt: "2026-10-03T00:00:00Z",
		});
	};
	const receipt = (envelope: GatewayCommandEnvelope, reason?: string): GatewayCommandReceipt => ({
		requestId: envelope.requestId,
		status: reason ? "rejected" : "accepted",
		conversationId:
			envelope.scope.kind === "conversation" && envelope.scope.selection.mode === "attach"
				? envelope.scope.selection.conversationId
				: null,
		...(reason ? { reason } : {}),
	});
	const gateway = new GatewayClient({
		subscribe: (cb) => {
			listener = cb;
			return () => {};
		},
		onObservation: (cb) => {
			observation = cb;
			return () => {};
		},
		observe: async (_connection, id, conversationId) => {
			observations.push({ id, conversationId });
			if (!holdObservation)
				observation(
					baselineFrame(conversationId, id, {
						head: { epoch: "epoch", revision: 1, journalSequence: 1 },
						turns: [turn(conversationId, `seed_${conversationId}`)],
						nextCursor: "older",
					}),
				);
		},
		unobserve: (id) => {
			releases.push(id);
		},
		onDisconnect: (cb) => {
			disconnected = cb;
			return () => {};
		},
		submit: async (envelope) => {
			commands.push(envelope);
			if (
				envelope.command.kind === "list_workspace_conversations" ||
				(holdHistory && envelope.command.kind === "get_conversation_resource") ||
				(holdSubmissions && envelope.command.kind === "user_message")
			) {
				return new Promise<GatewayCommandReceipt>((resolve, reject) => pending.push({ envelope, resolve, reject }));
			}
			return receipt(envelope);
		},
	});
	const controller = new MetaWorkTuiController({ gateway });
	controllers.push(controller);
	return {
		controller,
		commands,
		pending,
		observations,
		releases,
		emit,
		holdHistory: () => {
			holdHistory = true;
		},
		holdSubmissions: (value = true) => {
			holdSubmissions = value;
		},
		holdObservation: () => {
			holdObservation = true;
		},
		disconnect: () => disconnected(),
		frame: (frame: ConversationObservationFrame) => observation(frame),
		finish: (request: PendingRequest, reason?: string) => request.resolve(receipt(request.envelope, reason)),
		history: (request: PendingRequest, id: string) => {
			const command = request.envelope.command;
			if (command.kind !== "get_conversation_resource") throw new Error("not_resource");
			emit(
				"conversation_resource",
				{
					targetConversationId: command.conversationId,
					resource: "turns",
					page: { turns: [turn(command.conversationId, id)], nextCursor: null },
				},
				request.envelope.requestId,
			);
		},
		page: (request: PendingRequest, id: string, nextCursor: string | null = null) => {
			const command = request.envelope.command;
			if (command.kind !== "list_workspace_conversations") throw new Error("not_directory");
			emit(
				"workspace_directory_snapshot",
				{
					workspaceId: command.workspaceId,
					query: command.query ?? "",
					requestedCursor: command.cursor ?? null,
					page: { items: [{ conversationId: id, workspaceId: command.workspaceId, title: id }], nextCursor },
				},
				request.envelope.requestId,
			);
		},
		workspace: () =>
			emit("workspace_directory_snapshot", {
				workspaceId: "ws",
				workspace: { id: "ws", path: "/repo" },
				page: { items: [], nextCursor: null },
			}),
	};
}
describe("navigation request correlation", () => {
	it("purges drafts and fences late reads when the selected Conversation is revoked", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.controller.setDraft("private draft");
		h.holdHistory();
		const older = h.controller.loadOlderHistory();
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		h.frame({
			kind: "closed",
			conversationId: "a",
			observationId: h.observations[0]!.id,
			reason: "authorization_revoked",
		});
		h.history(h.pending[0]!, "stale");
		h.finish(h.pending[0]!);
		await older;
		expect(h.controller.getView().client.ui.drafts.a).toBeUndefined();
		expect(h.controller.getView().client.conversations.a).toBeUndefined();
		expect(h.controller.getView().conversationId).toBeNull();
		expect(h.controller.getView().reader).toBeNull();
	});

	it("switches through explicit observers without attach or journal replay and restores cache immediately", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.controller.setDraft("draft A");
		await h.controller.attachConversation("b", false);
		h.controller.setDraft("draft B");
		h.holdObservation();
		const switching = h.controller.attachConversation("a", false);
		expect(h.controller.getView().visibleTurns[0]?.id).toBe("seed_a");
		await switching;
		expect(h.controller.getView().client.ui.drafts).toMatchObject({ a: "draft A", b: "draft B" });
		expect(h.commands).toEqual([]);
		expect(h.releases).toHaveLength(2);
	});
	it("coalesces older reads and pages from the oldest resident Turn rather than an evicted cursor", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdHistory();
		const one = h.controller.loadOlderHistory();
		const two = h.controller.loadOlderHistory();
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		expect(h.pending[0]?.envelope.command).toMatchObject({
			kind: "get_conversation_resource",
			beforeTurnId: "seed_a",
		});
		h.history(h.pending[0]!, "old");
		h.finish(h.pending[0]!);
		await Promise.all([one, two]);
		expect(h.controller.getView().visibleTurns.map((t) => t.id)).toEqual(["old"]);
	});
	it.each(["a", "b"])("ignores delayed page replies after selecting %s in a new generation", async (target) => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdHistory();
		const older = h.controller.loadOlderHistory();
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		await h.controller.attachConversation(target, false);
		h.history(h.pending[0]!, "stale");
		h.finish(h.pending[0]!);
		await older;
		expect(h.controller.getView().visibleTurns.map((t) => t.id)).toEqual([`seed_${target}`]);
	});
	it("does not refetch history or steal focus when an old submission receipt arrives", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdSubmissions();
		const submitted = h.controller.submit("message A");
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		await h.controller.attachConversation("b", false);
		h.finish(h.pending[0]!);
		await submitted;
		expect(h.controller.getView().conversationId).toBe("b");
		expect(h.commands).toHaveLength(1);
		expect(h.pending[0]?.envelope.scope).toMatchObject({ selection: { conversationId: "a" } });
	});
	it("reconnects observers and resends the identical uncertain envelope without losing drafts", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		h.holdSubmissions();
		const submitted = h.controller.submit("message");
		await vi.waitFor(() => expect(h.pending).toHaveLength(1));
		h.pending[0]!.reject(new Error("lost receipt"));
		await submitted;
		h.controller.setDraft("next message");
		h.holdSubmissions(false);
		h.disconnect();
		await vi.waitFor(() => expect(h.controller.getView().client.connection).toBe("ready"));
		expect(h.commands).toHaveLength(2);
		expect(h.commands[1]).toEqual(h.commands[0]);
		expect(h.controller.getView().client.ui.drafts.a).toBe("next message");
	});
	it("ignores old observation frames during A/B/A switching", async () => {
		const h = harness();
		await h.controller.start();
		await h.controller.attachConversation("a", false);
		const first = h.observations[0]!;
		await h.controller.attachConversation("b", false);
		await h.controller.attachConversation("a", false);
		h.frame({ kind: "closed", conversationId: "a", observationId: first.id, reason: "authorization_revoked" });
		expect(h.controller.getView().visibleTurns[0]?.id).toBe("seed_a");
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
		expect(h.controller.getView().client.conversationSummaries.map((item) => item.conversationId)).toEqual(["first"]);
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
		expect(
			h.controller
				.getView()
				.client.conversationSummaries.map((item) => item.conversationId)
				.sort(),
		).toEqual(["first", "second"]);
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
		expect(
			h.controller
				.getView()
				.client.conversationSummaries.map((item) => item.conversationId)
				.sort(),
		).toEqual(["new", "new_second"]);
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
