import { createHash } from "node:crypto";

export type PlannerProposalPurpose = "kernel" | "validation" | "configuration";
export type PlannerRuntimeMode = "interactive" | "rpc";

export type ExecutorManualProposalResult =
	| {
			status: "accepted";
			agentClassRef: string;
			userProfile: {
				sourceText: string;
				assertions: Array<{
					topic: "mission" | "strength" | "limitation" | "preferred-task" | "avoid-task" | "model-contribution" | "capability-policy" | "delivery";
					text: string;
					target?: string;
					modelRef?: string;
					modelCapability?: "coding" | "image-editing" | "image-generation" | "long-context" | "planning" | "structured-output" | "tools" | "vision";
					routingCapability?: "current-web-research" | "image-editing" | "image-generation" | "workspace-engineering";
					disposition?: "preferred" | "allowed" | "avoid" | "disabled";
				}>;
			};
	  }
	| { status: "rejected"; issues: string[] }
	| { status: "transport_uncertain"; retryableByReplay: true; message: string };

export type PlannerProposalResult =
	| {
			status: "accepted";
			turnId: string;
			submissionId: string;
			planId: string;
			outcome: string;
			displayText: string;
			taskId: string | null;
			kernel: { decisionId: string; action: string; reason: string } | null;
	  }
	| {
			status: "rejected";
			turnId: string;
			submissionId: string;
			planId: string | null;
			rejectionType: "validation" | "kernel";
			issues: string[];
			kernel: { decisionId: string; action: "reject_request"; reason: string } | null;
	  }
	| {
			status: "conflict";
			turnId: string;
			submissionId: string;
			acceptedSubmissionId: string | null;
			message: string;
	  }
	| {
			status: "transport_uncertain";
			turnId: string;
			submissionId: string;
			retryableByReplay: true;
			message: string;
	  };

export function createPlannerProposalSubmissionId(sessionId: string, turnId: string, plan: unknown): string {
	return `proposal_${createHash("sha256")
		.update(`${sessionId}\n${turnId}\n${stableJson(plan)}`)
		.digest("hex")}`;
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}
