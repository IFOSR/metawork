import { createHash } from 'node:crypto';

/**
 * Pure, dependency-light identity of a managed local service specification.
 *
 * The revision describes the *launch contract* only: what command runs, where,
 * with which environment references, on which loopback address and health path.
 * The owning `taskId` is provenance, not part of the contract, so a new Task in
 * the same Workspace that asks for the very same service keeps the same
 * revision instead of forcing a specification update (2026-10-27 realignment
 * §4.2: historical service facts must not block the current specification).
 */
export interface LocalServiceRevisionInput {
  serviceId: string;
  taskId: string;
  command: string;
  args: string[];
  directory?: string;
  environmentReferences: Record<string, string>;
  host: '127.0.0.1' | '::1';
  port: number | null;
  healthPath: string | null;
  startupTimeoutMs: number;
  restartPolicy: 'explicit';
  origin?: 'manifest' | 'discovered';
}

export function localServiceSpecificationRevision(
  specification: LocalServiceRevisionInput & { revision?: string },
): string {
  const contract = [
    specification.serviceId,
    specification.command,
    specification.args,
    specification.directory ?? null,
    Object.entries(specification.environmentReferences).sort(([left], [right]) => left.localeCompare(right)),
    specification.host,
    specification.port,
    specification.healthPath,
    specification.startupTimeoutMs,
    specification.restartPolicy,
  ];
  // The historical manifest contract is exactly those ten fields. Persisted
  // records already carry a revision computed from them, so the material must
  // stay byte-identical for a manifest specification: appending an element
  // would invalidate every stored registration on upgrade. A discovered
  // contract is a different launch source, so it is namespaced instead of
  // reusing the manifest material.
  const material = specification.origin === 'discovered'
    ? JSON.stringify(['discovered', ...contract])
    : JSON.stringify(contract);
  return `service_revision_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}
