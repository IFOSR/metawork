import { describe, expect, it, vi } from "vitest";
import {
	AnyFusionClientModeController,
	type AnyFusionClientModeView,
} from "../src/modes/interactive/anyfusion-client-mode.ts";
import type { GatewayEventEnvelope } from "../src/anyfusion/gateway-protocol.ts";

function fixture() {
	let listener: ((event: GatewayEventEnvelope) => void) | undefined;
	const gateway = {
		onEvent: vi.fn((next: (event: GatewayEventEnvelope) => void) => {
			listener = next;
			return () => undefined;
		}),
		resume: vi.fn(async () => ({ lastSequence: 3, snapshot: [], deltas: [] })),
		submitUserInput: vi.fn(async () => ({
			requestId: "req_1",
			status: "accepted" as const,
			conversationId: "conv_native",
		})),
		submitSlashCommand: vi.fn(async () => ({
			requestId: "req_2",
			status: "accepted" as const,
			conversationId: "conv_native",
		})),
		submitPermissionResolution: vi.fn(async () => ({
			requestId: "req_3",
			status: "accepted" as const,
			conversationId: "conv_native",
		})),
	};
	const view: AnyFusionClientModeView = {
		setConnectionState: vi.fn(),
		appendUserInput: vi.fn(),
		appendGatewayEvent: vi.fn(),
		showError: vi.fn(),
	};
	const controller = new AnyFusionClientModeController({
		gateway,
		conversationId: "conv_native",
		view,
	});
	return { controller, gateway, view, publish: (event: GatewayEventEnvelope) => listener?.(event) };
}

describe("AnyFusionClientModeController", () => {
	it("submits raw editor input through Gateway without a semantic AgentSession", async () => {
		const { controller, gateway, view } = fixture();
		await controller.start();
		await controller.submit("分析这个需求");

		expect(gateway.resume).toHaveBeenCalledWith("conv_native");
		expect(gateway.submitUserInput).toHaveBeenCalledWith(
			"分析这个需求",
			{ mode: "attach", conversationId: "conv_native" },
		);
		expect(view.appendUserInput).toHaveBeenCalledWith("分析这个需求");
	});

	it("routes slash commands and renders streamed Gateway events", async () => {
		const { controller, gateway, view, publish } = fixture();
		await controller.start();
		await controller.submit("/task list");
		const event: GatewayEventEnvelope = {
			protocolVersion: 1,
			eventId: "event_trace",
			sequence: 4,
			accountId: "local-default",
			conversationId: "conv_native",
			requestId: "req_2",
			turnId: "turn_1",
			kind: "trace_delta",
			payload: { events: [{ phase: "planner", message: "Planner parsed intent" }] },
			occurredAt: "2026-08-19T00:00:00.000Z",
		};
		publish(event);

		expect(gateway.submitSlashCommand).toHaveBeenCalledWith(
			"/task list",
			{ mode: "attach", conversationId: "conv_native" },
		);
		expect(view.appendGatewayEvent).toHaveBeenCalledWith(event);
	});

	it("turns the permission selector shorthand into a permission_resolution command", async () => {
		const { controller, gateway, publish } = fixture();
		await controller.start();
		publish({
			protocolVersion: 1,
			eventId: "event_permission",
			sequence: 5,
			accountId: "local-default",
			conversationId: "conv_native",
			requestId: "req_4",
			turnId: "turn_1",
			kind: "permission_request",
			payload: { requestId: "permission_1" },
			occurredAt: "2026-08-19T00:00:00.000Z",
		});

		await controller.submit("/approve");

		expect(gateway.submitPermissionResolution).toHaveBeenCalledWith(
			"permission_1",
			"approve",
			{ mode: "attach", conversationId: "conv_native" },
		);
		expect(gateway.submitSlashCommand).not.toHaveBeenCalled();
	});
});
