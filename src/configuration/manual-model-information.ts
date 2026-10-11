import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { decodeHTML } from 'entities';

const MAX_SOURCE_URL_LENGTH = 2_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

export interface ManualModelInformation {
  sourceUrl: string;
  title?: string;
  description: string;
}

/**
 * Fetches a public model-information page for the settings editor.
 * This intentionally returns only text; the URL is never persisted as model
 * configuration and callers must still review the resulting description.
 */
export async function fetchManualModelInformation(sourceUrl: string): Promise<ManualModelInformation> {
  const url = validateSourceUrl(sourceUrl);
  await assertPublicHostname(url.hostname);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'text/html, text/plain;q=0.9, */*;q=0.1',
        'User-Agent': 'MetaWork model information importer',
      },
    });
    if (!response.ok) throw new Error(`读取链接失败（HTTP ${response.status}）`);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error('链接不是 HTML 或纯文本页面');
    }
    const body = await readBoundedText(response);
    const extracted = contentType.includes('text/html') || looksLikeHtml(body)
      ? extractHtmlInformation(body)
      : { description: cleanText(body) };
    if (!extracted.description) throw new Error('链接中没有找到可用的模型描述');
    return { sourceUrl: url.toString(), ...extracted };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('读取链接超时，请改用模型描述文本。');
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timeout);
  }
}

function validateSourceUrl(sourceUrl: string): URL {
  const value = sourceUrl.trim();
  if (!value || value.length > MAX_SOURCE_URL_LENGTH) throw new Error('模型信息链接无效或过长');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('模型信息链接无效');
  }
  if (url.protocol !== 'https:') throw new Error('为保护本机安全，只支持 HTTPS 链接');
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('链接不能包含账号、端口、查询参数或片段');
  }
  return url;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw new Error('为保护本机安全，不能读取本地链接');
  }
  const literalKind = isIP(normalized);
  if (literalKind && isPrivateAddress(normalized, literalKind)) {
    throw new Error('为保护本机安全，不能读取内网链接');
  }
  const records = literalKind ? [{ address: normalized }] : await lookup(normalized, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateAddress(record.address, isIP(record.address)))) {
    throw new Error('为保护本机安全，不能读取内网链接');
  }
}

function isPrivateAddress(address: string, kind: number): boolean {
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (kind === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    if (mappedIpv4) return isPrivateAddress(mappedIpv4, 4);
    return normalized === '::1' || normalized === '::'
      || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('fe8') || normalized.startsWith('fe9')
      || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return true;
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error('链接内容过大，请改用模型描述文本。');
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function looksLikeHtml(value: string): boolean {
  return /<\s*(?:!doctype\s+html|html\b|head\b|title\b|meta\b|body\b)/iu.test(value);
}

export function extractHtmlInformation(html: string): { title?: string; description: string } {
  const withoutNoise = html.replace(/<\s*(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/giu, ' ');
  const title = matchTag(withoutNoise, 'title');
  const metaDescription = matchMetaDescription(withoutNoise);
  const body = cleanText(withoutNoise.replace(/<[^>]+>/gu, ' '));
  const description = cleanText([metaDescription, body].filter(Boolean).join('\n')) || title || '';
  return {
    ...(title ? { title } : {}),
    description: description.slice(0, 4_000),
  };
}

function matchTag(html: string, tag: string): string | undefined {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'iu'));
  return match?.[1] ? cleanText(match[1].replace(/<[^>]+>/gu, ' ')).slice(0, 500) || undefined : undefined;
}

function matchMetaDescription(html: string): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/giu) ?? [];
  for (const tag of tags) {
    const name = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/iu)?.[1]?.toLowerCase();
    if (name !== 'description' && name !== 'og:description') continue;
    const content = tag.match(/\bcontent\s*=\s*["']([\s\S]*?)["']/iu)?.[1];
    if (content) return cleanText(content).slice(0, 1_000);
  }
  return undefined;
}

function cleanText(value: string): string {
  return decodeHTML(value)
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t\r\f]+/gu, ' ')
    .replace(/\n\s*\n+/gu, '\n')
    .trim();
}
