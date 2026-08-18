/**
 * 账户解析器（ADR-0031 第 6 节）。
 *
 * 把已认证 Principal 映射到被授权的账户记录。客户端提供的账户 ID 最多只是
 * 请求提示，绝不做权威；未知、撤销或歧义映射一律 fail closed。解析器只做
 * 映射，不激活 Runtime。
 */

import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import type { Principal } from '../account/types.js';

export type AccountResolution =
  | { readonly status: 'authorized'; readonly accountId: string }
  | { readonly status: 'denied'; readonly reason: string };

export interface AccountResolver {
  resolve(principal: Principal): Promise<AccountResolution>;
}

/** 静态映射解析器：`kind:id` -> accountId，未知映射 fail closed。 */
export class StaticAccountResolver implements AccountResolver {
  constructor(private readonly mappings: ReadonlyMap<string, string>) {}

  async resolve(principal: Principal): Promise<AccountResolution> {
    const accountId = this.mappings.get(principalKey(principal));
    if (!accountId) {
      return { status: 'denied', reason: 'principal has no authorized account mapping' };
    }
    return { status: 'authorized', accountId };
  }
}

/** 本地解析器：local Principal 固定映射到 `local-default`。 */
export class LocalAccountResolver implements AccountResolver {
  async resolve(principal: Principal): Promise<AccountResolution> {
    if (principal.kind !== 'local') {
      return {
        status: 'denied',
        reason: `principal kind not authorized locally: ${principal.kind}`,
      };
    }
    return { status: 'authorized', accountId: LOCAL_DEFAULT_ACCOUNT_ID };
  }
}

function principalKey(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}
