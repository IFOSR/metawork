export const MAX_ATTACHMENT_IMAGE_BYTES = 10 * 1024 * 1024;

export interface GatewayAttachmentStore {
  saveAttachment(input: {
    sessionId: string;
    name: string;
    bytes: Buffer;
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
