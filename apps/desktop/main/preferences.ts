import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DesktopDraft, DesktopPreferences, DesktopViewport } from '../shared/bridge.js';
import { identifier } from './security.js';
import type { WindowsPrivateFiles } from '../../../src/platform/windows-private-files.js';

const MAX_PREFERENCES_BYTES = 9 * 1024 * 1024;

export function desktopPreferencesPath(userData: string, installationId: string, accountId: string): string {
  // Chromium owns userData/Preferences, including on case-insensitive filesystems.
  return join(userData, 'metawork-preferences', installationId, `${accountId}.json`);
}

export class DesktopPreferenceStore {
  private value: DesktopPreferences = { theme: 'system', drafts: {} };
  private pending: Promise<void> | null = null;
  private revision = 0;
  constructor(private readonly path: string, private readonly privateFiles?: WindowsPrivateFiles) {
    if (process.platform === 'win32' && !privateFiles) throw new Error('Windows preferences require the native private-file adapter');
  }

  async load(): Promise<void> {
    this.privateFiles?.ensurePrivateDirectory(dirname(this.path));
    const read = async () => {
      if (!this.privateFiles) return readFile(this.path, 'utf8');
      await lstat(this.path); // Missing data is distinct from failed native ownership/ACL validation.
      return this.privateFiles.readPrivateFile(dirname(this.path), basename(this.path), MAX_PREFERENCES_BYTES).toString('utf8');
    };
    const raw = await read().catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return;
    if (Buffer.byteLength(raw) > MAX_PREFERENCES_BYTES) throw new Error('Desktop preferences exceed storage limit');
    const parsed = JSON.parse(raw) as DesktopPreferences;
    if (!parsed || !['system', 'light', 'dark'].includes(parsed.theme)
      || !parsed.drafts || Object.keys(parsed.drafts).length > 64) throw new Error('Invalid Desktop preferences');
    for (const [key, draft] of Object.entries(parsed.drafts)) validateDraft(key, draft);
    if (parsed.viewports) {
      if (Object.keys(parsed.viewports).length > 64) throw new Error('Too many viewports');
      for (const [id, value] of Object.entries(parsed.viewports)) validateViewport(id, value);
    }
    if (parsed.route !== undefined) validateRoute(parsed.route);
    this.value = parsed;
  }
  read(): DesktopPreferences { return structuredClone(this.value); }
  async setTheme(theme: unknown): Promise<void> {
    if (theme !== 'system' && theme !== 'light' && theme !== 'dark') throw new Error('Invalid theme');
    this.value.theme = theme;
    await this.persist();
  }
  async setDraft(id: unknown, draft: DesktopDraft | null): Promise<void> {
    if (!identifier(id)) throw new Error('Invalid conversation');
    if (draft === null) delete this.value.drafts[id];
    else {
      validateDraft(id, draft);
      if (!Object.hasOwn(this.value.drafts, id) && Object.keys(this.value.drafts).length >= 64) {
        throw new Error('Please send or clear an existing draft first');
      }
      Object.defineProperty(this.value.drafts, id, { value: structuredClone(draft), enumerable: true, configurable: true, writable: true });
    }
    await this.persist();
  }
  async clearDrafts(): Promise<void> { this.value.drafts = {}; this.value.viewports = {}; delete this.value.route; await this.persist(); }
  async setRoute(route: string): Promise<void> { validateRoute(route); this.value.route = route; await this.persist(); }
  async setViewport(id: string, value: DesktopViewport | null): Promise<void> {
    if (!identifier(id)) throw new Error('Invalid conversation');
    if (value) validateViewport(id, value);
    this.value.viewports ??= {};
    delete this.value.viewports[id];
    if (value) {
      this.value.viewports[id] = { ...value };
      while (Object.keys(this.value.viewports).length > 64) delete this.value.viewports[Object.keys(this.value.viewports)[0]!];
    }
    await this.persist();
  }
  async flush(): Promise<void> { await this.pending; }
  private persist(): Promise<void> {
    ++this.revision;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (this.privateFiles) await Promise.resolve();
      for (;;) {
        const revision = this.revision;
        const data = JSON.stringify(this.value);
        if (this.privateFiles) {
          this.privateFiles.ensurePrivateDirectory(dirname(this.path));
          this.privateFiles.writePrivateFile(dirname(this.path), basename(this.path), Buffer.from(data), MAX_PREFERENCES_BYTES);
          if (revision === this.revision) break;
          continue;
        }
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, data, { mode: 0o600 });
          await rename(temporary, this.path);
        } finally { await rm(temporary, { force: true }); }
        if (revision === this.revision) break;
      }
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}
function validateViewport(id: string, value: DesktopViewport): void {
  if (!identifier(id) || !value || !identifier(value.turnId) || !Number.isFinite(value.offset)
    || Math.abs(value.offset) > 1_000_000 || typeof value.bottom !== 'boolean') throw new Error('Invalid viewport');
}
function validateRoute(route: string): void {
  if (typeof route !== 'string' || route.length > 2048 || !route.startsWith('#')) throw new Error('Invalid route');
  for (const [key, value] of new URLSearchParams(route.slice(1))) {
    if (!['workspace', 'conversation', 'turn', 'task', 'artifact'].includes(key) || !identifier(value)) throw new Error('Invalid route');
  }
}
function validateDraft(id: string, draft: DesktopDraft): void {
  if (!identifier(id) || !draft || typeof draft.text !== 'string' || !Array.isArray(draft.attachments)
    || Buffer.byteLength(draft.text) > 48 * 1024 || Buffer.byteLength(JSON.stringify(draft)) > 128 * 1024) {
    throw new Error('Invalid or oversized draft');
  }
}
