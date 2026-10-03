import { createConnection, type Socket } from "node:net";
import type { ConversationObservationFrame, ConversationViewCursor } from "./conversation-observation-protocol.ts";
import type { GatewayClientDeps } from "./gateway-client.ts";
import type {
	GatewayCommandEnvelope,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayWireClientMessage,
	GatewayWireServerMessage,
} from "./gateway-protocol.ts";
import { GATEWAY_EVENT_KINDS } from "./gateway-protocol.ts";

export const MAX_GATEWAY_JSONL_FRAME_BYTES = 1024 * 1024;

export type GatewayFrameErrorCode = "gateway_malformed_frame" | "gateway_frame_too_large";

export class GatewayFrameError extends Error {
	readonly code: GatewayFrameErrorCode;
	readonly frameBytes: number;
	readonly maxFrameBytes: number;

	constructor(code: GatewayFrameErrorCode, message: string, frameBytes: number, maxFrameBytes: number) {
		super(message);
		this.name = "GatewayFrameError";
		this.code = code;
		this.frameBytes = frameBytes;
		this.maxFrameBytes = maxFrameBytes;
	}
}

export class GatewaySocketTransport implements GatewayClientDeps {
	private serverIdentity: string | null = null;
	getServerIdentity(): string | null {
		return this.serverIdentity;
	}
	private socket: Socket | null = null;
	private connecting: Promise<void> | null = null;
	private buffer = "";
	private connectionReady = false;
	private readonly pendingReceipts = new Map<
		string,
		{
			resolve(receipt: GatewayCommandReceipt): void;
			reject(error: Error): void;
		}
	>();
	private readonly eventListeners = new Set<(event: GatewayEventEnvelope) => void>();
	private readonly observationListeners = new Set<(frame: ConversationObservationFrame) => void>();
	private readonly disconnectListeners = new Set<() => void>();
	private readonly deliveredEventIds = new Map<string, string>();
	private readonly helloWaiters = new Set<{
		resolve(): void;
		reject(error: Error): void;
	}>();
	private readonly socketPath: string;
	private readonly maxFrameBytes: number;
	private serverCapabilities: string[] = [];
	private closed = false;

	constructor(socketPath: string, maxFrameBytes = MAX_GATEWAY_JSONL_FRAME_BYTES) {
		if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
			throw new Error("Gateway JSONL frame limit must be a positive safe integer");
		}
		this.socketPath = socketPath;
		this.maxFrameBytes = maxFrameBytes;
	}

	async submit(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt> {
		await this.connect();
		if (this.pendingReceipts.size >= 64) throw new Error("gateway_pending_command_limit");
		if (this.pendingReceipts.has(envelope.requestId)) throw new Error("gateway_request_in_flight");
		return new Promise<GatewayCommandReceipt>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingReceipts.delete(envelope.requestId);
				reject(new Error("gateway_receipt_timeout"));
			}, 15_000);
			timer.unref?.();
			this.pendingReceipts.set(envelope.requestId, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.write({ type: "command", envelope });
			} catch (error) {
				clearTimeout(timer);
				this.pendingReceipts.delete(envelope.requestId);
				reject(asError(error));
			}
		});
	}

	async connect(): Promise<void> {
		await this.ensureConnected();
		if (this.connectionReady) return;
		return new Promise<void>((resolve, reject) => {
			this.helloWaiters.add({ resolve, reject });
		});
	}

	async observe(
		connectionId: string,
		observationId: string,
		conversationId: string,
		cursor?: ConversationViewCursor,
	): Promise<void> {
		await this.connect();
		this.write({ type: "observe", connectionId, observationId, conversationId, ...(cursor ? { cursor } : {}) });
	}

	unobserve(observationId: string): void {
		if (this.socket && !this.socket.destroyed) this.write({ type: "unobserve", observationId });
	}

	onObservation(listener: (frame: ConversationObservationFrame) => void): () => void {
		this.observationListeners.add(listener);
		return () => this.observationListeners.delete(listener);
	}

	getServerCapabilities(): string[] {
		return [...this.serverCapabilities];
	}

	subscribe(listener: (event: GatewayEventEnvelope) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onDisconnect(listener: () => void): () => void {
		this.disconnectListeners.add(listener);
		return () => this.disconnectListeners.delete(listener);
	}

	close(): void {
		this.closed = true;
		const socket = this.socket;
		if (socket) {
			if (!socket.destroyed) socket.end(`${JSON.stringify({ type: "close" })}\n`);
			this.handleDisconnect(socket);
			socket.destroy();
		}
	}

	private async ensureConnected(): Promise<void> {
		if (this.socket && !this.socket.destroyed) return;
		if (this.connecting) return this.connecting;
		this.closed = false;
		this.connecting = new Promise<void>((resolve, reject) => {
			const socket = createConnection(this.socketPath);
			this.socket = socket;
			socket.setEncoding("utf8");
			socket.once("connect", resolve);
			socket.once("error", reject);
			socket.once("close", () => reject(new Error("Gateway connection closed")));
			socket.on("data", (chunk) => this.consume(socket, chunk));
			socket.on("close", () => this.handleDisconnect(socket));
		}).finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	private consume(socket: Socket, chunk: string | Buffer): void {
		if (this.socket !== socket) return;
		this.buffer += chunk.toString();
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) {
				const bufferedBytes = Buffer.byteLength(this.buffer, "utf8");
				if (bufferedBytes > this.maxFrameBytes) {
					this.failFrame(
						socket,
						new GatewayFrameError(
							"gateway_frame_too_large",
							`Gateway JSONL frame exceeds ${this.maxFrameBytes} bytes`,
							bufferedBytes,
							this.maxFrameBytes,
						),
					);
				}
				return;
			}

			const rawFrame = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			const frameBytes = Buffer.byteLength(rawFrame, "utf8");
			if (frameBytes > this.maxFrameBytes) {
				this.failFrame(
					socket,
					new GatewayFrameError(
						"gateway_frame_too_large",
						`Gateway JSONL frame exceeds ${this.maxFrameBytes} bytes`,
						frameBytes,
						this.maxFrameBytes,
					),
				);
				return;
			}

			const line = rawFrame.trim();
			if (!line) continue;
			const message = parseServerFrame(line, frameBytes, this.maxFrameBytes);
			if (message instanceof GatewayFrameError) {
				this.failFrame(socket, message);
				return;
			}
			this.handleMessage(message);
		}
	}

	private handleMessage(message: GatewayWireServerMessage): void {
		if (message.type === "observation") {
			for (const listener of this.observationListeners) listener(message.frame);
			return;
		}
		if (message.type === "hello") {
			if (!message.attached) this.serverIdentity = message.identity ? JSON.stringify(message.identity) : null;
			this.connectionReady = true;
			if (message.capabilities !== undefined) this.serverCapabilities = [...message.capabilities];
			for (const waiter of this.helloWaiters) waiter.resolve();
			this.helloWaiters.clear();
			return;
		}
		if (message.type === "receipt") {
			const pending = this.pendingReceipts.get(message.receipt.requestId);
			if (pending) {
				this.pendingReceipts.delete(message.receipt.requestId);
				pending.resolve(message.receipt);
			}
			return;
		}
		if (message.type === "event" || message.type === "output") {
			this.publish(message.event);
			return;
		}
		if (message.type === "error" && message.event) {
			this.publish(message.event);
			return;
		}
		if (message.type === "error") {
			const error = new Error(message.message);
			if (message.requestId) {
				const pending = this.pendingReceipts.get(message.requestId);
				if (pending) {
					this.pendingReceipts.delete(message.requestId);
					pending.reject(error);
				}
			}
		}
	}

	private publish(event: GatewayEventEnvelope): void {
		if (this.deliveredEventIds.has(event.eventId)) return;
		this.deliveredEventIds.set(event.eventId, event.conversationId);
		while (this.deliveredEventIds.size > 2_000) {
			this.deliveredEventIds.delete(this.deliveredEventIds.keys().next().value!);
		}
		for (const listener of this.eventListeners) listener(event);
	}

	private write(message: GatewayWireClientMessage): void {
		if (!this.socket || this.socket.destroyed) throw new Error("Gateway socket is unavailable");
		this.socket.write(`${JSON.stringify(message)}\n`);
	}

	private failFrame(socket: Socket, error: GatewayFrameError): void {
		if (this.socket !== socket) return;
		this.buffer = "";
		for (const waiter of this.helloWaiters) waiter.reject(error);
		this.helloWaiters.clear();
		for (const pending of this.pendingReceipts.values()) pending.reject(error);
		this.pendingReceipts.clear();
		socket.destroy();
	}

	private handleDisconnect(socket: Socket): void {
		if (this.socket !== socket) return;
		this.socket = null;
		this.buffer = "";
		this.connectionReady = false;
		this.serverCapabilities = [];
		const error = new Error("Gateway connection closed");
		for (const waiter of this.helloWaiters) waiter.reject(error);
		this.helloWaiters.clear();
		for (const pending of this.pendingReceipts.values()) pending.reject(error);
		this.pendingReceipts.clear();
		if (!this.closed) {
			for (const listener of this.disconnectListeners) listener();
		}
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function parseServerFrame(
	line: string,
	frameBytes: number,
	maxFrameBytes: number,
): GatewayWireServerMessage | GatewayFrameError {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return malformedFrame(frameBytes, maxFrameBytes);
	}
	return isGatewayWireServerMessage(value) ? value : malformedFrame(frameBytes, maxFrameBytes);
}

function malformedFrame(frameBytes: number, maxFrameBytes: number): GatewayFrameError {
	return new GatewayFrameError(
		"gateway_malformed_frame",
		"Gateway JSONL frame is not a valid server message",
		frameBytes,
		maxFrameBytes,
	);
}

function isGatewayWireServerMessage(value: unknown): value is GatewayWireServerMessage {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "observation")
		return (
			isRecord(value.frame) &&
			isNonEmptyString(value.frame.observationId) &&
			isNonEmptyString(value.frame.conversationId) &&
			["baseline", "patch", "activity", "freshness", "reset", "closed"].includes(String(value.frame.kind))
		);
	if (value.type === "hello") {
		return (
			isNonEmptyString(value.sessionId) &&
			typeof value.attached === "boolean" &&
			(value.lastSequence === undefined || isSequence(value.lastSequence)) &&
			(value.identity === undefined ||
				(isRecord(value.identity) &&
					isNonEmptyString(value.identity.serverId) &&
					isNonEmptyString(value.identity.accountId))) &&
			(value.capabilities === undefined ||
				(Array.isArray(value.capabilities) && value.capabilities.every((item) => typeof item === "string")))
		);
	}
	if (value.type === "receipt") return isGatewayReceipt(value.receipt);
	if (value.type === "event") return isGatewayEvent(value.event);
	if (value.type === "output") {
		return (
			Array.isArray(value.lines) &&
			value.lines.every((line) => typeof line === "string") &&
			isGatewayEvent(value.event)
		);
	}
	if (value.type === "error") {
		return (
			typeof value.message === "string" &&
			(value.requestId === undefined || typeof value.requestId === "string") &&
			(value.event === undefined || isGatewayEvent(value.event))
		);
	}
	return value.type === "exit";
}

function isGatewayReceipt(value: unknown): value is GatewayCommandReceipt {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.requestId) &&
		["accepted", "duplicate", "rejected"].includes(String(value.status)) &&
		(value.conversationId === null || typeof value.conversationId === "string") &&
		(value.workspaceId === undefined || value.workspaceId === null || typeof value.workspaceId === "string") &&
		(value.reason === undefined || typeof value.reason === "string")
	);
}

function isGatewayEvent(value: unknown): value is GatewayEventEnvelope {
	if (!isRecord(value)) return false;
	return (
		value.protocolVersion === 2 &&
		isNonEmptyString(value.eventId) &&
		typeof value.sequence === "number" &&
		Number.isSafeInteger(value.sequence) &&
		value.sequence >= 0 &&
		isNonEmptyString(value.accountId) &&
		isNonEmptyString(value.conversationId) &&
		(value.requestId === null || typeof value.requestId === "string") &&
		(value.turnId === null || typeof value.turnId === "string") &&
		isGatewayEventKind(value.kind) &&
		typeof value.occurredAt === "string"
	);
}

function isGatewayEventKind(value: unknown): boolean {
	return typeof value === "string" && (GATEWAY_EVENT_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isSequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
