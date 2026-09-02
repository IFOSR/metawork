import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type {
	ExecutorManualProposalResult,
	PlannerProposalPurpose,
	PlannerProposalResult,
	PlannerRuntimeMode,
} from "./planner-proposal-types.ts";

export const ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION = 2 as const;
const MAX_LINE_BYTES = 1_048_576;

export type CommandCompletionState = "inactive" | "incomplete" | "executable" | "invalid";

export interface CommandCompletionSuggestion {
	value: string;
	label: string;
	description: string;
	replacement: {
		start: number;
		end: number;
		text: string;
	};
}

export interface CommandCompletion {
	state: CommandCompletionState;
	suggestions: CommandCompletionSuggestion[];
	hint: string | null;
	error: string | null;
}

type HostMessage = {
	protocolVersion: number;
	type: string;
	requestId?: string | null;
	accepted?: boolean;
	capabilities?: unknown;
	snapshot?: unknown;
	completion?: unknown;
	result?: unknown;
	permission?: unknown;
	permissionRequestId?: unknown;
	reason?: unknown;
	exitRequested?: boolean;
	output?: unknown;
	error?: { code?: string; message?: string; details?: string[] };
};

export interface ExecutorResultNotification {
	schemaVersion: 1;
	publicationId: string;
	taskId: string;
	taskTitle: string;
	subtaskId: string;
	subtaskTitle: string;
	attemptId: string;
	executorName: string;
	report: string;
	artifacts: string[];
	warnings: string[];
	integrationCommit: string | null;
	completedAt: string;
	reportTruncated: boolean;
}

export interface PermissionRequestNotification {
	schemaVersion: 1;
	permissionRequestId: string;
	taskId: string;
	taskTitle: string;
	generationId: string;
	subtaskId: string;
	subtaskTitle: string;
	attemptId: string;
	executorName: string;
	permissionProfileId: string;
	capability: string;
	resource: string;
	operation: string;
	reason: string;
	suggestedScope: "once" | "attempt";
	escalationReason: string;
	createdAt: string;
	expiresAt: string;
}

export interface PermissionResolutionResult {
	status: "resolved" | "replayed" | "conflict";
	resolution: "approve" | "deny" | null;
	message: string;
}

export interface CommandResult {
	exitRequested: boolean;
	output: string[];
}

function abortError(): Error {
	const error = new Error("Planner host request aborted");
	error.name = "AbortError";
	return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseCommandCompletion(value: unknown): CommandCompletion | null {
	if (!isRecord(value)) return null;
	if (!(["inactive", "incomplete", "executable", "invalid"] as unknown[]).includes(value.state)) return null;
	if (!Array.isArray(value.suggestions) || value.suggestions.length > 200) return null;
	const suggestions: CommandCompletionSuggestion[] = [];
	for (const candidate of value.suggestions) {
		if (!isRecord(candidate) || !isRecord(candidate.replacement)) return null;
		const { replacement } = candidate;
		if (
			typeof candidate.value !== "string" ||
			typeof candidate.label !== "string" ||
			typeof candidate.description !== "string" ||
			!Number.isInteger(replacement.start) ||
			!Number.isInteger(replacement.end) ||
			(replacement.start as number) < 0 ||
			(replacement.end as number) < (replacement.start as number) ||
			typeof replacement.text !== "string"
		) {
			return null;
		}
		suggestions.push({
			value: candidate.value,
			label: candidate.label,
			description: candidate.description,
			replacement: {
				start: replacement.start as number,
				end: replacement.end as number,
				text: replacement.text,
			},
		});
	}
	if (value.hint !== null && typeof value.hint !== "string") return null;
	if (value.error !== null && typeof value.error !== "string") return null;
	return {
		state: value.state as CommandCompletionState,
		suggestions,
		hint: value.hint as string | null,
		error: value.error as string | null,
	};
}

function parseExecutorResult(value: unknown): ExecutorResultNotification | null {
	if (!isRecord(value) || value.schemaVersion !== 1) return null;
	const requiredStrings = [
		"publicationId",
		"taskId",
		"taskTitle",
		"subtaskId",
		"subtaskTitle",
		"attemptId",
		"executorName",
		"report",
		"completedAt",
	] as const;
	if (requiredStrings.some((key) => typeof value[key] !== "string")) return null;
	if (!Array.isArray(value.artifacts) || !value.artifacts.every((item) => typeof item === "string")) return null;
	if (!Array.isArray(value.warnings) || !value.warnings.every((item) => typeof item === "string")) return null;
	if (value.integrationCommit !== null && typeof value.integrationCommit !== "string") return null;
	if (typeof value.reportTruncated !== "boolean") return null;
	return value as unknown as ExecutorResultNotification;
}

function parsePermissionRequest(value: unknown): PermissionRequestNotification | null {
	if (!isRecord(value) || value.schemaVersion !== 1) return null;
	const strings = [
		"permissionRequestId",
		"taskId",
		"taskTitle",
		"generationId",
		"subtaskId",
		"subtaskTitle",
		"attemptId",
		"executorName",
		"permissionProfileId",
		"capability",
		"resource",
		"operation",
		"reason",
		"escalationReason",
		"createdAt",
		"expiresAt",
	] as const;
	if (strings.some((key) => typeof value[key] !== "string")) return null;
	if (value.suggestedScope !== "once" && value.suggestedScope !== "attempt") return null;
	if (
		!Number.isFinite(Date.parse(value.createdAt as string)) ||
		!Number.isFinite(Date.parse(value.expiresAt as string))
	)
		return null;
	return value as unknown as PermissionRequestNotification;
}

function parsePermissionResult(value: unknown): PermissionResolutionResult | null {
	if (!isRecord(value) || !["resolved", "replayed", "conflict"].includes(String(value.status))) return null;
	if (value.resolution !== null && value.resolution !== "approve" && value.resolution !== "deny") return null;
	if (typeof value.message !== "string") return null;
	return value as unknown as PermissionResolutionResult;
}

export class AnyFusionPlannerHostClient {
	private readonly socketPath: string;
	private readonly sessionId: string;
	private readonly runtimeVersion: string;
	private readonly mode: PlannerRuntimeMode;
	private socket: Socket | undefined;
	private buffer = "";
	private readonly pending = new Map<
		string,
		{
			resolve: (message: HostMessage) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			cleanup?: () => void;
		}
	>();
	private readonly snapshotListeners = new Set<(snapshot: unknown) => void>();
	private readonly executorResultListeners = new Set<(result: ExecutorResultNotification) => void>();
	private readonly permissionRequestListeners = new Set<(request: PermissionRequestNotification) => void>();
	private readonly permissionClosedListeners = new Set<(requestId: string, reason: string) => void>();
	private readonly disconnectListeners = new Set<() => void>();
	private capabilities = new Set<string>();

	constructor(
		socketPath: string,
		sessionId: string,
		runtimeVersion: string,
		mode: PlannerRuntimeMode = "interactive",
	) {
		this.socketPath = socketPath;
		this.sessionId = sessionId;
		this.runtimeVersion = runtimeVersion;
		this.mode = mode;
	}

	async connect(): Promise<void> {
		if (this.socket && !this.socket.destroyed) return;
		this.socket = undefined;
		const socket = createConnection(this.socketPath);
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => this.handleData(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
		socket.on("error", (error) => this.failPending(error));
		socket.on("close", () => {
			if (this.socket === socket) this.socket = undefined;
			this.failPending(new Error("AnyFusion Planner host connection closed"));
			for (const listener of this.disconnectListeners) listener();
		});
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const hello = await this.request({
			type: "hello",
			runtimeVersion: this.runtimeVersion,
			sessionId: this.sessionId,
			mode: this.mode,
		});
		if (hello.type !== "hello" || hello.accepted !== true) throw new Error("Planner host rejected protocol hello");
		this.capabilities = new Set(
			Array.isArray(hello.capabilities)
				? hello.capabilities.filter((capability): capability is string => typeof capability === "string")
				: [],
		);
	}

	supportsExecutorResults(): boolean {
		return this.capabilities.has("executor_result");
	}

	supportsPermissionRequests(): boolean {
		return this.capabilities.has("permission_request");
	}

	async subscribe(
		listener: (snapshot: unknown) => void,
		executorResultListener?: (result: ExecutorResultNotification) => void,
		permissionRequestListener?: (request: PermissionRequestNotification) => void,
		permissionClosedListener?: (requestId: string, reason: string) => void,
	): Promise<void> {
		this.snapshotListeners.add(listener);
		if (executorResultListener) this.executorResultListeners.add(executorResultListener);
		if (permissionRequestListener) this.permissionRequestListeners.add(permissionRequestListener);
		if (permissionClosedListener) this.permissionClosedListeners.add(permissionClosedListener);
		const response = await this.request({ type: "snapshot_subscribe" });
		if (response.type !== "subscribed") throw new Error("Planner host did not accept snapshot subscription");
	}

	onDisconnect(listener: () => void): () => void {
		this.disconnectListeners.add(listener);
		return () => this.disconnectListeners.delete(listener);
	}

	async resolvePermission(
		permissionRequestId: string,
		resolution: "approve" | "deny",
	): Promise<PermissionResolutionResult> {
		const response = await this.request({ type: "permission_resolve", permissionRequestId, resolution });
		if (response.type !== "permission_result")
			throw new Error("Planner host returned an unexpected permission response");
		const result = parsePermissionResult(response.result);
		if (!result) throw new Error("Planner host returned an invalid permission response");
		return result;
	}

	async completeCommand(text: string, cursor = text.length, signal?: AbortSignal): Promise<CommandCompletion> {
		const response = await this.request({ type: "command_complete", text, cursor }, signal);
		if (response.type !== "command_completion") {
			throw new Error("Planner host returned an unexpected command completion response");
		}
		const completion = parseCommandCompletion(response.completion);
		if (!completion) throw new Error("Planner host returned an invalid command completion");
		return completion;
	}

	async submitProposal(
		input: {
			turnId: string;
			userInput: string;
			submissionId: string;
			purpose: PlannerProposalPurpose;
			plan: unknown;
		},
		signal?: AbortSignal,
	): Promise<PlannerProposalResult> {
		const response = await this.request(
			{
				type: "proposal_submit",
				turnId: input.turnId,
				sessionId: this.sessionId,
				userInput: input.userInput,
				submissionId: input.submissionId,
				purpose: input.purpose,
				plan: input.plan,
			},
			signal,
		);
		if (response.type !== "proposal_result" || !isPlannerProposalResult(response.result)) {
			throw new Error("Planner host returned an invalid proposal response");
		}
		return response.result;
	}

	async submitExecutorManualProposal(
		input: {
			agentClassRef: string;
			userProfile: unknown;
		},
		signal?: AbortSignal,
	): Promise<ExecutorManualProposalResult> {
		const turnId = `configuration_${Date.now()}_${randomUUID()}`;
		const response = await this.request(
			{
				type: "proposal_submit",
				turnId,
				sessionId: this.sessionId,
				userInput: "Configure Executor capability manual",
				submissionId: `configuration_${turnId}`,
				purpose: "configuration",
				plan: input,
			},
			signal,
		);
		if (response.type !== "proposal_result" || !isExecutorManualProposalResult(response.result)) {
			throw new Error("Planner host returned an invalid Executor manual proposal response");
		}
		return response.result;
	}

	async submitCommand(command: string): Promise<CommandResult> {
		const response = await this.request({ type: "command_submit", command });
		if (response.type !== "command_result") throw new Error("Planner host returned an unexpected command response");
		if (response.accepted !== true) {
			throw new Error(response.error?.message ?? "MetaClaw rejected the command");
		}
		if (!Array.isArray(response.output) || !response.output.every((line) => typeof line === "string")) {
			throw new Error("Planner host returned an invalid command result");
		}
		return {
			exitRequested: response.exitRequested === true,
			output: response.output,
		};
	}

	close(): void {
		this.socket?.destroy();
		this.socket = undefined;
		this.failPending(new Error("AnyFusion Planner host client closed"));
	}

	private request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<HostMessage> {
		const socket = this.socket;
		if (!socket || socket.destroyed) return Promise.reject(new Error("Planner host is not connected"));
		if (signal?.aborted) return Promise.reject(abortError());
		const requestId = randomUUID();
		const line = JSON.stringify({
			protocolVersion: ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION,
			requestId,
			...payload,
		});
		if (Buffer.byteLength(line) > MAX_LINE_BYTES)
			return Promise.reject(new Error("Planner host request exceeds 1 MiB"));
		return new Promise((resolve, reject) => {
			const cleanup = signal ? () => signal.removeEventListener("abort", onAbort) : undefined;
			const onAbort = () => {
				const pending = this.pending.get(requestId);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(requestId);
				cleanup?.();
				reject(abortError());
			};
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				cleanup?.();
				reject(new Error(`Planner host request timed out: ${String(payload.type)}`));
			}, 10_000);
			this.pending.set(requestId, { resolve, reject, timer, cleanup });
			signal?.addEventListener("abort", onAbort, { once: true });
			socket.write(`${line}\n`);
		});
	}

	private handleData(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
				this.close();
				return;
			}
			if (line) this.handleLine(line);
			newline = this.buffer.indexOf("\n");
		}
		if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) this.close();
	}

	private handleLine(line: string): void {
		let message: HostMessage;
		try {
			message = JSON.parse(line) as HostMessage;
		} catch {
			return;
		}
		if (message.protocolVersion !== ANYFUSION_PLANNER_HOST_PROTOCOL_VERSION) {
			this.close();
			return;
		}
		if (message.type === "snapshot") {
			for (const listener of this.snapshotListeners) listener(message.snapshot);
		}
		if (message.type === "executor_result") {
			const result = parseExecutorResult(message.result);
			if (result) {
				for (const listener of this.executorResultListeners) listener(result);
			}
		}
		if (message.type === "permission_request") {
			const permission = parsePermissionRequest(message.permission);
			if (permission) for (const listener of this.permissionRequestListeners) listener(permission);
		}
		if (
			message.type === "permission_request_closed" &&
			typeof message.permissionRequestId === "string" &&
			typeof message.reason === "string"
		) {
			for (const listener of this.permissionClosedListeners) listener(message.permissionRequestId, message.reason);
		}
		if (typeof message.requestId === "string") {
			const pending = this.pending.get(message.requestId);
			if (!pending) return;
			clearTimeout(pending.timer);
			pending.cleanup?.();
			this.pending.delete(message.requestId);
			if (message.type === "error") pending.reject(new Error(message.error?.message ?? "Planner host error"));
			else pending.resolve(message);
		}
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.cleanup?.();
			pending.reject(error);
		}
		this.pending.clear();
	}
}

function isPlannerProposalResult(value: unknown): value is PlannerProposalResult {
	if (!isRecord(value) || typeof value.status !== "string") return false;
	if (typeof value.turnId !== "string" || typeof value.submissionId !== "string") return false;
	if (value.status === "accepted") {
		return (
			typeof value.planId === "string" && typeof value.outcome === "string" && typeof value.displayText === "string"
		);
	}
	if (value.status === "rejected")
		return Array.isArray(value.issues) && value.issues.every((issue) => typeof issue === "string");
	if (value.status === "conflict" || value.status === "transport_uncertain") return typeof value.message === "string";
	return false;
}

function isExecutorManualProposalResult(value: unknown): value is ExecutorManualProposalResult {
	if (!isRecord(value)) return false;
	if (value.status === "rejected") {
		return Array.isArray(value.issues) && value.issues.every(item => typeof item === "string");
	}
	if (value.status === "transport_uncertain") {
		return value.retryableByReplay === true && typeof value.message === "string";
	}
	return value.status === "accepted"
		&& typeof value.agentClassRef === "string"
		&& isRecord(value.userProfile)
		&& typeof value.userProfile.sourceText === "string"
		&& Array.isArray(value.userProfile.assertions);
}
