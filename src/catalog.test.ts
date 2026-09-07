import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findEntry, listActive, readCatalog, resolveCatalogPriceUsd, publishCatalogEntry, setActiveCatalogSource } from './catalog';
import type { DesignCatalog, DesignSystemEntry } from './types';

function entry(id: string): DesignSystemEntry {
  return {
    id,
    file: `${id}.md`,
    name: id,
    description: '',
    price_usd: '0.01',
    tags: [],
    published_at: '2026-08-29T00:00:00.000Z',
    active: true,
  };
}

function fixture(): { directory: string; registryPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-catalog-'));
  const registryPath = path.join(directory, '.registry.json');
  const catalog: DesignCatalog = {
    owner: { name: 'test', wallet: '0x0000000000000000000000000000000000000000' },
    design_systems: [],
  };
  fs.writeFileSync(registryPath, `${JSON.stringify(catalog)}\n`);
  return { directory, registryPath };
}

test('setActiveCatalogSource redirects readCatalog and everything derived from it', t => {
  // Regression test for the 2026-09-06 production outage: design-systems/
  // .registry.json does not exist in Vercel's deployed function bundle, so
  // the plain filesystem readCatalog() throws ENOENT for every request in
  // production -- and x402.ts, x402-discovery.ts, discovery.ts,
  // openapi-spec.ts, and sitemap.ts all call readCatalog/findEntry/
  // listActive/resolveCatalogPriceUsd imported directly from this module,
  // bypassing server.ts's Blob-backed dependencies.catalog entirely. Every
  // paid route was broken. setActiveCatalogSource lets server.ts redirect
  // all of them at once without threading DI through each call site.
  const overrideCatalog: DesignCatalog = {
    owner: { name: 'override', wallet: '0x1111111111111111111111111111111111111111', catalog_price_usd: '0.02' },
    design_systems: [entry('override-entry')],
  };
  t.after(() => setActiveCatalogSource(undefined));

  setActiveCatalogSource({ readCatalog: () => overrideCatalog });

  assert.equal(readCatalog(), overrideCatalog);
  assert.equal(findEntry('override-entry')?.id, 'override-entry');
  assert.equal(listActive().length, 1);
  assert.equal(resolveCatalogPriceUsd(), '0.02');

  setActiveCatalogSource(undefined);
  // With no override installed, readCatalog falls back to the real
  // filesystem registry rather than continuing to serve the override data.
  assert.equal(findEntry('override-entry'), null);
});

test('concurrent catalog publications preserve every writer', async t => {
  const { directory, registryPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      publishCatalogEntry(entry(`entry-${index}`), { registryPath }),
    ),
  );

  const saved = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as DesignCatalog;
  assert.deepEqual(
    saved.design_systems.map(value => value.id).sort(),
    Array.from({ length: 20 }, (_, index) => `entry-${index}`).sort(),
  );
  assert.deepEqual(fs.readdirSync(`${registryPath}.lock`), []);
});

test('catalog publication is idempotent but rejects deterministic ID conflicts', async t => {
  const { directory, registryPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await publishCatalogEntry(entry('immutable'), { registryPath });
  await publishCatalogEntry(
    { ...entry('immutable'), published_at: '2026-08-30T00:00:00.000Z' },
    { registryPath },
  );
  await assert.rejects(
    () =>
      publishCatalogEntry(
        { ...entry('immutable'), content_sha256: 'a'.repeat(64) },
        { registryPath },
      ),
    /Catalog ID conflict: "immutable" is already published/,
  );
});

test('catalog publication reclaims a crashed stale lock', async t => {
  const { directory, registryPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = `${registryPath}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });
  const token = '00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(
    path.join(lockPath, `${token}.ticket`),
    JSON.stringify({
      token,
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: '2000-01-01T00:00:00.000Z',
      choosing: false,
      number: 1,
    }),
  );
  const old = new Date('2000-01-01T00:00:00.000Z');
  fs.utimesSync(path.join(lockPath, `${token}.ticket`), old, old);

  await publishCatalogEntry(entry('after-crash'), {
    registryPath,
    staleLockMs: 1,
    lockTimeoutMs: 500,
  });
  assert.deepEqual(fs.readdirSync(lockPath), []);
});

test('catalog publication times out rather than stealing a live lock', async t => {
  const { directory, registryPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = `${registryPath}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });
  const token = '00000000-0000-4000-8000-000000000002';
  fs.writeFileSync(
    path.join(lockPath, `${token}.ticket`),
    JSON.stringify({
      token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: '2000-01-01T00:00:00.000Z',
      choosing: false,
      number: 1,
    }),
  );
  const old = new Date('2000-01-01T00:00:00.000Z');
  fs.utimesSync(path.join(lockPath, `${token}.ticket`), old, old);

  await assert.rejects(
    () =>
      publishCatalogEntry(entry('blocked'), {
        registryPath,
        staleLockMs: 1,
        lockTimeoutMs: 40,
      }),
    /Timed out waiting for catalog publication lock/,
  );
});

test('multiple stale reclaimers cannot steal replacement tickets and all writers persist', {
  timeout: 90_000,
}, async t => {
  const { directory, registryPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = `${registryPath}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });
  const old = new Date('2000-01-01T00:00:00.000Z');
  for (let index = 0; index < 25; index += 1) {
    const token = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const ticketPath = path.join(lockPath, `${token}.ticket`);
    fs.writeFileSync(
      ticketPath,
      JSON.stringify({
        token,
        pid: 2_147_000_000 + index,
        hostname: os.hostname(),
        createdAt: old.toISOString(),
        choosing: index % 2 === 0,
        number: index + 1,
      }),
    );
    fs.utimesSync(ticketPath, old, old);
  }

  const writerCount = 50;
  await Promise.all(
    Array.from({ length: writerCount }, (_, index) =>
      publishCatalogEntry(entry(`stress-${index}`), {
        registryPath,
        staleLockMs: 5,
        lockTimeoutMs: 60_000,
      }),
    ),
  );

  const saved = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as DesignCatalog;
  assert.equal(saved.design_systems.length, writerCount);
  assert.equal(new Set(saved.design_systems.map(value => value.id)).size, writerCount);
  assert.deepEqual(fs.readdirSync(lockPath), []);
});

test('catalog publication rejects hash missing with verified status', async t => {
  const { directory, registryPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      publishCatalogEntry(
        { ...entry('verified-missing-hash'), integrity_status: 'verified' },
        { registryPath },
      ),
    /Verified catalog entries require a 64-hex content_sha256/,
  );
  await assert.rejects(
    () =>
      publishCatalogEntry(
        {
          ...entry('verified-malformed-hash'),
          integrity_status: 'verified',
          content_sha256: 'not-a-digest',
        },
        { registryPath },
      ),
    /Verified catalog entries require a 64-hex content_sha256/,
  );

  const saved = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as DesignCatalog;
  assert.deepEqual(saved.design_systems, []);
});

test('catalog publication rejects unsafe filename or MIME values', async t => {
  const { directory, registryPath } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      publishCatalogEntry(
        { ...entry('unsafe-name'), file: '../secret.md' },
        { registryPath },
      ),
    /Catalog filename is unsafe/,
  );
  await assert.rejects(
    () =>
      publishCatalogEntry(
        { ...entry('unsafe-mime'), mime_type: 'text/markdown\r\nX-Injected: 1' },
        { registryPath },
      ),
    /Catalog MIME type is unsafe/,
  );
  await assert.rejects(
    () =>
      publishCatalogEntry(
        { ...entry('missing-slash'), mime_type: 'not-a-mime' },
        { registryPath },
      ),
    /Catalog MIME type is unsafe/,
  );

  await publishCatalogEntry(
    {
      ...entry('verified-ok'),
      mime_type: 'image/vnd.adobe.photoshop',
      integrity_status: 'verified',
      content_sha256: 'a'.repeat(64),
    },
    { registryPath },
  );
  const saved = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as DesignCatalog;
  assert.equal(saved.design_systems.length, 1);
  assert.equal(saved.design_systems[0].id, 'verified-ok');
});
