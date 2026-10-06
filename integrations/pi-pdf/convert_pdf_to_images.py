"""Pi PDF extension renderer; bounded PDFium replacement for upstream pdf2image.

See UPSTREAM.md and LICENSE. Produces PNGs for Pi's existing read tool.
"""
import hashlib
import json
import os
import sys
import pypdfium2 as pdfium


def selected_pages(spec, total):
    if not spec:
        if total > 5:
            raise ValueError("Specify pages: at most 5 per call; total_pages=" + str(total))
        return list(range(total))
    pages = set()
    for item in spec.split(','):
        if '-' in item:
            first, last = item.split('-', 1)
            first, last = int(first or 1), int(last or total)
        else:
            first = last = int(item)
        if first < 1 or last > total or first > last or last - first >= 5:
            raise ValueError('Invalid or oversized page range')
        pages.update(range(first - 1, last))
    if not pages or len(pages) > 5:
        raise ValueError('Select 1 to 5 pages')
    return sorted(pages)


def convert(path, output, pages='', dpi=160):
    with open(path, 'rb') as source:
        digest = hashlib.sha256(source.read()).hexdigest()
    doc = pdfium.PdfDocument(path)
    try:
        selected = selected_pages(pages, len(doc))
        os.makedirs(output, exist_ok=True)
        results = []
        for index in selected:
            print('PDF_PROGRESS:rendering page ' + str(index + 1), file=sys.stderr, flush=True)
            page = doc[index]
            try:
                width, height = page.get_size()
                scale = min(max(72, min(dpi, 200)) / 72, 2048 / max(width, height))
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil()
                    filename = os.path.join(output, digest[:16] + '-page-' + str(index + 1) + '.png')
                    image.save(filename)
                    results.append({'page': index + 1, 'path': filename})
                    # Keep a source-indexed checkpoint even if a later page is cancelled.
                    with open(os.path.join(output, digest[:16] + '-manifest.json'), 'w') as checkpoint:
                        json.dump({'source_sha256': digest, 'total_pages': len(doc), 'pages': results,
                                   'remaining_pages': [p + 1 for p in selected if p > index]}, checkpoint)
                    print('PDF_PROGRESS:completed page ' + str(index + 1), file=sys.stderr, flush=True)
                finally:
                    bitmap.close()
            finally:
                page.close()
        print(json.dumps({'source_sha256': digest, 'total_pages': len(doc), 'pages': results,
                          'next_step': 'Use read on each PNG to send the page to the vision model.'}))
    finally:
        doc.close()


if __name__ == '__main__':
    try:
        convert(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '',
                int(sys.argv[4]) if len(sys.argv) > 4 else 160)
    except Exception as error:
        print('PDF_ERROR:' + str(error), file=sys.stderr)
        sys.exit(1)
