import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildTinyRgbPsd,
  generatePsdFixture,
} from '../scripts/generate-psd-fixture';

test('tiny PSD fixture is a valid minimal uncompressed 1x1 RGB document', () => {
  const bytes = buildTinyRgbPsd();

  assert.equal(bytes.byteLength, 43);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), '8BPS');
  assert.equal(bytes.readUInt16BE(4), 1);
  assert.deepEqual(bytes.subarray(6, 12), Buffer.alloc(6));
  assert.equal(bytes.readUInt16BE(12), 3);
  assert.equal(bytes.readUInt32BE(14), 1);
  assert.equal(bytes.readUInt32BE(18), 1);
  assert.equal(bytes.readUInt16BE(22), 8);
  assert.equal(bytes.readUInt16BE(24), 3);
  assert.equal(bytes.readUInt32BE(26), 0);
  assert.equal(bytes.readUInt32BE(30), 0);
  assert.equal(bytes.readUInt32BE(34), 0);
  assert.equal(bytes.readUInt16BE(38), 0);
  assert.deepEqual([...bytes.subarray(40)], [0x35, 0x69, 0xa8]);
});

test('fixture generator reproduces byte-identical PSD and manifest output', () => {
  const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-psd-first-'));
  const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-psd-second-'));

  const first = generatePsdFixture(firstDirectory);
  const second = generatePsdFixture(secondDirectory);
  const firstPsd = fs.readFileSync(first.psdPath);
  const secondPsd = fs.readFileSync(second.psdPath);
  const firstManifest = fs.readFileSync(first.manifestPath);
  const secondManifest = fs.readFileSync(second.manifestPath);

  assert.deepEqual(firstPsd, secondPsd);
  assert.deepEqual(firstManifest, secondManifest);

  const manifest = JSON.parse(firstManifest.toString('utf8')) as {
    file: string;
    bytes: number;
    sha256: string;
    generated_by: string;
    source: string;
  };
  assert.equal(manifest.file, 'tiny-rgb-1x1.psd');
  assert.equal(manifest.bytes, firstPsd.byteLength);
  assert.equal(
    manifest.sha256,
    crypto.createHash('sha256').update(firstPsd).digest('hex'),
  );
  assert.equal(manifest.generated_by, 'scripts/generate-psd-fixture.ts');
  assert.equal(manifest.source, 'generated; no external or copyrighted source material');
});
