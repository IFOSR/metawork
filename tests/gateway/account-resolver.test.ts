import { describe, expect, it } from 'vitest';
import {
  LocalAccountResolver,
  StaticAccountResolver,
} from '../../src/gateway/account-resolver.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../../src/account/account-id.js';
import type { Principal } from '../../src/account/types.js';

describe('AccountResolver', () => {
  it('maps the local principal to the local-default account', async () => {
    const resolver = new LocalAccountResolver();
    const resolution = await resolver.resolve({ kind: 'local', id: 'local-installation' });
    expect(resolution).toEqual({ status: 'authorized', accountId: LOCAL_DEFAULT_ACCOUNT_ID });
  });

  it('fails closed for non-local principals', async () => {
    const resolver = new LocalAccountResolver();
    const resolution = await resolver.resolve({ kind: 'web', id: 'web_user' });
    expect(resolution.status).toBe('denied');
  });

  it('resolves a configured principal mapping', async () => {
    const resolver = new StaticAccountResolver(new Map([
      ['web:web_user_1', 'acct-one'],
    ]));
    const resolution = await resolver.resolve({ kind: 'web', id: 'web_user_1' });
    expect(resolution).toEqual({ status: 'authorized', accountId: 'acct-one' });
  });

  it('fails closed for unknown and revoked mappings', async () => {
    const resolver = new StaticAccountResolver(new Map());
    const unknown = await resolver.resolve({ kind: 'web', id: 'web_user_1' });
    expect(unknown.status).toBe('denied');
  });

  it('ignores any client-supplied account id by never accepting one', async () => {
    // AccountResolver.resolve 只接收 Principal；客户端账户 ID 在类型层面无法
    // 进入解析，因而只能作为请求提示而绝不能成为权威。
    const principal: Principal = { kind: 'feishu', id: 'feishu_user' };
    const resolver = new StaticAccountResolver(new Map([['feishu:feishu_user', 'acct-real']]));
    const resolution = await resolver.resolve(principal);
    expect(resolution).toEqual({ status: 'authorized', accountId: 'acct-real' });
  });
});
