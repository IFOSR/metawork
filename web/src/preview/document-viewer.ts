import DOMPurify from 'dompurify';
import { MAX_DOCUMENT_PREVIEW_BYTES, type DocumentPreviewFormat } from '../../../src/delivery/document-preview-format';
import './document-viewer.css';

const host = document.querySelector<HTMLElement>('#document')!;
const controls = document.querySelector<HTMLElement>('#controls')!;
const status = document.querySelector<HTMLElement>('#status')!;
let accepted = false;

function announce(message: string, error = false) {
  status.textContent = message;
  status.setAttribute('role', error ? 'alert' : 'status');
}

// Only the parent application can supply bytes. No URL, fetch or filesystem API.
window.addEventListener('message', event => {
  if (accepted || event.source !== parent || event.origin !== location.origin || event.data?.type !== 'metawork-preview') return;
  accepted = true;
  const { content, format, name } = event.data;
  document.title = typeof name === 'string' ? name : '文档预览';
  void render(format, content).catch(() => {
    host.replaceChildren(); controls.replaceChildren();
    announce('无法预览此文件：文件可能已损坏、已加密或包含尚不支持的内容。可下载原文件查看。', true);
  });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') parent.postMessage({ type: 'metawork-preview-escape' }, location.origin);
});
// Document hyperlinks must never navigate this trusted renderer or open a window.
document.addEventListener('click', event => {
  if ((event.target as Element | null)?.closest('a')) event.preventDefault();
});

async function render(format: DocumentPreviewFormat, content: string) {
  if (typeof content !== 'string' || content.length > MAX_DOCUMENT_PREVIEW_BYTES * 1.4) throw new Error('size');
  const encoded = content.slice(content.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  if (bytes.byteLength > MAX_DOCUMENT_PREVIEW_BYTES) throw new Error('size');
  if (['docx', 'pptx', 'xlsx'].includes(format)) await checkArchive(bytes);
  if (format === 'html') {
    const html = DOMPurify.sanitize(new TextDecoder().decode(bytes), {
      WHOLE_DOCUMENT: true, ADD_TAGS: ['style'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'link', 'meta', 'form'],
      FORBID_ATTR: ['href', 'action', 'formaction', 'srcset'],
    });
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    await Promise.all([...parsed.querySelectorAll('img')].slice(0, 24).map(async image => {
      const reference = image.getAttribute('src') ?? '';
      if (!reference || /^(?:[a-z][a-z\d+.-]*:|[\\/])/iu.test(reference)) return;
      const resource = await localImage(reference);
      if (resource) image.setAttribute('src', resource);
    }));
    const page = document.createElement('iframe');
    page.title = 'HTML 页面'; page.setAttribute('sandbox', '');
    // Place CSP before any document-supplied styles or resources.
    page.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data: blob:; base-uri \'none\'; form-action \'none\'">' + parsed.documentElement.outerHTML;
    host.className = 'html-document'; host.append(page);
    announce('HTML 页面');
  } else if (format === 'docx') {
    const { renderAsync } = await import('docx-preview');
    await renderAsync(bytes, host, undefined, { useBase64URL: true, renderAltChunks: false, breakPages: true });
    const fitPages = () => host.querySelectorAll<HTMLElement>('section.docx').forEach(page => {
      page.style.zoom = String(Math.min(1, Math.max(0.1, (host.clientWidth - 48) / page.offsetWidth)));
    });
    fitPages(); window.addEventListener('resize', fitPages);
    announce('Word 文档');
  } else if (format === 'pptx') {
    const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer');
    const viewer = await PptxViewer.open(bytes, host, {
      zipLimits: RECOMMENDED_ZIP_LIMITS, renderMode: 'slide', lazySlides: true, lazyMedia: true,
      onSlideError: () => announce('部分幻灯片无法显示，请下载原文件查看。', true),
    });
    if (!viewer.slideCount) throw new Error('no slides');
    pager(viewer.slideCount, async index => { await viewer.renderSlide(index); }, '幻灯片');
    window.addEventListener('pagehide', () => viewer.destroy(), { once: true });
    announce('PowerPoint 演示文稿');
  } else if (format === 'xlsx' || format === 'xls' || format === 'csv') {
    await spreadsheet(bytes, format);
  } else if (format === 'pdf') {
    const pdf = await import('pdfjs-dist');
    const { default: worker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdf.GlobalWorkerOptions.workerSrc = new URL(worker, location.href).href;
    const task = pdf.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true });
    const doc = await task.promise;
    const canvas = document.createElement('canvas'); host.append(canvas);
    const show = async (index: number) => {
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1.5 });
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    };
    await show(0); pager(doc.numPages, show, '页'); announce('PDF 文档');
    window.addEventListener('pagehide', () => void task.destroy(), { once: true });
  } else throw new Error('format');
}

/** Reject oversized expanded archives before any Office renderer inflates content. */
async function checkArchive(bytes: Uint8Array) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > 10000) throw new Error('archive entries');
  let total = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (size === undefined || size > 32 * 1024 * 1024) throw new Error('archive entry');
    total += size;
    if (total > 96 * 1024 * 1024) throw new Error('archive size');
  }
}

function pager(count: number, show: (index: number) => Promise<void>, unit: string) {
  let index = 0;
  const previous = document.createElement('button'); previous.textContent = '上一页';
  const next = document.createElement('button'); next.textContent = '下一页';
  const label = document.createElement('span'); label.setAttribute('aria-live', 'polite');
  const update = () => { previous.disabled = index === 0; next.disabled = index === count - 1; label.textContent = `${unit} ${index + 1} / ${count}`; };
  const navigate = async (delta: number) => {
    previous.disabled = true; next.disabled = true;
    try { await show(index + delta); index += delta; }
    catch { announce('此页无法显示，可下载原文件查看。', true); }
    finally { update(); }
  };
  previous.onclick = () => void navigate(-1); next.onclick = () => void navigate(1);
  controls.append(previous, label, next); update();
}

async function spreadsheet(bytes: Uint8Array, format: 'xlsx' | 'xls' | 'csv') {
  const XLSX = await import('xlsx');
  const book = XLSX.read(format === 'csv' ? new TextDecoder().decode(bytes) : bytes,
    { type: format === 'csv' ? 'string' : 'array', cellStyles: true, cellNF: true, cellHTML: false, sheetRows: 1001 });
  if (!book.SheetNames.length) throw new Error('no sheets');
  // ExcelJS preserves XLSX font/fill/alignment facts that SheetJS CE omits.
  let styled: import('exceljs').Workbook | undefined;
  if (format === 'xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    styled = new ExcelJS.Workbook(); await styled.xlsx.load(bytes as never);
  }
  const select = document.createElement('select'); select.setAttribute('aria-label', '工作表');
  for (const name of book.SheetNames) { const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option); }
  const label = document.createElement('label'); label.textContent = '工作表 '; label.append(select); controls.append(label);
  const show = () => {
    const sheet = book.Sheets[select.value]!;
    host.replaceChildren(); host.className = 'spreadsheet-document';
    if (!sheet['!ref']) { announce('空工作表'); return; }
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const lastRow = Math.min(range.e.r, range.s.r + 999), lastCol = Math.min(range.e.c, range.s.c + 99);
    const table = document.createElement('table'); table.setAttribute('aria-label', select.value);
    const head = table.createTHead().insertRow(); head.append(document.createElement('th'));
    for (let col = range.s.c; col <= lastCol; col++) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = XLSX.utils.encode_col(col); head.append(th); }
    const body = table.createTBody();
    const merges = sheet['!merges'] ?? [];
    const styles = styled?.getWorksheet(select.value);
    for (let row = range.s.r; row <= lastRow; row++) {
      const tr = body.insertRow(); const th = document.createElement('th'); th.scope = 'row'; th.textContent = String(row + 1); tr.append(th);
      for (let col = range.s.c; col <= lastCol; col++) {
        const merge = merges.find(m => row >= m.s.r && row <= m.e.r && col >= m.s.c && col <= m.e.c);
        if (merge && (row !== merge.s.r || col !== merge.s.c)) continue;
        const td = tr.insertCell(); const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
        td.textContent = cell ? XLSX.utils.format_cell(cell) : '';
        if (merge) { td.rowSpan = Math.min(merge.e.r, lastRow) - row + 1; td.colSpan = Math.min(merge.e.c, lastCol) - col + 1; }
        const style = styles?.getCell(row + 1, col + 1);
        if (style?.font) {
          td.style.fontWeight = style.font.bold ? 'bold' : '';
          td.style.fontStyle = style.font.italic ? 'italic' : '';
          if (style.font.size) td.style.fontSize = `${Math.min(72, style.font.size)}pt`;
          td.style.color = argb(style.font.color?.argb);
        }
        if (style?.fill?.type === 'pattern') td.style.backgroundColor = argb(style.fill.fgColor?.argb);
        if (style?.alignment) { td.style.textAlign = style.alignment.horizontal ?? ''; td.style.whiteSpace = style.alignment.wrapText ? 'pre-wrap' : 'pre'; }
      }
    }
    host.append(table);
    const original = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref']);
    announce(`${select.value}${original.e.r > lastRow || original.e.c > lastCol ? ' · 当前仅预览前 1000 行、100 列，完整内容请下载查看' : ''}`);
  };
  select.onchange = show; show();
}

function argb(value?: string): string { return value && /^(?:[0-9a-f]{2})?[0-9a-f]{6}$/iu.test(value) ? `#${value.slice(-6)}` : ''; }

function localImage(reference: string): Promise<string | null> {
  return new Promise(resolve => {
    const requestId = crypto.randomUUID();
    const finish = (content: string | null) => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(content); };
    const receive = (event: MessageEvent) => {
      if (event.source === parent && event.origin === location.origin
        && event.data?.type === 'metawork-preview-image-result' && event.data.requestId === requestId) {
        finish(typeof event.data.content === 'string' ? event.data.content : null);
      }
    };
    const timer = setTimeout(() => finish(null), 5000);
    window.addEventListener('message', receive);
    parent.postMessage({ type: 'metawork-preview-image', requestId, reference }, location.origin);
  });
}
