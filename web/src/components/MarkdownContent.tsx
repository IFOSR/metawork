import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { BudgetedImage } from './BudgetedImage';

marked.use({ gfm: true, breaks: true });

export function MarkdownContent({ value }: { value: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<Element[]>([]);
  const rendered = useMemo(
    () => {
      const fragment = DOMPurify.sanitize(marked.parse(value, { async: false }), { RETURN_DOM_FRAGMENT: true, FORBID_ATTR: ['data-image-slot'] });
      const images: Array<{ src: string; alt: string }> = [];
      for (const image of fragment.querySelectorAll('img')) {
        const slot = document.createElement('span');
        slot.dataset.imageSlot = String(images.length);
        images.push({ src: image.getAttribute('src') ?? '', alt: image.alt || '图片' });
        image.replaceWith(slot);
      }
      const container = document.createElement('div'); container.append(fragment);
      return { html: container.innerHTML, images };
    },
    [value],
  );
  useEffect(() => { setTargets([...root.current!.querySelectorAll('[data-image-slot]')]); }, [rendered]);
  return <><div ref={root} className="markdown-content" dangerouslySetInnerHTML={{ __html: rendered.html }} />
    {targets.map((target, index) => rendered.images[index] && createPortal(
      <BudgetedImage key={`${index}:${rendered.images[index]!.src}`} {...rendered.images[index]!} />, target,
    ))}</>;
}
