import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.use({ gfm: true, breaks: true });

export function MarkdownContent({ value }: { value: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(value, { async: false })),
    [value],
  );
  return <div className="markdown-content" dangerouslySetInnerHTML={{ __html: html }} />;
}
