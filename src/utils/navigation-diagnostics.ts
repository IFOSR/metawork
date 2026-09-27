import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

type NavigationStage = 'catalog_read' | 'activity_projection' | 'journal_replay'
  | 'record_read' | 'history_enrichment' | 'directory_read';
interface StageMeasurement { calls: number; items: number; milliseconds: number }
type Measurements = Partial<Record<NavigationStage, StageMeasurement>>;
const context = new AsyncLocalStorage<Measurements>();

export async function collectNavigationDiagnostics<T>(operation: () => Promise<T>) {
  const stages: Measurements = {};
  const started = performance.now();
  const result = await context.run(stages, operation);
  return { result, milliseconds: performance.now() - started, stages: structuredClone(stages) };
}

function record(stages: Measurements, stage: NavigationStage, started: number, items: number) {
  const entry = stages[stage] ??= { calls: 0, items: 0, milliseconds: 0 };
  entry.calls += 1;
  entry.items += items;
  entry.milliseconds += performance.now() - started;
}

export async function measureNavigationStage<T>(
  stage: NavigationStage, operation: () => Promise<T>, items = 0,
): Promise<T> {
  const stages = context.getStore();
  if (!stages) return operation();
  const started = performance.now();
  try { return await operation(); }
  finally { record(stages, stage, started, items); }
}

export function measureNavigationStageSync<T>(
  stage: NavigationStage, operation: () => T, items = 0,
): T {
  const stages = context.getStore();
  if (!stages) return operation();
  const started = performance.now();
  try { return operation(); }
  finally { record(stages, stage, started, items); }
}
