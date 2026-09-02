export class AttachmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentInputError';
  }
}

export class AttachmentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentTypeError';
  }
}

export interface GatewayAttachmentStore {
  saveAttachment(input: {
    sessionId: string;
    name: string;
    bytes: Buffer;
  }): Promise<unknown>;
  saveAttachmentStream(input: {
    sessionId: string;
    name: string;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  }): Promise<unknown>;
  readAttachment(sessionId: string, attachmentId: string): Promise<{
    metadata: {
      name: string;
      mime: string;
      kind: 'image' | 'text';
      size: number;
    };
    bytes: Buffer;
    path: string;
  } | null>;
}
