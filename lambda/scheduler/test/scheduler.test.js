import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Valkey from 'iovalkey';
import { createRegistry } from '../../shared/valkey/registry.js';
import { CONSUMER_GROUP, environmentQueueKey } from '../../shared/valkey/keys.js';
import { createScheduler } from '../index.js';

// The registry here is the REAL one against the REAL Valkey container. Only the
// provisioner is stubbed, because CreateFleet is the only part that cannot run in
// a test. That keeps the interesting behaviour — what actually lands on which
// stream, and in what order — genuinely exercised.
const host = process.env.VALKEY_HOST;
const port = Number(process.env.VALKEY_PORT || 6379);

let client;
let suffix = 0;
const nextEnv = () => `test-sched-${process.pid}-${++suffix}`;

const ec2Target = (environmentId, overrides = {}) => ({
  kind: 'EC2',
  environmentId,
  revisionId: 'r-1',
  launchTemplateId: 'lt-1',
  launchTemplateVersion: '3',
  launchSpec: {
    strategyId: 'per-stage-ephemeral',
    maxInstances: 2,
    maxConcurrentPlacements: 2,
    maxLifetimeSeconds: 3600,
    bootstrapTimeoutSeconds: 600,
    instanceTypes: ['c7i.2xlarge'],
    ...overrides,
  },
});

const stubProvisioners = ({ ec2Fails = null } = {}) => {
  const ec2 = {
    kind: 'EC2',
    provision: vi.fn(async ({ workerId }) => {
      if (ec2Fails) throw Object.assign(new Error('no capacity'), { code: ec2Fails });
      return { workerId, instanceId: `i-${workerId.slice(-8)}`, fleetId: 'fleet-1' };
    }),
    terminate: vi.fn(async () => ({ terminated: true })),
  };
  return { EC2: ec2, ec2Stub: ec2 };
};

const stageRequest = (target, overrides = {}) => ({
  executionId: 'x-1',
  stageId: 'construction-code',
  stageInstanceId: 's-1',
  attempt: 1,
  target,
  stageCallbackId: 'cb-1',
  payload: { command: 'run-stage-start' },
  ...overrides,
});

describe.skipIf(!host)('scheduler', () => {
  let registry;

  beforeAll(() => {
    client = new Valkey({ host, port, maxRetriesPerRequest: 2 });
    registry = createRegistry({ client });
  });

  afterAll(async () => {
    await client?.quit();
  });

  afterEach(async () => {
    const keys = await client.keys('*test-sched-*');
    if (keys.length > 0) await client.del(...keys);
  });

  const schedulerWith = (provisioners, extra = {}) =>
    createScheduler({ registry, provisioners, subnetIds: ['subnet-a'], ...extra });

  describe('enqueue-stage', () => {
    it('provisions a worker and puts the job on the environment queue', async () => {
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners);

      const result = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));

      expect(result).toMatchObject({ ok: true, action: 'provision' });
      expect(provisioners.ec2Stub.provision).toHaveBeenCalledTimes(1);

      // The job is claimable from the shared queue by any worker of this env.
      const delivered = await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        'w1',
        'COUNT',
        10,
        'STREAMS',
        environmentQueueKey(environmentId),
        '>',
      );
      expect(delivered[0][1]).toHaveLength(1);
      expect(delivered[0][1][0][1]).toEqual(['jobId', result.jobId]);
    });

    it('registers the worker under its instance id, not the provisional id', async () => {
      // The runner learns its own instance id from IMDS, so that must be the
      // registry key or it cannot find its own addressed stream.
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners());
      const result = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));

      expect(result.workerId).toMatch(/^i-/);
      const worker = await registry.getWorker(result.workerId);
      expect(worker).toMatchObject({
        kind: 'EC2',
        environmentId,
        state: 'PROVISIONING',
        executionId: 'x-1',
        instanceId: result.workerId,
      });
    });

    it('records the job with its callback id and payload', async () => {
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners());
      const result = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));

      const job = await registry.getJob(result.jobId);
      expect(job).toMatchObject({ stageCallbackId: 'cb-1', executionId: 'x-1', state: 'PENDING' });
      expect(job.payload).toEqual({ command: 'run-stage-start' });
    });

    it('enqueues before provisioning, so a fast worker never finds an empty queue', async () => {
      const environmentId = nextEnv();
      const order = [];
      const provisioners = stubProvisioners();
      provisioners.EC2.provision = vi.fn(async ({ workerId }) => {
        // By the time provision runs, the job must already be claimable.
        const pending = await client.xlen(environmentQueueKey(environmentId));
        order.push(`provision:queue=${pending}`);
        return { workerId, instanceId: 'i-fast', fleetId: null };
      });
      await schedulerWith(provisioners).enqueueStage(stageRequest(ec2Target(environmentId)));
      expect(order).toEqual(['provision:queue=1']);
    });

    it('reports a capacity refusal as a value, not an exception', async () => {
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners());
      const target = ec2Target(environmentId, { maxInstances: 1, maxConcurrentPlacements: 1 });

      await scheduler.enqueueStage(stageRequest(target));
      const second = await scheduler.enqueueStage(stageRequest(target, { stageInstanceId: 's-2' }));

      expect(second).toMatchObject({ ok: false, action: 'queue', reason: 'max_instances_reached' });
    });

    it('marks the job failed and reports the provisioner code when capacity is gone', async () => {
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners({ ec2Fails: 'PROVISION_NO_CAPACITY' }));

      const result = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));

      expect(result).toMatchObject({ ok: false, reason: 'PROVISION_NO_CAPACITY' });
      const job = await registry.getJob(result.jobId ?? `job-x-1-s-1-1`);
      expect(job).toMatchObject({ state: 'FAILED', failureReason: 'PROVISION_NO_CAPACITY' });
    });

    it('refuses a target it does not own instead of inventing a worker for it', async () => {
      // The scheduler manages a fleet WE pay for. An AgentCore session is not part
      // of it — the orchestrator invokes the runtime directly — so a non-EC2 target
      // here is a routing bug. Handling it quietly is how a row nobody leases and
      // nobody reaps got into the registry.
      const environmentId = nextEnv();
      await expect(
        schedulerWith(stubProvisioners()).enqueueStage(
          stageRequest({ kind: 'AGENTCORE', environmentId, revisionId: 'r-1' }),
        ),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_TARGET_KIND' });
      expect(await client.xlen(environmentQueueKey(environmentId))).toBe(0);
      expect(await registry.listWorkers(environmentId)).toEqual([]);
    });

    it('refuses a request with no resolved target', async () => {
      await expect(
        schedulerWith(stubProvisioners()).enqueueStage({ executionId: 'x-1' }),
      ).rejects.toMatchObject({ code: 'TARGET_REQUIRED' });
    });

    describe('resume after a park', () => {
      it('addresses the held worker directly instead of the shared queue', async () => {
        const environmentId = nextEnv();
        const scheduler = schedulerWith(stubProvisioners());
        const first = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));
        const workerId = first.workerId;
        await registry.markIdle(await registry.getWorker(workerId));

        const resumed = await scheduler.enqueueStage(
          stageRequest(ec2Target(environmentId), {
            stageInstanceId: 's-1',
            attempt: 2,
            resumeWorkerId: workerId,
          }),
        );

        expect(resumed).toMatchObject({ ok: true, action: 'reuse', workerId });
        const entries = await client.xrange(`{w:${workerId}}:stream`, '-', '+');
        expect(entries.at(-1)[1]).toEqual(['type', 'job', 'jobId', resumed.jobId, 'reason', '']);
        // …and the worker is busy again, so nothing else will be placed on it.
        expect((await registry.getWorker(workerId)).state).toBe('BUSY');
      });

      it('provisions fresh when the held worker is gone', async () => {
        const environmentId = nextEnv();
        const scheduler = schedulerWith(stubProvisioners());
        const resumed = await scheduler.enqueueStage(
          stageRequest(ec2Target(environmentId), { resumeWorkerId: 'i-vanished', attempt: 2 }),
        );
        expect(resumed).toMatchObject({ ok: true, action: 'provision' });
      });
    });
  });

  describe('dispatch', () => {
    it('addresses a live worker', async () => {
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners());
      const { workerId } = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));

      expect(await scheduler.dispatch({ workerId, type: 'cancel', reason: 'user' })).toMatchObject({
        ok: true,
        type: 'cancel',
      });
      const entries = await client.xrange(`{w:${workerId}}:stream`, '-', '+');
      expect(entries.at(-1)[1]).toEqual(['type', 'cancel', 'jobId', '', 'reason', 'user']);
    });

    it('reports a missing worker rather than writing to a dead stream', async () => {
      expect(
        await schedulerWith(stubProvisioners()).dispatch({ workerId: 'i-gone', type: 'cancel' }),
      ).toMatchObject({ ok: false, reason: 'worker_not_found' });
    });
  });

  describe('release', () => {
    it('terminates the worker and clears its registry rows', async () => {
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners);
      const { workerId } = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));

      expect(await scheduler.releaseWorker({ workerId })).toMatchObject({
        ok: true,
        released: true,
        terminated: true,
      });
      expect(provisioners.ec2Stub.terminate).toHaveBeenCalledTimes(1);
      expect(await registry.getWorker(workerId)).toBeNull();
    });

    it('is idempotent for a worker that is already gone', async () => {
      expect(
        await schedulerWith(stubProvisioners()).releaseWorker({ workerId: 'i-gone' }),
      ).toMatchObject({ ok: true, released: false, reason: 'worker_not_found' });
    });

    it('releases every worker of one execution and leaves others alone', async () => {
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners());
      await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));
      await scheduler.enqueueStage(
        stageRequest(ec2Target(environmentId), {
          executionId: 'x-2',
          stageInstanceId: 's-9',
        }),
      );

      const result = await scheduler.releaseExecution({
        executionId: 'x-1',
        environmentIds: [environmentId],
      });

      expect(result.released).toBe(1);
      const left = await registry.listWorkers(environmentId);
      expect(left).toHaveLength(1);
      expect(left[0].executionId).toBe('x-2');
    });
  });

  describe('reconcile', () => {
    const noInstances = async () => ({ Reservations: [] });

    it('abandons a job whose lease expired, and acks it so it is not redelivered', async () => {
      // Redelivering would risk two workers completing one durable callback.
      // leaseIdleMs 0 means "anything pending", which is what a dead holder looks
      // like once the real window has elapsed — without making the test wait it out.
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners(), {
        describeInstances: noInstances,
        leaseIdleMs: 0,
      });
      const { jobId } = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));
      await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        'w1',
        'COUNT',
        10,
        'STREAMS',
        environmentQueueKey(environmentId),
        '>',
      );

      const first = await scheduler.reconcile({ environmentIds: [environmentId] });
      expect(first.abandoned).toContain(jobId);
      expect((await registry.getJob(jobId)).state).toBe('ABANDONED');

      // A second sweep must find nothing: the entry was acked.
      const second = await scheduler.reconcile({ environmentIds: [environmentId] });
      expect(second.abandoned).toEqual([]);
    });

    it('leaves a freshly claimed job alone inside the lease window', async () => {
      // The inverse of the case above, and the one that matters in production: a
      // worker that claimed a job seconds ago is alive, and abandoning its job
      // would open a second attempt against a stage that is still running.
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners(), {
        describeInstances: noInstances,
        leaseIdleMs: 5 * 60 * 1000,
      });
      const { jobId } = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));
      await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        'w1',
        'COUNT',
        10,
        'STREAMS',
        environmentQueueKey(environmentId),
        '>',
      );

      const result = await scheduler.reconcile({ environmentIds: [environmentId] });

      expect(result.abandoned).toEqual([]);
      expect((await registry.getJob(jobId)).state).toBe('PENDING');
    });

    it('releases a worker that launched but never registered', async () => {
      const environmentId = nextEnv();
      let now = 1_000_000;
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners, {
        describeInstances: noInstances,
        clock: () => now,
      });
      const target = ec2Target(environmentId, { bootstrapTimeoutSeconds: 60 });
      const { workerId } = await scheduler.enqueueStage(stageRequest(target));

      now += 61_000;
      const result = await scheduler.reconcile({ environmentIds: [environmentId] });

      expect(result.timedOut).toEqual([workerId]);
      expect(await registry.getWorker(workerId)).toBeNull();
    });

    it('leaves a still-booting worker alone inside its bootstrap window', async () => {
      const environmentId = nextEnv();
      let now = 1_000_000;
      const scheduler = schedulerWith(stubProvisioners(), {
        describeInstances: noInstances,
        clock: () => now,
      });
      const { workerId } = await scheduler.enqueueStage(
        stageRequest(ec2Target(environmentId, { bootstrapTimeoutSeconds: 600 })),
      );

      now += 60_000;
      const result = await scheduler.reconcile({ environmentIds: [environmentId] });

      expect(result.timedOut).toEqual([]);
      expect(await registry.getWorker(workerId)).not.toBeNull();
    });

    it('releases a worker past its lifetime cap', async () => {
      const environmentId = nextEnv();
      let now = 1_000_000;
      const scheduler = schedulerWith(stubProvisioners(), {
        describeInstances: noInstances,
        clock: () => now,
      });
      const { workerId } = await scheduler.enqueueStage(
        stageRequest(ec2Target(environmentId, { maxLifetimeSeconds: 100 })),
      );
      // Register it so the bootstrap check does not claim it first.
      await registry.markIdle(await registry.getWorker(workerId));

      now += 101_000;
      const result = await scheduler.reconcile({ environmentIds: [environmentId] });

      expect(result.expired).toEqual([workerId]);
    });

    it('terminates a tagged instance the registry has never heard of', async () => {
      // This is the check that makes Valkey disposable: EC2 is the authority on
      // what exists, so a lost registry cannot leak instances forever.
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners, {
        clock: () => 10_000_000,
        describeInstances: async () => ({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-orphan',
                  LaunchTime: new Date(1_000_000),
                  Tags: [{ Key: 'aidlc:environmentId', Value: environmentId }],
                },
              ],
            },
          ],
        }),
      });

      const result = await scheduler.reconcile({ environmentIds: [environmentId] });

      expect(result.orphans).toEqual(['i-orphan']);
      expect(provisioners.ec2Stub.terminate).toHaveBeenCalledWith(
        expect.objectContaining({ worker: expect.objectContaining({ instanceId: 'i-orphan' }) }),
      );
    });

    it('never terminates an instance belonging to an environment it did not sweep', async () => {
      // The terminate-everything bug this closes: `known` is built by listing the
      // SWEPT environments' workers, so a caller scoping the sweep narrowly (or, as
      // the EventBridge rule did, to nothing at all) made every live instance in
      // every other environment look unowned. An instance is only judged against
      // the environments actually examined.
      const environmentId = nextEnv();
      const otherEnvironmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners, {
        clock: () => 10_000_000,
        describeInstances: async () => ({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-elsewhere',
                  LaunchTime: new Date(1_000_000),
                  Tags: [{ Key: 'aidlc:environmentId', Value: otherEnvironmentId }],
                },
                { InstanceId: 'i-untagged', LaunchTime: new Date(1_000_000) },
              ],
            },
          ],
        }),
      });

      const result = await scheduler.reconcile({ environmentIds: [environmentId] });

      expect(result.orphans).toEqual([]);
      expect(provisioners.ec2Stub.terminate).not.toHaveBeenCalled();
    });

    it('discovers the environments to sweep when the caller names none', async () => {
      // The bug the schedule actually had: EventBridge sends a static
      // `{"action":"reconcile"}`, `environmentIds` defaulted to `[]`, and the whole
      // per-environment sweep — abandoned leases, bootstrap timeout, idle reap,
      // lifetime cap — iterated nothing. It ran every five minutes and never once
      // reaped anything, which is why finished instances kept billing until an
      // operator noticed them.
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      let now = 5_000_000;
      const scheduler = schedulerWith(provisioners, {
        describeInstances: noInstances,
        clock: () => now,
      });
      const { workerId } = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));
      await registry.markIdle(await registry.getWorker(workerId));
      // `markIdle` stamps `idleSinceMs` from the REGISTRY's clock, which is real
      // time here, while the sweep judges against the scheduler's injected one. Left
      // alone the two timelines are ~1.8e12 ms apart and `idleForMs` comes out
      // hugely negative, so the reap never fires and the test passes for the wrong
      // reason. Restate the stamp on the scheduler's timeline.
      await registry.setWorkerState(workerId, 'IDLE', { currentJobId: '', idleSinceMs: now });

      now += 10 * 60 * 1000;
      // NO environmentIds — exactly the event the rule delivers.
      const result = await scheduler.reconcile({});

      expect(result.environmentIds).toContain(environmentId);
      expect(result.idle).toContain(workerId);
    });

    it('discovers an environment from a running instance whose worker row has expired', async () => {
      // The lease outlives nothing: a worker row expires after WORKER_LEASE_SECONDS,
      // so an instance whose runner died is invisible to the registry. Its
      // `aidlc:environmentId` tag is then the ONLY way the sweep learns the
      // environment exists — and without that it would never look, which is how a
      // dead-runner instance ran until its lifetime cap (or forever, when unset).
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners, {
        clock: () => 10_000_000,
        describeInstances: async () => ({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-rowless',
                  LaunchTime: new Date(1_000_000),
                  Tags: [{ Key: 'aidlc:environmentId', Value: environmentId }],
                },
              ],
            },
          ],
        }),
      });

      const result = await scheduler.reconcile({});

      expect(result.environmentIds).toContain(environmentId);
      expect(result.orphans).toEqual(['i-rowless']);
    });

    it('drops a queued entry whose execution no longer exists', async () => {
      // The liveness bug, not tidiness. XREADGROUP '>' hands out the OLDEST
      // undelivered entry and per-stage-ephemeral allows one job per worker, so a
      // single dead entry at the head of the queue eats the whole allotment of the
      // next worker to boot — it runs the corpse, goes idle, stops claiming, and the
      // job the orchestrator is waiting on is never claimed at all. Seen with five
      // dead entries queued ahead of one live job; the stage hung to its heartbeat.
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners, {
        describeInstances: noInstances,
        // The execution is ABSENT — what a deleted intent looks like, and the state
        // the five real corpses were in. Distinct from an unreadable table below.
        readExecution: async () => null,
      });
      await scheduler.enqueueStage(
        stageRequest(ec2Target(environmentId), { executionId: 'gone-1', stageInstanceId: 's-dead' }),
      );

      const before = await registry.listQueued(environmentId);
      expect(before.map((e) => e.jobId)).toContain('job-gone-1-s-dead-1');

      // The execution is absent from the table, which is what a deleted intent looks
      // like — and is exactly the state the five real corpses were in.
      const dropped = await scheduler.sweepQueue({ environmentId });

      expect(dropped).toContain('job-gone-1-s-dead-1');
      expect((await registry.listQueued(environmentId)).map((e) => e.jobId)).not.toContain(
        'job-gone-1-s-dead-1',
      );
    });

    it('leaves a queued entry alone when the execution cannot be read', async () => {
      // A read failure is not evidence of a dead execution. Dropping a live job
      // strands its stage exactly as badly as keeping a dead one, so the sweep must
      // fail CLOSED — keep the entry.
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners, {
        describeInstances: noInstances,
        readExecution: async () => {
          throw new Error('ProvisionedThroughputExceededException');
        },
      });
      await scheduler.enqueueStage(
        stageRequest(ec2Target(environmentId), { executionId: 'live-1', stageInstanceId: 's-live' }),
      );

      const dropped = await scheduler.sweepQueue({ environmentId });

      expect(dropped).toEqual([]);
      expect((await registry.listQueued(environmentId)).map((e) => e.jobId)).toContain(
        'job-live-1-s-live-1',
      );
    });

    it('spares a young instance that may simply not have registered yet', async () => {
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners, {
        clock: () => 1_060_000,
        describeInstances: async () => ({
          Reservations: [
            { Instances: [{ InstanceId: 'i-young', LaunchTime: new Date(1_000_000) }] },
          ],
        }),
      });

      const result = await scheduler.reconcile({ environmentIds: [environmentId] });

      expect(result.orphans).toEqual([]);
      expect(provisioners.ec2Stub.terminate).not.toHaveBeenCalled();
    });

    it('spares an instance the registry does know about', async () => {
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners, { clock: () => 10_000_000 });
      const { workerId } = await scheduler.enqueueStage(stageRequest(ec2Target(environmentId)));
      const known = createScheduler({
        registry,
        provisioners,
        subnetIds: ['subnet-a'],
        clock: () => 10_000_000,
        describeInstances: async () => ({
          Reservations: [{ Instances: [{ InstanceId: workerId, LaunchTime: new Date(1_000) }] }],
        }),
      });

      expect((await known.reconcile({ environmentIds: [environmentId] })).orphans).toEqual([]);
    });
  });
});
