import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildTinyRgbPsd } from '../scripts/generate-psd-fixture';
import { preflightLocalAsset, sourceFromArgs } from '../scripts/publish-asset';

const CLI = path.join(__dirname, '../scripts/publish-asset.ts');
const REGISTRY_PATH = path.join(__dirname, '../design-systems/.registry.json');

function spawnPublishAsset(argv: string[], env: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--require', 'ts-node/register', CLI, ...argv], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      BLOB_READ_WRITE_TOKEN: '',
      DROPBOX_ACCESS_TOKEN: '',
      ...env,
    },
    encoding: 'utf8',
  });
}

function parseStdoutJson(stdout: string | Buffer | null): Record<string, unknown> {
  return JSON.parse(String(stdout ?? '')) as Record<string, unknown>;
}

test('publish-asset rejects Dropbox folder URLs from the source env without leaking them', () => {
  const folderUrl = 'https://www.dropbox.com/scl/fo/FolderSecretId123/shared-folder?rlkey=xyz';
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'dropbox', 'source-env': 'STARTER_PSD_SOURCE' },
        { STARTER_PSD_SOURCE: folderUrl },
      ),
    error => {
      assert.match(
        String(error),
        /folder links \(\/scl\/fo\/\) are not supported[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
      );
      assert.doesNotMatch(String(error), /FolderSecretId123|dropbox\.com|rlkey/);
      return true;
    },
  );
});

test('publish-asset rejects classic Dropbox folder /sh/ URLs from the source env without leaking them', () => {
  const folderUrl = 'https://www.dropbox.com/sh/FolderSecretId123/shared-folder?dl=0';
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'dropbox', 'source-env': 'STARTER_PSD_SOURCE' },
        { STARTER_PSD_SOURCE: folderUrl },
      ),
    error => {
      assert.match(
        String(error),
        /folder links \(\/sh\/\) are not supported[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
      );
      assert.doesNotMatch(String(error), /FolderSecretId123|dropbox\.com/);
      return true;
    },
  );
});

test('publish-asset rejects Dropbox Paper URLs from the source env without leaking them', () => {
  const paperUrl = 'https://paper.dropbox.com/doc/PaperSecretId123';
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'dropbox', 'source-env': 'STARTER_PSD_SOURCE' },
        { STARTER_PSD_SOURCE: paperUrl },
      ),
    error => {
      assert.match(
        String(error),
        /Paper links are not supported[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
      );
      assert.doesNotMatch(String(error), /PaperSecretId123|dropbox\.com/);
      return true;
    },
  );
});

test('publish-asset rejects unknown Dropbox /scl/ URLs from the source env without leaking them', () => {
  const unknownUrl = 'https://www.dropbox.com/scl/xx/UnknownSecretId123/mystery?rlkey=xyz';
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'dropbox', 'source-env': 'STARTER_PSD_SOURCE' },
        { STARTER_PSD_SOURCE: unknownUrl },
      ),
    error => {
      assert.match(
        String(error),
        /\/scl\/ path are not supported[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
      );
      assert.doesNotMatch(String(error), /UnknownSecretId123|dropbox\.com|rlkey/);
      return true;
    },
  );
});

test('publish-asset rejects Google Drive folder URLs from the source env without leaking them', () => {
  const folderUrl = 'https://drive.google.com/drive/folders/FolderSecretId123';
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'gdrive', 'source-env': 'STARTER_PSD_SOURCE' },
        { STARTER_PSD_SOURCE: folderUrl },
      ),
    error => {
      assert.match(String(error), /folder links are not supported[\s\S]*file share link \(\/file\/d\/ or open\?id=\)/);
      assert.doesNotMatch(String(error), /FolderSecretId123|drive\.google\.com/);
      return true;
    },
  );
});

test('publish-asset rejects Dropbox URLs with userinfo from the source env without leaking them', () => {
  const credentialUrl = 'https://SecretUser:SecretPass@www.dropbox.com/s/abc123/my-doc.md?dl=0';
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'dropbox', 'source-env': 'STARTER_PSD_SOURCE' },
        { STARTER_PSD_SOURCE: credentialUrl },
      ),
    error => {
      assert.match(
        String(error),
        /cannot contain credentials[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
      );
      assert.doesNotMatch(String(error), /SecretUser|SecretPass|dropbox\.com|abc123/);
      return true;
    },
  );
});

test('publish-asset rejects Google Drive URLs with userinfo from the source env without leaking them', () => {
  const credentialUrl = 'https://SecretUser:SecretPass@drive.google.com/file/d/safe_file_id/view';
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'gdrive', 'source-env': 'STARTER_PSD_SOURCE' },
        { STARTER_PSD_SOURCE: credentialUrl },
      ),
    error => {
      assert.match(
        String(error),
        /cannot contain credentials[\s\S]*file share link \(\/file\/d\/ or open\?id=\)/,
      );
      assert.doesNotMatch(String(error), /SecretUser|SecretPass|drive\.google\.com|safe_file_id/);
      return true;
    },
  );
});

test('publish-asset reads the provider identifier only from a named environment variable', () => {
  const source = sourceFromArgs(
    { provider: 'gdrive', 'source-env': 'STARTER_PSD_SOURCE' },
    { STARTER_PSD_SOURCE: 'https://drive.google.com/file/d/safe_file_id/view' },
  );
  assert.deepEqual(source, { type: 'gdrive', file_id: 'safe_file_id' });
});

test('publish-asset fails closed for missing or invalid source environment input', () => {
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'dropbox', 'source-env': 'STARTER_PSD_SOURCE' },
        {},
      ),
    /is not set/,
  );
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'dropbox', 'source-env': 'not-valid-name' },
        { 'not-valid-name': 'https://www.dropbox.com/s/example/asset.psd' },
      ),
    /environment variable name/,
  );
  assert.throws(
    () =>
      sourceFromArgs(
        {
          provider: 'dropbox',
          'source-env': 'STARTER_PSD_SOURCE',
          'dropbox-url': 'https://www.dropbox.com/s/leaked/asset.psd',
        },
        { STARTER_PSD_SOURCE: 'https://www.dropbox.com/s/example/asset.psd' },
      ),
    /Unknown argument --dropbox-url/,
  );
  const secretLink = 'bad/id?secret=value';
  assert.throws(
    () =>
      sourceFromArgs(
        { provider: 'gdrive', 'source-env': 'STARTER_PSD_SOURCE' },
        { STARTER_PSD_SOURCE: secretLink },
      ),
    error => {
      assert.doesNotMatch(String(error), /secret=value|bad\/id/);
      return true;
    },
  );
});

test('publish-asset never logs the provider environment value', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-publish-test-'));
  const original = path.join(directory, 'asset.psd');
  fs.writeFileSync(original, Buffer.from('8BPSdata'));
  const secretValue = 'provider-link-secret-value';
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        'ts-node/register',
        path.join(__dirname, '../scripts/publish-asset.ts'),
        '--id',
        'asset',
        '--name',
        'Asset',
        '--price',
        '0.01',
        '--filename',
        'asset.psd',
        '--mime',
        'image/vnd.adobe.photoshop',
        '--original-file',
        original,
        '--provider',
        'url',
        '--source-env',
        'ASSET_SOURCE',
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ASSET_SOURCE: secretValue },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretValue));
    assert.match(result.stderr, /\[redacted source\]/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preflightLocalAsset reports bytes, SHA-256, 8BPS, and filename/MIME safety', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-preflight-ok-'));
  const original = path.join(directory, 'tiny.psd');
  const bytes = buildTinyRgbPsd();
  fs.writeFileSync(original, bytes);
  try {
    const report = await preflightLocalAsset({
      originalFile: original,
      filename: 'tiny.psd',
      mimeType: 'image/vnd.adobe.photoshop',
    });
    assert.equal(report.ok, true);
    assert.equal(report.preflight, true);
    assert.equal(report.content_bytes, bytes.byteLength);
    assert.equal(report.content_sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(report.psd_signature, '8BPS');
    assert.equal(report.psd_signature_ok, true);
    assert.equal(report.filename_safe, true);
    assert.equal(report.mime_safe, true);
    assert.equal(report.error, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preflightLocalAsset fails closed for missing 8BPS or unsafe filename/MIME', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-preflight-fail-'));
  const corrupt = path.join(directory, 'corrupt.psd');
  const valid = path.join(directory, 'valid.psd');
  fs.writeFileSync(corrupt, Buffer.from('not a PSD'));
  fs.writeFileSync(valid, buildTinyRgbPsd());
  try {
    const missingSignature = await preflightLocalAsset({
      originalFile: corrupt,
      filename: 'corrupt.psd',
      mimeType: 'image/vnd.adobe.photoshop',
    });
    assert.equal(missingSignature.ok, false);
    assert.equal(missingSignature.psd_signature_ok, false);
    assert.match(missingSignature.error ?? '', /8BPS/);

    const unsafeName = await preflightLocalAsset({
      originalFile: valid,
      filename: '../secret.psd',
      mimeType: 'image/vnd.adobe.photoshop',
    });
    assert.equal(unsafeName.ok, false);
    assert.equal(unsafeName.filename_safe, false);
    assert.equal(unsafeName.psd_signature_ok, true);

    const unsafeMime = await preflightLocalAsset({
      originalFile: valid,
      filename: 'valid.psd',
      mimeType: 'image/vnd.adobe.photoshop\r\nX-Injected: 1',
    });
    assert.equal(unsafeMime.ok, false);
    assert.equal(unsafeMime.mime_safe, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publish-asset --preflight exits 0 without Blob, catalog, Dropbox, or payment', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-preflight-cli-'));
  const original = path.join(directory, 'asset.psd');
  const bytes = buildTinyRgbPsd();
  fs.writeFileSync(original, bytes);
  const registryBefore = fs.existsSync(REGISTRY_PATH) ? fs.readFileSync(REGISTRY_PATH) : null;
  const registryMtime = fs.existsSync(REGISTRY_PATH) ? fs.statSync(REGISTRY_PATH).mtimeMs : 0;
  try {
    const result = spawnPublishAsset([
      '--preflight',
      '--filename',
      'asset.psd',
      '--mime',
      'image/vnd.adobe.photoshop',
      '--original-file',
      original,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const report = parseStdoutJson(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.preflight, true);
    assert.equal(report.content_bytes, bytes.byteLength);
    assert.equal(report.content_sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(report.psd_signature, '8BPS');
    assert.equal(report.filename_safe, true);
    assert.equal(report.mime_safe, true);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /dropbox|blob\.vercel|paid|402/i);
    if (registryBefore) {
      assert.deepEqual(fs.readFileSync(REGISTRY_PATH), registryBefore);
      assert.equal(fs.statSync(REGISTRY_PATH).mtimeMs, registryMtime);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publish-asset --preflight exits 1 for a corrupt local PSD', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-preflight-cli-fail-'));
  const original = path.join(directory, 'bad.psd');
  fs.writeFileSync(original, Buffer.from('not a PSD'));
  try {
    const result = spawnPublishAsset([
      '--preflight',
      '--filename',
      'bad.psd',
      '--mime',
      'image/vnd.adobe.photoshop',
      '--original-file',
      original,
    ]);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    const report = parseStdoutJson(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.preflight, true);
    assert.equal(report.psd_signature_ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
