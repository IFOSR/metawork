export interface PlannerProposalGate {
	unavailableReason: string | undefined;
}

export function createPlannerProposalGate(): PlannerProposalGate {
	return { unavailableReason: "Planner MCP context has not been initialized" };
}
