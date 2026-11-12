// 待激活 Provider 暂存区。
//
// 用户在设置页填好 Provider（端点 + API Key）但还没点"保存并激活"时，这些
// 事实只存在于浏览器内存里：Provider 不在已激活配置中，API Key 也不在凭据库。
// 于是"获取模型能力""更新智能体介绍"这类需要调用模型的辅助功能拿不到任何
// 可用通道。
//
// 本存储让这类调用在等待激活期间也能工作：
//   - 端点与协议来自本机已落盘的数据（不是客户端任意输入），因此不放松
//     "客户端提交的 baseUrl 不得成为任意代理目标"这条边界；
//   - API Key 仍然写进本机凭据库，暂存区只保存密钥引用，不保存明文；
//   - Provider 成功激活后从暂存区移除，避免两处事实长期分叉。
//
// 暂存区是"编辑态"事实，不是配置事实：它不会进入已激活配置，不参与 Planner
// 路由，也不会被任何执行路径当成授权。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface PendingProvider {
  readonly providerRef: string;
  readonly baseUrl: string;
  readonly protocol: string;
  /** 凭据库中的密钥引用；明文不落在这里。 */
  readonly apiKeyRef: string;
  readonly savedAt: string;
}

export interface PendingProviderStore {
  read(): Promise<PendingProvider[]>;
  remember(provider: PendingProvider): Promise<void>;
  /** Provider 已进入已激活配置：移除暂存事实。 */
  forget(providerRefs: readonly string[]): Promise<void>;
}

interface PendingProviderFile {
  version: 1;
  providers: PendingProvider[];
}

const FILE_VERSION = 1;

export class FilePendingProviderStore implements PendingProviderStore {
  private readonly filePath: string;

  constructor(rootPath: string) {
    this.filePath = join(resolve(rootPath), 'pending-providers.json');
  }

  async read(): Promise<PendingProvider[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PendingProviderFile>;
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.providers)) return [];
      return parsed.providers.filter(isPendingProvider);
    } catch {
      return [];
    }
  }

  async remember(provider: PendingProvider): Promise<void> {
    const current = await this.read();
    const next = [
      ...current.filter(item => item.providerRef !== provider.providerRef),
      provider,
    ];
    await this.write(next);
  }

  async forget(providerRefs: readonly string[]): Promise<void> {
    if (!providerRefs.length) return;
    const removing = new Set(providerRefs);
    const current = await this.read();
    const next = current.filter(item => !removing.has(item.providerRef));
    if (next.length === current.length) return;
    await this.write(next);
  }

  private async write(providers: PendingProvider[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    const payload: PendingProviderFile = { version: FILE_VERSION, providers };
    try {
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function isPendingProvider(value: unknown): value is PendingProvider {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.providerRef === 'string' && record.providerRef.length > 0
    && typeof record.baseUrl === 'string' && record.baseUrl.length > 0
    && typeof record.protocol === 'string' && record.protocol.length > 0
    && typeof record.apiKeyRef === 'string' && record.apiKeyRef.length > 0
    && typeof record.savedAt === 'string';
}
