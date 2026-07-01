import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  DESIGN_SYSTEMS_DIR,
  REPO_ROOT,
  resolveLocalDesignSystemsFile,
} from './paths';

test('repo paths resolve from the repository root', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'package.json')));
  assert.ok(fs.existsSync(DESIGN_SYSTEMS_DIR));
});

test('resolveLocalDesignSystemsFile accepts design-systems paths from repo root', () => {
  const resolved = resolveLocalDesignSystemsFile('design-systems/example-minimal.md');
  assert.equal(resolved, path.join(DESIGN_SYSTEMS_DIR, 'example-minimal.md'));
});

test('resolveLocalDesignSystemsFile rejects paths outside design-systems', () => {
  assert.throws(
    () => resolveLocalDesignSystemsFile('README.md'),
    /must live under design-systems/,
  );
  assert.throws(
    () => resolveLocalDesignSystemsFile('/tmp/outside.md'),
    /must live under design-systems/,
  );
});
