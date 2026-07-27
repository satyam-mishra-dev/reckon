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

/** Idempotent: safe to run any number of times. */
export async function seed(client: ClientBase): Promise<void> {
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
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://tally:tally@localhost:5433/tally',
  });
  await client.connect();
  try {
    await seed(client);
    console.log('seeded: one merchant + platform account set');
  } finally {
    await client.end();
  }
}
