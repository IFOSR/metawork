import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CONVERSATION_FORMAT_VERSION,
  type ConversationCatalogFile,
  type ConversationMetadata,
  type ConversationRecord,
  type ConversationTurn,
} from '../session/conversation-store.js';
import {
  WORKSPACE_CATALOG_VERSION,
  normalizeWorkspaceDisplayName,
  type WorkspaceCatalogFile,
  type WorkspaceRecord,
} from './workspace-types.js';

interface MigratorOptions {
  readonly accountId: string;
  readonly conversationsRoot: string;
  readonly workspaceCatalogRoot: string;
  readonly createWorkspaceId?: () => string;
  readonly now?: () => string;
}

interface LegacyWorkspace {
  readonly path: string;
  readonly selectedAt: string;
  readonly selectedByPrincipal: string;
}

interface LegacyMetadata extends Omit<ConversationMetadata, 'workspaceBinding'> {
  readonly workspace: LegacyWorkspace | null;
}

interface LegacyRecord {
  readonly version: 1 | 2;
  readonly conversation: LegacyMetadata;
  readonly turns: ConversationTurn[];
}

interface PreparedMigrationJournal {
  readonly version: 1;
  readonly state: 'prepared';
  readonly stageRoot: string;
}

export class WorkspaceConversationMigrator {
  private readonly conversationsRoot: string;
  private readonly workspaceCatalogRoot: string;

  constructor(private readonly options: MigratorOptions) {
    this.conversationsRoot = resolve(options.conversationsRoot);
    this.workspaceCatalogRoot = resolve(options.workspaceCatalogRoot);
  }

  async migrate(): Promise<void> {
    await this.recoverPreparedMigration();
    const catalogPath = join(this.conversationsRoot, 'catalog.json');
    let raw: string;
    try {
      raw = await readFile(catalogPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (parsed.version === CONVERSATION_FORMAT_VERSION) return;
    if (parsed.version !== 1 && parsed.version !== 2) {
      throw new Error('Unsupported Conversation migration version');
    }

    const legacyCatalog = parseLegacyCatalog(raw);
    const now = this.options.now?.() ?? new Date().toISOString();
    const workspaceByPath = new Map<string, WorkspaceRecord>();
    const records: ConversationRecord[] = [];

    for (const metadata of legacyCatalog.conversations) {
      const legacyRecord = await this.readLegacyRecord(metadata.id);
      let workspaceBinding: ConversationMetadata['workspaceBinding'] = null;
      if (metadata.workspace) {
        const resolved = await resolveLegacyPath(metadata.workspace.path);
        let workspace = workspaceByPath.get(resolved.path);
        if (!workspace) {
          workspace = {
            id: this.options.createWorkspaceId?.() ?? `workspace_${randomUUID()}`,
            accountId: this.options.accountId,
            displayName: normalizeWorkspaceDisplayName(basename(resolved.path) || 'Workspace'),
            canonicalPath: resolved.path,
            availability: resolved.available ? 'available' : 'unavailable',
            createdAt: now,
            updatedAt: now,
            createdByPrincipal: metadata.workspace.selectedByPrincipal,
            archived: false,
          };
          workspaceByPath.set(resolved.path, workspace);
        }
        workspaceBinding = {
          workspaceId: workspace.id,
          boundAt: metadata.workspace.selectedAt,
          boundByPrincipal: metadata.workspace.selectedByPrincipal,
        };
      }
      records.push({
        version: CONVERSATION_FORMAT_VERSION,
        conversation: {
          id: metadata.id,
          plannerSessionId: metadata.plannerSessionId,
          accountId: metadata.accountId,
          title: metadata.title,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          archived: metadata.archived,
          workspaceBinding,
        },
        turns: legacyRecord.turns,
      });
    }

    await this.commitPrepared({
      version: WORKSPACE_CATALOG_VERSION,
      workspaces: [...workspaceByPath.values()],
    }, {
      version: CONVERSATION_FORMAT_VERSION,
      conversations: records.map(record => record.conversation),
    }, records);
  }

  private async readLegacyRecord(conversationId: string): Promise<LegacyRecord> {
    const raw = await readFile(
      join(this.conversationsRoot, 'records', `${conversationId}.json`),
      'utf8',
    );
    const value = JSON.parse(raw) as LegacyRecord;
    if ((value.version !== 1 && value.version !== 2)
      || value.conversation.id !== conversationId
      || !Array.isArray(value.turns)) {
      throw new Error(`Invalid legacy Conversation record: ${conversationId}`);
    }
    return value;
  }

  private async commitPrepared(
    workspaceCatalog: WorkspaceCatalogFile,
    conversationCatalog: ConversationCatalogFile,
    records: ConversationRecord[],
  ): Promise<void> {
    const stageRoot = join(this.workspaceCatalogRoot, `.migration-${randomUUID()}`);
    const stageConversations = join(stageRoot, 'conversations');
    const journalPath = join(this.workspaceCatalogRoot, 'migration.json');
    await mkdir(join(stageConversations, 'records'), { recursive: true, mode: 0o700 });
    await atomicWriteJson(join(stageRoot, 'workspace-catalog.json'), workspaceCatalog);
    await atomicWriteJson(join(stageConversations, 'catalog.json'), conversationCatalog);
    for (const record of records) {
      await atomicWriteJson(
        join(stageConversations, 'records', `${record.conversation.id}.json`),
        record,
      );
    }
    await atomicWriteJson(journalPath, {
      version: 1,
      state: 'prepared',
      stageRoot,
    });
    await mkdir(this.workspaceCatalogRoot, { recursive: true, mode: 0o700 });
    await rename(join(stageRoot, 'workspace-catalog.json'), join(this.workspaceCatalogRoot, 'catalog.json'));
    await rename(join(stageConversations, 'catalog.json'), join(this.conversationsRoot, 'catalog.json'));
    for (const record of records) {
      await rename(
        join(stageConversations, 'records', `${record.conversation.id}.json`),
        join(this.conversationsRoot, 'records', `${record.conversation.id}.json`),
      );
    }
    await rm(stageRoot, { recursive: true, force: true });
    await unlink(journalPath).catch(() => undefined);
  }

  private async recoverPreparedMigration(): Promise<void> {
    const journalPath = join(this.workspaceCatalogRoot, 'migration.json');
    let journal: PreparedMigrationJournal;
    try {
      journal = JSON.parse(await readFile(journalPath, 'utf8')) as PreparedMigrationJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const stageRoot = resolve(journal.stageRoot);
    if (
      journal.version !== 1
      || journal.state !== 'prepared'
      || !stageRoot.startsWith(`${this.workspaceCatalogRoot}/.migration-`)
    ) {
      throw new Error('Invalid Workspace migration journal');
    }

    const stagedWorkspaceCatalog = join(stageRoot, 'workspace-catalog.json');
    const workspaceCatalog = join(this.workspaceCatalogRoot, 'catalog.json');
    await movePreparedFile(stagedWorkspaceCatalog, workspaceCatalog);
    const stagedConversationCatalog = join(stageRoot, 'conversations', 'catalog.json');
    const conversationCatalog = join(this.conversationsRoot, 'catalog.json');
    await movePreparedFile(stagedConversationCatalog, conversationCatalog);

    const catalog = JSON.parse(await readFile(conversationCatalog, 'utf8')) as {
      version?: unknown;
      conversations?: Array<{ id?: unknown }>;
    };
    if (
      catalog.version !== CONVERSATION_FORMAT_VERSION
      || !Array.isArray(catalog.conversations)
    ) {
      throw new Error('Invalid prepared Conversation catalog');
    }
    await mkdir(join(this.conversationsRoot, 'records'), { recursive: true, mode: 0o700 });
    for (const conversation of catalog.conversations) {
      if (typeof conversation.id !== 'string') {
        throw new Error('Invalid prepared Conversation metadata');
      }
      await movePreparedFile(
        join(stageRoot, 'conversations', 'records', `${conversation.id}.json`),
        join(this.conversationsRoot, 'records', `${conversation.id}.json`),
      );
      const record = JSON.parse(await readFile(
        join(this.conversationsRoot, 'records', `${conversation.id}.json`),
        'utf8',
      )) as { version?: unknown; conversation?: { id?: unknown } };
      if (
        record.version !== CONVERSATION_FORMAT_VERSION
        || record.conversation?.id !== conversation.id
      ) {
        throw new Error(`Invalid prepared Conversation record: ${conversation.id}`);
      }
    }
    await rm(stageRoot, { recursive: true, force: true });
    await unlink(journalPath).catch(() => undefined);
  }
}

function parseLegacyCatalog(raw: string): { conversations: LegacyMetadata[] } {
  const value = JSON.parse(raw) as { conversations?: LegacyMetadata[] };
  if (!Array.isArray(value.conversations)) throw new Error('Invalid legacy Conversation catalog');
  return { conversations: value.conversations };
}

async function resolveLegacyPath(path: string): Promise<{ path: string; available: boolean }> {
  try {
    const canonical = await realpath(path);
    await access(canonical);
    return { path: canonical, available: (await stat(canonical)).isDirectory() };
  } catch {
    return { path: resolve(path), available: false };
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function movePreparedFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await access(destination);
  }
}
