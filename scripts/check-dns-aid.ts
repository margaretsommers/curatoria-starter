/**
 * check-dns-aid.ts — verify DNS-AID records via DNS-over-HTTPS
 *
 * Usage:
 *   npm run check-dns-aid
 *   npm run check-dns-aid -- --domain curatoria.dev
 *   npm run check-dns-aid -- --url https://curatoria.dev
 */

const HTTPS_TYPE = 65;
const SVCB_TYPE = 64;

const DOH_RESOLVERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

type DohAnswer = {
  name: string;
  type: number;
  TTL?: number;
  data: string;
};

type DohResponse = {
  Status: number;
  AD?: boolean;
  Answer?: DohAnswer[];
};

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
    }
  }
  return args;
}

function parseDomain(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('://')) {
    return new URL(trimmed).hostname.toLowerCase();
  }
  return trimmed.replace(/\.$/, '').toLowerCase();
}

function resolveDomain(args: Record<string, string>): string {
  if (args.domain) return parseDomain(args.domain);
  if (args.url) return parseDomain(args.url);
  if (process.env.PUBLIC_BASE_URL) return parseDomain(process.env.PUBLIC_BASE_URL);
  return 'curatoria.dev';
}

async function queryDoh(name: string, type: number, resolver: string): Promise<DohResponse> {
  const url = `${resolver}?${new URLSearchParams({
    name,
    type: String(type),
  }).toString()}`;

  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
  });

  if (!response.ok) {
    throw new Error(`DoH ${resolver} returned HTTP ${response.status}`);
  }

  return (await response.json()) as DohResponse;
}

function statusLabel(status: number): string {
  if (status === 0) return 'NOERROR';
  if (status === 3) return 'NXDOMAIN';
  return `RCODE ${status}`;
}

function validateServiceMode(data: string): { ok: boolean; detail: string } {
  const trimmed = data.trim();
  if (!/^1\s+\S/.test(trimmed)) {
    return { ok: false, detail: 'expected ServiceMode record with priority 1' };
  }
  if (!/\balpn=/.test(trimmed)) {
    return { ok: false, detail: 'missing alpn SvcParam' };
  }
  if (!/\bport=/.test(trimmed)) {
    return { ok: false, detail: 'missing port SvcParam' };
  }
  return { ok: true, detail: 'ServiceMode HTTPS/SVCB with alpn and port' };
}

async function checkIndexRecord(domain: string): Promise<boolean> {
  const owner = `_index._agents.${domain}`;
  let lastDetail = 'record not found';

  for (const resolver of DOH_RESOLVERS) {
    for (const type of [HTTPS_TYPE, SVCB_TYPE]) {
      try {
        const result = await queryDoh(owner, type, resolver);
        if (result.Status !== 0) {
          lastDetail = `${statusLabel(result.Status)} from ${new URL(resolver).hostname}`;
          continue;
        }

        const answers =
          result.Answer?.filter(answer => answer.type === HTTPS_TYPE || answer.type === SVCB_TYPE) ??
          [];
        if (answers.length === 0) {
          lastDetail = `NOERROR without HTTPS/SVCB answers from ${new URL(resolver).hostname}`;
          continue;
        }

        const validation = validateServiceMode(answers[0].data);
        if (!validation.ok) {
          lastDetail = `${validation.detail} (${answers[0].data})`;
          continue;
        }

        const typeLabel = answers[0].type === HTTPS_TYPE ? 'HTTPS' : 'SVCB';
        console.log(
          `PASS  ${owner} — ${typeLabel} via ${new URL(resolver).hostname}: ${answers[0].data}`,
        );

        if (result.AD) {
          console.log('PASS  DNSSEC — AD (authenticated data) set');
        } else {
          console.log(
            'WARN  DNSSEC — AD not set; enable DNSSEC at your DNS host (see docs/operator/dns-aid-records.md)',
          );
        }

        return true;
      } catch (error) {
        lastDetail = String(error);
      }
    }
  }

  console.log(`FAIL  ${owner} — ${lastDetail}`);
  console.log('      Publish DNS-AID records: docs/operator/dns-aid-records.md');
  return false;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const domain = resolveDomain(args);

  console.log(`Checking DNS-AID for ${domain}\n`);

  const ok = await checkIndexRecord(domain);
  if (!ok) {
    process.exitCode = 1;
    return;
  }

  console.log('\nDNS-AID index check passed.');
}

run().catch(error => {
  console.error(`DNS-AID check failed with unexpected error: ${String(error)}`);
  process.exit(1);
});
