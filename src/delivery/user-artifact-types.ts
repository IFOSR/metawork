/**
 * 用户可见 artifact 契约（Web Workspace 落地方案 §3.1）。
 *
 * ArtifactProjection 是唯一允许进入 Web 投影的 artifact 形态：
 * 它只包含 artifact ID、显示名称、相对路径、媒体类型、预览类型、
 * 大小和内容哈希，绝不携带 absolutePath、storageUri、workspaceRoot
 * 或内部执行标识。
 */

export type ArtifactPreviewKind = 'markdown' | 'text' | 'code' | 'image' | 'unsupported';

export interface ArtifactProjection {
  artifactId: string;
  taskId: string;
  publicationId: string | null;
  displayName: string;
  relativePath: string;
  mediaType: string;
  previewKind: ArtifactPreviewKind;
  previewable: boolean;
  byteLength: number;
  contentHash: string;
  publishedAt: string;
}

/** 用户 Workspace 内固定的用户产物目录名（兼容既有 preview URL 与测试）。 */
export const USER_ARTIFACTS_DIRECTORY = 'metaclaw-tasks';

const PREVIEW_KINDS = new Set<ArtifactPreviewKind>(['markdown', 'text', 'code', 'image']);

export function isPreviewableKind(kind: string): kind is ArtifactPreviewKind {
  return PREVIEW_KINDS.has(kind as ArtifactPreviewKind);
}

/**
 * 解析可预览类型。历史产物可能存储了旧的 `unsupported` 值（例如图片在
 * 图片预览支持加入前发布），这里按 mediaType 兜底回退到 `image`，
 * 使存量图片无需重新发布即可预览。
 */
export function resolvePreviewKind(
  kind: string,
  mediaType: string,
): ArtifactPreviewKind {
  if (isPreviewableKind(kind)) return kind;
  if (mediaType.startsWith('image/')) return 'image';
  return 'unsupported';
}

export function classifyPreviewKind(
  relativePath: string,
): ArtifactPreviewKind {
  const extension = relativePath.slice(relativePath.lastIndexOf('.') + 1)
    .toLowerCase();
  if (['md', 'markdown'].includes(extension)) return 'markdown';
  if (['txt', 'log', 'csv', 'json', 'yml', 'yaml'].includes(extension)) return 'text';
  if ([
    'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'go', 'rs', 'java',
    'c', 'h', 'cpp', 'hpp', 'sh', 'bash', 'zsh', 'sql', 'html', 'css',
    'toml', 'ini', 'xml',
  ].includes(extension)) return 'code';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension)) return 'image';
  return 'unsupported';
}

export function mediaTypeForRelativePath(relativePath: string): string {
  const extension = relativePath.slice(relativePath.lastIndexOf('.') + 1)
    .toLowerCase();
  const mediaTypes: Record<string, string> = {
    md: 'text/markdown; charset=utf-8',
    markdown: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    json: 'application/json; charset=utf-8',
    yml: 'text/yaml; charset=utf-8',
    yaml: 'text/yaml; charset=utf-8',
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    ts: 'text/typescript; charset=utf-8',
    tsx: 'text/typescript; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
  };
  return mediaTypes[extension] ?? 'application/octet-stream';
}
