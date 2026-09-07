import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../src/paths';

const FIXTURE_NAME = 'tiny-rgb-1x1.psd';
const GENERATOR_PATH = 'scripts/generate-psd-fixture.ts';

export function buildTinyRgbPsd(): Buffer {
  const bytes = Buffer.alloc(43);
  bytes.write('8BPS', 0, 'ascii');
  bytes.writeUInt16BE(1, 4);
  bytes.writeUInt16BE(3, 12);
  bytes.writeUInt32BE(1, 14);
  bytes.writeUInt32BE(1, 18);
  bytes.writeUInt16BE(8, 22);
  bytes.writeUInt16BE(3, 24);
  // The color-mode, image-resources, and layer/mask sections are empty.
  bytes.writeUInt32BE(0, 26);
  bytes.writeUInt32BE(0, 30);
  bytes.writeUInt32BE(0, 34);
  // Raw planar image data: compression=0, then one R, G, and B byte.
  bytes.writeUInt16BE(0, 38);
  bytes.set([0x35, 0x69, 0xa8], 40);
  return bytes;
}

export function generatePsdFixture(
  outputDirectory = path.join(PROJECT_ROOT, 'test/fixtures/psd'),
): { psdPath: string; manifestPath: string } {
  const bytes = buildTinyRgbPsd();
  const psdPath = path.join(outputDirectory, FIXTURE_NAME);
  const manifestPath = path.join(outputDirectory, 'manifest.json');
  const manifest = {
    schema_version: 1,
    file: FIXTURE_NAME,
    bytes: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    format: {
      signature: '8BPS',
      version: 1,
      channels: 3,
      height: 1,
      width: 1,
      depth: 8,
      color_mode: 'RGB',
      compression: 'raw',
    },
    generated_by: GENERATOR_PATH,
    source: 'generated; no external or copyrighted source material',
  };

  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(psdPath, bytes);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { psdPath, manifestPath };
}

if (require.main === module) {
  const outputDirectory = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(PROJECT_ROOT, 'test/fixtures/psd');
  const generated = generatePsdFixture(outputDirectory);
  console.log(`Generated ${path.relative(PROJECT_ROOT, generated.psdPath)} and manifest.`);
}
