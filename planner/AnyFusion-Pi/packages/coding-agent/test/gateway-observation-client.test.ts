import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationObservationFrame } from "../src/anyfusion/conversation-observation-protocol.ts";
import {
	GatewayObservationClient,
	type GatewayObservedConversation,
} from "../src/anyfusion/gateway-observation-client.ts";
import { baselineFrame, turn } from "./helpers/observation-fixture.ts";

const clients: GatewayObservationClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	vi.useRealTimers();
});
function fixture() {
	let emit: (frame: ConversationObservationFrame) => void = () => {};
	const observe = vi.fn(async (_connection: string, _id: string, _conversation: string) => {});
	const unobserve = vi.fn();
	const client = new GatewayObservationClient(
		{
			observe,
			unobserve,
			onObservation: (listener) => {
				emit = listener;
				return () => {};
			},
		},
		"connection",
	);
	clients.push(client);
	const views: GatewayObservedConversation[] = [];
	return {
		client,
		observe,
		unobserve,
		views,
		emit: (frame: ConversationObservationFrame) => emit(frame),
		follow: (id = "a") => client.follow(id, (view) => views.push(view)),
		id: () => observe.mock.calls.at(-1)![1],
	};
}

describe("native Conversation observation", () => {
	it("keeps a newer live result when an older history page arrives later", async () => {
		const h = fixture();
		await h.follow();
		h.emit(baselineFrame("a", h.id()));
		h.emit({
			kind: "patch",
			conversationId: "a",
			observationId: h.id(),
			change: {
				epoch: "epoch",
				prevRevision: 1,
				revision: 2,
				turn: { ...turn("a", "turn", 2), answer: "new answer" },
			},
		});
		h.client.page(
			"a",
			{ turns: [turn("a")], nextCursor: null, asOf: { epoch: "epoch", revision: 1 } },
			false,
			"epoch",
		);
		expect(h.views.at(-1)?.turns[0]?.answer).toBe("new answer");
	});

	it("does not resurrect a deleted Turn from an older page response", async () => {
		const h = fixture();
		await h.follow();
		h.emit(baselineFrame("a", h.id()));
		h.emit({
			kind: "patch",
			conversationId: "a",
			observationId: h.id(),
			change: { removed: true, epoch: "epoch", prevRevision: 1, revision: 2, turn: turn("a", "turn", 2) },
		});
		h.client.page(
			"a",
			{ turns: [turn("a")], nextCursor: null, asOf: { epoch: "epoch", revision: 1 } },
			false,
			"epoch",
		);
		expect(h.views.at(-1)?.turns).toEqual([]);
	});
	it("retries a missing initial baseline and fences pages from a replaced epoch", async () => {
		vi.useFakeTimers();
		const h = fixture();
		await h.follow();
		await vi.advanceTimersByTimeAsync(10_250);
		expect(h.observe).toHaveBeenCalledTimes(2);
		h.emit(baselineFrame("a", h.id()));
		h.client.page("a", { turns: [turn("a", "stale")], nextCursor: null }, false, "retired-epoch");
		expect(h.views.at(-1)?.turns[0]?.id).not.toBe("stale");
	});
	it("restores cached output before a network round trip and fences old subscription frames", async () => {
		const h = fixture();
		const stop = await h.follow();
		const oldId = h.id();
		h.emit(baselineFrame("a", oldId));
		stop();
		await h.follow("b");
		const before = h.views.length;
		const following = h.follow("a");
		expect(h.views.length).toBe(before + 1);
		expect(h.views.at(-1)?.turns[0]?.answer).toBe("answer");
		await following;
		h.emit({ kind: "closed", conversationId: "a", observationId: oldId, reason: "authorization_revoked" });
		expect(h.views.at(-1)?.turns).toHaveLength(1);
	});
	it("deduplicates patches, preserves readable cache across gaps, and retries a fresh baseline", async () => {
		vi.useFakeTimers();
		const h = fixture();
		await h.follow();
		const id = h.id();
		h.emit(baselineFrame("a", id));
		const patch: ConversationObservationFrame = {
			kind: "patch",
			conversationId: "a",
			observationId: id,
			change: { epoch: "epoch", prevRevision: 1, revision: 2, turn: { ...turn("a"), revision: 2, answer: "new" } },
		};
		h.emit(patch);
		h.emit(patch);
		expect(h.views.at(-1)?.error).toBeNull();
		h.emit({ ...patch, change: { ...patch.change, prevRevision: 3, revision: 4 } });
		expect(h.views.at(-1)?.turns[0]?.answer).toBe("new");
		await vi.advanceTimersByTimeAsync(250);
		expect(h.observe).toHaveBeenCalledTimes(2);
		expect(h.id()).not.toBe(id);
		h.emit(baselineFrame("a", h.id()));
		expect(h.views.at(-1)?.error).toBeNull();
	});
	it("bounds live windows and does not insert new Turns into an older reading page", async () => {
		const h = fixture();
		await h.follow();
		const id = h.id();
		h.emit(
			baselineFrame("a", id, {
				head: { epoch: "epoch", revision: 50, journalSequence: 50 },
				turns: Array.from({ length: 50 }, (_, n) => turn("a", `t${n + 1}`, n + 1)),
				nextCursor: null,
			}),
		);
		h.emit({
			kind: "patch",
			conversationId: "a",
			observationId: id,
			change: { epoch: "epoch", prevRevision: 50, revision: 51, turn: turn("a", "latest", 51) },
		});
		expect(h.views.at(-1)?.turns).toHaveLength(50);
		expect(h.views.at(-1)?.nextCursor).not.toBeNull();
		h.client.page("a", { turns: [turn("a", "old")], nextCursor: null });
		h.emit({
			kind: "patch",
			conversationId: "a",
			observationId: id,
			change: { epoch: "epoch", prevRevision: 51, revision: 52, turn: turn("a", "newer", 52) },
		});
		expect(h.views.at(-1)?.turns.map((turn) => turn.id)).toEqual(["old"]);
		expect(h.views.at(-1)?.cursor?.revision).toBe(52);
		expect(() => h.client.page("a", { turns: [turn("foreign")], nextCursor: null })).toThrow("scope_mismatch");
	});
	it("purges revoked views and cancels recovery timers when the last view closes", async () => {
		vi.useFakeTimers();
		const h = fixture();
		const release = await h.follow();
		h.emit(baselineFrame("a", h.id()));
		h.emit({ kind: "closed", conversationId: "a", observationId: h.id(), reason: "read_unavailable" });
		release();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.observe).toHaveBeenCalledTimes(1);
		await h.follow();
		h.emit({ kind: "closed", conversationId: "a", observationId: h.id(), reason: "authorization_revoked" });
		expect(h.views.at(-1)?.turns).toEqual([]);
		const count = h.views.length;
		await h.follow();
		expect(h.views).toHaveLength(count);
	});
});
