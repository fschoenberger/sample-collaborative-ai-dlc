import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Valkey from 'iovalkey';
import { createRegistry } from '../../shared/valkey/registry.js';
import { CONSUMER_GROUP, environmentQueueKey } from '../../shared/valkey/keys.js';
import { createScheduler } from '../index.js';

// The registry here is the REAL one against the REAL Valkey container. Only the
// provisioners are stubbed, because CreateFleet and InvokeAgentRuntime are the
// only parts that cannot run in a test. That keeps the interesting behaviour —
// what actually lands on which stream, and in what order — genuinely exercised.
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

const agentcoreTarget = (environmentId) => ({
  kind: 'AGENTCORE',
  environmentId,
  revisionId: 'r-1',
  agentRuntimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:1:runtime/std',
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
  const agentcore = {
    kind: 'AGENTCORE',
    provision: vi.fn(async ({ workerId }) => ({
      workerId,
      sessionId: workerId,
      instanceId: null,
      fleetId: null,
    })),
    terminate: vi.fn(async () => ({ terminated: true })),
  };
  return { EC2: ec2, AGENTCORE: agentcore, ec2Stub: ec2, agentcoreStub: agentcore };
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

    it('wakes an AgentCore session using the session id as the worker id', async () => {
      const environmentId = nextEnv();
      const provisioners = stubProvisioners();
      const scheduler = schedulerWith(provisioners);
      const sessionId = 'aidlc-intent-abc0000000000000000000';

      const result = await scheduler.enqueueStage(
        stageRequest(agentcoreTarget(environmentId), { sessionId }),
      );

      expect(result).toMatchObject({ ok: true, workerId: sessionId });
      expect(provisioners.agentcoreStub.provision).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: sessionId }),
      );
      expect((await registry.getWorker(sessionId)).kind).toBe('AGENTCORE');
    });

    it('refuses an AgentCore placement with no session id', async () => {
      // Affinity is the whole reason the checkout survives between stages, so a
      // missing session id is a bug to surface, never a value to invent.
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners());
      await expect(
        scheduler.enqueueStage(stageRequest(agentcoreTarget(environmentId))),
      ).rejects.toMatchObject({ code: 'SESSION_ID_REQUIRED' });
    });

    it('never refuses an AgentCore placement for capacity', async () => {
      // AgentCore bounds its own concurrency; adding ours would only be a second,
      // worse limit.
      const environmentId = nextEnv();
      const scheduler = schedulerWith(stubProvisioners());
      for (const n of [1, 2, 3]) {
        const result = await scheduler.enqueueStage(
          stageRequest(agentcoreTarget(environmentId), {
            sessionId: `aidlc-intent-session${n}000000000000000`,
            stageInstanceId: `s-${n}`,
          }),
        );
        expect(result.ok).toBe(true);
      }
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
            { Instances: [{ InstanceId: 'i-orphan', LaunchTime: new Date(1_000_000) }] },
          ],
        }),
      });

      const result = await scheduler.reconcile({ environmentIds: [environmentId] });

      expect(result.orphans).toEqual(['i-orphan']);
      expect(provisioners.ec2Stub.terminate).toHaveBeenCalledWith(
        expect.objectContaining({ worker: expect.objectContaining({ instanceId: 'i-orphan' }) }),
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
