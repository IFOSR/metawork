/** Presentation-only classification. Never persisted as a task_artifacts preview_kind. */
export type DocumentPreviewFormat = 'html' | 'docx' | 'pptx' | 'xlsx' | 'xls' | 'csv' | 'pdf';

export const MAX_DOCUMENT_PREVIEW_BYTES = 32 * 1024 * 1024;

const formats: Record<string, DocumentPreviewFormat> = {
  html: 'html', htm: 'html', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', xls: 'xls', csv: 'csv', pdf: 'pdf',
  'text/html': 'html', 'application/pdf': 'pdf', 'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
};

export function documentPreviewFormat(name: string, mediaType = ''): DocumentPreviewFormat | undefined {
  return formats[name.split('.').pop()?.toLowerCase() ?? '']
    ?? formats[mediaType.split(';')[0]!.trim().toLowerCase()];
}
