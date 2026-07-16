// Canonical, Planner-safe routing descriptions for built-in executor classes.
// Runtime configuration remains owned by adapters and is intentionally excluded.

export interface PlannerExecutorCatalogEntry {
  name: string;
  routingCapabilities: string[];
  primaryUseCases: string[];
  avoidUseCases: string[];
  affordances: string[];
}

export interface PlannerExecutorCatalog {
  version: 1;
  executors: PlannerExecutorCatalogEntry[];
}

const EXECUTORS: readonly PlannerExecutorCatalogEntry[] = [
  {
    name: 'codex-cli',
    routingCapabilities: ['workspace-engineering'],
    primaryUseCases: ['repository implementation', 'tests', 'engineering documentation', 'local artifacts'],
    avoidUseCases: ['current public-web research requiring source-backed delivery'],
    affordances: ['workspace-read-write', 'workspace-command-validation'],
  },
  {
    name: 'pi-agent',
    routingCapabilities: ['current-web-research'],
    primaryUseCases: ['current public-web research', 'source verification', 'citation handoff'],
    avoidUseCases: ['repository modification and engineering verification'],
    affordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
  },
];

export function getPlannerExecutorCatalog(): PlannerExecutorCatalog {
  return {
    version: 1,
    executors: EXECUTORS.map(executor => ({
      ...executor,
      routingCapabilities: [...executor.routingCapabilities],
      primaryUseCases: [...executor.primaryUseCases],
      avoidUseCases: [...executor.avoidUseCases],
      affordances: [...executor.affordances],
    })),
  };
}
