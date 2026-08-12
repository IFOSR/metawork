import { PlannerProcessSupervisor } from '../planning/planner-process-supervisor.js';

export interface PlannerTuiProcessOptions {
  socketPath: string;
  sessionId: string;
  cwd: string;
}

/** Launches the downstream AnyFusion-Pi Planner with isolated home/config. */
export async function runPlannerTuiProcess(options: PlannerTuiProcessOptions): Promise<void> {
  const supervisor = new PlannerProcessSupervisor({
    socketPath: options.socketPath,
  });
  await supervisor.startInteractive(options);
}

export function parsePlannerTuiArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error('METACLAW_PLANNER_TUI_ARGS must be a JSON string array');
  }
  return parsed;
}
