import { describe, expect, it } from "vitest";
import { createPlannerProposalSubmissionId } from "../src/anyfusion/planner-proposal-types.ts";

describe("Planner proposal identity", () => {
	it("is stable across object key order and changes with a revised plan", () => {
		const first = createPlannerProposalSubmissionId("session", "turn", { b: 2, a: { y: 2, x: 1 } });
		const replay = createPlannerProposalSubmissionId("session", "turn", { a: { x: 1, y: 2 }, b: 2 });
		const revised = createPlannerProposalSubmissionId("session", "turn", { a: { x: 1, y: 3 }, b: 2 });
		expect(replay).toBe(first);
		expect(revised).not.toBe(first);
	});
});
