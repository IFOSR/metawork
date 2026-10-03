import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationActivityView } from "../src/anyfusion/conversation-observation-protocol.ts";
import type { MetaWorkConversationSummary } from "../src/modes/metawork-tui/model.ts";
import { WorkspaceTaskOverview } from "../src/modes/metawork-tui/task-overview.ts";

const summary = (id: string, workspaceId = "ws"): MetaWorkConversationSummary => ({
	conversationId: id,
	workspaceId,
	title: id,
	preview: "",
	updatedAt: "",
	activity: { state: "executing", taskId: null, updatedAt: "" },
});
const activity = (id: string, phase = "executing", nextCursor: string | null = null): ConversationActivityView => ({
	tasks: [{ taskId: id, title: id, phase, executionGeneration: "g", explanation: "", canCancel: true }],
	pendingInteractions: [],
	nextCursor,
});
afterEach(() => vi.useRealTimers());

describe("Workspace task overview resource isolation", () => {
	it("refreshes different Conversations without a detailed subscription or changing their selection", async () => {
		vi.useFakeTimers();
		let phase = "queued";
		const read = vi.fn(async (id: string) => activity(id, id === "c" ? phase : "executing"));
		const overview = new WorkspaceTaskOverview(read, () => undefined);
		overview.update(
			"ws",
			["a", "b", "c"].map((id) => summary(id)),
		);
		await vi.advanceTimersByTimeAsync(2_100);
		expect(overview.state().rows.map((row) => row.phase)).toEqual(["executing", "executing", "queued"]);
		phase = "blocked";
		await vi.advanceTimersByTimeAsync(3_000);
		expect(overview.state().rows[2]?.phase).toBe("blocked");
		overview.clear();
		const calls = read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledTimes(calls);
	});

	it("fences old Workspace reads and gives newer observed activity precedence", async () => {
		vi.useFakeTimers();
		let finish!: (page: ConversationActivityView) => void;
		const overview = new WorkspaceTaskOverview(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
			() => undefined,
		);
		overview.update("ws", [summary("a")]);
		await vi.advanceTimersByTimeAsync(0);
		overview.observe("a", activity("a", "blocked"));
		finish(activity("a"));
		await vi.advanceTimersByTimeAsync(0);
		expect(overview.state().rows[0]?.phase).toBe("blocked");
		await vi.advanceTimersByTimeAsync(3_000);
		overview.update("other", [summary("b", "other")]);
		finish(activity("a"));
		await vi.advanceTimersByTimeAsync(0);
		expect(overview.state().rows).toEqual([]);
		overview.clear();
	});

	it("keeps a requested activity page while refreshing and offers a return to the first page", async () => {
		vi.useFakeTimers();
		const read = vi.fn(async (_id: string, cursor?: string) =>
			cursor ? activity("older") : activity("first", "queued", "next"),
		);
		const overview = new WorkspaceTaskOverview(read, () => undefined);
		overview.update("ws", [summary("a")]);
		await vi.advanceTimersByTimeAsync(0);
		expect(overview.state().more).toEqual(["a"]);
		await overview.loadMore("a");
		expect(overview.state().rows[0]?.taskId).toBe("older");
		await vi.advanceTimersByTimeAsync(3_000);
		expect(overview.state().rows[0]?.taskId).toBe("older");
		expect(overview.state().previous).toEqual(["a"]);
		await overview.first("a");
		expect(overview.state().rows[0]?.taskId).toBe("first");
		overview.clear();
	});
});
