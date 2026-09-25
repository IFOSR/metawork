/**
 * Gateway public payload 校验与归一化（统一 TUI 设计 §6、§10.2、§12）。
 *
 * 所有远端正文、标题、文件名和错误都是不可信显示内容：剥离终端控制字符，
 * 样式只能由可信组件生成。非法 payload 返回 null，由 reducer 忽略，
 * 绝不打印原始数据。
 */

import type { MetaWorkAttemptProjection, MetaWorkRoutingProjection, MetaWorkBillStageUsage, MetaWorkTurnBillView, MetaWorkTaskUsageSummary } from "./model.ts";

/**
 * 剥离 C0/C1 控制字符与完整 CSI/OSC/DCS 转义序列（保留换行与 Tab）。
 * 远端正文永远不能直接携带终端控制序列；样式仅由可信组件生成。
 */
export function sanitizeDisplayText(value: string): string {
	let output = "";
	let index = 0;
	while (index < value.length) {
		const code = value.codePointAt(index)!;
		const char = String.fromCodePoint(code);
		const width = char.length;
		if (code === 0x1b) {
			index += width;
			const introducer = value[index];
			if (introducer === "[" ) {
				// CSI：参数/中间字节后到 0x40–0x7e 的最终字节结束。
				index += 1;
				while (index < value.length) {
					const current = value.charCodeAt(index);
					index += 1;
					if (current >= 0x40 && current <= 0x7e) break;
				}
				continue;
			}
			if (introducer === "]" || introducer === "P" || introducer === "X" || introducer === "^" || introducer === "_") {
				// OSC/DCS/SOS/PM/APC：以 BEL 或 ST（ESC \）结束。
				index += 1;
				while (index < value.length) {
					const current = value.charCodeAt(index);
					if (current === 0x07) {
						index += 1;
						break;
					}
					if (current === 0x1b && value[index + 1] === "\\") {
						index += 2;
						break;
					}
					index += 1;
				}
				continue;
			}
			// 两字节转义序列（如 ESC c、ESC 7）：跳过引导后的一个字符。
			if (introducer !== undefined) index += introducer.length;
			continue;
		}
		if (char === "\n" || char === "\t") {
			output += char;
			index += width;
			continue;
		}
		// 其余 C0、DEL、C1 控制字符一律剥离。
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			index += width;
			continue;
		}
		output += char;
		index += width;
	}
	return output;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

export function asString(value: unknown): string | null {
	return typeof value === "string" ? sanitizeDisplayText(value) : null;
}

export function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const BILL_USER_STATUSES = ["billed", "unconfirmed", "no_charge"] as const;
const BILL_COST_STATUSES = ["calculated", "not_chargeable", "pending"] as const;

function isBillCostStatus(value: unknown): value is MetaWorkBillStageUsage["costStatus"] {
	return typeof value === "string" && (BILL_COST_STATUSES as readonly string[]).includes(value);
}

function isBillUserStatus(value: unknown): value is MetaWorkTurnBillView["userStatus"] {
	return typeof value === "string" && (BILL_USER_STATUSES as readonly string[]).includes(value);
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" ? sanitizeDisplayText(value) : null;
}

/** token 计数是十进制整数或服务端精确分数（n/d）。 */
function tokenQuantity(value: unknown): string | null {
	return typeof value === "string" && /^\d+(?:\/\d+)?$/.test(value) ? value : null;
}

/** 金额是服务端格式化的十进制 MetaCoin 展示值（如 `1.416796`）。 */
function metaCoinAmount(value: unknown): string | null {
	return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? value : null;
}

function normalizeStageUsage(value: unknown): MetaWorkBillStageUsage | null {
	const entry = asRecord(value);
	if (!entry) return null;
	const costStatus = entry.costStatus;
	if (!isBillCostStatus(costStatus)) return null;
	const inputTokens = tokenQuantity(entry.inputTokens);
	const outputTokens = tokenQuantity(entry.outputTokens);
	const totalTokens = tokenQuantity(entry.totalTokens);
	if (!inputTokens || !outputTokens || !totalTokens) return null;
	return {
		stage: optionalString(entry.stage),
		agentClassRef: optionalString(entry.agentClassRef),
		providerRef: optionalString(entry.providerRef),
		modelId: optionalString(entry.modelId),
		inputTokens,
		outputTokens,
		totalTokens,
		assessedMetaCoin: metaCoinAmount(entry.assessedMetaCoin),
		costStatus,
	};
}

export function normalizeTurnBillView(value: unknown): MetaWorkTurnBillView | null {
	const outer = asRecord(value);
	const item = asRecord(outer?.turnBill);
	if (!item) return null;
	const userStatus = item.userStatus;
	if (!isBillUserStatus(userStatus)) return null;
	if (typeof item.headline !== "string") return null;
	const stageBreakdown = Array.isArray(item.stageBreakdown)
		? item.stageBreakdown.flatMap(entry => {
			const usage = normalizeStageUsage(entry);
			return usage ? [usage] : [];
		})
		: [];
	return {
		userStatus,
		headline: sanitizeDisplayText(item.headline),
		amountMicroCoin: metaCoinAmount(item.amountMicroCoin),
		amountIsFinal: item.amountIsFinal === true,
		diagnosticMessage: optionalString(item.diagnosticMessage),
		stageBreakdown,
		billId: optionalString(item.billId),
		finalizedAt: optionalString(item.finalizedAt),
	};
}

export function normalizeTaskUsageSummary(value: unknown): MetaWorkTaskUsageSummary | null {
	const item = asRecord(value);
	if (!item || typeof item.taskId !== "string") return null;
	const fields = ["finalizedMicroCoin", "pendingReconciliationMicroCoin", "inFlightMicroCoin", "confirmedDeductedMicroCoin"];
	if (!fields.every(field => typeof item[field] === "string" && /^\d+$/.test(item[field] as string))) return null;
	return {
		taskId: item.taskId,
		finalizedMicroCoin: item.finalizedMicroCoin as string,
		pendingReconciliationMicroCoin: item.pendingReconciliationMicroCoin as string,
		inFlightMicroCoin: item.inFlightMicroCoin as string,
		queryCount: typeof item.queryCount === "number" && Number.isSafeInteger(item.queryCount) ? item.queryCount : 0,
		confirmedDeductedMicroCoin: item.confirmedDeductedMicroCoin as string,
	};
}

export function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string").map(sanitizeDisplayText)
		: [];
}

export interface NormalizedTraceEvent {
	readonly eventKey: string | null;
	readonly phase: string;
	readonly actor: string;
	readonly kind: string;
	readonly status: string;
	readonly title: string;
	readonly summary: string;
	readonly occurredAt: string | null;
	readonly subtaskId: string | null;
	readonly attemptId: string | null;
}

export function normalizeTraceEvents(payload: Record<string, unknown>): NormalizedTraceEvent[] {
	if (!Array.isArray(payload.events)) return [];
	const events: NormalizedTraceEvent[] = [];
	for (const raw of payload.events) {
		const item = asRecord(raw);
		if (!item) continue;
		events.push({
			eventKey: asString(item.eventKey),
			phase: asString(item.phase) ?? "",
			actor: asString(item.actor) ?? "runtime",
			kind: asString(item.kind) ?? "",
			status: asString(item.status) ?? "",
			title: asString(item.title) ?? asString(item.message) ?? "",
			summary: asString(item.summary) ?? "",
			occurredAt: asString(item.occurredAt),
			subtaskId: asString(item.subtaskId),
			attemptId: asString(item.attemptId),
		});
	}
	return events;
}

export interface NormalizedResultMetadata {
	readonly resultId: string;
	readonly contentHash: string;
	readonly byteLength: number;
	readonly completeness: "complete" | "partial" | "incomplete";
	readonly certification: "certified" | "uncertified";
}

export function normalizeResultMetadata(
	payload: Record<string, unknown>,
): NormalizedResultMetadata | null {
	const resultId = asString(payload.resultId);
	if (!resultId) return null;
	const completeness = payload.completeness;
	const certification = payload.certification;
	return {
		resultId,
		contentHash: asString(payload.contentHash) ?? "",
		byteLength: asNumber(payload.byteLength) ?? 0,
		completeness: completeness === "partial" || completeness === "incomplete"
			? completeness
			: "complete",
		certification: certification === "uncertified" ? "uncertified" : "certified",
	};
}

export interface NormalizedHistoryTurn {
	readonly id: string;
	readonly startedAt: string | null;
	readonly userInput: string;
	readonly finalAnswer: string | null;
	readonly status: "running" | "completed" | "failed" | "blocked" | "cancelled";
	readonly taskId: string | null;
}

export interface NormalizedHistoryPage {
	readonly turns: NormalizedHistoryTurn[];
	readonly previousCursor: string | null;
	readonly nextCursor: string | null;
}

export function normalizeHistoryPage(
	payload: Record<string, unknown>,
): NormalizedHistoryPage | null {
	if (!Array.isArray(payload.turns)) return null;
	const turns: NormalizedHistoryTurn[] = [];
	for (const raw of payload.turns) {
		const item = asRecord(raw);
		if (!item) continue;
		const id = asString(item.id);
		const status = asString(item.status);
		if (!id) continue;
		if (
			status !== "completed" && status !== "failed"
			&& status !== "blocked" && status !== "cancelled" && status !== "running"
		) continue;
		turns.push({
			id,
			startedAt: asString(item.startedAt),
			userInput: asString(item.userInput) ?? "",
			finalAnswer: asString(item.finalAnswer),
			status,
			taskId: asString(item.taskId),
		});
	}
	return {
		turns,
		previousCursor: asString(payload.previousCursor),
		nextCursor: asString(payload.nextCursor),
	};
}

export interface NormalizedCompletion {
	readonly requestId: string;
	readonly targetConversationId: string | null;
	readonly state: "inactive" | "incomplete" | "executable" | "invalid";
	readonly suggestions: Array<{
		readonly value: string;
		readonly label: string;
		readonly description: string;
		readonly replacement: { readonly start: number; readonly end: number; readonly text: string };
	}>;
	readonly hint: string | null;
	readonly error: string | null;
}

export function normalizeCompletion(
	payload: Record<string, unknown>,
): NormalizedCompletion | null {
	if (payload.queryVersion !== "command_completion_v1") return null;
	const requestId = asString(payload.requestId);
	if (!requestId) return null;
	const state = payload.state;
	if (
		state !== "inactive" && state !== "incomplete"
		&& state !== "executable" && state !== "invalid"
	) return null;
	const suggestions: NormalizedCompletion["suggestions"] = [];
	if (Array.isArray(payload.suggestions)) {
		for (const raw of payload.suggestions.slice(0, 50)) {
			const item = asRecord(raw);
			const replacement = asRecord(item?.replacement);
			if (!item || !replacement) continue;
			const value = asString(item.value);
			const start = asNumber(replacement.start);
			const end = asNumber(replacement.end);
			const text = asString(replacement.text);
			if (!value || start === null || end === null || text === null) continue;
			suggestions.push({
				value,
				label: asString(item.label) ?? value,
				description: asString(item.description) ?? "",
				replacement: { start, end, text },
			});
		}
	}
	return {
		requestId,
		targetConversationId: asString(payload.targetConversationId),
		state,
		suggestions,
		hint: asString(payload.hint),
		error: asString(payload.error),
	};
}

export interface NormalizedTaskView {
	readonly requestId: string;
	readonly targetConversationId: string;
	readonly turnId: string;
	readonly taskId: string;
	readonly title: string;
	readonly status: string;
	readonly routing: MetaWorkRoutingProjection | null;
	readonly attempts: Record<string, MetaWorkAttemptProjection[]>;
	readonly goal: string | null;
	readonly startedAt: string | null;
	readonly completedAt: string | null;
	readonly progressSummary: string | null;
	readonly schedulingReason: string | null;
	readonly subtasks: Array<{
		readonly id: string;
		readonly title: string;
		readonly status: string;
		readonly executor: string | null;
	}>;
	readonly pendingPermission: {
		readonly requestId: string;
		readonly status: "pending" | "resolved" | "expired";
		readonly summary: string | null;
	} | null;
	readonly artifacts: Array<{
		readonly artifactId: string;
		readonly displayName: string;
		readonly relativePath: string;
		readonly mediaType: string;
		readonly previewable: boolean;
		readonly byteLength: number;
		readonly publishedAt: string;
	}>;
	readonly result: {
		readonly resultId: string;
		readonly completeness: "complete" | "partial" | "incomplete";
		readonly certification: "certified" | "uncertified";
	} | null;
	readonly asOfSequence: number;
}

export function normalizeTaskView(
	payload: Record<string, unknown>,
): NormalizedTaskView | null {
	if (payload.queryVersion !== "task_view_v1") return null;
	const requestId = asString(payload.requestId);
	const targetConversationId = asString(payload.targetConversationId);
	const turnId = asString(payload.turnId);
	const taskId = asString(payload.taskId);
	const asOfSequence = asNumber(payload.asOfSequence);
	if (!requestId || !targetConversationId || !turnId || !taskId || asOfSequence === null) {
		return null;
	}
	const schedulingReason = asString(payload.schedulingReason);
	const subtasks: NormalizedTaskView["subtasks"] = [];
	if (Array.isArray(payload.subtasks)) {
		for (const raw of payload.subtasks) {
			const item = asRecord(raw);
			const id = asString(item?.id);
			if (!item || !id) continue;
			subtasks.push({
				id,
				title: asString(item.title) ?? "",
				status: asString(item.status) ?? "",
				executor: asString(item.executor),
			});
		}
	}
	const routingRecord = asRecord(payload.routing);
	const routing = routingRecord ? {
		executor: asString(routingRecord.executor),
		provider: asString(routingRecord.provider),
		model: asString(routingRecord.model),
		harness: asString(routingRecord.harness),
	} : null;
	const attempts: NormalizedTaskView["attempts"] = {};
	const timeline = asRecord(payload.timeline);
	if (timeline?.taskId === taskId && Array.isArray(timeline.stages)) {
		for (const rawStage of timeline.stages) {
			const stage = asRecord(rawStage);
			if (stage?.phase !== "execution" || !Array.isArray(stage.subtasks)) continue;
			for (const rawSubtask of stage.subtasks) {
				const subtask = asRecord(rawSubtask);
				const id = asString(subtask?.id);
				if (!id || !subtasks.some(item => item.id === id) || !Array.isArray(subtask?.attempts)) continue;
				attempts[id] = subtask.attempts.slice(-20).flatMap(raw => {
					const attempt = asRecord(raw);
					const attemptId = asString(attempt?.attemptId);
					return attempt && attemptId ? [{
						attemptId,
						label: asString(attempt.attemptLabel) ?? attemptId,
						status: asString(attempt.displayStatus) ?? asString(attempt.status) ?? "",
						startedAt: asString(attempt.startedAt),
						updatedAt: asString(attempt.updatedAt),
						result: (asString(attempt.result) ?? "").slice(0, 500),
					}] : [];
				});
			}
		}
	}
	let pendingPermission: NormalizedTaskView["pendingPermission"] = null;
	const permission = asRecord(payload.pendingPermission);
	if (permission) {
		const permissionRequestId = asString(permission.requestId);
		const permissionStatus = permission.status;
		if (
			permissionRequestId
			&& (permissionStatus === "pending"
				|| permissionStatus === "resolved"
				|| permissionStatus === "expired")
		) {
			pendingPermission = {
				requestId: permissionRequestId,
				status: permissionStatus,
				summary: asString(permission.summary),
			};
		}
	}
	const artifacts: NormalizedTaskView["artifacts"] = [];
	if (Array.isArray(payload.artifacts)) {
		for (const raw of payload.artifacts) {
			const item = asRecord(raw);
			const artifactId = asString(item?.artifactId);
			if (!item || !artifactId) continue;
			artifacts.push({
				artifactId,
				displayName: asString(item.displayName) ?? "",
				relativePath: asString(item.relativePath) ?? "",
				mediaType: asString(item.mediaType) ?? "",
				previewable: item.previewable === true,
				byteLength: asNumber(item.byteLength) ?? 0,
				publishedAt: asString(item.publishedAt) ?? "",
			});
		}
	}
	let result: NormalizedTaskView["result"] = null;
	const resultRecord = asRecord(payload.result);
	if (resultRecord) {
		const resultId = asString(resultRecord.resultId);
		if (resultId) {
			const completeness = resultRecord.completeness;
			result = {
				resultId,
				completeness: completeness === "partial" || completeness === "incomplete"
					? completeness
					: "complete",
				certification: resultRecord.certification === "uncertified"
					? "uncertified"
					: "certified",
			};
		}
	}
	return {
		requestId,
		targetConversationId,
		turnId,
		taskId,
		title: asString(payload.title) ?? "",
		status: asString(payload.status) ?? "",
		routing,
		attempts,
		goal: asString(payload.goal),
		startedAt: asString(payload.startedAt),
		completedAt: asString(payload.completedAt),
		progressSummary: asString(payload.progressSummary),
		schedulingReason,
		subtasks,
		pendingPermission,
		artifacts,
		result,
		asOfSequence,
	};
}
