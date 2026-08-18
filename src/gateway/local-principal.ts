/**
 * 本地安装 Principal（ADR-0031 第 6 节）。
 *
 * 本地 TUI/CLI 由安装拥有的本地 Principal 表示，映射到 reserved
 * `local-default` 账户。
 */

import type { Principal } from '../account/types.js';

export const LOCAL_INSTALLATION_PRINCIPAL_ID = 'local-installation';

export function localPrincipal(): Principal {
  return { kind: 'local', id: LOCAL_INSTALLATION_PRINCIPAL_ID };
}
