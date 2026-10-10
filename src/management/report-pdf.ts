import { fileURLToPath } from 'node:url';
import { Marked, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';
import PdfPrinter from 'pdfmake';
import type { Content, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces.js';

const markdown = new Marked({ gfm: true, breaks: true });
const regular = fileURLToPath(new URL('./fonts/NotoSansSC-Regular.otf', import.meta.url));
const bold = fileURLToPath(new URL('./fonts/NotoSansSC-Bold.otf', import.meta.url));

export function reportPdfName(name: string): string {
  return `${name.replace(/\.(?:md|markdown)$/iu, '')}.pdf`;
}

function safeLink(value: string): string | undefined {
  return /^(?:https?:\/\/|mailto:)/iu.test(value) ? value : undefined;
}

function inline(tokens: Token[] | undefined, fallback = ''): ContentText[] {
  if (!tokens?.length) return [{ text: decodeHTML(fallback) }];
  return tokens.flatMap((token): ContentText[] => {
    switch (token.type) {
      case 'strong': return [{ text: inline((token as Tokens.Strong).tokens), bold: true }];
      case 'em': return [{ text: inline((token as Tokens.Em).tokens), italics: true }];
      case 'del': return [{ text: inline((token as Tokens.Del).tokens), decoration: 'lineThrough' }];
      case 'codespan': return [{ text: (token as Tokens.Codespan).text, background: '#eef1f4' }];
      case 'br': return [{ text: '\n' }];
      case 'link': {
        const link = token as Tokens.Link;
        return [{ text: inline(link.tokens), ...(safeLink(link.href) ? { link: link.href, color: '#245a8d' } : {}) }];
      }
      case 'image': {
        const image = token as Tokens.Image;
        return [{ text: `[图片：${decodeHTML(image.text || '图片')}]`,
          ...(safeLink(image.href) ? { link: image.href, color: '#245a8d' } : {}) }];
      }
      case 'html': return [{ text: /<br\s*\/?\s*>/iu.test(token.raw) ? '\n' : '' }];
      default: {
        const text = token as Tokens.Text;
        return text.tokens ? inline(text.tokens) : [{ text: decodeHTML(text.text ?? token.raw) }];
      }
    }
  });
}

function blocks(tokens: Token[], images: ReadonlyMap<string, string>): Content[] {
  return tokens.flatMap((token): Content[] => {
    switch (token.type) {
      case 'space': return [];
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [{ text: inline(heading.tokens), fontSize: [22, 17, 14, 12, 11, 10][heading.depth - 1],
          bold: true, headlineLevel: heading.depth, margin: [0, 12, 0, 7] }];
      }
      case 'paragraph':
      case 'text': {
        const paragraph = token as Tokens.Paragraph;
        // A Markdown image on its own line is a block; retain captions if an image is unavailable.
        if (paragraph.tokens?.some(t => t.type === 'image')) {
          const content: Content[] = [];
          let pending: Token[] = [];
          const flush = () => { if (pending.length) content.push({ text: inline(pending), margin: [0, 0, 0, 7] }); pending = []; };
          for (const child of paragraph.tokens) {
            const data = child.type === 'image' ? images.get((child as Tokens.Image).href) : undefined;
            if (data) { flush(); content.push({ image: data, fit: [499, 620], margin: [0, 4, 0, 10] }); }
            else pending.push(child);
          }
          flush();
          return content;
        }
        return [{ text: inline(paragraph.tokens, paragraph.text), margin: [0, 0, 0, 8] }];
      }
      case 'blockquote': return [{ stack: blocks((token as Tokens.Blockquote).tokens, images),
        margin: [14, 4, 0, 8], color: '#52606d' }];
      case 'code': return [{ text: (token as Tokens.Code).text || ' ', fontSize: 9,
        background: '#eef1f4', margin: [0, 4, 0, 10], preserveLeadingSpaces: true }];
      case 'hr': return [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 499, y2: 0, lineColor: '#ced5dc' }],
        margin: [0, 10, 0, 10] }];
      case 'list': {
        const list = token as Tokens.List;
        const items: Content[] = list.items.map(item => ({ stack: [
          ...(item.task ? [{ text: item.checked ? '[x]' : '[ ]' }] : []),
          ...blocks(item.tokens, images),
        ] }));
        return [list.ordered ? { ol: items, start: list.start || 1, margin: [0, 0, 0, 8] }
          : { ul: items, margin: [0, 0, 0, 8] }];
      }
      case 'table': {
        const table = token as Tokens.Table;
        const cell = (value: Tokens.TableCell, index: number, header = false): Content => ({
          text: inline(value.tokens, value.text), bold: header,
          alignment: table.align[index] ?? 'left', ...(header ? { fillColor: '#eef1f4' } : {}),
        });
        return [{ table: { headerRows: 1, widths: table.header.map(() => '*'), body: [
          table.header.map((v, i) => cell(v, i, true)),
          ...table.rows.map(row => row.map((v, i) => cell(v, i))),
        ] }, layout: 'lightHorizontalLines', fontSize: table.header.length > 5 ? 8 : 9,
        margin: [0, 4, 0, 12] }];
      }
      // HTML is inert text. Never execute HTML or load its scripts/styles/resources.
      case 'html': return [{ text: decodeHTML(token.raw.replace(/<[^>]*>/gu, '')), margin: [0, 0, 0, 8] }];
      default: return [{ text: decodeHTML(token.raw) }];
    }
  });
}

export async function createReportPdf(markdownSource: string, name: string,
  readImage?: (reference: string) => Promise<string | undefined>): Promise<Buffer> {
  const tokens = markdown.lexer(markdownSource);
  const images = new Map<string, string>();
  const references = new Set<string>();
  markdown.walkTokens(tokens, token => { if (token.type === 'image') references.add((token as Tokens.Image).href); });
  if (readImage) {
    for (const reference of references) {
      const image = await readImage(reference);
      if (image) images.set(reference, image);
    }
  }
  const definition: TDocumentDefinitions = {
    info: { title: name, creator: 'MetaWork' },
    pageSize: 'A4', pageMargins: [48, 48, 48, 48],
    defaultStyle: { font: 'NotoSansSC', fontSize: 10, lineHeight: 1.35, color: '#202b36' },
    content: blocks(tokens, images),
    footer: (page, total) => ({ text: `${page} / ${total}`, alignment: 'center', fontSize: 8, color: '#697684' }),
    // Keep a heading with the first following block when it would end a page alone.
    pageBreakBefore: (node, following) => Boolean(node.headlineLevel && !following.length),
  };
  const printer = new PdfPrinter({ NotoSansSC: { normal: regular, bold, italics: regular, bolditalics: bold } });
  const document = printer.createPdfKitDocument(definition);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.end();
  });
}
