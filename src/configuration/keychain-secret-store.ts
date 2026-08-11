import { spawn } from 'node:child_process';
import type { SecretReference, SecretStore } from './secret-store.js';
import { assertSecretReference } from './secret-store.js';

export interface SecurityCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SecurityCommandRunner = (
  args: readonly string[],
  stdin?: string,
) => Promise<SecurityCommandResult>;

export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly run: SecurityCommandRunner = runSecurityCommand,
    private readonly account = 'anyfusion',
  ) {}

  async get(reference: SecretReference): Promise<string> {
    const service = this.serviceFor(reference);
    const result = await this.run([
      'find-generic-password',
      '-a',
      this.account,
      '-s',
      service,
      '-w',
    ]);
    return this.requireSuccess(result);
  }

  async put(reference: SecretReference, value: string): Promise<void> {
    const service = this.serviceFor(reference);
    const result = await this.run([
      'add-generic-password',
      '-U',
      '-a',
      this.account,
      '-s',
      service,
      '-w',
    ], value);
    this.requireSuccess(result);
  }

  async delete(reference: SecretReference): Promise<void> {
    const service = this.serviceFor(reference);
    const result = await this.run([
      'delete-generic-password',
      '-a',
      this.account,
      '-s',
      service,
    ]);
    this.requireSuccess(result);
  }

  private serviceFor(reference: SecretReference): string {
    assertSecretReference(reference);
    if (!reference.startsWith('keychain:')) {
      throw new Error('Keychain secret store requires a keychain reference');
    }
    return `com.anyfusion.secret.${reference.slice('keychain:'.length)}`;
  }

  private requireSuccess(result: SecurityCommandResult): string {
    if (result.code !== 0) {
      throw new Error(`Keychain operation failed with status ${result.code}`);
    }
    return result.stdout.trimEnd();
  }
}

async function runSecurityCommand(
  args: readonly string[],
  stdin = '',
): Promise<SecurityCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}
