import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DestinationPreflightError,
  preflightDownloadDestination,
  resolveStateDirectory,
} from './destination-preflight';

const GIB = 1024 ** 3;

function capacity(available = 2 * GIB, total = 10 * GIB) {
  return async () => ({
    bavail: BigInt(available),
    bsize: 1n,
    blocks: BigInt(total),
  });
}

test('preflight fails closed on missing noninteractive output', async () => {
  await assert.rejects(
    () =>
      preflightDownloadDestination({
        filename: 'layout.psd',
        contentBytes: 10,
        isTTY: false,
        statfs: capacity(),
      }),
    (error: unknown) =>
      error instanceof DestinationPreflightError &&
      error.code === 'output_required',
  );
});

test('preflight prompts for missing output only on a TTY', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-preflight-prompt-'));
  let prompts = 0;
  const reservation = await preflightDownloadDestination({
    filename: 'layout.psd',
    contentBytes: 10,
    stateDirectory: path.join(root, 'state'),
    isTTY: true,
    prompt: async () => {
      prompts += 1;
      return root;
    },
    statfs: capacity(),
  });
  assert.equal(prompts, 1);
  assert.equal(reservation.finalPath, path.join(root, 'layout.psd'));
});

test('preflight reserves bytes plus max of 64MiB or five percent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-preflight-space-'));
  await assert.rejects(
    () =>
      preflightDownloadDestination({
        out: root,
        filename: 'layout.psd',
        contentBytes: 100,
        stateDirectory: path.join(root, 'state'),
        statfs: capacity(64 * 1024 ** 2, GIB),
      }),
    (error: unknown) =>
      error instanceof DestinationPreflightError &&
      error.code === 'insufficient_space',
  );
  await assert.rejects(
    () =>
      preflightDownloadDestination({
        out: root,
        filename: 'layout.psd',
        contentBytes: 100,
        stateDirectory: path.join(root, 'state'),
        statfs: capacity(500_000_099, 10_000_000_000),
      }),
    /requires 500000100 bytes/,
  );
});

test('preflight fails closed when capacity is unknown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-preflight-unknown-'));
  await assert.rejects(
    () =>
      preflightDownloadDestination({
        out: root,
        filename: 'layout.psd',
        contentBytes: 10,
        stateDirectory: path.join(root, 'state'),
        statfs: async () => {
          throw new Error('unsupported');
        },
      }),
    (error: unknown) =>
      error instanceof DestinationPreflightError &&
      error.code === 'capacity_unknown',
  );
});

test('preflight independently checks private state capacity and writability', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-preflight-statefs-'));
  const stateRoot = path.join(root, 'state');
  await assert.rejects(
    () =>
      preflightDownloadDestination({
        out: path.join(root, 'output'),
        filename: 'layout.psd',
        contentBytes: 10,
        stateDirectory: stateRoot,
        statfs: async target => {
          if (target === stateRoot) throw new Error('state statfs unavailable');
          return capacity()();
        },
      }),
    (error: unknown) =>
      error instanceof DestinationPreflightError &&
      error.code === 'capacity_unknown' &&
      /state\/cache capacity/.test(error.message),
  );

  const stateFile = path.join(root, 'not-a-directory');
  await fs.writeFile(stateFile, 'blocked');
  await assert.rejects(
    () =>
      preflightDownloadDestination({
        out: path.join(root, 'output-2'),
        filename: 'layout.psd',
        contentBytes: 10,
        stateDirectory: stateFile,
        statfs: capacity(),
      }),
    /not a regular directory|EEXIST/,
  );
});

test('preflight reserves simultaneous partial and final bytes on one filesystem', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-preflight-combined-'));
  await assert.rejects(
    () =>
      preflightDownloadDestination({
        out: path.join(root, 'output'),
        filename: 'layout.psd',
        contentBytes: 100 * 1024 ** 2,
        stateDirectory: path.join(root, 'state'),
        statfs: capacity(180 * 1024 ** 2, GIB),
      }),
    /Combined destination and private state\/cache.*requires/i,
  );
});

test('collision policies number, replace, cancel, and ask are explicit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-preflight-collision-'));
  const stateRoot = path.join(root, 'private-state');
  const original = path.join(root, 'layout.psd');
  await fs.writeFile(original, 'original');

  const numbered = await preflightDownloadDestination({
    out: root,
    filename: 'layout.psd',
    contentBytes: 10,
    stateDirectory: stateRoot,
    collisionPolicy: 'number',
    statfs: capacity(),
  });
  assert.equal(path.basename(numbered.finalPath), 'layout (1).psd');
  assert.equal(numbered.replaceExisting, false);

  const replaced = await preflightDownloadDestination({
    out: root,
    filename: 'layout.psd',
    contentBytes: 10,
    stateDirectory: stateRoot,
    collisionPolicy: 'replace',
    statfs: capacity(),
  });
  assert.equal(replaced.finalPath, original);
  assert.equal(replaced.replaceExisting, true);
  assert.equal(await fs.readFile(original, 'utf8'), 'original');

  await assert.rejects(
    () =>
      preflightDownloadDestination({
        out: root,
        filename: 'layout.psd',
        contentBytes: 10,
        stateDirectory: stateRoot,
        collisionPolicy: 'cancel',
        statfs: capacity(),
      }),
    (error: unknown) =>
      error instanceof DestinationPreflightError &&
      error.code === 'collision_cancelled',
  );

  const asked = await preflightDownloadDestination({
    out: root,
    filename: 'layout.psd',
    contentBytes: 10,
    stateDirectory: stateRoot,
    collisionPolicy: 'ask',
    isTTY: true,
    prompt: async () => 'number',
    statfs: capacity(),
  });
  assert.match(path.basename(asked.finalPath), /^layout \(\d+\)\.psd$/);
});

test('collisions require explicit choices and --yes never overwrites', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-preflight-yes-'));
  await fs.writeFile(path.join(root, 'layout.psd'), 'original');

  const prompted = await preflightDownloadDestination({
    out: root,
    filename: 'layout.psd',
    contentBytes: 10,
    stateDirectory: path.join(root, 'state'),
    yes: true,
    isTTY: true,
    prompt: async () => 'number',
    statfs: capacity(),
  });
  assert.notEqual(path.basename(prompted.finalPath), 'layout.psd');

  await assert.rejects(
    () =>
      preflightDownloadDestination({
        out: root,
        filename: 'layout.psd',
        contentBytes: 10,
        stateDirectory: path.join(root, 'state'),
        isTTY: false,
        statfs: capacity(),
      }),
    (error: unknown) =>
      error instanceof DestinationPreflightError &&
      error.code === 'collision_policy_required',
  );
  await assert.rejects(
    () =>
      preflightDownloadDestination({
      out: root,
      filename: 'layout.psd',
      contentBytes: 10,
      stateDirectory: path.join(root, 'state'),
      collisionPolicy: 'replace',
      yes: true,
      statfs: capacity(),
      }),
    /--yes never permits overwrite/,
  );
});

test('concurrent preflights get unique reservations and private cache state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-preflight-race-'));
  const stateRoot = path.join(root, 'cache');
  const reservations = await Promise.all(
    Array.from({ length: 4 }, () =>
      preflightDownloadDestination({
        out: root,
        filename: 'layout.psd',
        contentBytes: 10,
        stateDirectory: stateRoot,
        statfs: capacity(),
      }),
    ),
  );
  assert.equal(new Set(reservations.map((item) => item.finalPath)).size, 4);
  for (const reservation of reservations) {
    assert.equal(path.dirname(reservation.statePath), stateRoot);
    assert.equal(path.dirname(reservation.tempPath), stateRoot);
    assert.notEqual(path.dirname(reservation.statePath), root);
    assert.equal((await fs.stat(reservation.tempPath)).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(stateRoot)).mode & 0o777, 0o700);
});

test('private state directory follows Curatoria, XDG, then home cache precedence', () => {
  assert.equal(
    resolveStateDirectory(
      {
        CURATORIA_STATE_DIR: '/private/curatoria',
        XDG_CACHE_HOME: '/xdg',
      },
      '/home/test',
    ),
    '/private/curatoria',
  );
  assert.equal(
    resolveStateDirectory({ XDG_CACHE_HOME: '/xdg' }, '/home/test'),
    '/xdg/curatoria/downloads',
  );
  assert.equal(
    resolveStateDirectory({}, '/home/test'),
    '/home/test/.cache/curatoria/downloads',
  );
});
