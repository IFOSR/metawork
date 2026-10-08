import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type { WindowsPrivateFileRoot } from '../platform/windows-private-files.js';
import type { SecretReference, SecretStore } from './secret-store.js';
import { assertSecretReference } from './secret-store.js';

interface CredentialsDocument {
  version: 1;
  providers: Record<string, string>;
  /**
   * Non-Provider MetaWork secrets (for example the optional Span routing
   * advisor credential). Kept in a separate namespace so a Provider named
   * `routing-span` can never share, overwrite or read this slot.
   */
  internal?: Record<string, string>;
}

const PROVIDER_REFERENCE =
  /^(?:file-secret|keychain):anyfusion\/(?:providers\/)?([a-z][a-z0-9-]{0,63})$/u;
const INTERNAL_REFERENCE =
  /^(?:file-secret|keychain):anyfusion\/internal\/([a-z][a-z0-9-]{0,63})$/u;

type CredentialLocation =
  | { kind: 'provider'; key: string }
  | { kind: 'internal'; key: string };

/** Resolves a supported reference to exactly one credential namespace slot. */
function locateCredential(reference: SecretReference): CredentialLocation {
  assertSecretReference(reference);
  const internal = INTERNAL_REFERENCE.exec(reference);
  if (internal) return { kind: 'internal', key: internal[1]! };
  const provider = PROVIDER_REFERENCE.exec(reference);
  if (provider) return { kind: 'provider', key: provider[1]! };
  throw new Error(
    'credentials file store only supports Provider or internal secret references',
  );
}

export class CredentialsFileSecretStore implements SecretStore {
  constructor(readonly filePath: string, private readonly windows?: WindowsPrivateFileRoot) {}

  async initialize(): Promise<void> {
    if (this.windows) {
      this.windows.files.ensurePrivateDirectory(this.windows.root);
      this.windows.files.ensurePrivateDirectory(dirname(this.filePath));
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  async validate(): Promise<void> {
    try {
      await this.read();
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
  }

  async get(reference: SecretReference): Promise<string> {
    const location = locateCredential(reference);
    const document = await this.read();
    const value = location.kind === 'provider'
      ? document.providers[location.key]
      : document.internal?.[location.key];
    if (!value) {
      throw new Error(`credential is missing: ${location.kind}/${location.key}`);
    }
    return value;
  }

  async put(reference: SecretReference, value: string): Promise<void> {
    const location = locateCredential(reference);
    const current = await this.readOrEmpty();
    await this.write(
      location.kind === 'provider'
        ? { ...current, providers: { ...current.providers, [location.key]: value } }
        : {
            ...current,
            internal: { ...current.internal, [location.key]: value },
          },
    );
  }

  async delete(reference: SecretReference): Promise<void> {
    const location = locateCredential(reference);
    const current = await this.readOrEmpty();
    if (location.kind === 'provider') {
      if (!(location.key in current.providers)) return;
      const providers = { ...current.providers };
      delete providers[location.key];
      await this.write({ ...current, providers });
      return;
    }
    if (!current.internal || !(location.key in current.internal)) return;
    const internal = { ...current.internal };
    delete internal[location.key];
    await this.write({ ...current, internal });
  }

  async putProviders(values: Record<string, string>): Promise<void> {
    const current = await this.readOrEmpty();
    await this.write({ ...current, providers: { ...current.providers, ...values } });
  }

  private async readOrEmpty(): Promise<CredentialsDocument> {
    try {
      return await this.read();
    } catch (error) {
      if (isMissingFileError(error)) {
        return { version: 1, providers: {} };
      }
      throw error;
    }
  }
  private async read(): Promise<CredentialsDocument> {
    let text: string;
    try {
      if (this.windows) {
        await this.initialize();
        text = this.windows.files.readPrivateFile(this.windows.root, relative(this.windows.root, this.filePath)).toString('utf8');
      } else text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        const missing = new Error(`credentials file is missing: ${this.filePath}`);
        Object.assign(missing, { code: 'ENOENT' });
        throw missing;
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `invalid credentials.json: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isCredentialsDocument(value)) {
      throw new Error('invalid credentials.json: expected version 1 providers object');
    }
    return value;
  }

  private async write(document: CredentialsDocument): Promise<void> {
    await this.initialize();
    const serialized = `${JSON.stringify({
      version: 1,
      providers: document.providers,
      ...(document.internal && Object.keys(document.internal).length > 0 ? { internal: document.internal } : {}),
    }, null, 2)}\n`;
    if (this.windows) {
      this.windows.files.writePrivateFile(this.windows.root, relative(this.windows.root, this.filePath), Buffer.from(serialized));
      return;
    }
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        serialized,
        { encoding: 'utf8', mode: 0o600 },
      );
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

export function providerRefFromSecretReference(reference: SecretReference): string {
  const location = locateCredential(reference);
  if (location.kind !== 'provider') {
    throw new Error('credentials file store only supports Provider secret references');
  }
  return location.key;
}

function isCredentialsDocument(value: unknown): value is CredentialsDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.providers || typeof record.providers !== 'object'
    || Array.isArray(record.providers)) {
    return false;
  }
  if (!Object.values(record.providers).every(item => typeof item === 'string')) {
    return false;
  }
  if (record.internal === undefined) return true;
  if (!record.internal || typeof record.internal !== 'object' || Array.isArray(record.internal)) {
    return false;
  }
  return Object.values(record.internal as Record<string, unknown>)
    .every(item => typeof item === 'string');
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT');
}
