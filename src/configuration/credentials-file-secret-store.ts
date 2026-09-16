import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecretReference, SecretStore } from './secret-store.js';
import { assertSecretReference } from './secret-store.js';

interface CredentialsDocument {
  version: 1;
  providers: Record<string, string>;
}

const PROVIDER_REFERENCE =
  /^(?:file-secret|keychain):anyfusion\/providers\/([a-z][a-z0-9-]{0,63})$/u;

export class CredentialsFileSecretStore implements SecretStore {
  constructor(readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  async get(reference: SecretReference): Promise<string> {
    const providerRef = providerRefFromSecretReference(reference);
    const document = await this.read();
    const value = document.providers[providerRef];
    if (!value) throw new Error(`provider credential is missing: ${providerRef}`);
    return value;
  }

  async put(reference: SecretReference, value: string): Promise<void> {
    const providerRef = providerRefFromSecretReference(reference);
    const current = await this.readOrEmpty();
    await this.writeAtomic({
      version: 1,
      providers: { ...current.providers, [providerRef]: value },
    });
  }

  async delete(reference: SecretReference): Promise<void> {
    const providerRef = providerRefFromSecretReference(reference);
    const current = await this.readOrEmpty();
    if (!(providerRef in current.providers)) return;
    const providers = { ...current.providers };
    delete providers[providerRef];
    await this.writeAtomic({ version: 1, providers });
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
      text = await readFile(this.filePath, 'utf8');
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

  private async writeAtomic(document: CredentialsDocument): Promise<void> {
    await this.initialize();
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(document, null, 2)}\n`,
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
  assertSecretReference(reference);
  const match = PROVIDER_REFERENCE.exec(reference);
  if (!match) {
    throw new Error('credentials file store only supports Provider secret references');
  }
  return match[1]!;
}

function isCredentialsDocument(value: unknown): value is CredentialsDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.providers || typeof record.providers !== 'object'
    || Array.isArray(record.providers)) {
    return false;
  }
  return Object.values(record.providers).every(item => typeof item === 'string');
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT');
}
