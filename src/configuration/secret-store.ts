export type SecretReference = `keychain:${string}` | `file-secret:${string}`;

export interface SecretStore {
  get(reference: SecretReference): Promise<string>;
  put(reference: SecretReference, value: string): Promise<void>;
  delete(reference: SecretReference): Promise<void>;
}

export function assertSecretReference(value: string): asserts value is SecretReference {
  if (!/^(?:keychain|file-secret):[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(value)) {
    throw new Error('invalid secret reference');
  }
}
