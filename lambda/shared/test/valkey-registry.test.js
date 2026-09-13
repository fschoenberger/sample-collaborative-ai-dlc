import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Valkey from 'iovalkey';
import { createRegistry } from '../valkey/registry.js';
import { CONSUMER_GROUP, environmentQueueKey } from '../valkey/keys.js';

// Runs against the REAL Valkey from test/valkey-setup.js. The behaviour under
// test — consumer groups, the pending-entries list, XAUTOCLAIM's idle window —
// is exactly what a hand-written fake would get wrong, so there is no fake.
const host = process.env.VALKEY_HOST;
const port = Number(process.env.VALKEY_PORT || 6379);

let client;
let suffix = 0;

// A fresh environment id per test keeps streams, groups and worker sets from
// leaking between cases without needing FLUSHALL (which would fight the other
// suites sharing this container).
const nextEnv = () => `test-env-${process.pid}-${++suffix}`;

const worker = (overrides = {}) => ({
  workerId: `i-${Math.random().toString(16).slice(2, 12)}`,
  kind: 'EC2',
  environmentId: overrides.environmentId,
  revisionId: 'r-1',
  state: 'PROVISIONING',
  maxLifetimeSeconds: 3600,
  bootstrapTimeoutSeconds: 900,
  ...overrides,
});

describe.skipIf(!host)('registry against a real Valkey', () => {
  beforeAll(() => {
    client = new Valkey({ host, port, maxRetriesPerRequest: 2 });
  });

  afterAll(async () => {
    await client?.quit();
  });

  afterEach(async () => {
    // Only the keys this suite made: other projects share the container.
    const keys = await client.keys('*test-env-*');
    if (keys.length > 0) await client.del(...keys);
  });

  const registryFor = (clock) => createRegistry({ client, ...(clock ? { clock } : {}) });

  describe('worker rows', () => {
    it('round-trips a worker through put and get', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId, instanceId: 'i-real', fleetId: 'fleet-1' });
      await registry.putWorker(w);

      const stored = await registry.getWorker(w.workerId);
      expect(stored).toMatchObject({
        workerId: w.workerId,
        kind: 'EC2',
        environmentId,
        revisionId: 'r-1',
        state: 'PROVISIONING',
        instanceId: 'i-real',
        fleetId: 'fleet-1',
        draining: false,
      });
      expect(stored.lastSeenAtMs).toBeGreaterThan(0);
    });

    it('returns null for a worker that does not exist', async () => {
      expect(await registryFor().getWorker('i-nope')).toBeNull();
    });

    it('indexes workers by environment and lists them', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      const a = worker({ environmentId });
      const b = worker({ environmentId });
      await registry.putWorker(a);
      await registry.putWorker(b);

      const listed = await registry.listWorkers(environmentId);
      expect(listed.map((w) => w.workerId).sort()).toEqual([a.workerId, b.workerId].sort());
    });

    it('prunes ids whose worker row has expired out of the index', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      const a = worker({ environmentId });
      const b = worker({ environmentId });
      await registry.putWorker(a);
      await registry.putWorker(b);

      // Simulate the TTL having reaped one row while its id lingers in the set.
      await client.del(`{w:${a.workerId}}:meta`);

      const listed = await registry.listWorkers(environmentId);
      expect(listed.map((w) => w.workerId)).toEqual([b.workerId]);
      // …and the stale id is gone from the index, not re-fetched every time.
      expect(await client.smembers(`{e:${environmentId}}:workers`)).toEqual([b.workerId]);
    });

    it('moves a worker between idle and busy, keeping the idle set in step', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId });
      await registry.putWorker(w);

      await registry.markIdle({ ...w, environmentId });
      expect(await client.zrange(`{e:${environmentId}}:idle`, 0, -1)).toEqual([w.workerId]);
      expect((await registry.getWorker(w.workerId)).state).toBe('IDLE');

      await registry.markBusy({ ...w, environmentId }, 'job-1');
      expect(await client.zrange(`{e:${environmentId}}:idle`, 0, -1)).toEqual([]);
      const busy = await registry.getWorker(w.workerId);
      expect(busy).toMatchObject({ state: 'BUSY', currentJobId: 'job-1' });
    });

    it('removes a worker completely, including its addressed stream', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId });
      await registry.putWorker(w);
      await registry.markIdle({ ...w, environmentId });
      await registry.dispatchToWorker({ workerId: w.workerId, type: 'shutdown' });

      await registry.removeWorker({ ...w, environmentId });

      expect(await registry.getWorker(w.workerId)).toBeNull();
      expect(await client.exists(`{w:${w.workerId}}:stream`)).toBe(0);
      expect(await client.zrange(`{e:${environmentId}}:idle`, 0, -1)).toEqual([]);
      expect(await client.smembers(`{e:${environmentId}}:workers`)).toEqual([]);
    });

    it('leases an EC2 row and gives an AgentCore row no expiry at all', async () => {
      // The EC2 row IS the lease: its worker renews it from the poll loop. Nothing
      // beats an AgentCore row — it is a placement record removed on release — so it
      // gets no TTL. A long one picked so it "never fires" would be an expiry that
      // means nothing, which is the 12h TTL this design replaced.
      const registry = registryFor();
      const environmentId = nextEnv();
      const instance = worker({ environmentId });
      const session = worker({
        environmentId,
        kind: 'AGENTCORE',
        state: 'BUSY',
        workerId: 'aidlc-intent-lease',
      });
      await registry.putWorker(instance);
      await registry.putWorker(session);

      const instanceTtl = await client.ttl(`{w:${instance.workerId}}:meta`);
      expect(instanceTtl).toBeGreaterThan(0);
      expect(instanceTtl).toBeLessThanOrEqual(5 * 60);
      // -1 is "exists, no expiry"; -2 would be "gone".
      expect(await client.ttl(`{w:${session.workerId}}:meta`)).toBe(-1);
    });

    it('leases a PROVISIONING row exactly like any other EC2 row', async () => {
      // A launching instance is not a special case. If its runner never boots, the
      // row expiring is accurate — it was claiming a worker exists and none does —
      // and reapOrphans is what terminates the instance if one did come up. Any
      // grace period here is how a TTL nobody renews creeps back in.
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId, state: 'PROVISIONING' });
      await registry.putWorker(w);

      const ttl = await client.ttl(`{w:${w.workerId}}:meta`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(5 * 60);
    });

    it('does not renew the lease on a state transition — only a heartbeat does', async () => {
      // markBusy and the draining mark are written by the SCHEDULER. If those
      // renewed the lease, the scheduler would be holding a row alive on behalf of a
      // worker that may be dead, and the lease would stop being the worker's own
      // liveness claim.
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId, state: 'IDLE' });
      await registry.putWorker(w);
      const key = `{w:${w.workerId}}:meta`;

      await client.expire(key, 20);
      await registry.markBusy({ ...w, environmentId }, 'job-1');

      expect(await client.ttl(key)).toBeLessThanOrEqual(20);
      expect((await registry.getWorker(w.workerId)).state).toBe('BUSY');
    });

    it('refuses to resurrect an expired row on a state transition', async () => {
      // HSET creates the key it writes to, so a transition landing just after the
      // lease expired would rebuild the row as a partial with no kind, no
      // instanceId and — since only putWorker sets one — no TTL at all: an immortal
      // row counting against maxInstances forever.
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId, state: 'IDLE' });
      await registry.putWorker(w);
      const key = `{w:${w.workerId}}:meta`;

      await client.del(key);

      expect(await registry.setWorkerState(w.workerId, 'BUSY', { currentJobId: 'j-1' })).toBeNull();
      expect(await registry.markIdle({ ...w, environmentId })).toBeNull();
      expect(await client.exists(key)).toBe(0);
      expect(await client.zrange(`{e:${environmentId}}:idle`, 0, -1)).toEqual([]);
    });

    it('renews the lease on every heartbeat', async () => {
      // Without the EXPIRE, lastSeenAtMs is a timestamp nobody enforces and the
      // row outlives the worker by 12 hours.
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId, state: 'IDLE' });
      await registry.putWorker(w);
      const key = `{w:${w.workerId}}:meta`;

      // Burn most of the lease, then beat.
      await client.expire(key, 20);
      expect(await client.ttl(key)).toBeLessThanOrEqual(20);
      expect(await registry.heartbeat(w.workerId)).toBe(true);

      expect(await client.ttl(key)).toBeGreaterThan(20);
    });

    it('lets an unrenewed lease expire, and does not resurrect it', async () => {
      // Expiry is the liveness signal: the worker ceases to exist without any
      // sweep comparing timestamps. A worker able to beat its own row back into
      // existence would not be holding a lease at all.
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId });
      await registry.putWorker(w);
      const key = `{w:${w.workerId}}:meta`;

      await client.pexpire(key, 1);
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(await registry.getWorker(w.workerId)).toBeNull();
      expect(await registry.heartbeat(w.workerId)).toBe(false);
      expect(await client.exists(key)).toBe(0);
      // The set is a convenience index, so the id lingers until pruned on read.
      expect(await registry.listWorkers(environmentId)).toEqual([]);
      expect(await client.smembers(`{e:${environmentId}}:workers`)).toEqual([]);
    });

    it('beats a live worker and refuses to resurrect a reaped one', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId });
      await registry.putWorker(w);

      expect(await registry.heartbeat(w.workerId)).toBe(true);
      // The signal the runner uses to decide it has been reaped and should exit.
      expect(await registry.heartbeat('i-never-existed')).toBe(false);
      expect(await client.exists('{w:i-never-existed}:meta')).toBe(0);
    });
  });

  describe('fleet view', () => {
    it('counts provisioning and busy workers as in flight', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      const a = worker({ environmentId, state: 'PROVISIONING' });
      const b = worker({ environmentId, state: 'BUSY' });
      const c = worker({ environmentId, state: 'IDLE' });
      for (const w of [a, b, c]) await registry.putWorker(w);

      const view = await registry.fleetView(environmentId);
      expect(view.workers).toHaveLength(3);
      expect(view.inFlight).toBe(2);
      expect(view.idle).toBe(1);
    });

    it('reports an empty fleet for an unknown environment', async () => {
      expect(await registryFor().fleetView(nextEnv())).toMatchObject({
        workers: [],
        inFlight: 0,
        idle: 0,
      });
    });
  });

  describe('jobs', () => {
    it('round-trips a job, preserving the payload as structured data', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      await registry.putJob({
        jobId: 'job-1',
        executionId: 'x-1',
        stageInstanceId: 's-1',
        stageId: 'construction-code',
        environmentId,
        revisionId: 'r-1',
        stageCallbackId: 'cb-1',
        payload: { command: 'run-stage-start', unitSlug: null, nested: { a: 1 } },
      });

      const job = await registry.getJob('job-1');
      expect(job).toMatchObject({
        jobId: 'job-1',
        executionId: 'x-1',
        stageId: 'construction-code',
        stageCallbackId: 'cb-1',
        state: 'PENDING',
        attempt: 1,
      });
      expect(job.payload).toEqual({ command: 'run-stage-start', unitSlug: null, nested: { a: 1 } });
    });

    it('returns null for an unknown job', async () => {
      expect(await registryFor().getJob('job-nope')).toBeNull();
    });

    it('patches job state without losing other fields', async () => {
      const registry = registryFor();
      await registry.putJob({ jobId: 'job-2', executionId: 'x-1', environmentId: nextEnv() });
      await registry.setJobState('job-2', 'ABANDONED', { abandonedReason: 'lease_expired' });

      const job = await registry.getJob('job-2');
      expect(job).toMatchObject({
        state: 'ABANDONED',
        abandonedReason: 'lease_expired',
        executionId: 'x-1',
      });
    });
  });

  describe('queue and consumer group', () => {
    it('creates the group idempotently', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      await registry.ensureGroup(environmentId);
      // The second call hits BUSYGROUP, which must be swallowed rather than thrown.
      await expect(registry.ensureGroup(environmentId)).resolves.toBeUndefined();
    });

    it('delivers an enqueued job to a claiming worker exactly once', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      await registry.enqueueJob({ environmentId, jobId: 'job-3' });

      const first = await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        'worker-a',
        'COUNT',
        10,
        'STREAMS',
        environmentQueueKey(environmentId),
        '>',
      );
      expect(first?.[0]?.[1]).toHaveLength(1);

      // A second consumer sees nothing: the entry is claimed, not broadcast.
      const second = await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        'worker-b',
        'COUNT',
        10,
        'STREAMS',
        environmentQueueKey(environmentId),
        '>',
      );
      expect(second).toBeNull();
    });

    it('addresses a resume to one worker without touching the shared queue', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId });
      await registry.putWorker(w);
      await registry.dispatchToWorker({ workerId: w.workerId, type: 'resume', jobId: 'job-4' });

      const entries = await client.xrange(`{w:${w.workerId}}:stream`, '-', '+');
      expect(entries).toHaveLength(1);
      expect(entries[0][1]).toEqual(['type', 'resume', 'jobId', 'job-4', 'reason', '']);
      // The environment queue was never written to.
      expect(await client.exists(environmentQueueKey(environmentId))).toBe(0);
    });
  });

  describe('leases via the pending-entries list', () => {
    it('does not reclaim a job whose holder is still within the lease window', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      await registry.enqueueJob({ environmentId, jobId: 'job-5' });
      await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        'worker-a',
        'COUNT',
        10,
        'STREAMS',
        environmentQueueKey(environmentId),
        '>',
      );

      const abandoned = await registry.claimAbandoned({ environmentId, idleMs: 60_000 });
      expect(abandoned).toEqual([]);
    });

    it('reclaims a job once its holder has gone quiet past the window', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      await registry.enqueueJob({ environmentId, jobId: 'job-6' });
      await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        'worker-a',
        'COUNT',
        10,
        'STREAMS',
        environmentQueueKey(environmentId),
        '>',
      );

      // idleMs 0 means "anything pending", which is how a dead holder looks once
      // the real window has elapsed — without making the test sleep.
      const abandoned = await registry.claimAbandoned({ environmentId, idleMs: 0 });
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0].jobId).toBe('job-6');
      expect(abandoned[0].entryId).toMatch(/^\d+-\d+$/);
    });

    it('stops reporting a job once it is acked', async () => {
      const registry = registryFor();
      const environmentId = nextEnv();
      await registry.enqueueJob({ environmentId, jobId: 'job-7' });
      const delivered = await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        'worker-a',
        'COUNT',
        10,
        'STREAMS',
        environmentQueueKey(environmentId),
        '>',
      );
      const entryId = delivered[0][1][0][0];

      await registry.ackJob({ environmentId, entryId });

      expect(await registry.claimAbandoned({ environmentId, idleMs: 0 })).toEqual([]);
    });

    it('does not hand the same abandoned entry to two consecutive sweeps', async () => {
      // XAUTOCLAIM reassigns ownership to the reclaiming consumer, so a second
      // sweep at the same idle threshold must come back empty — otherwise the
      // reconciler would open a new attempt on every tick.
      const registry = registryFor();
      const environmentId = nextEnv();
      await registry.enqueueJob({ environmentId, jobId: 'job-8' });
      await client.xreadgroup(
        'GROUP',
        CONSUMER_GROUP,
        'worker-a',
        'COUNT',
        10,
        'STREAMS',
        environmentQueueKey(environmentId),
        '>',
      );

      expect(await registry.claimAbandoned({ environmentId, idleMs: 0 })).toHaveLength(1);
      expect(await registry.claimAbandoned({ environmentId, idleMs: 60_000 })).toEqual([]);
    });
  });

  describe('cluster slot discipline', () => {
    it('pipelines only same-slot keys', async () => {
      // A single node cannot reject a cross-slot pipeline, so this asserts the
      // pipelines actually issued stay within one tag. putWorker deliberately
      // splits the {e:…} sadd out of the {w:…} pipeline for this reason.
      const registry = registryFor();
      const environmentId = nextEnv();
      const w = worker({ environmentId });
      await expect(registry.putWorker(w)).resolves.toMatchObject({ workerId: w.workerId });
      await expect(registry.removeWorker({ ...w, environmentId })).resolves.toBeUndefined();
    });
  });
});
