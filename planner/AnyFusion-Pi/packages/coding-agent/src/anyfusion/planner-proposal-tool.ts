import { readFileSync } from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import { defineTool, type ToolDefinition } from "../core/extensions/types.ts";
import type { SessionEntry } from "../core/session-manager.ts";
import { AnyFusionPlannerHostClient } from "./planner-host-client.ts";
import type { PlannerProposalGate } from "./planner-proposal-gate.ts";
import {
	createPlannerProposalSubmissionId,
	type PlannerProposalPurpose,
	type PlannerProposalResult,
	type PlannerRuntimeMode,
} from "./planner-proposal-types.ts";

const TOOL_NAME = "submit_planning_proposal";

export function createPlanningProposalTool(
	schemaPath: string | undefined,
	proposalGate?: PlannerProposalGate,
): ToolDefinition {
	const planSchema = readPlanSchema(schemaPath);
	let client: AnyFusionPlannerHostClient | undefined;
	let clientKey = "";

	return defineTool({
		name: TOOL_NAME,
		label: "Submit planning proposal",
		description:
			"Submit a PlanningAgentPlan v8 proposal to MetaClaw for authoritative validation and Kernel handling. The runtime injects session, turn, user input, and submission identity.",
		promptSnippet: "Submit a PlanningAgentPlan v8 proposal to MetaClaw and read the structured result",
		promptGuidelines: [
			"Every completed semantic turn must call submit_planning_proposal; do not finish with assistant text alone.",
			"Pass only the plan. Never invent sessionId, turnId, userInput, or submissionId.",
			"If MetaClaw returns rejected, read every issue, revise the plan, and call the tool again in this same turn.",
			"If transport is uncertain, replay the identical plan so MetaClaw can return the authoritative idempotent result.",
		],
		parameters: Type.Object(
			{ plan: Type.Unsafe<Record<string, unknown>>(planSchema) },
			{ additionalProperties: false },
		),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (proposalGate?.unavailableReason) {
				return {
					content: [{ type: "text", text: proposalGate.unavailableReason }],
					details: { status: "planner_context_unavailable", message: proposalGate.unavailableReason },
				};
			}
			const runtime = deriveRuntimeContext(ctx.sessionManager.getBranch(), ctx.mode);
			const submissionId = createPlannerProposalSubmissionId(runtime.sessionId, runtime.turnId, params.plan);
			if (signal?.aborted) throw abortError();
			let result: PlannerProposalResult;
			try {
				const socketPath = requiredEnv("ANYFUSION_BRIDGE_SOCKET");
				const key = `${socketPath}\n${runtime.sessionId}\n${runtime.mode}`;
				if (!client || clientKey !== key) {
					client?.close();
					client = new AnyFusionPlannerHostClient(socketPath, runtime.sessionId, runtimeVersion(), runtime.mode);
					clientKey = key;
				}
				await client.connect();
				result = await client.submitProposal(
					{
						turnId: runtime.turnId,
						userInput: runtime.userInput,
						submissionId,
						purpose: runtime.purpose,
						plan: params.plan,
					},
					signal,
				);
			} catch (error) {
				result = {
					status: "transport_uncertain",
					turnId: runtime.turnId,
					submissionId,
					retryableByReplay: true,
					message: error instanceof Error ? error.message : String(error),
				};
			}

			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
				terminate: result.status === "accepted" || result.status === "conflict",
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("muted", "Submitting proposal to MetaClaw…"), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as PlannerProposalResult | undefined;
			if (!details) return new Text("MetaClaw returned no proposal result.", 0, 0);
			if (details.status === "accepted") {
				return new Text(theme.fg("success", details.displayText), 0, 0);
			}
			if (details.status === "rejected") {
				return new Text(
					theme.fg("warning", `Proposal rejected:\n${details.issues.map((issue) => `- ${issue}`).join("\n")}`),
					0,
					0,
				);
			}
			return new Text(theme.fg("warning", details.message), 0, 0);
		},
	});
}

function readPlanSchema(schemaPath: string | undefined): TSchema {
	if (!schemaPath) throw new Error("ANYFUSION_PLANNER_SCHEMA_PATH is required for submit_planning_proposal");
	const parsed: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("PlanningAgentPlan v8 schema must be a JSON object");
	}
	return parsed as TSchema;
}

function deriveRuntimeContext(
	entries: SessionEntry[],
	mode: string,
): {
	sessionId: string;
	turnId: string;
	userInput: string;
	purpose: PlannerProposalPurpose;
	mode: PlannerRuntimeMode;
} {
	const entry = latestUserEntry(entries);
	const userInput = extractUserText(entry);
	if (!userInput.trim()) throw new Error("Current Planner turn does not contain user input");
	const purpose = process.env.ANYFUSION_PLANNER_TURN_PURPOSE === "validation" ? "validation" : "kernel";
	return {
		sessionId: requiredEnv("ANYFUSION_PLANNER_SESSION_ID", "METACLAW_PLANNER_SESSION_ID"),
		turnId: `turn_${entry.id}`,
		userInput,
		purpose,
		mode: mode === "rpc" ? "rpc" : "interactive",
	};
}

function latestUserEntry(entries: SessionEntry[]): Extract<SessionEntry, { type: "message" }> {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "user") return entry;
	}
	throw new Error("Current Planner turn has no persisted user message");
}

function extractUserText(entry: Extract<SessionEntry, { type: "message" }>): string {
	if (!("content" in entry.message)) return "";
	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && part.type === "text" ? part.text : ""))
		.filter((part): part is string => typeof part === "string")
		.join("\n")
		.trim();
}

function requiredEnv(...names: string[]): string {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	throw new Error(`Missing required Planner runtime environment: ${names.join(" or ")}`);
}

function runtimeVersion(): string {
	return process.env.ANYFUSION_PLANNER_RUNTIME_VERSION?.trim() || "0.80.2-anyfusion";
}

function abortError(): Error {
	const error = new Error("Planner proposal submission aborted");
	error.name = "AbortError";
	return error;
}
