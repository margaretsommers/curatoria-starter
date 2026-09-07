import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  PUBLIC_DIR,
  estimateMarkdownTokens,
  htmlToAgentMarkdown,
  sendPublicHtml,
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

function mockResponse() {
  const calls: { redirects: [number, string][]; statuses: number[]; ended: boolean } = {
    redirects: [],
    statuses: [],
    ended: false,
  };
  const res: any = {
    redirect(status: number, url: string) {
      calls.redirects.push([status, url]);
      return res;
    },
    status(code: number) {
      calls.statuses.push(code);
      return res;
    },
    end() {
      calls.ended = true;
      return res;
    },
    sendFile() {
      throw new Error('sendFile should not be called when the file is missing');
    },
    setHeader() {
      return res;
    },
    send() {
      return res;
    },
  };
  return { res, calls };
}

test('sendPublicHtml redirects to the static path when the file is missing from the bundle', () => {
  // Regression test for the 2026-09-06 production outage: public/ is not
  // reliably present in Vercel's deployed function bundle, so a bare "/"
  // reaching handleHomepage (which the CDN's own static match for the
  // literal file doesn't cover) used to 404 via a raw fs.sendFile ENOENT.
  const missingPath = path.join(PUBLIC_DIR, 'does-not-exist-regression.html');
  const { res, calls } = mockResponse();
  sendPublicHtml({ path: '/', method: 'GET', headers: {} } as any, res, missingPath);
  assert.deepEqual(calls.redirects, [[302, '/does-not-exist-regression.html']]);
});

test('sendPublicHtml 404s instead of looping when the static path itself is missing', () => {
  const missingPath = path.join(PUBLIC_DIR, 'does-not-exist-regression.html');
  const { res, calls } = mockResponse();
  sendPublicHtml(
    { path: '/does-not-exist-regression.html', method: 'GET', headers: {} } as any,
    res,
    missingPath,
  );
  assert.deepEqual(calls.redirects, []);
  assert.deepEqual(calls.statuses, [404]);
  assert.equal(calls.ended, true);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
