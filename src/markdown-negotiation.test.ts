import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  estimateMarkdownTokens,
  htmlToAgentMarkdown,
  wantsMarkdown,
} from './markdown-negotiation';

test('wantsMarkdown honors Accept content negotiation', () => {
  assert.equal(wantsMarkdown({ headers: { accept: 'text/markdown' } }), true);
  assert.equal(wantsMarkdown({ headers: { accept: 'text/html' } }), false);
  assert.equal(
    wantsMarkdown({ headers: { accept: 'text/html, text/markdown;q=0.9' } }),
    false,
  );
  assert.equal(
    wantsMarkdown({ headers: { accept: 'text/markdown, text/html;q=0.8' } }),
    true,
  );
});

test('htmlToAgentMarkdown converts homepage HTML to markdown with frontmatter', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf-8');
  const markdown = htmlToAgentMarkdown(html);
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();

  assert.ok(title);
  assert.match(markdown, new RegExp(`^---\\ntitle: ${escapeRegExp(title)}\\n---\\n\\n`));
  assert.match(markdown, new RegExp(escapeRegExp(title)));
  assert.doesNotMatch(markdown, /<html/i);
});

test('estimateMarkdownTokens returns a positive estimate', () => {
  assert.ok(estimateMarkdownTokens('hello world') >= 1);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
