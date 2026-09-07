import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DESIGN_SYSTEMS_DIR,
  PROJECT_ROOT,
  findProjectRoot,
  resolveDesignSystemPath,
  resolvePathWithin,
  resolveProjectRootOrFallback,
} from './paths';

test('findProjectRoot resolves from source and compiled source directories', () => {
  assert.equal(findProjectRoot(path.join(PROJECT_ROOT, 'src')), PROJECT_ROOT);
  assert.equal(findProjectRoot(path.join(PROJECT_ROOT, 'dist/src')), PROJECT_ROOT);
});

test('findProjectRoot requires both package.json and design-systems', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-paths-'));
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, 'package.json'), '{}');
    assert.throws(() => findProjectRoot(path.join(temporaryRoot, 'nested')), /project root/i);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('resolveProjectRootOrFallback never throws even when design-systems is genuinely absent', () => {
  // Reproduces the exact 2026-09-06 production condition: a directory tree
  // with a package.json but no design-systems/ anywhere findable (as
  // observed in Vercel's deployed function bundle). Regression test for the
  // outage where PROJECT_ROOT's module-level computation threw at import
  // time and crashed every single request.
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-paths-fallback-'));
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, 'package.json'), '{}');
    let result: string | undefined;
    assert.doesNotThrow(() => {
      result = resolveProjectRootOrFallback(path.join(temporaryRoot, 'src'));
    });
    assert.equal(typeof result, 'string');
    assert.ok(path.isAbsolute(result as string));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('resolveProjectRootOrFallback still finds the real project root when it exists', () => {
  assert.equal(resolveProjectRootOrFallback(path.join(PROJECT_ROOT, 'src')), PROJECT_ROOT);
});

test('resolvePathWithin rejects traversal, absolute escapes, and symlink escapes', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-confine-'));
  const allowed = path.join(temporaryRoot, 'design-systems');
  const outside = path.join(temporaryRoot, 'outside');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(allowed, 'linked'));

  try {
    assert.equal(
      resolvePathWithin(allowed, 'product.md'),
      path.join(allowed, 'product.md'),
    );
    assert.throws(() => resolvePathWithin(allowed, '../outside/secret.txt'), /escapes/);
    assert.throws(() => resolvePathWithin(allowed, path.join(outside, 'secret.txt')), /escapes/);
    assert.throws(() => resolvePathWithin(allowed, 'linked/secret.txt'), /escapes/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('resolvePathWithin never throws when the base directory itself does not exist', () => {
  // Reproduces the 2026-09-06 production outage: sitemap.ts and
  // link-headers.ts both call resolvePublicPath (-> resolvePathWithin) at
  // MODULE LOAD TIME, and PUBLIC_DIR does not exist in Vercel's deployed
  // function bundle for this project. resolvePathWithin used to call
  // fs.realpathSync(resolvedBase) unconditionally, which throws ENOENT for a
  // missing base and crashed every request. A missing base has nothing to
  // serve and nothing to escape into via a symlink, so this should resolve
  // the candidate path instead of throwing -- callers then get a normal
  // not-found from fs.existsSync/readFileSync/res.sendFile.
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-missing-base-'));
  try {
    const missingBase = path.join(temporaryRoot, 'public');
    assert.ok(!fs.existsSync(missingBase));
    let result: string | undefined;
    assert.doesNotThrow(() => {
      result = resolvePathWithin(missingBase, 'sitemap.xml', 'public');
    });
    assert.equal(result, path.join(missingBase, 'sitemap.xml'));
    // Traversal is still rejected even when the base is missing.
    assert.throws(() => resolvePathWithin(missingBase, '../escape.txt', 'public'), /escapes/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('resolveDesignSystemPath confines paths to the shared catalog directory', () => {
  assert.equal(
    resolveDesignSystemPath('example-minimal.md'),
    path.join(DESIGN_SYSTEMS_DIR, 'example-minimal.md'),
  );
  assert.throws(() => resolveDesignSystemPath('../package.json'), /escapes design-systems/);
});

for (const [script, sourceFlag] of [
  ['scripts/publish.ts', '--file'],
  ['scripts/publish-pack.ts', '--zip'],
] as const) {
  test(`${script} rejects local publish sources outside design-systems`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        'ts-node/register',
        script,
        '--id',
        'escape-canary',
        sourceFlag,
        'package.json',
        '--name',
        'Escape Canary',
        '--price',
        '0.01',
      ],
      { cwd: PROJECT_ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /escapes design-systems/);
  });
}
