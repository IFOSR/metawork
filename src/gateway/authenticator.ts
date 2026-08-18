/**
 * Gateway 认证端口（ADR-0031 第 6 节）。
 *
 * 传输适配器把传输层凭证归一化为已认证 Principal。认证只产生 Principal，
 * 绝不直接授权 Runtime 访问；账户解析由 AccountResolver 完成。
 */

import type { Principal } from '../account/types.js';
import { localPrincipal } from './local-principal.js';

export type AuthenticatorTransport = 'local' | 'web' | 'feishu' | 'app';

export interface AuthenticatorInput {
  readonly transport: AuthenticatorTransport;
  readonly credential?: unknown;
}

export interface Authenticator {
  authenticate(input: AuthenticatorInput): Promise<Principal | null>;
}

/** 本地安装认证器：把本地 socket/token 凭证映射到本地安装 Principal。 */
export class LocalAuthenticator implements Authenticator {
  async authenticate(input: AuthenticatorInput): Promise<Principal | null> {
    if (input.transport !== 'local') return null;
    return localPrincipal();
  }
}
