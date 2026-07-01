import fs from 'fs';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { PUBLIC_DIR } from './paths';

export { PUBLIC_DIR };

type AcceptEntry = { type: string; q: number };

export function parseAcceptHeader(header: string | undefined): AcceptEntry[] {
  if (!header?.trim()) return [];

  return header
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const [rawType, ...params] = part.split(';').map(value => value.trim());
      const type = rawType.toLowerCase();
      const qParam = params.find(value => value.startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { type, q: Number.isFinite(q) ? q : 0 };
    });
}

export function wantsMarkdown(req: Pick<Request, 'headers'>): boolean {
  const entries = parseAcceptHeader(req.headers.accept);
  if (entries.length === 0) return false;

  const markdown = entries.filter(entry => entry.type === 'text/markdown');
  if (markdown.length === 0) return false;

  const html = entries.filter(entry => entry.type === 'text/html');
  if (html.length === 0) return true;

  const bestMarkdown = Math.max(...markdown.map(entry => entry.q));
  const bestHtml = Math.max(...html.map(entry => entry.q));
  return bestMarkdown >= bestHtml;
}

export function estimateMarkdownTokens(markdown: string): number {
  return Math.max(1, Math.ceil(markdown.length / 4));
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function extractMetaContent(html: string, attr: 'name' | 'property', key: string): string | undefined {
  const patterns = [
    new RegExp(`<meta\\s+[^>]*${attr}=["']${key}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\s+[^>]*content=["']([^"']*)["'][^>]*${attr}=["']${key}["'][^>]*>`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1].trim());
  }

  return undefined;
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].replace(/\s+/g, ' ').trim()) : undefined;
}

function extractJsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const pattern = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = pattern.exec(html);
  while (match) {
    blocks.push(match[1].trim());
    match = pattern.exec(html);
  }
  return blocks;
}

function buildFrontmatter(html: string): string {
  const title = extractMetaContent(html, 'name', 'title') ?? extractMetaContent(html, 'property', 'og:title') ?? extractTitle(html);
  const description =
    extractMetaContent(html, 'name', 'description') ??
    extractMetaContent(html, 'property', 'og:description');
  const image = extractMetaContent(html, 'property', 'og:image');

  const lines: string[] = [];
  if (title) lines.push(`title: ${yamlScalar(title)}`);
  if (description) lines.push(`description: ${yamlScalar(description)}`);
  if (image) lines.push(`image: ${yamlScalar(image)}`);

  if (lines.length === 0) return '';
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function yamlScalar(value: string): string {
  if (/[:#\n]/.test(value) || value.startsWith('"') || value.startsWith("'")) {
    return JSON.stringify(value);
  }
  return value;
}

function preprocessHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<div id="shader-gradient-root"[\s\S]*?<\/div>/gi, '')
    .replace(/<header class="top-header"[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '');
}

function extractMainHtml(html: string): string {
  const match = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
  return match?.[1] ?? html;
}

function convertInline(html: string): string {
  let out = html;
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${stripTags(inner)}\``);
  out = out.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, inner) => `**${stripTags(inner)}**`);
  out = out.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (_, inner) => `**${stripTags(inner)}**`);
  out = out.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, inner) => `*${stripTags(inner)}*`);
  out = out.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (_, inner) => `*${stripTags(inner)}*`);
  out = out.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const label = stripTags(inner);
    return label ? `[${label}](${href})` : '';
  });
  return out;
}

function convertBlockHtml(html: string): string {
  let out = convertInline(html);

  out = out.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner) => `# ${stripTags(convertInline(inner))}\n\n`);
  out = out.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, inner) => `## ${stripTags(convertInline(inner))}\n\n`);
  out = out.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, inner) => `### ${stripTags(convertInline(inner))}\n\n`);
  out = out.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, inner) => `#### ${stripTags(convertInline(inner))}\n\n`);
  out = out.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, inner) => `##### ${stripTags(convertInline(inner))}\n\n`);
  out = out.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, inner) => `###### ${stripTags(convertInline(inner))}\n\n`);

  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `- ${stripTags(convertInline(inner))}\n`);
  out = out.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');

  out = out.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => `${stripTags(convertInline(inner))}\n\n`);
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<[^>]+>/g, '');

  return out
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function htmlToAgentMarkdown(html: string): string {
  const frontmatter = buildFrontmatter(html);
  const jsonLd = extractJsonLdBlocks(html);
  const body = convertBlockHtml(extractMainHtml(preprocessHtml(html)));

  let markdown = `${frontmatter}${body}\n`;
  if (jsonLd.length > 0) {
    markdown += `\n\`\`\`json\n${jsonLd.join('\n')}\n\`\`\`\n`;
  }

  return markdown;
}

export function convertHtmlFileToMarkdown(filePath: string): { markdown: string; tokens: number } {
  const html = fs.readFileSync(filePath, 'utf-8');
  const markdown = htmlToAgentMarkdown(html);
  return { markdown, tokens: estimateMarkdownTokens(markdown) };
}

export function sendPublicHtml(req: Request, res: Response, filePath: string): void {
  if (wantsMarkdown(req)) {
    const { markdown, tokens } = convertHtmlFileToMarkdown(filePath);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Vary', 'Accept');
    res.setHeader('x-markdown-tokens', String(tokens));

    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }

    res.status(200).send(markdown);
    return;
  }

  res.sendFile(filePath);
}

const STATIC_HTML_ROUTES: Record<string, string> = {
  '/starter-guide.html': 'starter-guide.html',
  '/privacy.html': 'privacy.html',
  '/privacy-policy.html': 'privacy-policy.html',
  '/whitepaper': 'whitepaper/index.html',
  '/whitepaper/': 'whitepaper/index.html',
  '/whitepaper/index.html': 'whitepaper/index.html',
  '/whitepaper.html': 'whitepaper.html',
};

export function resolvePublicHtmlPath(urlPath: string): string | null {
  const normalized = urlPath.split('?')[0] || '/';
  const relative = STATIC_HTML_ROUTES[normalized];
  if (!relative) return null;
  return path.join(PUBLIC_DIR, relative);
}

export function negotiateMarkdownStatic(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }

  if (!wantsMarkdown(req)) {
    next();
    return;
  }

  const filePath = resolvePublicHtmlPath(req.path);
  if (!filePath || !fs.existsSync(filePath)) {
    next();
    return;
  }

  sendPublicHtml(req, res, filePath);
}
