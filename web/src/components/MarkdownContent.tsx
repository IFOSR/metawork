import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import type { ArtifactProjection } from '../api/session-types';
import { findArtifactReferences } from '../artifact-reference';
import { ArtifactReferenceLink } from './ArtifactLink';
import { BudgetedImage } from './BudgetedImage';
import { InlineChart } from './InlineChart';

const markdown = new Marked({ gfm: true, breaks: true });
const noArtifacts: ArtifactProjection[] = [];
type Slot = { kind: 'image'; src: string; alt: string }
  | { kind: 'chart'; source: string }
  | { kind: 'artifact'; artifact: ArtifactProjection };

export function MarkdownContent({ value, artifacts = noArtifacts, onOpenArtifact }: {
  value: string;
  artifacts?: ArtifactProjection[];
  onOpenArtifact?: (artifact: ArtifactProjection) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const canOpenArtifact = Boolean(onOpenArtifact);
  const rendered = useMemo(() => {
    const fragment = DOMPurify.sanitize(markdown.parse(value, { async: false }), {
      RETURN_DOM_FRAGMENT: true, FORBID_ATTR: ['data-markdown-slot', 'data-image-slot'],
    });
    const slots: Slot[] = [];
    const slot = (item: Slot, block = false) => {
      const element = document.createElement(block ? 'div' : 'span');
      element.dataset.markdownSlot = String(slots.length); slots.push(item);
      return element;
    };
    for (const image of fragment.querySelectorAll('img')) {
      image.replaceWith(slot({ kind: 'image', src: image.getAttribute('src') ?? '', alt: image.alt || '图片' }));
    }
    // Parse whole blocks before inserting portals, so filenames cannot split a table or chart.
    let charts = 0;
    for (const code of fragment.querySelectorAll('pre > code.language-chart, pre > code.language-metawork-chart')) {
      if (charts++ < 12) code.parentElement!.replaceWith(slot({ kind: 'chart', source: code.textContent ?? '' }, true));
    }
    for (const table of fragment.querySelectorAll('table')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-table-scroll'; wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', '数据表格，可横向滚动');
      for (const header of table.querySelectorAll('thead th')) header.setAttribute('scope', 'col');
      table.replaceWith(wrapper); wrapper.append(table);
    }
    for (const link of fragment.querySelectorAll('a')) link.setAttribute('rel', 'noopener noreferrer');
    if (canOpenArtifact && artifacts.length) {
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      for (const node of nodes) {
        if (node.parentElement?.closest('pre, a, button, textarea, svg, [data-markdown-slot]')) continue;
        const matches = findArtifactReferences(node.data, artifacts);
        // An inline-code filename remains useful; actual code examples stay untouched.
        if (node.parentElement?.closest('code') && !(matches.length === 1 && matches[0]!.text === node.data)) continue;
        if (!matches.length) continue;
        const replacement = document.createDocumentFragment(); let cursor = 0;
        for (const match of matches) {
          replacement.append(node.data.slice(cursor, match.start), slot({ kind: 'artifact', artifact: match.artifact }));
          cursor = match.end;
        }
        replacement.append(node.data.slice(cursor)); node.replaceWith(replacement);
      }
    }
    const container = document.createElement('div'); container.append(fragment);
    return { html: container.innerHTML, slots };
  }, [value, artifacts, canOpenArtifact]);
  const [mounted, setMounted] = useState<{ rendered: typeof rendered; targets: Element[] }>();
  useLayoutEffect(() => {
    setMounted({ rendered, targets: [...root.current!.querySelectorAll('[data-markdown-slot]')] });
  }, [rendered]);
  return <><div ref={root} className="markdown-content" dangerouslySetInnerHTML={{ __html: rendered.html }} />
    {mounted?.rendered === rendered && mounted.targets.map(target => {
      const index = Number(target.getAttribute('data-markdown-slot'));
      const item = rendered.slots[index];
      if (!item) return null;
      return createPortal(item.kind === 'image' ? <BudgetedImage src={item.src} alt={item.alt} />
        : item.kind === 'chart' ? <InlineChart source={item.source} />
          : onOpenArtifact ? <ArtifactReferenceLink artifact={item.artifact} onOpen={onOpenArtifact} /> : null,
      target, String(index));
    })}</>;
}
