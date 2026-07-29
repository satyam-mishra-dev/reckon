import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { claimJobs, failJob, heartbeatJobs, sweepExpired, type JobRow } from '@tally/core';
import type { WorkerConfig } from './config.js';
import {
  enqueueReconcileJob,
  enqueueStuckKeys,
  fanOutEvents,
  handleCompleteIntent,
  handleDeliverWebhook,
  handleReconcile,
  handleTestSleep,
  type HandlerContext,
} from './handlers.js';

// The worker process: one claim/execute poll loop plus three periodic loops
// (lease heartbeat, expired-lease sweeper, outbox fan-out + completer
// enqueuer). Claiming is one short statement; work happens outside any TX;
// liveness while working is the locked_at heartbeat (notes §2/§3).

export interface RunningWorker {
  /** Graceful stop: no new claims, in-flight jobs finish, then loops + pool shut down. */
  stop(): Promise<void>;
}

type Handler = (ctx: HandlerContext, job: JobRow) => Promise<void>;

export function startWorker(config: WorkerConfig, log: Logger): RunningWorker {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const ctx: HandlerContext = { pool, config, log };

  const handlers = new Map<string, Handler>([
    ['deliver_webhook', handleDeliverWebhook],
    ['complete_intent', handleCompleteIntent],
    ['reconcile', handleReconcile],
  ]);
  if (config.testJobs) handlers.set('test_sleep', handleTestSleep);
  const kinds = [...handlers.keys()];

  const inFlight = new Set<string>();
  let stopping = false;
  // Two abort scopes: pollAbort wakes the claim loop so it stops taking work;
  // loopAbort stays live until in-flight jobs drain, so heartbeats keep the
  // lease fresh for the whole graceful shutdown.
  const pollAbort = new AbortController();
  const loopAbort = new AbortController();

  async function idle(ms: number, signal: AbortSignal): Promise<void> {
    await sleep(ms, undefined, { signal }).catch(() => undefined);
  }

  async function runJob(job: JobRow): Promise<void> {
    const handler = handlers.get(job.kind);
    inFlight.add(job.id);
    try {
      if (handler === undefined) {
        // Unknown kind: nothing will ever handle it — dead-letter, don't loop.
        log.error({ jobId: job.id, kind: job.kind }, 'no handler for job kind, dead-lettering');
        await pool.query(`UPDATE jobs SET status = 'dead', locked_at = NULL WHERE id = $1`, [
          job.id,
        ]);
        return;
      }
      await handler(ctx, job);
    } catch (err) {
      // Handlers settle their own job on expected failures; this is the
      // crash-bar for unexpected throws.
      log.error({ err, jobId: job.id, kind: job.kind }, 'job handler threw, scheduling retry');
      await failJob(pool, job, config.workerId, {
        maxAttempts: config.maxAttempts,
        backoffBaseMs: config.backoffBaseMs,
        backoffCapMs: config.backoffCapMs,
        rand: config.rand,
      }).catch((failErr: unknown) => log.error({ err: failErr, jobId: job.id }, 'failJob failed'));
    } finally {
      inFlight.delete(job.id);
    }
  }

  async function pollLoop(): Promise<void> {
    let idleMs = config.pollMinMs;
    while (!stopping) {
      let jobs: JobRow[] = [];
      try {
        jobs = await claimJobs(pool, { kinds, workerId: config.workerId, batch: config.batchSize });
      } catch (err) {
        log.error({ err }, 'claim failed');
      }
      if (jobs.length === 0) {
        await idle(idleMs, pollAbort.signal);
        idleMs = Math.min(idleMs * 2, config.pollMaxMs); // adaptive idle backoff
        continue;
      }
      idleMs = config.pollMinMs;
      log.debug({ count: jobs.length }, 'claimed jobs');
      await Promise.all(jobs.map((job) => runJob(job)));
    }
  }

  async function heartbeatLoop(): Promise<void> {
    while (!loopAbort.signal.aborted) {
      await idle(config.heartbeatMs, loopAbort.signal);
      if (inFlight.size === 0) continue;
      try {
        const ids = [...inFlight];
        const kept = await heartbeatJobs(pool, ids, config.workerId);
        if (kept.length < ids.length) {
          log.warn(
            { lost: ids.filter((id) => !kept.includes(id)) },
            'lease lost on in-flight jobs (swept?) — heartbeat too slow vs visibility timeout',
          );
        }
      } catch (err) {
        log.error({ err }, 'heartbeat failed');
      }
    }
  }

  async function periodically(
    name: string,
    everyMs: number,
    fn: () => Promise<void>,
  ): Promise<void> {
    while (!loopAbort.signal.aborted) {
      await idle(everyMs, loopAbort.signal);
      if (loopAbort.signal.aborted) return;
      try {
        await fn();
      } catch (err) {
        log.error({ err }, `${name} loop iteration failed`);
      }
    }
  }

  const pollPromise = pollLoop();
  const loops = Promise.all([
    heartbeatLoop(),
    periodically('sweeper', config.sweepIntervalMs, async () => {
      const swept = await sweepExpired(pool, {
        visibilityMs: config.visibilityMs,
        maxAttempts: config.maxAttempts,
      });
      if (swept.length > 0) log.warn({ swept }, 'swept expired job leases');
    }),
    periodically('outbox', config.outboxIntervalMs, async () => {
      const dispatched = await fanOutEvents(pool, config.outboxBatch);
      if (dispatched > 0) log.info({ dispatched }, 'outbox events fanned out');
    }),
    periodically('completer-enqueuer', config.completerIntervalMs, async () => {
      const enqueued = await enqueueStuckKeys(pool, config);
      if (enqueued > 0) log.warn({ enqueued }, 'enqueued completion jobs for stuck keys');
    }),
    periodically('reconcile-enqueuer', config.reconcileIntervalMs, async () => {
      if (await enqueueReconcileJob(pool)) log.info('reconcile job enqueued');
    }),
  ]);

  log.info({ workerId: config.workerId, kinds }, 'worker started');

  return {
    async stop(): Promise<void> {
      log.info('worker stopping: draining in-flight jobs');
      stopping = true;
      pollAbort.abort(); // wake the poll loop; it exits after in-flight jobs finish
      // Heartbeat/sweep/outbox loops keep running until the drain completes,
      // so long jobs stay leased through a graceful shutdown.
      await pollPromise;
      loopAbort.abort();
      await loops;
      await pool.end();
      log.info('worker stopped');
    },
  };
}
