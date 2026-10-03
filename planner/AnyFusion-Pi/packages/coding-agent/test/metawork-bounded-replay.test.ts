import { describe, expect, it, vi } from "vitest";
import type {
	ConversationObservationFrame,
	ConversationViewCursor,
} from "../src/anyfusion/conversation-observation-protocol.ts";
import { GatewayClient } from "../src/anyfusion/gateway-client.ts";
import type { GatewayCommandEnvelope, GatewayEventEnvelope } from "../src/anyfusion/gateway-protocol.ts";
import { baselineFrame, turn } from "./helpers/observation-fixture.ts";

function fixture() {
	let disconnect = () => {};
	let publish = (_event: GatewayEventEnvelope) => {};
	let emit = (_frame: ConversationObservationFrame) => {};
	let identity = "server/account";
	const connect = vi.fn(async () => {});
	const observe = vi.fn(
		async (_connection: string, _id: string, _conversation: string, _cursor?: ConversationViewCursor) => {},
	);
	const submit = vi.fn(async (envelope: GatewayCommandEnvelope) => ({
		requestId: envelope.requestId,
		status: "accepted" as const,
		conversationId: "a",
	}));
	const client = new GatewayClient({
		connect,
		observe,
		submit,
		unobserve: vi.fn(),
		getServerIdentity: () => identity,
		subscribe: (listener) => {
			publish = listener;
			return () => {};
		},
		onObservation: (listener) => {
			emit = listener;
			return () => {};
		},
		onDisconnect: (listener) => {
			disconnect = listener;
			return () => {};
		},
	});
	return {
		client,
		connect,
		observe,
		submit,
		disconnect: () => disconnect(),
		identity: (value: string) => {
			identity = value;
		},
		emit: (frame: ConversationObservationFrame) => emit(frame),
		publish: (event: GatewayEventEnvelope) => publish(event),
	};
}

describe("native observation recovery replaces audit replay", () => {
	it("keeps observation cursors independent of directory and query reply sequences", async () => {
		const h = fixture();
		try {
			h.client.onEvent(() => {});
			await h.client.connect();
			const releaseA = await h.client.followConversation("a", () => {});
			h.emit(
				baselineFrame("a", h.observe.mock.calls.at(-1)![1], {
					head: { epoch: "a-epoch", revision: 2, journalSequence: 5 },
					turns: [turn("a")],
					nextCursor: null,
				}),
			);
			h.publish({
				protocolVersion: 2,
				eventId: "directory",
				sequence: 99999,
				accountId: "account",
				conversationId: "directory",
				turnId: null,
				requestId: null,
				kind: "workspace_directory_snapshot",
				payload: {},
				occurredAt: "",
			});
			releaseA();
			const releaseB = await h.client.followConversation("b", () => {});
			h.emit(
				baselineFrame("b", h.observe.mock.calls.at(-1)![1], {
					head: { epoch: "b-epoch", revision: 7, journalSequence: 80 },
					turns: [turn("b")],
					nextCursor: null,
				}),
			);
			releaseB();
			await h.client.followConversation("a", () => {});
			expect(h.observe.mock.calls.at(-1)?.[3]).toMatchObject({ epoch: "a-epoch", revision: 2 });
			await h.client.followConversation("b", () => {});
			expect(h.observe.mock.calls.at(-1)?.[3]).toMatchObject({ epoch: "b-epoch", revision: 7 });
		} finally {
			h.client.dispose();
		}
	});

	it("waits for the replacement connection before submitting an explicit target", async () => {
		const h = fixture();
		let release!: () => void;
		try {
			await h.client.connect();
			h.connect.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			);
			h.disconnect();
			const pending = h.client.submitUserInput("after reconnect", { mode: "attach", conversationId: "a" });
			await Promise.resolve();
			expect(h.submit).not.toHaveBeenCalled();
			release();
			await expect(pending).resolves.toMatchObject({ status: "accepted" });
			expect(h.submit.mock.calls[0]?.[0].scope).toEqual({
				kind: "conversation",
				selection: { mode: "attach", conversationId: "a" },
			});
			expect(h.observe).not.toHaveBeenCalled();
		} finally {
			h.client.dispose();
		}
	});

	it("recovers a temporary connection failure on the next explicit submission", async () => {
		const h = fixture();
		try {
			await h.client.connect();
			h.connect.mockRejectedValueOnce(new Error("temporary socket failure"));
			h.disconnect();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await expect(
				h.client.submitUserInput("retry", { mode: "attach", conversationId: "b" }),
			).resolves.toMatchObject({ status: "accepted" });
			expect(h.connect).toHaveBeenCalledTimes(3);
			expect(h.submit).toHaveBeenCalledTimes(1);
		} finally {
			h.client.dispose();
		}
	});

	it("purges cached observations and refuses submission after Server identity replacement", async () => {
		const h = fixture();
		try {
			await h.client.connect();
			await h.client.followConversation("a", () => {});
			h.emit(baselineFrame("a", h.observe.mock.calls[0]![1]));
			h.identity("different-server/account");
			h.disconnect();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await expect(h.client.submitUserInput("unsafe", { mode: "attach", conversationId: "a" })).rejects.toThrow(
				"server_identity_changed",
			);
			expect(h.submit).not.toHaveBeenCalled();
		} finally {
			h.client.dispose();
		}
	});

	it("does not resurrect a released observation when a late old baseline arrives", async () => {
		const h = fixture();
		const a = vi.fn();
		const b = vi.fn();
		try {
			const release = await h.client.followConversation("a", a);
			const oldId = h.observe.mock.calls[0]![1];
			release();
			await h.client.followConversation("b", b);
			h.emit(baselineFrame("a", oldId));
			h.emit(baselineFrame("b", h.observe.mock.calls[1]![1]));
			expect(a).not.toHaveBeenCalled();
			expect(b).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "b" }));
		} finally {
			h.client.dispose();
		}
	});
});
