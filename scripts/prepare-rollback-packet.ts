/**
 * Prepare an unexecuted paid-PSD rollback packet. Records commits, sanitized
 * registry hashes, environment variable NAMES only, schema notes, and
 * go/no-go items. Never executes rollback, deploy, payment, or provider work.
 */

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT, REGISTRY_PATH } from '../src/paths';
import { atomicWritePrivate, deriveRepositoryState } from './generate-proof-report';

export const ROLLBACK_PACKET_SCHEMA_VERSION = 1;
export const DOCUMENTED_BASELINE_COMMIT = '0db7823';

const FORBIDDEN_ROLLBACK_FLAGS = [
  '--execute',
  '--apply',
  '--rollback',
  '--run',
  '--reset',
  '--force',
];

export type RollbackCommand = {
  instruction: string;
  executed: false;
};

export type RollbackGoNoGoItem = {
  item: string;
  status: 'pending';
};

export type RollbackPacket = {
  schema_version: typeof ROLLBACK_PACKET_SCHEMA_VERSION;
  generated_at: string;
  kind: 'unexecuted_rollback_packet';
  repository: {
    current_commit: string;
    base_commit: string;
    documented_baseline: string;
    dirty: boolean;
  };
  registry: {
    path: 'design-systems/.registry.json';
    sanitized_sha256: string;
    entry_count: number;
    entry_hashes: Array<{ id: string; sha256: string }>;
  };
  environment_variable_names: string[];
  schema_compatibility: string[];
  rollback_commands: RollbackCommand[];
  go_no_go: RollbackGoNoGoItem[];
};

export type PrepareRollbackPacketOptions = {
  projectRoot?: string;
  outputDirectory?: string;
  argv?: string[];
  now?: () => Date;
  envExample?: string;
};

export function refuseExecutedRollback(argv: string[] = process.argv): void {
  const flags = argv.filter(argument => FORBIDDEN_ROLLBACK_FLAGS.includes(argument));
  if (flags.length > 0) {
    throw new Error(
      'Rollback prepare records unexecuted instructions only; it will not apply a rollback.',
    );
  }
}

export function environmentVariableNamesFromExample(contents: string): string[] {
  const names = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^#\s*/, '');
    if (!trimmed) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=/);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].sort();
}

export function sanitizeRegistryForHash(raw: unknown): {
  sanitized: unknown;
  entry_hashes: Array<{ id: string; sha256: string }>;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Registry must be a JSON object.');
  }
  const registry = raw as {
    owner?: Record<string, unknown>;
    design_systems?: unknown[];
  };
  const entries = Array.isArray(registry.design_systems) ? registry.design_systems : [];
  const sanitizedEntries = entries.map(entry => sanitizeRegistryEntry(entry));
  const entry_hashes = sanitizedEntries.map(entry => ({
    id: entry.id,
    sha256: sha256Json(entry),
  }));
  return {
    sanitized: {
      owner: {
        name: typeof registry.owner?.name === 'string' ? registry.owner.name : '',
      },
      design_systems: sanitizedEntries,
    },
    entry_hashes,
  };
}

export function prepareRollbackPacket(
  options: PrepareRollbackPacketOptions = {},
): { packet: RollbackPacket; outputPath?: string } {
  refuseExecutedRollback(options.argv ?? []);
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const repository = deriveRepositoryState(projectRoot);
  const baseCommit = resolveBaseCommit(projectRoot);
  const registryRaw = JSON.parse(fs.readFileSync(path.join(projectRoot, 'design-systems', '.registry.json'), 'utf8'));
  const sanitized = sanitizeRegistryForHash(registryRaw);
  const envExample =
    options.envExample ??
    fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
  const packet: RollbackPacket = {
    schema_version: ROLLBACK_PACKET_SCHEMA_VERSION,
    generated_at: generatedAt,
    kind: 'unexecuted_rollback_packet',
    repository: {
      current_commit: repository.commit,
      base_commit: baseCommit,
      documented_baseline: DOCUMENTED_BASELINE_COMMIT,
      dirty: repository.dirty,
    },
    registry: {
      path: 'design-systems/.registry.json',
      sanitized_sha256: sha256Json(sanitized.sanitized),
      entry_count: sanitized.entry_hashes.length,
      entry_hashes: sanitized.entry_hashes,
    },
    environment_variable_names: environmentVariableNamesFromExample(envExample),
    schema_compatibility: [
      'Observability events remain schema_version 1 and additive only.',
      'Stored grant records remain version 1.',
      'Recover and redeem keep 401 for invalid proof and 503 for store or signing unavailability.',
      'ENTITLEMENT_STORE_INDEX_KEY stays a dedicated secret and is never derived from the signing key.',
      'Purchase and redeem stay small JSON responses; binary bytes do not pass through the Vercel function.',
    ],
    rollback_commands: [
      {
        instruction: `git switch --detach ${baseCommit}`,
        executed: false,
      },
      {
        instruction: `git restore --source=${baseCommit} -- design-systems/.registry.json`,
        executed: false,
      },
      {
        instruction: 'vercel rollback <deployment-id>  # human-only; do not run from this packet',
        executed: false,
      },
    ],
    go_no_go: [
      { item: 'Focused observability, harness, and rollback tests are green.', status: 'pending' },
      { item: 'Preview harness refused production origins and production wallet configuration.', status: 'pending' },
      { item: 'Failure drills observed injected faults and did not execute rollback.', status: 'pending' },
      { item: 'Packet contains env var names only and sanitized registry hashes.', status: 'pending' },
      { item: 'Human approval is recorded before any rollback command is run.', status: 'pending' },
    ],
  };
  assertSafeRollbackPacket(packet);
  if (!options.outputDirectory) {
    return { packet };
  }
  fs.mkdirSync(options.outputDirectory, { recursive: true, mode: 0o700 });
  const outputPath = atomicWritePrivate(
    options.outputDirectory,
    'rollback-packet.json',
    `${JSON.stringify(packet, null, 2)}\n`,
  );
  return { packet, outputPath };
}

function sanitizeRegistryEntry(value: unknown): {
  id: string;
  resource_type: unknown;
  price_usd: unknown;
  active: unknown;
  content_sha256: unknown;
  content_bytes: unknown;
  integrity_status: unknown;
  delivery_mode: unknown;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Registry entry must be a JSON object.');
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(entry.id)) {
    throw new Error('Registry entry id is invalid.');
  }
  return {
    id: entry.id,
    resource_type: entry.resource_type ?? 'design_md',
    price_usd: entry.price_usd ?? null,
    active: entry.active ?? null,
    content_sha256: typeof entry.content_sha256 === 'string' ? entry.content_sha256 : null,
    content_bytes: typeof entry.content_bytes === 'number' ? entry.content_bytes : null,
    integrity_status: entry.integrity_status ?? null,
    delivery_mode: entry.delivery_mode ?? null,
  };
}

function resolveBaseCommit(projectRoot: string): string {
  for (const candidate of ['origin/main', 'main', DOCUMENTED_BASELINE_COMMIT]) {
    const mergeBase = spawnSync('git', ['merge-base', 'HEAD', candidate], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    const commit = mergeBase.stdout.trim().toLowerCase();
    if (mergeBase.status === 0 && /^[a-f0-9]{7,40}$/.test(commit)) {
      return commit;
    }
  }
  return DOCUMENTED_BASELINE_COMMIT;
}

function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertSafeRollbackPacket(packet: RollbackPacket): void {
  const serialized = JSON.stringify(packet);
  if (/(?:https?|s3):\/\//i.test(serialized)) {
    throw new Error('Rollback packet rejected a URL; value was redacted.');
  }
  if (/\b(authorization|bearer|blob_path|file_id|share_url)\b/i.test(serialized)) {
    throw new Error('Rollback packet rejected a secret-bearing field; value was redacted.');
  }
  if (/"entitlement"\s*:/.test(serialized)) {
    throw new Error('Rollback packet rejected a secret-bearing field; value was redacted.');
  }
  if (packet.rollback_commands.some(command => command.executed !== false)) {
    throw new Error('Rollback packet commands must remain unexecuted.');
  }
  if (REGISTRY_PATH.length === 0) {
    throw new Error('Registry path is required.');
  }
}

if (require.main === module) {
  try {
    refuseExecutedRollback(process.argv);
    const outputDirectory = path.join(PROJECT_ROOT, '.proof', 'rollback');
    const generated = prepareRollbackPacket({ outputDirectory, argv: process.argv });
    console.log(
      `Wrote unexecuted rollback packet ${path.relative(PROJECT_ROOT, generated.outputPath ?? '')}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Rollback packet preparation failed.');
    process.exitCode = 1;
  }
}
