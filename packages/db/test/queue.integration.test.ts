import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  heartbeatJobs,
  sweepExpired,
  type JobRow,
} from '@reckon/core';

// The hand-rolled queue against real Postgres — claim atomicity, retry
// scheduling, lease heartbeat, and the visibility-timeout sweeper.

let container: StartedPostgreSqlContainer;
let databaseUrl: string;
let client: Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  databaseUrl = container.getConnectionUri();
  await runner({
    databaseUrl,
    dir: fileURLToPath(new URL('../migrations', import.meta.url)),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

beforeEach(async () => {
  await client.query('DELETE FROM jobs');
});

async function job(id: string): Promise<JobRow> {
  const result = await client.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`job ${id} not found`);
  return row;
}

describe('claimJobs', () => {
  it('8 concurrent claimers over 200 jobs get disjoint sets covering everything', async () => {
    for (let i = 0; i < 200; i++) await enqueueJob(client, 'race', { i });

    const claimers = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const c = new Client({ connectionString: databaseUrl });
        await c.connect();
        return { c, workerId: `claimer-${i}` };
      }),
    );
    try {
      const claimedBy = await Promise.all(
        claimers.map(async ({ c, workerId }) => {
          const mine: string[] = [];
          // Claimed jobs stay 'running' (never completed), so every claim is
          // final: drain until a poll comes back empty.
          for (;;) {
            const batch = await claimJobs(c, { kinds: ['race'], workerId, batch: 7 });
            if (batch.length === 0) break;
            for (const j of batch) {
              expect(j.status).toBe('running');
              expect(j.locked_by).toBe(workerId);
              mine.push(j.id);
            }
          }
          return mine;
        }),
      );

      const all = claimedBy.flat();
      expect(all.length).toBe(200); // nothing double-claimed…
      expect(new Set(all).size).toBe(200); // …and nothing missed
    } finally {
      await Promise.all(claimers.map(({ c }) => c.end()));
    }
  });

  it('does not claim future-scheduled or non-pending jobs', async () => {
    await enqueueJob(client, 'later', {}, new Date(Date.now() + 60_000));
    const claimed = await claimJobs(client, { kinds: ['later'], workerId: 'w', batch: 10 });
    expect(claimed).toHaveLength(0);
  });
});

describe('completeJob / failJob', () => {
  it('complete marks done; a non-owner cannot complete', async () => {
    const id = await enqueueJob(client, 'k', {});
    await claimJobs(client, { kinds: ['k'], workerId: 'owner', batch: 1 });

    expect(await completeJob(client, id, 'impostor')).toBe(false);
    expect((await job(id)).status).toBe('running');

    expect(await completeJob(client, id, 'owner')).toBe(true);
    expect((await job(id)).status).toBe('done');
  });

  it('fail schedules an exponential retry, then dead-letters at maxAttempts', async () => {
    const id = await enqueueJob(client, 'k', {});
    const retry = { maxAttempts: 3, backoffBaseMs: 50, backoffCapMs: 10_000, rand: () => 0.5 };

    let lastDelay = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await client.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [id]); // make due again
      const [claimed] = await claimJobs(client, { kinds: ['k'], workerId: 'w', batch: 1 });
      expect(claimed?.id).toBe(id);
      const before = Date.now();
      const failed = await failJob(client, claimed as JobRow, 'w', retry);
      expect(failed?.attempts).toBe(attempt);
      if (attempt < 3) {
        expect(failed?.status).toBe('pending');
        const delay = (failed?.runAt?.getTime() ?? 0) - before;
        expect(delay).toBeGreaterThan(lastDelay); // 75ms, then 150ms (rand pinned at 0.5)
        lastDelay = delay;
      } else {
        expect(failed?.status).toBe('dead');
        expect(failed?.runAt).toBeNull();
      }
    }
    expect((await job(id)).status).toBe('dead');
  });
});

describe('heartbeatJobs', () => {
  it('extends locked_at for the owner only', async () => {
    const id = await enqueueJob(client, 'k', {});
    await claimJobs(client, { kinds: ['k'], workerId: 'owner', batch: 1 });
    const lockedAt = (await job(id)).locked_at?.getTime() ?? 0;

    await sleep(30);
    expect(await heartbeatJobs(client, [id], 'impostor')).toEqual([]);
    expect(await heartbeatJobs(client, [id], 'owner')).toEqual([id]);
    expect((await job(id)).locked_at?.getTime() ?? 0).toBeGreaterThan(lockedAt);
  });
});

describe('sweepExpired', () => {
  it('returns expired-lease jobs to pending with attempts++, leaves fresh leases alone', async () => {
    const stale = await enqueueJob(client, 'k', {});
    const fresh = await enqueueJob(client, 'k', {});
    await claimJobs(client, { kinds: ['k'], workerId: 'doomed', batch: 2 });
    // Backdate one lease past the visibility timeout (a SIGKILLed worker
    // stops heartbeating, so locked_at just ages in place).
    await client.query(`UPDATE jobs SET locked_at = now() - interval '10 seconds' WHERE id = $1`, [
      stale,
    ]);

    const swept = await sweepExpired(client, { visibilityMs: 5000, maxAttempts: 10 });
    expect(swept.map((s) => s.id)).toEqual([stale]);
    expect(swept[0]).toMatchObject({ status: 'pending', attempts: 1 });

    const staleRow = await job(stale);
    expect(staleRow.status).toBe('pending');
    expect(staleRow.locked_at).toBeNull();
    expect((await job(fresh)).status).toBe('running');
  });

  it('dead-letters a job that keeps dying instead of sweeping it forever', async () => {
    const id = await enqueueJob(client, 'k', {});
    await claimJobs(client, { kinds: ['k'], workerId: 'doomed', batch: 1 });
    await client.query(
      `UPDATE jobs SET locked_at = now() - interval '10 seconds', attempts = 9 WHERE id = $1`,
      [id],
    );

    const swept = await sweepExpired(client, { visibilityMs: 5000, maxAttempts: 10 });
    expect(swept[0]).toMatchObject({ id, status: 'dead', attempts: 10 });
  });
});
