// The fleet registry — worker state, job dispatch and leases, over Valkey.
//
// The client is injected rather than imported so tests can point it at the real
// Valkey testcontainer (test/valkey-setup.js) — not at a hand-written fake. The
// semantics this module leans on (consumer groups, the pending-entries list, and
// XAUTOCLAIM's idle window) are precisely the ones a fake would get subtly wrong,
// so they are exercised against a real server or not at all.
//
// LEASES. A job is dispatched by XADD onto a stream and claimed by XREADGROUP.
// The consumer group's pending-entries list then holds "worker X owes job Y since
// time T" — so lease expiry needs no separate lock or TTL key: XAUTOCLAIM over
// entries idle longer than the lease window IS the expiry sweep. What that gets
// us over a TTL key is that the lease is established by the same operation that
// delivers the work, so there is no window where a job is claimed but unleased.
//
// AUTHORITY. Valkey is a fast working copy, never the system of record. Attempt
// lifecycle belongs to the durable orchestrator; instance existence belongs to
// EC2 (DescribeInstances by tag). So an expired lease here marks a job abandoned
// and lets the ORCHESTRATOR open a new attempt — it never re-delivers the same
// job to a second worker behind the orchestrator's back, because two workers
// completing one durable callback is the one failure this design must not have.

import {
  CONSUMER_GROUP,
  environmentIdleKey,
  environmentQueueKey,
  environmentWorkersKey,
  jobMetaKey,
  workerMetaKey,
  workerStreamKey,
} from './keys.js';

export const WORKER_STATES = ['PROVISIONING', 'IDLE', 'BUSY', 'DRAINING', 'TERMINATED'];

// Worker rows outlive their usefulness only briefly; a TTL keeps a crashed
// provision from leaking a row forever without the reconciler having to notice.
// Generous relative to the 8h max lifetime so it never expires a live worker.
const WORKER_TTL_SECONDS = 12 * 60 * 60;
const JOB_TTL_SECONDS = 12 * 60 * 60;

const nowMs = () => Date.now();

// Valkey hashes are flat string maps, so anything structured is JSON in one
// field. Kept explicit rather than clever: the fields a strategy or the
// reconciler reads are top-level and cheap; only the opaque job payload is JSON.
const encodeWorker = (worker) => {
  const flat = {
    workerId: worker.workerId,
    kind: worker.kind,
    environmentId: worker.environmentId,
    revisionId: worker.revisionId ?? '',
    state: worker.state,
    executionId: worker.executionId ?? '',
    stageInstanceId: worker.stageInstanceId ?? '',
    currentJobId: worker.currentJobId ?? '',
    draining: worker.draining ? '1' : '',
    createdAtMs: String(worker.createdAtMs ?? nowMs()),
    lastSeenAtMs: String(worker.lastSeenAtMs ?? nowMs()),
    maxLifetimeSeconds: String(worker.maxLifetimeSeconds ?? 0),
    bootstrapTimeoutSeconds: String(worker.bootstrapTimeoutSeconds ?? 0),
  };
  if (worker.instanceId) flat.instanceId = worker.instanceId;
  if (worker.sessionId) flat.sessionId = worker.sessionId;
  if (worker.fleetId) flat.fleetId = worker.fleetId;
  return flat;
};

const decodeWorker = (flat) => {
  if (!flat || Object.keys(flat).length === 0) return null;
  return {
    workerId: flat.workerId,
    kind: flat.kind,
    environmentId: flat.environmentId,
    revisionId: flat.revisionId || null,
    state: flat.state,
    executionId: flat.executionId || null,
    stageInstanceId: flat.stageInstanceId || null,
    currentJobId: flat.currentJobId || null,
    draining: flat.draining === '1',
    instanceId: flat.instanceId || null,
    sessionId: flat.sessionId || null,
    fleetId: flat.fleetId || null,
    createdAtMs: Number(flat.createdAtMs || 0),
    lastSeenAtMs: Number(flat.lastSeenAtMs || 0),
    maxLifetimeSeconds: Number(flat.maxLifetimeSeconds || 0),
    bootstrapTimeoutSeconds: Number(flat.bootstrapTimeoutSeconds || 0),
  };
};

export const createRegistry = ({ client, clock = nowMs }) => {
  if (!client) throw new Error('createRegistry requires a Valkey client');

  // XGROUP CREATE is not idempotent — it errors BUSYGROUP when the group exists,
  // which is the overwhelmingly common case. Swallowing only that error is how
  // this stays a safe every-enqueue call instead of needing separate setup.
  const ensureGroup = async (environmentId) => {
    try {
      await client.xgroup(
        'CREATE',
        environmentQueueKey(environmentId),
        CONSUMER_GROUP,
        '$',
        'MKSTREAM',
      );
    } catch (error) {
      if (!/BUSYGROUP/i.test(error?.message ?? '')) throw error;
    }
  };

  const putWorker = async (worker) => {
    const key = workerMetaKey(worker.workerId);
    const flat = encodeWorker({ ...worker, lastSeenAtMs: clock() });
    // Same hash tag, so these three land in one slot and can pipeline safely.
    const pipeline = client.pipeline();
    pipeline.hset(key, flat);
    pipeline.expire(key, WORKER_TTL_SECONDS);
    await pipeline.exec();
    // Different tag ({e:…}), so this is a separate round trip by necessity.
    await client.sadd(environmentWorkersKey(worker.environmentId), worker.workerId);
    return decodeWorker(flat);
  };

  const getWorker = async (workerId) => decodeWorker(await client.hgetall(workerMetaKey(workerId)));

  const listWorkers = async (environmentId) => {
    const ids = await client.smembers(environmentWorkersKey(environmentId));
    const workers = await Promise.all(ids.map((id) => getWorker(id)));
    // A null row means the TTL reaped a worker whose id is still in the set.
    // Prune opportunistically: the set is a convenience index, not truth.
    const live = [];
    const stale = [];
    for (const [index, worker] of workers.entries()) {
      if (worker) live.push(worker);
      else stale.push(ids[index]);
    }
    if (stale.length > 0) await client.srem(environmentWorkersKey(environmentId), ...stale);
    return live;
  };

  const setWorkerState = async (workerId, state, patch = {}) => {
    const key = workerMetaKey(workerId);
    const flat = { state, lastSeenAtMs: String(clock()) };
    for (const [field, value] of Object.entries(patch)) {
      flat[field] = value == null ? '' : String(value);
    }
    await client.hset(key, flat);
    return getWorker(workerId);
  };

  const markIdle = async (worker) => {
    await setWorkerState(worker.workerId, 'IDLE', { currentJobId: '' });
    await client.zadd(environmentIdleKey(worker.environmentId), clock(), worker.workerId);
  };

  const markBusy = async (worker, jobId) => {
    await client.zrem(environmentIdleKey(worker.environmentId), worker.workerId);
    return setWorkerState(worker.workerId, 'BUSY', { currentJobId: jobId });
  };

  const removeWorker = async (worker) => {
    await client.zrem(environmentIdleKey(worker.environmentId), worker.workerId);
    await client.srem(environmentWorkersKey(worker.environmentId), worker.workerId);
    const pipeline = client.pipeline();
    pipeline.del(workerMetaKey(worker.workerId));
    pipeline.del(workerStreamKey(worker.workerId));
    await pipeline.exec();
  };

  const heartbeat = async (workerId) => {
    // HSET on an absent key would resurrect a reaped worker as a partial row with
    // only a timestamp, which the reconciler would then have to interpret. Beat
    // only a worker that still exists; `false` is the runner's signal that it has
    // been reaped and should shut itself down.
    const key = workerMetaKey(workerId);
    if (!(await client.exists(key))) return false;
    await client.hset(key, { lastSeenAtMs: String(clock()) });
    return true;
  };

  const putJob = async (job) => {
    const key = jobMetaKey(job.jobId);
    const pipeline = client.pipeline();
    pipeline.hset(key, {
      jobId: job.jobId,
      executionId: job.executionId,
      projectId: job.projectId ?? '',
      // The named credential provider for this job, JSON-encoded. Carries no
      // secret; it exists so the grant can be minted when a worker CLAIMS the job
      // rather than when it was enqueued, which would race the 300s grant TTL.
      credentialBinding: job.credentialBinding ? JSON.stringify(job.credentialBinding) : '',
      stageInstanceId: job.stageInstanceId ?? '',
      stageId: job.stageId ?? '',
      unitSlug: job.unitSlug ?? '',
      environmentId: job.environmentId,
      revisionId: job.revisionId ?? '',
      stageCallbackId: job.stageCallbackId ?? '',
      resumeFrom: job.resumeFrom ?? '',
      attempt: String(job.attempt ?? 1),
      payload: JSON.stringify(job.payload ?? {}),
      createdAtMs: String(clock()),
      state: 'PENDING',
    });
    pipeline.expire(key, JOB_TTL_SECONDS);
    await pipeline.exec();
    return job.jobId;
  };

  const getJob = async (jobId) => {
    const flat = await client.hgetall(jobMetaKey(jobId));
    if (!flat || Object.keys(flat).length === 0) return null;
    return {
      ...flat,
      attempt: Number(flat.attempt || 1),
      createdAtMs: Number(flat.createdAtMs || 0),
      payload: flat.payload ? JSON.parse(flat.payload) : {},
    };
  };

  const setJobState = async (jobId, state, patch = {}) => {
    const flat = { state };
    for (const [field, value] of Object.entries(patch)) {
      flat[field] = value == null ? '' : String(value);
    }
    await client.hset(jobMetaKey(jobId), flat);
  };

  // Unassigned work: any worker of this environment may claim it.
  const enqueueJob = async ({ environmentId, jobId }) => {
    await ensureGroup(environmentId);
    return client.xadd(environmentQueueKey(environmentId), '*', 'jobId', jobId);
  };

  // Addressed work: this worker and no other. Used for a resume that must land on
  // the worker holding the parked conversation, and for cancel/shutdown.
  const dispatchToWorker = async ({ workerId, type, jobId = '', reason = '' }) =>
    client.xadd(workerStreamKey(workerId), '*', 'type', type, 'jobId', jobId, 'reason', reason);

  const inFlightCount = async (environmentId) => {
    const workers = await listWorkers(environmentId);
    return workers.filter((w) => w.state === 'PROVISIONING' || w.state === 'BUSY').length;
  };

  const fleetView = async (environmentId) => {
    const workers = await listWorkers(environmentId);
    return {
      workers,
      inFlight: workers.filter((w) => w.state === 'PROVISIONING' || w.state === 'BUSY').length,
      idle: workers.filter((w) => w.state === 'IDLE').length,
    };
  };

  /**
   * Jobs whose holder has gone quiet for longer than `idleMs`.
   *
   * XAUTOCLAIM reassigns the pending entry to `reclaimConsumer` so it is not
   * returned again on the next sweep, and returns the entries it moved. The
   * caller decides what to do with them — for us, mark the job abandoned and let
   * the orchestrator open a fresh attempt.
   */
  const claimAbandoned = async ({
    environmentId,
    idleMs,
    reclaimConsumer = 'reconciler',
    count = 32,
  }) => {
    await ensureGroup(environmentId);
    const [, entries = []] = await client.xautoclaim(
      environmentQueueKey(environmentId),
      CONSUMER_GROUP,
      reclaimConsumer,
      idleMs,
      '0-0',
      'COUNT',
      count,
    );
    return entries.map(([entryId, fields]) => {
      const map = {};
      for (let i = 0; i < (fields ?? []).length; i += 2) map[fields[i]] = fields[i + 1];
      return { entryId, jobId: map.jobId };
    });
  };

  const ackJob = async ({ environmentId, entryId }) =>
    client.xack(environmentQueueKey(environmentId), CONSUMER_GROUP, entryId);

  return {
    ensureGroup,
    putWorker,
    getWorker,
    listWorkers,
    setWorkerState,
    markIdle,
    markBusy,
    removeWorker,
    heartbeat,
    putJob,
    getJob,
    setJobState,
    enqueueJob,
    dispatchToWorker,
    inFlightCount,
    fleetView,
    claimAbandoned,
    ackJob,
  };
};

export { decodeWorker, encodeWorker, WORKER_TTL_SECONDS, JOB_TTL_SECONDS };
export default { createRegistry, WORKER_STATES };
