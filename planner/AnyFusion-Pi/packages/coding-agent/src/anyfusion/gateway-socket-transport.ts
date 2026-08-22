import { createConnection, type Socket } from "node:net";
import type { GatewayClientDeps } from "./gateway-client.ts";
import type {
	GatewayCommandEnvelope,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayReplay,
	GatewayWireClientMessage,
	GatewayWireServerMessage,
} from "./gateway-protocol.ts";

export const MAX_GATEWAY_JSONL_FRAME_BYTES = 16 * 1024 * 1024;

export type GatewayFrameErrorCode =
	| "gateway_malformed_frame"
	| "gateway_frame_too_large";

export class GatewayFrameError extends Error {
	readonly code: GatewayFrameErrorCode;
	readonly frameBytes: number;
	readonly maxFrameBytes: number;

	constructor(
		code: GatewayFrameErrorCode,
		message: string,
		frameBytes: number,
		maxFrameBytes: number,
	) {
		super(message);
		this.name = "GatewayFrameError";
		this.code = code;
		this.frameBytes = frameBytes;
		this.maxFrameBytes = maxFrameBytes;
	}
}

interface PendingAttach {
	conversationId: string;
	afterSequence: number;
	promise: Promise<void>;
	resolve(): void;
	reject(error: Error): void;
}

export class GatewaySocketTransport implements GatewayClientDeps {
	private socket: Socket | null = null;
	private connecting: Promise<void> | null = null;
	private buffer = "";
	private currentConversationId: string | null = null;
	private desiredConversationId: string | null = null;
	private desiredAfterSequence = 0;
	private readonly pendingReceipts = new Map<
		string,
		{
			resolve(receipt: GatewayCommandReceipt): void;
			reject(error: Error): void;
		}
	>();
	private pendingAttach: PendingAttach | null = null;
	private readonly eventListeners = new Set<(event: GatewayEventEnvelope) => void>();
	private readonly disconnectListeners = new Set<() => void>();
	private readonly deliveredEventIds = new Set<string>();
	private readonly socketPath: string;
	private readonly maxFrameBytes: number;
	private closed = false;

	constructor(socketPath: string, maxFrameBytes = MAX_GATEWAY_JSONL_FRAME_BYTES) {
		if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
			throw new Error("Gateway JSONL frame limit must be a positive safe integer");
		}
		this.socketPath = socketPath;
		this.maxFrameBytes = maxFrameBytes;
	}

	async submit(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt> {
		await this.ensureConnected();
		await this.ensureDesiredAttachment();
		return new Promise<GatewayCommandReceipt>((resolve, reject) => {
			this.pendingReceipts.set(envelope.requestId, { resolve, reject });
			try {
				this.write({ type: "command", envelope });
			} catch (error) {
				this.pendingReceipts.delete(envelope.requestId);
				reject(asError(error));
			}
		});
	}

	async replay(conversationId: string, afterSequence = 0): Promise<GatewayReplay> {
		this.desiredConversationId = conversationId;
		this.desiredAfterSequence = afterSequence;
		await this.ensureConnected();
		await this.ensureAttached(conversationId, afterSequence);
		return {
			lastSequence: afterSequence,
			snapshot: [],
			deltas: [],
		};
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
		if (this.socket && !this.socket.destroyed) {
			this.socket.end(`${JSON.stringify({ type: "close" })}\n`);
			this.socket.destroy();
		}
		this.socket = null;
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
					this.failFrame(socket, new GatewayFrameError(
						"gateway_frame_too_large",
						`Gateway JSONL frame exceeds ${this.maxFrameBytes} bytes`,
						bufferedBytes,
						this.maxFrameBytes,
					));
				}
				return;
			}

			const rawFrame = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			const frameBytes = Buffer.byteLength(rawFrame, "utf8");
			if (frameBytes > this.maxFrameBytes) {
				this.failFrame(socket, new GatewayFrameError(
					"gateway_frame_too_large",
					`Gateway JSONL frame exceeds ${this.maxFrameBytes} bytes`,
					frameBytes,
					this.maxFrameBytes,
				));
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
		if (message.type === "hello") {
			this.currentConversationId = message.sessionId;
			if (this.pendingAttach?.conversationId === message.sessionId) {
				if (this.desiredConversationId === message.sessionId) {
					this.desiredAfterSequence = 0;
				}
				this.pendingAttach.resolve();
				this.pendingAttach = null;
			}
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
			} else if (this.pendingAttach) {
				this.pendingAttach.reject(error);
				this.pendingAttach = null;
			}
		}
	}

	private publish(event: GatewayEventEnvelope): void {
		if (this.deliveredEventIds.has(event.eventId)) return;
		this.deliveredEventIds.add(event.eventId);
		for (const listener of this.eventListeners) listener(event);
	}

	private write(message: GatewayWireClientMessage): void {
		if (!this.socket || this.socket.destroyed) throw new Error("Gateway socket is unavailable");
		this.socket.write(`${JSON.stringify(message)}\n`);
	}

	private ensureDesiredAttachment(): Promise<void> {
		if (!this.desiredConversationId) return Promise.resolve();
		return this.ensureAttached(this.desiredConversationId, this.desiredAfterSequence);
	}

	private ensureAttached(conversationId: string, afterSequence: number): Promise<void> {
		if (this.pendingAttach) {
			if (
				this.pendingAttach.conversationId === conversationId
				&& this.pendingAttach.afterSequence === afterSequence
			) {
				return this.pendingAttach.promise;
			}
			this.pendingAttach.reject(new Error("Gateway attach was superseded"));
			this.pendingAttach = null;
		}
		if (this.currentConversationId === conversationId && afterSequence === 0) {
			return Promise.resolve();
		}

		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<void>((done, fail) => {
			resolve = done;
			reject = fail;
		});
		this.pendingAttach = {
			conversationId,
			afterSequence,
			promise,
			resolve,
			reject,
		};
		try {
			this.write({
				type: "attach",
				conversationId,
				resumeFromSequence: afterSequence,
			});
		} catch (error) {
			this.pendingAttach = null;
			reject(asError(error));
		}
		return promise;
	}

	private failFrame(socket: Socket, error: GatewayFrameError): void {
		if (this.socket !== socket) return;
		this.buffer = "";
		this.currentConversationId = null;
		this.pendingAttach?.reject(error);
		this.pendingAttach = null;
		for (const pending of this.pendingReceipts.values()) pending.reject(error);
		this.pendingReceipts.clear();
		socket.destroy();
	}

	private handleDisconnect(socket: Socket): void {
		if (this.socket !== socket) return;
		this.socket = null;
		this.buffer = "";
		this.currentConversationId = null;
		const error = new Error("Gateway connection closed");
		this.pendingAttach?.reject(error);
		this.pendingAttach = null;
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
	return isGatewayWireServerMessage(value)
		? value
		: malformedFrame(frameBytes, maxFrameBytes);
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
	if (value.type === "hello") return isNonEmptyString(value.sessionId);
	if (value.type === "receipt") return isGatewayReceipt(value.receipt);
	if (value.type === "event") return isGatewayEvent(value.event);
	if (value.type === "output") {
		return Array.isArray(value.lines)
			&& value.lines.every((line) => typeof line === "string")
			&& isGatewayEvent(value.event);
	}
	if (value.type === "error") {
		return typeof value.message === "string"
			&& (value.requestId === undefined || typeof value.requestId === "string")
			&& (value.event === undefined || isGatewayEvent(value.event));
	}
	return value.type === "exit";
}

function isGatewayReceipt(value: unknown): value is GatewayCommandReceipt {
	if (!isRecord(value)) return false;
	return isNonEmptyString(value.requestId)
		&& ["accepted", "duplicate", "rejected"].includes(String(value.status))
		&& (value.conversationId === null || typeof value.conversationId === "string")
		&& (value.reason === undefined || typeof value.reason === "string");
}

function isGatewayEvent(value: unknown): value is GatewayEventEnvelope {
	if (!isRecord(value)) return false;
	return value.protocolVersion === 1
		&& isNonEmptyString(value.eventId)
		&& typeof value.sequence === "number"
		&& Number.isSafeInteger(value.sequence)
		&& value.sequence >= 0
		&& isNonEmptyString(value.accountId)
		&& isNonEmptyString(value.conversationId)
		&& (value.requestId === null || typeof value.requestId === "string")
		&& (value.turnId === null || typeof value.turnId === "string")
		&& isGatewayEventKind(value.kind)
		&& typeof value.occurredAt === "string";
}

function isGatewayEventKind(value: unknown): boolean {
	return [
		"conversation_snapshot",
		"turn_started",
		"trace_delta",
		"task_projection",
		"execution_delta",
		"permission_request",
		"artifact",
		"result_delivery_available",
		"result_chunk",
		"result_completed",
		"final_answer",
		"terminal_error",
		"delivery_status",
	].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
