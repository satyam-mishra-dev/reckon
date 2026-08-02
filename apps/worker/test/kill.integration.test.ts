import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { enqueueJob } from '@reckon/core';

// THE KILL TEST (brief §4.10 day 4 gate): SIGKILL a REAL worker process
// mid-job, prove the job is stuck 'running' with a stale lease, then prove a
// second worker's sweeper returns it to 'pending' and completes it — with an
// observable side effect (an events row) written exactly once.

const workerDir = fileURLToPath(new URL('..', import.meta.url));

// Test clocks (defaults documented in src/config.ts): visibility 1s instead
// of 30s, heartbeat 250ms, sweep every 300ms — the whole death-and-recovery
// cycle fits in a few seconds.
const VISIBILITY_MS = 1000;
const workerEnv = (databaseUrl: string, workerId: string): NodeJS.ProcessEnv => ({
  ...process.env,
  DATABASE_URL: databaseUrl,
  WORKER_ID: workerId,
  TEST_JOBS: '1',
  VISIBILITY_MS: String(VISIBILITY_MS),
  HEARTBEAT_MS: '250',
  SWEEP_INTERVAL_MS: '300',
  POLL_MIN_MS: '50',
  POLL_MAX_MS: '200',
  OUTBOX_INTERVAL_MS: '60000', // irrelevant loops slowed to keep logs quiet
  COMPLETER_INTERVAL_MS: '60000',
  LOG_LEVEL: 'warn',
  PROVIDER_URL: 'http://127.0.0.1:9', // never called by test_sleep
});

let container: StartedPostgreSqlContainer;
let databaseUrl: string;
let client: Client;
const children: ChildProcess[] = [];

function startWorkerProcess(workerId: string): ChildProcess {
  // node --import tsx (NOT the tsx CLI): the CLI wraps the real worker in a
  // child process, so SIGKILLing the wrapper would orphan a still-heartbeating
  // worker instead of killing it. One process = the kill really kills.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: workerDir,
    env: workerEnv(databaseUrl, workerId),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(child);
  return child;
}

async function until<T>(
  what: string,
  deadlineMs: number,
  poll: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const result = await poll();
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

interface JobState {
  status: string;
  attempts: number;
  locked_by: string | null;
  lock_age_ms: number | null;
}

async function jobState(id: string): Promise<JobState> {
  const result = await client.query<JobState>(
    `SELECT status, attempts, locked_by,
            (EXTRACT(EPOCH FROM (now() - locked_at)) * 1000)::float8 AS lock_age_ms
     FROM jobs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`job ${id} not found`);
  return row;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  databaseUrl = container.getConnectionUri();
  await runner({
    databaseUrl,
    dir: fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await client?.end();
  await container?.stop();
});

describe('worker SIGKILL mid-job', () => {
  it('job stuck running with stale lock -> second worker sweeps it back to pending and completes it', async () => {
    const marker = `kill-test-${Date.now()}`;
    const jobId = await enqueueJob(client, 'test_sleep', { sleep_ms: 3000, marker });

    // Worker A claims the job and goes to sleep inside the handler.
    const workerA = startWorkerProcess('worker-a');
    await until('worker A to claim the job', 15_000, async () => {
      const state = await jobState(jobId);
      return state.status === 'running' && state.locked_by === 'worker-a' ? state : null;
    });

    // SIGKILL: no cleanup, no failure report — the lease just stops renewing.
    workerA.kill('SIGKILL');
    await new Promise<void>((resolve) => workerA.once('exit', () => resolve()));

    // The job is stranded: still 'running', owned by a dead process, and its
    // lock age grows past the visibility timeout with nobody to heartbeat it.
    const stale = await until('the lease to go stale', 10_000, async () => {
      const state = await jobState(jobId);
      return (state.lock_age_ms ?? 0) > VISIBILITY_MS ? state : null;
    });
    expect(stale.status).toBe('running');
    expect(stale.locked_by).toBe('worker-a');
    expect(stale.attempts).toBe(0);
    // And the side effect never happened — worker A died mid-sleep.
    const eventsBefore = await client.query(
      `SELECT 1 FROM events WHERE type = 'test.sleep_done' AND payload ->> 'marker' = $1`,
      [marker],
    );
    expect(eventsBefore.rows).toHaveLength(0);

    // Worker B's sweeper flips the expired lease back to pending (attempts++,
    // because a SIGKILLed worker never reports failure), then claims and
    // finishes the job.
    const workerB = startWorkerProcess('worker-b');
    const done = await until('worker B to complete the job', 20_000, async () => {
      const state = await jobState(jobId);
      return state.status === 'done' ? state : null;
    });
    expect(done.attempts).toBe(1); // exactly one sweep bump
    expect(done.locked_by).toBe('worker-b');

    // Observable side effect exactly once: worker A never got there, worker B
    // ran the handler to completion once.
    const eventsAfter = await client.query<{ worker_id: string }>(
      `SELECT payload ->> 'worker_id' AS worker_id
       FROM events WHERE type = 'test.sleep_done' AND payload ->> 'marker' = $1`,
      [marker],
    );
    expect(eventsAfter.rows).toEqual([{ worker_id: 'worker-b' }]);

    // Graceful shutdown for contrast: SIGTERM drains and exits 0.
    workerB.kill('SIGTERM');
    const exitCode = await new Promise<number | null>((resolve) =>
      workerB.once('exit', (code) => resolve(code)),
    );
    expect(exitCode).toBe(0);
  });
});
