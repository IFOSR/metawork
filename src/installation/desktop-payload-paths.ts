import { join } from 'node:path';

/**
 * Payload paths inside a signed Desktop release.
 *
 * The bundled Runtime/Planner trees are staged verbatim, but the memory engine is
 * staged into `<release>/memory/tdai`, so the caller must pass the engine root
 * itself (`payload/memory/tdai`) rather than its parent. Passing the parent
 * produced `<release>/memory/tdai/tdai` during a clean install and, when the
 * argument was omitted entirely, no engine at all — both leave the product with
 * a long-term memory switch that can never work.
 */
export function desktopPayloadRoots(resources: string): {
  sourceRoot: string;
  plannerRoot: string;
  memoryRoot: string;
} {
  return {
    sourceRoot: join(resources, 'payload', 'metawork'),
    plannerRoot: join(resources, 'payload', 'planner'),
    memoryRoot: join(resources, 'payload', 'memory', 'tdai'),
  };
}
