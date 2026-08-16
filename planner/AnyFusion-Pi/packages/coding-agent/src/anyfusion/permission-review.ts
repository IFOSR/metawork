import type { PermissionRequestNotification } from "./planner-host-client.ts";

export class AnyFusionPermissionInbox {
	private requests: PermissionRequestNotification[] = [];
	private snoozed = false;

	enqueue(request: PermissionRequestNotification): boolean {
		if (this.requests.some((candidate) => candidate.permissionRequestId === request.permissionRequestId))
			return false;
		this.requests.push(request);
		this.requests.sort(
			(left, right) =>
				left.createdAt.localeCompare(right.createdAt) ||
				left.permissionRequestId.localeCompare(right.permissionRequestId),
		);
		return true;
	}

	remove(permissionRequestId: string): boolean {
		const previousLength = this.requests.length;
		this.requests = this.requests.filter((request) => request.permissionRequestId !== permissionRequestId);
		return this.requests.length !== previousLength;
	}

	clear(): void {
		this.requests = [];
		this.snoozed = false;
	}

	peek(now = Date.now()): PermissionRequestNotification | null {
		this.removeExpired(now);
		return this.snoozed ? null : (this.requests[0] ?? null);
	}

	removeExpired(now = Date.now()): PermissionRequestNotification[] {
		const expired = this.requests.filter((request) => Date.parse(request.expiresAt) <= now);
		if (expired.length > 0) {
			const ids = new Set(expired.map((request) => request.permissionRequestId));
			this.requests = this.requests.filter((request) => !ids.has(request.permissionRequestId));
		}
		return expired;
	}

	nextExpiryAt(): number | null {
		if (this.requests.length === 0) return null;
		return Math.min(...this.requests.map((request) => Date.parse(request.expiresAt)));
	}

	snooze(): void {
		this.snoozed = true;
	}

	resumeAfterUserInput(): void {
		this.snoozed = false;
	}
}

export function formatPermissionRequest(request: PermissionRequestNotification): string {
	return [
		"Executor 请求权限",
		`Task: ${request.taskTitle} (${request.taskId})`,
		`Subtask: ${request.subtaskTitle} (${request.subtaskId})`,
		`Executor: ${request.executorName} · ${request.permissionProfileId}`,
		`Capability: ${request.capability}`,
		`Operation: ${request.operation}`,
		`Resource: ${request.resource}`,
		`Scope: ${request.suggestedScope}`,
		`Reason: ${request.reason}`,
		`Kernel: ${request.escalationReason}`,
	].join("\n");
}
