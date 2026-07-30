import {
  normalizePartitionIdentity,
  type CapabilityRequestInput,
  type PartitionIdentity,
} from '../resource/index.js';

export interface CapabilityResourceResolverPort {
  resolve(input: CapabilityRequestInput): PartitionIdentity;
}

const BROAD_RESOURCE_VALUES = new Set(['*', 'all', 'any', 'everything', '任意', '全部']);
const PRIVATE_IPV4 = /^(?:0\.|10\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|192\.168\.|198\.(?:18|19)\.|172\.(?:1[6-9]|2\d|3[01])\.)/u;

export class RegisteredCapabilityResourceResolver implements CapabilityResourceResolverPort {
  constructor(private readonly registrations: ReadonlyMap<string, PartitionIdentity>) {}

  resolve(input: CapabilityRequestInput): PartitionIdentity {
    const resource = input.resource.normalize('NFC').trim();
    if (!resource || BROAD_RESOURCE_VALUES.has(resource.toLowerCase()) || resource.includes('*')) {
      throw new Error('capability resource must be concrete and narrow');
    }
    if (input.capability === 'network_target') return this.resolveNetworkTarget(resource);
    const registered = this.registrations.get(resource);
    if (!registered) throw new Error('capability resource is not registered for this Task');
    return normalizePartitionIdentity(registered);
  }

  private resolveNetworkTarget(resource: string): PartitionIdentity {
    const url = new URL(resource);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('network target must be a credential-free public HTTP(S) URL');
    }
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.includes(':') || PRIVATE_IPV4.test(host)) {
      throw new Error('loopback and private network targets are forbidden');
    }
    const normalizedPath = url.pathname.split('/').filter(Boolean).join('/') || 'root';
    return normalizePartitionIdentity({
      kind: 'external_object',
      provider: url.protocol.slice(0, -1),
      account: 'public',
      collection: host,
      objectId: `${url.port || (url.protocol === 'https:' ? '443' : '80')}/${normalizedPath}`,
    });
  }
}
