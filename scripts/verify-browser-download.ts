import fs from 'node:fs';
import path from 'node:path';

import {
  parseBrowserProofReceipt,
  verifyBrowserDownload,
} from '../src/browser-disk-verifier';

type Arguments = {
  receipt: string;
  file: string;
  receiptId: string;
  productId: string;
  transaction: string;
  entitlementFingerprint: string;
};

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  const receipt = parseBrowserProofReceipt(
    JSON.parse(await fs.promises.readFile(path.resolve(args.receipt), 'utf8')),
  );
  const result = await verifyBrowserDownload({
    receipt,
    filePath: args.file,
    expected: {
      receiptId: args.receiptId,
      productId: args.productId,
      transaction: args.transaction,
      entitlementFingerprint: args.entitlementFingerprint,
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(
        'Usage: verify-browser-download --receipt <receipt.json> --file <saved.psd> --receipt-id <id> --product <id> --transaction <tx> --entitlement-fingerprint <sha256>',
      );
    }
    values.set(flag, value);
  }
  const receipt = values.get('--receipt');
  const file = values.get('--file');
  const receiptId = values.get('--receipt-id');
  const productId = values.get('--product');
  const transaction = values.get('--transaction');
  const entitlementFingerprint = values.get('--entitlement-fingerprint');
  if (
    !receipt ||
    !file ||
    !receiptId ||
    !productId ||
    !transaction ||
    !entitlementFingerprint
  ) {
    throw new Error('Receipt, file, and all transaction identity bindings are required.');
  }
  return {
    receipt,
    file,
    receiptId,
    productId,
    transaction,
    entitlementFingerprint,
  };
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { main, parseArguments };
