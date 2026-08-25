/**
 * 用户可见 artifact 契约（Web Workspace 落地方案 §3.1）。
 *
 * ArtifactProjection 是唯一允许进入 Web 投影的 artifact 形态：
 * 它只包含 artifact ID、显示名称、相对路径、媒体类型、预览类型、
 * 大小和内容哈希，绝不携带 absolutePath、storageUri、workspaceRoot
 * 或内部执行标识。
 */

export type ArtifactPreviewKind = 'markdown' | 'text' | 'code' | 'unsupported';

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
