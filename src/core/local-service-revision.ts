import { createHash } from 'node:crypto';

/** Pure, dependency-light identity of a managed local service specification. */
export interface LocalServiceRevisionInput {
  serviceId: string;
  taskId: string;
  command: string;
  args: string[];
  directory?: string;
  environmentReferences: Record<string, string>;
  host: '127.0.0.1' | '::1';
  port: number;
  healthPath: string;
  startupTimeoutMs: number;
  restartPolicy: 'explicit';
}

export function localServiceSpecificationRevision(
  specification: LocalServiceRevisionInput & { revision?: string },
): string {
  const material = JSON.stringify([
    specification.serviceId,
    specification.taskId,
    specification.command,
    specification.args,
    specification.directory ?? null,
    Object.entries(specification.environmentReferences).sort(([left], [right]) => left.localeCompare(right)),
    specification.host,
    specification.port,
    specification.healthPath,
    specification.startupTimeoutMs,
    specification.restartPolicy,
  ]);
  return `service_revision_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}
