import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import type { ClientBase } from 'pg';

export const DEMO_MERCHANT_NAME = 'demo-merchant';
export const SEED_CURRENCY = 'USD';

// Demo-grade API key for the seeded merchant. Static, documented, and shared by
// the dashboard and the tests so they can authenticate — see DECISIONS
// ("Demo-grade API auth"). Only its sha256 hash is stored; this plaintext is the
// value clients send as `Authorization: Bearer <key>`.
export const DEMO_API_KEY = 'rk_demo_0000000000000000000000000000';

/** sha256 hex of an API key — the only form ever stored (never the plaintext). */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export const PLATFORM_ACCOUNT_TYPES = [
  'customer_receivable',
  'provider_clearing',
  'merchant_payable',
  'platform_revenue',
  'payout_clearing',
] as const;

export interface SeedOptions {
  /** Register a demo webhook endpoint (compose seeds one pointed at the receiver). */
  webhookUrl?: string;
  webhookSecret?: string;
}

/** Idempotent: safe to run any number of times. */
export async function seed(client: ClientBase, options: SeedOptions = {}): Promise<void> {
  await client.query('INSERT INTO merchants (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [
    DEMO_MERCHANT_NAME,
  ]);
  for (const type of PLATFORM_ACCOUNT_TYPES) {
    await client.query(
      `INSERT INTO accounts (type, currency)
       SELECT $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE type = $1 AND currency = $2)`,
      [type, SEED_CURRENCY],
    );
  }
  // One demo API key per seeded merchant. Idempotent: keyed by the unique hash.
  await client.query(
    `INSERT INTO api_keys (merchant_id, key_hash, prefix)
     SELECT m.id, $1, $2 FROM merchants m
     WHERE m.name = $3
       AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash = $1)`,
    [hashApiKey(DEMO_API_KEY), DEMO_API_KEY.slice(0, 12), DEMO_MERCHANT_NAME],
  );
  if (options.webhookUrl !== undefined && options.webhookSecret !== undefined) {
    await client.query(
      `INSERT INTO webhook_endpoints (merchant_id, url, secret)
       SELECT m.id, $1, $2 FROM merchants m
       WHERE m.name = $3
         AND NOT EXISTS (SELECT 1 FROM webhook_endpoints w WHERE w.url = $1)`,
      [options.webhookUrl, options.webhookSecret, DEMO_MERCHANT_NAME],
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://reckon:reckon@localhost:5433/reckon',
  });
  await client.connect();
  try {
    const webhookUrl = process.env.SEED_WEBHOOK_URL;
    const webhookSecret = process.env.SEED_WEBHOOK_SECRET;
    await seed(
      client,
      webhookUrl !== undefined && webhookSecret !== undefined ? { webhookUrl, webhookSecret } : {},
    );
    console.log(
      `seeded: one merchant + platform account set${
        webhookUrl !== undefined ? ` + webhook endpoint -> ${webhookUrl}` : ''
      }`,
    );
    // The plaintext is shown exactly once, here. Authenticate with:
    //   Authorization: Bearer <key>   (or X-API-Key: <key>)
    console.log(`demo API key (send as 'Authorization: Bearer <key>'): ${DEMO_API_KEY}`);
  } finally {
    await client.end();
  }
}
