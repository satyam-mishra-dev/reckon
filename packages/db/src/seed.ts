import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import type { ClientBase } from 'pg';

export const DEMO_MERCHANT_NAME = 'demo-merchant';
export const SEED_CURRENCY = 'USD';

export const PLATFORM_ACCOUNT_TYPES = [
  'customer_receivable',
  'provider_clearing',
  'merchant_payable',
  'platform_revenue',
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
    connectionString: process.env.DATABASE_URL ?? 'postgres://tally:tally@localhost:5433/tally',
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
  } finally {
    await client.end();
  }
}
