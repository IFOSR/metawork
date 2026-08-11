import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SecretReference, SecretStore } from './secret-store.js';
import { assertSecretReference } from './secret-store.js';

export class FileSecretStore implements SecretStore {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    await chmod(this.rootPath, 0o700);
  }

  async get(reference: SecretReference): Promise<string> {
    const path = this.pathFor(reference);
    return readFile(path, 'utf8');
  }

  async put(reference: SecretReference, value: string): Promise<void> {
    const path = this.pathFor(reference);
    await this.initialize();
    await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600);
  }

  async delete(reference: SecretReference): Promise<void> {
    await rm(this.pathFor(reference), { force: true });
  }

  async assertSecurePermissions(): Promise<void> {
    const rootMode = (await stat(this.rootPath)).mode & 0o777;
    if (rootMode !== 0o700) throw new Error('file secret store directory permissions are not secure');
  }

  private pathFor(reference: SecretReference): string {
    assertSecretReference(reference);
    if (!reference.startsWith('file-secret:')) {
      throw new Error('file secret store requires a file-secret reference');
    }
    const digest = createHash('sha256').update(reference).digest('hex');
    return join(this.rootPath, `${digest}.secret`);
  }
}
