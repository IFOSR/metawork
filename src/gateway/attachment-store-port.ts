export class AttachmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentInputError';
  }
}

/**
 * Upload contract for one attachment. Owned by the store port so the Gateway,
 * Management and Storage layers share one definition instead of a copy.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export class AttachmentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentTypeError';
  }
}

export interface GatewayAttachmentMetadata {
  name: string;
  mime: string;
  mediaClass: 'image' | 'text' | 'document' | 'archive' | 'binary' | 'unknown';
  size: number;
  accountId: string;
  conversationId: string;
  workspaceId: string;
  sha256: string;
  status: 'available' | 'unavailable';
}

export interface GatewayAttachmentStore {
  saveAttachment(input: {
    conversationId: string;
    workspaceId: string;
    name: string;
    bytes: Buffer;
  }): Promise<unknown>;
  saveAttachmentStream(input: {
    conversationId: string;
    workspaceId: string;
    name: string;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  }): Promise<unknown>;
  readAttachment(conversationId: string, attachmentId: string): Promise<{
    metadata: GatewayAttachmentMetadata;
    bytes: Buffer;
    path: string;
  } | null>;
  readAttachmentMetadata?(
    conversationId: string,
    attachmentId: string,
  ): Promise<{
    attachmentId: string;
    accountId: string;
    conversationId: string;
    workspaceId: string;
    name: string;
    mime: string;
    mediaClass: 'image' | 'text' | 'document' | 'archive' | 'binary' | 'unknown';
    size: number;
    sha256: string;
    status: 'available' | 'unavailable';
    createdAt: string;
  } | null>;
  readAttachmentSync?(conversationId: string, attachmentId: string): {
    metadata: GatewayAttachmentMetadata;
    bytes: Buffer;
    path: string;
  } | null;
}
