import { scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Web 工作台账密登录凭据（单账号，服务端预设）。
 *
 * 凭据来源优先级：
 * 1. `ANYFUSION_WEB_USERNAME` + `ANYFUSION_WEB_PASSWORD_HASH`（scrypt，格式 `saltHex:hashHex`）
 * 2. `ANYFUSION_WEB_USERNAME` + `ANYFUSION_WEB_PASSWORD`（明文）
 * 3. 内置默认 `admin` / `123456`
 *
 * 内置默认值与 `metawork.sh`、`src/installation/native-launcher.ts` 一致。
 * 凭据永不随机生成：登录信息只能由用户显式修改，Server 不得擅自变更。
 */

const USERNAME_PATTERN = /^[\w.@-]{1,64}$/u;
const BUILT_IN_USERNAME = 'admin';
const BUILT_IN_PASSWORD = '123456';

export interface LoginCredentials {
  readonly username: string;
  /** 明文密码；仅在未配置 hash 时存在。 */
  readonly password?: string;
  /** scrypt hash（`saltHex:hashHex`）；优先于明文密码。 */
  readonly passwordHash?: string;
  /** 是否仍在使用内置默认密码（仅用于启动提示，不代表凭据被生成）。 */
  readonly builtInDefault: boolean;
}

export interface LoginCredentialsEnv {
  ANYFUSION_WEB_USERNAME?: string;
  ANYFUSION_WEB_PASSWORD?: string;
  ANYFUSION_WEB_PASSWORD_HASH?: string;
}

export function resolveLoginCredentials(env: LoginCredentialsEnv): LoginCredentials {
  const username = normalizeUsername(env.ANYFUSION_WEB_USERNAME) ?? BUILT_IN_USERNAME;
  if (env.ANYFUSION_WEB_PASSWORD_HASH) {
    assertHashFormat(env.ANYFUSION_WEB_PASSWORD_HASH);
    return {
      username,
      passwordHash: env.ANYFUSION_WEB_PASSWORD_HASH,
      builtInDefault: false,
    };
  }
  if (env.ANYFUSION_WEB_PASSWORD) {
    return {
      username,
      password: env.ANYFUSION_WEB_PASSWORD,
      builtInDefault: false,
    };
  }
  return {
    username,
    password: BUILT_IN_PASSWORD,
    builtInDefault: true,
  };
}

export function verifyLogin(
  username: string,
  password: string,
  credentials: LoginCredentials,
): boolean {
  if (!safeEquals(credentials.username, normalizeUsername(username) ?? '\0')) {
    return false;
  }
  if (credentials.passwordHash) {
    const [saltHex, expectedHex] = credentials.passwordHash.split(':');
    if (!saltHex || !expectedHex) return false;
    try {
      const salt = Buffer.from(saltHex, 'hex');
      const actual = scryptSync(password, salt, 32);
      const expected = Buffer.from(expectedHex, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  return safeEquals(credentials.password ?? '\0', password);
}

function safeEquals(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    // 长度不同也要消耗一次比较，避免通过耗时区分长度。
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function normalizeUsername(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed || !USERNAME_PATTERN.test(trimmed)) return null;
  return trimmed.toLocaleLowerCase();
}

function assertHashFormat(hash: string): void {
  const parts = hash.split(':');
  if (parts.length !== 2 || !/^[0-9a-f]{32}$/u.test(parts[0]!) || !/^[0-9a-f]{64}$/u.test(parts[1]!)) {
    throw new Error(
      'ANYFUSION_WEB_PASSWORD_HASH must be formatted as "<scryptSaltHex>:<scryptHashHex>" (16-byte salt, 32-byte key).',
    );
  }
}
