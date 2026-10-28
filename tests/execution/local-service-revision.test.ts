import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { localServiceSpecificationRevision } from '../../src/core/local-service-revision.js';
import type { LocalServiceSpecification } from '../../src/task/local-service.js';

const manifest: LocalServiceSpecification = {
  serviceId: 'backend',
  taskId: 'task_1',
  command: 'node',
  args: ['server.mjs'],
  environmentReferences: {},
  host: '127.0.0.1',
  port: 8080,
  healthPath: '/health',
  startupTimeoutMs: 10_000,
  restartPolicy: 'explicit',
  origin: 'manifest',
};

/** The revision material shipped before discovered contracts existed. */
function historicalRevision(specification: LocalServiceSpecification): string {
  const material = JSON.stringify([
    specification.serviceId,
    specification.command,
    specification.args,
    specification.directory ?? null,
    Object.entries(specification.environmentReferences)
      .sort(([left], [right]) => left.localeCompare(right)),
    specification.host,
    specification.port,
    specification.healthPath,
    specification.startupTimeoutMs,
    specification.restartPolicy,
  ]);
  return `service_revision_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

describe('local service specification revision', () => {
  it('keeps the historical hash for a manifest contract, including legacy rows without origin', () => {
    // Persisted `managed_local_services` rows already store this revision. If
    // the material changed, every stored registration would look "already bound
    // to another launch contract" and Server recovery could not save it.
    expect(localServiceSpecificationRevision(manifest)).toBe(historicalRevision(manifest));
    const { origin: _origin, ...legacy } = manifest;
    expect(localServiceSpecificationRevision(legacy)).toBe(historicalRevision(manifest));
  });

  it('namespaces a discovered contract so adopting a manifest is a real change', () => {
    const discovered: LocalServiceSpecification = { ...manifest, origin: 'discovered' };
    expect(localServiceSpecificationRevision(discovered))
      .not.toBe(localServiceSpecificationRevision(manifest));
    expect(localServiceSpecificationRevision(discovered))
      .toBe(localServiceSpecificationRevision({ ...discovered }));
  });

  it('ignores the owning Task because provenance is not part of the contract', () => {
    expect(localServiceSpecificationRevision({ ...manifest, taskId: 'task_2' }))
      .toBe(localServiceSpecificationRevision(manifest));
  });
});
