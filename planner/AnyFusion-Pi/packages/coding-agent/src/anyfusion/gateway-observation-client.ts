import { createHash, randomUUID } from "node:crypto";
import type {
	ConversationActivityView,
	ConversationObservationFrame,
	ConversationReadBaseline,
	ConversationTurnPage,
	ConversationTurnView,
	ConversationViewCursor,
} from "./conversation-observation-protocol.ts";

export interface GatewayObservedConversation {
	readonly atLatest: boolean;
	readonly preparing: boolean;
	readonly conversationId: string;
	readonly turns: readonly ConversationTurnView[];
	readonly nextCursor: string | null;
	readonly cursor: ConversationViewCursor | null;
	readonly activity: ConversationActivityView;
	readonly error: string | null;
}
export interface GatewayObservationPort {
	observe(
		connectionId: string,
		observationId: string,
		conversationId: string,
		cursor?: ConversationViewCursor,
	): Promise<void>;
	unobserve(observationId: string): void;
	onObservation(listener: (frame: ConversationObservationFrame) => void): () => void;
}
interface Follow {
	id: string;
	attempts: number;
	retry?: ReturnType<typeof setTimeout>;
	timeout?: ReturnType<typeof setTimeout>;
	listener: (view: GatewayObservedConversation) => void;
	transfer?: {
		id: string;
		hash: string;
		count: number;
		byteLength: number;
		parts: Map<number, string>;
		bytes: number;
	};
}

/** Bounded, reconnectable client projection. Releasing a view never cancels work. */
export class GatewayObservationClient {
	private readonly port: GatewayObservationPort;
	private readonly connectionId: string;
	private readonly cache = new Map<string, GatewayObservedConversation>();
	private readonly deletedAt = new Map<string, number>();
	private readonly active = new Map<string, Follow>();
	private readonly stop: () => void;
	constructor(port: GatewayObservationPort, connectionId: string) {
		this.port = port;
		this.connectionId = connectionId;
		this.stop = port.onObservation((frame) => this.consume(frame));
	}
	async follow(conversationId: string, listener: Follow["listener"]): Promise<() => void> {
		const previous = this.active.get(conversationId);
		if (previous) this.release(previous);
		if (!previous && this.active.size >= 8) throw new Error("observation_limit");
		const follow: Follow = { id: randomUUID(), listener, attempts: 0 };
		this.active.set(conversationId, follow);
		const cached = this.cache.get(conversationId);
		if (cached) listener(cached);
		try {
			follow.timeout = setTimeout(() => this.reset(conversationId, follow, "observation_timeout"), 10_000);
			follow.timeout.unref?.();
			await this.port.observe(this.connectionId, follow.id, conversationId, cached?.cursor ?? undefined);
		} catch (error) {
			this.release(follow);
			if (this.active.get(conversationId) === follow) this.active.delete(conversationId);
			throw error;
		}
		return () => {
			if (this.active.get(conversationId) !== follow) return;
			this.release(follow);
			this.active.delete(conversationId);
		};
	}
	page(conversationId: string, page: ConversationTurnPage, atLatest = false, expectedEpoch?: string): void {
		const current = this.cache.get(conversationId);
		if (!current || (expectedEpoch !== undefined && current.cursor?.epoch !== expectedEpoch)) return;
		if ((this.deletedAt.get(conversationId) ?? 0) > (page.asOf?.revision ?? 0)) return;
		this.validatePage(conversationId, page);
		// Replace a page rather than accumulating the audit in client memory.
		const resident = new Map(current.turns.map((turn) => [turn.id, turn]));
		const turns = page.turns.map((turn) => {
			const newer = resident.get(turn.id);
			return newer && newer.revision > turn.revision ? newer : turn;
		});
		this.save({ ...current, turns, nextCursor: page.nextCursor, atLatest });
	}
	close(): void {
		this.stop();
		for (const follow of this.active.values()) this.release(follow);
		this.active.clear();
		this.cache.clear();
		this.deletedAt.clear();
	}
	private consume(frame: ConversationObservationFrame): void {
		const follow = this.active.get(frame.conversationId);
		if (!follow || follow.id !== frame.observationId) return;
		try {
			if (Buffer.byteLength(JSON.stringify(frame)) > 65536) throw new Error("observation_frame_budget");
			const current = this.cache.get(frame.conversationId);
			if (frame.kind === "baseline") {
				if (
					!Number.isSafeInteger(frame.count) ||
					frame.count < 1 ||
					frame.count > 8 ||
					!Number.isSafeInteger(frame.index) ||
					frame.index < 0 ||
					frame.index >= frame.count ||
					!Number.isSafeInteger(frame.byteLength) ||
					frame.byteLength < 0 ||
					frame.byteLength > 262144 ||
					typeof frame.data !== "string" ||
					!/^[a-f0-9]{64}$/.test(frame.hash)
				)
					throw new Error("invalid_baseline");
				if (follow.transfer?.id !== frame.transferId) {
					if (follow.timeout) clearTimeout(follow.timeout);
					follow.timeout = setTimeout(() => this.reset(frame.conversationId, follow, "baseline_timeout"), 10_000);
					follow.timeout.unref?.();
					follow.transfer = {
						id: frame.transferId,
						hash: frame.hash,
						count: frame.count,
						byteLength: frame.byteLength,
						parts: new Map(),
						bytes: 0,
					};
				}
				const transfer = follow.transfer;
				if (
					transfer.hash !== frame.hash ||
					transfer.count !== frame.count ||
					transfer.byteLength !== frame.byteLength
				)
					throw new Error("invalid_baseline");
				const previous = transfer.parts.get(frame.index);
				if (previous !== undefined && previous !== frame.data) throw new Error("invalid_baseline");
				if (previous === undefined) {
					transfer.parts.set(frame.index, frame.data);
					transfer.bytes += frame.data.length;
				}
				if (transfer.bytes > 350 * 1024) throw new Error("observation_transfer_budget");
				if (
					[...this.active.values()].reduce((sum, value) => sum + (value.transfer?.bytes ?? 0), 0) >
					2 * 1024 * 1024
				)
					throw new Error("observation_connection_budget");
				if (transfer.parts.size !== transfer.count) return;
				const bytes = Buffer.from(
					Array.from({ length: transfer.count }, (_, i) => transfer.parts.get(i)!).join(""),
					"base64",
				);
				if (
					bytes.length !== transfer.byteLength ||
					createHash("sha256").update(bytes).digest("hex") !== transfer.hash
				)
					throw new Error("invalid_baseline_hash");
				const value = JSON.parse(bytes.toString("utf8")) as ConversationReadBaseline;
				this.validatePage(frame.conversationId, value);
				if (
					value.head !== null &&
					(!value.head || typeof value.head.epoch !== "string" || !Number.isSafeInteger(value.head.revision))
				)
					throw new Error("invalid_baseline_head");
				if (follow.timeout) clearTimeout(follow.timeout);
				follow.transfer = undefined;
				if (current?.cursor?.epoch !== value.head?.epoch) this.deletedAt.delete(frame.conversationId);
				this.save({
					atLatest: true,
					preparing: !value.head,
					conversationId: frame.conversationId,
					turns: value.turns,
					nextCursor: value.nextCursor,
					cursor: value.head,
					activity: current?.activity ?? { tasks: [], pendingInteractions: [], nextCursor: null },
					error: null,
				});
			} else if (frame.kind === "patch" && current) {
				const change = frame.change;
				if (current.cursor?.epoch === change.epoch && change.revision <= current.cursor.revision) return;
				if (
					!current.cursor ||
					current.cursor.epoch !== change.epoch ||
					current.cursor.revision !== change.prevRevision ||
					change.revision !== change.prevRevision + 1 ||
					change.turn.conversationId !== frame.conversationId
				)
					throw new Error("observation_revision_gap");
				this.validatePage(frame.conversationId, { turns: [change.turn], nextCursor: null });
				if (change.removed) this.deletedAt.set(frame.conversationId, change.revision);
				const resident = current.turns.some((turn) => turn.id === change.turn.id);
				const turns = current.turns.filter((turn) => turn.id !== change.turn.id);
				if (!change.removed && (current.atLatest || resident)) turns.push(change.turn);
				turns.sort((a, b) => a.firstSequence - b.firstSequence || a.id.localeCompare(b.id));
				this.save({
					...current,
					turns: turns.slice(-50),
					nextCursor: turns.length > 50 ? "window_anchor" : current.nextCursor,
					cursor: { epoch: change.epoch, revision: change.revision },
				});
			} else if (frame.kind === "activity" && current) this.save({ ...current, activity: frame.view });
			else if (frame.kind === "freshness" && current) {
				if (!follow.transfer && follow.timeout) clearTimeout(follow.timeout);
				this.save({ ...current, preparing: frame.preparing });
			} else if (frame.kind === "reset") {
				follow.transfer = undefined;
				// Server sends the replacement baseline on this stream. Bound a lost transfer.
				if (follow.timeout) clearTimeout(follow.timeout);
				follow.timeout = setTimeout(() => this.reset(frame.conversationId, follow, "baseline_timeout"), 10_000);
				follow.timeout.unref?.();
			} else if (frame.kind === "closed") {
				if (frame.reason !== "authorization_revoked") {
					this.reset(frame.conversationId, follow, frame.reason);
					return;
				}
				this.release(follow);
				this.cache.delete(frame.conversationId);
				this.deletedAt.delete(frame.conversationId);
				this.active.delete(frame.conversationId);
				follow.listener({
					atLatest: true,
					preparing: false,
					conversationId: frame.conversationId,
					turns: [],
					nextCursor: null,
					cursor: null,
					activity: { tasks: [], pendingInteractions: [], nextCursor: null },
					error: frame.reason,
				});
			}
		} catch (error) {
			this.reset(frame.conversationId, follow, (error as Error).message);
		}
	}
	private validatePage(conversationId: string, page: ConversationTurnPage): void {
		if (
			!page ||
			!Array.isArray(page.turns) ||
			page.turns.length > 50 ||
			(page.nextCursor !== null && typeof page.nextCursor !== "string") ||
			page.turns.some(
				(turn) =>
					!turn ||
					turn.conversationId !== conversationId ||
					typeof turn.id !== "string" ||
					!Number.isSafeInteger(turn.revision) ||
					typeof turn.userInput !== "string" ||
					typeof turn.answer !== "string" ||
					Buffer.byteLength(JSON.stringify(turn)) > 16 * 1024,
			)
		)
			throw new Error("observation_scope_mismatch");
	}
	private release(follow: Follow): void {
		this.port.unobserve(follow.id);
		if (follow.retry) clearTimeout(follow.retry);
		if (follow.timeout) clearTimeout(follow.timeout);
		follow.transfer = undefined;
	}
	private reset(conversationId: string, follow: Follow, error: string): void {
		if (this.active.get(conversationId) !== follow) return;
		this.release(follow);
		follow.id = randomUUID();
		const current = this.cache.get(conversationId);
		if (current) this.save({ ...current, error, preparing: true });
		const delay = Math.min(30_000, 250 * 2 ** Math.min(follow.attempts++, 7));
		follow.retry = setTimeout(() => {
			if (this.active.get(conversationId) !== follow) return;
			follow.timeout = setTimeout(() => this.reset(conversationId, follow, "observation_timeout"), 10_000);
			follow.timeout.unref?.();
			void this.port
				.observe(this.connectionId, follow.id, conversationId)
				.catch(() => this.reset(conversationId, follow, "read_unavailable"));
		}, delay);
		follow.retry.unref?.();
	}
	private save(view: GatewayObservedConversation): void {
		this.cache.delete(view.conversationId);
		this.cache.set(view.conversationId, view);
		while (this.cache.size > 8) {
			const candidate = [...this.cache.keys()].find((id) => !this.active.has(id));
			if (!candidate) break;
			this.cache.delete(candidate);
			this.deletedAt.delete(candidate);
		}
		this.active.get(view.conversationId)?.listener(view);
	}
}
