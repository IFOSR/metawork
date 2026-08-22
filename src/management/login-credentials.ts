import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Web 工作台账密登录凭据（MVP：单账号，服务端预设）。
 *
 * 凭据来源优先级：
 * 1. `ANYFUSION_WEB_USERNAME` + `ANYFUSION_WEB_PASSWORD`（明文）
 * 2. `ANYFUSION_WEB_USERNAME` + `ANYFUSION_WEB_PASSWORD_HASH`（scrypt，格式 `saltHex:hashHex`）
 * 3. 未配置时生成 `admin` + 随机 8 位密码（启动时打印到终端）
 */

const USERNAME_PATTERN = /^[\w.@-]{1,64}$/u;

export interface LoginCredentials {
  readonly username: string;
  /** 明文密码；仅在未配置 hash 时存在。 */
  readonly password?: string;
  /** scrypt hash（`saltHex:hashHex`）；优先于明文密码。 */
  readonly passwordHash?: string;
  /** 是否为自动生成的凭据（需要启动时展示给用户）。 */
  readonly generated: boolean;
}

export interface LoginCredentialsEnv {
  ANYFUSION_WEB_USERNAME?: string;
  ANYFUSION_WEB_PASSWORD?: string;
  ANYFUSION_WEB_PASSWORD_HASH?: string;
}

export function resolveLoginCredentials(env: LoginCredentialsEnv): LoginCredentials {
  const username = normalizeUsername(env.ANYFUSION_WEB_USERNAME) ?? 'admin';
  if (env.ANYFUSION_WEB_PASSWORD_HASH) {
    assertHashFormat(env.ANYFUSION_WEB_PASSWORD_HASH);
    return {
      username,
      passwordHash: env.ANYFUSION_WEB_PASSWORD_HASH,
      generated: false,
    };
  }
  if (env.ANYFUSION_WEB_PASSWORD) {
    return {
      username,
      password: env.ANYFUSION_WEB_PASSWORD,
      generated: false,
    };
  }
  return generateLoginCredentials(username);
}

export function generateLoginCredentials(
  username = 'admin',
): LoginCredentials & { password: string } {
  return {
    username,
    password: generateReadablePassword(),
    generated: true,
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

function generateReadablePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let password = '';
  for (let index = 0; index < 8; index += 1) {
    password += alphabet[randomInt(alphabet.length)];
  }
  void randomBytes(0);
  return password;
}

function assertHashFormat(hash: string): void {
  const parts = hash.split(':');
  if (parts.length !== 2 || !/^[0-9a-f]{32}$/u.test(parts[0]!) || !/^[0-9a-f]{64}$/u.test(parts[1]!)) {
    throw new Error(
      'ANYFUSION_WEB_PASSWORD_HASH must be formatted as "<scryptSaltHex>:<scryptHashHex>" (16-byte salt, 32-byte key).',
    );
  }
}
