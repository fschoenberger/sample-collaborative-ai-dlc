import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Valkey from 'iovalkey';

import { createRegistry } from '../../shared/valkey/registry.js';
import { createBusyTracker } from '../http-server.js';
import { createWorker } from '../worker.js';

// Real registry against the real Valkey container, because what is being tested is
// the worker's effect on registry STATE — and that state is what the reconciler acts
// on. A stubbed registry would have happily agreed with the bug.
const host = process.env.VALKEY_HOST;
const port = Number(process.env.VALKEY_PORT || 6379);

let client;
let suffix = 0;
const nextEnv = () => `test-worker-${process.pid}-${++suffix}`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe.skipIf(!host)('worker', () => {
  let registry;

  beforeAll(() => {
    client = new Valkey({ host, port, maxRetriesPerRequest: 2 });
    registry = createRegistry({ client });
  });

  afterAll(async () => {
    await client?.quit();
  });

  afterEach(async () => {
    const keys = await client.keys('*test-worker-*');
    if (keys.length > 0) await client.del(...keys);
  });

  const enqueue = async ({ environmentId, jobId }) => {
    await registry.ensureGroup(environmentId);
    await registry.putJob({
      jobId,
      executionId: 'x-1',
      stageInstanceId: 's-1',
      stageId: 'reverse-engineering',
      environmentId,
      stageCallbackId: 'cb-1',
      attempt: 1,
      payload: { command: 'run-stage-start' },
    });
    await registry.enqueueJob({ environmentId, jobId });
  };

  const startWorker = async ({ environmentId, workerId, busy, dispatchInvocation }) => {
    await registry.putWorker({
      workerId,
      kind: 'EC2',
      environmentId,
      state: 'PROVISIONING',
      instanceId: workerId,
      createdAtMs: Date.now(),
      maxLifetimeSeconds: 0,
      bootstrapTimeoutSeconds: 0,
    });
    const worker = createWorker({
      workerId,
      environmentId,
      client,
      addressedClient: new Valkey({ host, port, maxRetriesPerRequest: 2 }),
      dispatchInvocation,
      handlers: {},
      busy,
      blockMs: 50,
      heartbeatMs: 60_000,
      busyPollMs: 10,
      logger: { error: () => {}, log: () => {} },
    });
    return worker;
  };

  it('stays BUSY while a detached stage job is still running', async () => {
    // The bug this closes killed a live run. `run-stage-start` accepts a stage and
    // returns `{ accepted: true }` in milliseconds while the stage runs on as a
    // background job holding the busy tracker. The worker marked its row IDLE when
    // that ACCEPT returned, so the registry advertised a free worker while a build
    // was running on it — and the reconciler's idle reap then terminated the
    // instance mid-stage, SIGTERMing the CLI into `cli_nonzero_exit: 143` five
    // minutes in, after three artifacts had already been produced.
    const environmentId = nextEnv();
    const workerId = `i-${environmentId}`;
    const busy = createBusyTracker();
    let releaseStage;
    const stageFinished = new Promise((resolve) => {
      releaseStage = resolve;
    });

    const dispatchInvocation = vi.fn(async () => {
      // Exactly what run-stage-start does: take the tracker, detach, answer accept.
      busy.enter();
      stageFinished.then(() => busy.leave());
      return { statusCode: 200, body: { accepted: true } };
    });

    await enqueue({ environmentId, jobId: 'job-detached-1' });
    const worker = await startWorker({ environmentId, workerId, busy, dispatchInvocation });
    const run = worker.start();

    // Give it time to claim, dispatch, and get the accept back.
    for (let i = 0; i < 40 && !dispatchInvocation.mock.calls.length; i += 1) await settle();
    expect(dispatchInvocation).toHaveBeenCalledTimes(1);

    // The accept has returned. The stage has NOT finished. The row must not say IDLE,
    // because that is the exact state the idle reap collects.
    await settle();
    const during = await registry.getWorker(workerId);
    expect(during.state).toBe('BUSY');
    expect(during.currentJobId).toBe('job-detached-1');

    releaseStage();
    for (let i = 0; i < 60; i += 1) {
      const row = await registry.getWorker(workerId);
      if (row?.state === 'IDLE') break;
      await settle();
    }
    const after = await registry.getWorker(workerId);
    expect(after.state).toBe('IDLE');

    await worker.stop();
    await run;
  });

  it('does not spend its job allotment on an entry whose job is not pending', async () => {
    // XREADGROUP '>' hands out the OLDEST undelivered entry and per-stage-ephemeral
    // allows one job per worker, so a single stale entry at the head of the queue
    // used to consume the whole allotment: the worker ran the corpse, went idle,
    // stopped claiming, and the live job behind it was never picked up.
    const environmentId = nextEnv();
    const workerId = `i-${environmentId}`;
    const busy = createBusyTracker();

    await enqueue({ environmentId, jobId: 'job-stale-1' });
    await registry.setJobState('job-stale-1', 'DONE');
    await enqueue({ environmentId, jobId: 'job-live-1' });

    const seen = [];
    const dispatchInvocation = vi.fn(async (args) => {
      seen.push(args.payload);
      return { statusCode: 200, body: { ok: true } };
    });

    const worker = await startWorker({ environmentId, workerId, busy, dispatchInvocation });
    const run = worker.start();

    for (let i = 0; i < 60 && seen.length === 0; i += 1) await settle();

    // It reached the LIVE job despite the corpse in front of it.
    expect(dispatchInvocation).toHaveBeenCalledTimes(1);
    const ranJob = await registry.getJob('job-live-1');
    expect(ranJob.state).toBe('DONE');

    await worker.stop();
    await run;
  });
});
