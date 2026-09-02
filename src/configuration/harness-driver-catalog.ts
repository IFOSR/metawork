import type {
  HarnessDriverId,
  HarnessExecutionProtocolId,
  HarnessKind,
} from './types.js';

export interface HarnessDriverCatalogEntry {
  kind: HarnessKind;
  transport: string;
  command?: string;
  executionProtocols: readonly HarnessExecutionProtocolId[];
}

export const HARNESS_DRIVER_CATALOG = {
  'a2a-v1': {
    kind: 'executor',
    transport: 'a2a',
    executionProtocols: [],
  },
  'anyfusion-planner-host-v2': {
    kind: 'planner',
    transport: 'local-process',
    executionProtocols: [],
  },
  'codex-cli': {
    kind: 'executor',
    transport: 'local-cli',
    command: 'codex',
    executionProtocols: ['workspace-image-artifact-v1'],
  },
  'container-cli': {
    kind: 'executor',
    transport: 'container',
    executionProtocols: [],
  },
  'pi-cli': {
    kind: 'executor',
    transport: 'local-cli',
    command: 'pi',
    executionProtocols: ['workspace-image-artifact-v1'],
  },
} as const satisfies Record<HarnessDriverId, HarnessDriverCatalogEntry>;

export function harnessDriverCatalogEntry(
  driverId: string,
): HarnessDriverCatalogEntry | undefined {
  return HARNESS_DRIVER_CATALOG[driverId as HarnessDriverId];
}
