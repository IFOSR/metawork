import type { AttachmentMetadata } from '../api/session-types';

export interface ConversationDraft { draft: string; attachments: AttachmentMetadata[] }

/** Drafts are user work: reject a new oversized edit instead of silently evicting another draft. */
export class ComposerStore {
  private readonly entries = new Map<string, ConversationDraft>();
  get(id: string): ConversationDraft | undefined { return this.entries.get(id); }
  delete(id: string): void { this.entries.delete(id); }
  clear(): void { this.entries.clear(); }
  canEdit(id: string): boolean { return this.entries.has(id) || this.entries.size < 64; }
  set(id: string, value: ConversationDraft): void {
    if (!value.draft && !value.attachments.length) { this.delete(id); return; }
    if (!this.canEdit(id)) throw new Error('已有 64 个未发送草稿，请先发送或清空其中一个。');
    if (new TextEncoder().encode(value.draft).length > 48 * 1024) throw new Error('草稿过长，请将较长材料作为附件上传。');
    if (new TextEncoder().encode(JSON.stringify(value)).length > 128 * 1024) throw new Error('草稿附件信息过多，请先发送或移除部分附件。');
    this.entries.set(id, value);
  }
}
