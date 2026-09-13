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

// A WORKER ROW IS A LEASE.
//
// The expiry is not garbage collection — it is the liveness signal. The worker holds
// its row by renewing the TTL on every heartbeat (30s from its poll loop); when it
// stops renewing, the row expires and the worker is gone, with nothing having to
// compare timestamps or run a sweep to notice. Five minutes is ten missed beats:
// generous enough that a brief Valkey blip cannot evict a healthy worker, tight
// enough that a dead one stops counting against maxInstances within a stage's
// lifetime. A launch that never boots losing its row after five minutes is not a
// false positive — the row is claiming a worker exists, and none does.
//
// That is also why every row in here is an EC2 instance. A row nobody renews has no
// answer to "what expiry?": a long one picked so it "never fires in practice" is a
// number pretending to be a signal, which is exactly what the 12h
// WORKER_TTL_SECONDS this design replaced was.
//
// EXPIRY REMOVES A ROW, NEVER AN INSTANCE. Nothing here can call
// TerminateInstances, so a runner that dies while its instance keeps running
// leaves that instance to `reapOrphans`, which asks EC2 what exists rather than
// trusting this registry. Valkey holds liveness; EC2 holds existence.
const WORKER_LEASE_SECONDS = Number(process.env.WORKER_LEASE_SECONDS || 5 * 60);

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
    // Same hash tag, so these land in one slot and can pipeline safely.
    const pipeline = client.pipeline();
    pipeline.hset(key, flat);
    // The lease starts here and is the worker's to hold; see the header.
    pipeline.expire(key, WORKER_LEASE_SECONDS);
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

  /**
   * Move a row to a new state. Deliberately does NOT touch the expiry.
   *
   * Renewing here would let the scheduler hold a lease open on a worker's behalf —
   * `markBusy` and the draining mark are both written by the scheduler — and a
   * lease somebody else can renew is not a liveness claim by the worker. Only
   * `heartbeat` renews.
   *
   * Guarded exactly as `heartbeat` is, though, and for the same reason: HSET CREATES
   * the key it writes to, so a transition landing a moment after the lease expired
   * would rebuild the row as a partial one — no kind, no instanceId, and no TTL at
   * all, since only `putWorker` ever sets one. That row is immortal, and
   * `listWorkers` would go on offering it to the placement strategy and counting it
   * against maxInstances forever. So a missing row answers `null`: a worker that
   * failed to hold its lease does not get it back by announcing a state change.
   */
  const setWorkerState = async (workerId, state, patch = {}) => {
    const key = workerMetaKey(workerId);
    if (!(await client.exists(key))) return null;
    const flat = { state, lastSeenAtMs: String(clock()) };
    for (const [field, value] of Object.entries(patch)) {
      flat[field] = value == null ? '' : String(value);
    }
    await client.hset(key, flat);
    return getWorker(workerId);
  };

  const markIdle = async (worker) => {
    const row = await setWorkerState(worker.workerId, 'IDLE', { currentJobId: '' });
    // No row means the lease is gone. Adding the id to the idle index anyway would
    // advertise a worker that does not exist.
    if (!row) return null;
    await client.zadd(environmentIdleKey(worker.environmentId), clock(), worker.workerId);
    return row;
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

  /**
   * Renew this worker's lease. THIS is what keeps its row alive.
   *
   * The EXPIRE is the point; lastSeenAtMs is written alongside for operators
   * reading describe-fleet, and nothing decides liveness from it.
   *
   * Renewal is deliberately not a blind write. HSET on an absent key would
   * resurrect an expired worker as a partial row carrying only a timestamp, which
   * would then look alive to the placement strategy — a worker able to
   * resurrect its own lease is not holding a lease at all. So a lost lease stays
   * lost: `false` tells the runner it has been written off and must shut down
   * rather than keep claiming jobs.
   */
  const heartbeat = async (workerId) => {
    const key = workerMetaKey(workerId);
    if (!(await client.exists(key))) return false;
    const pipeline = client.pipeline();
    pipeline.hset(key, { lastSeenAtMs: String(clock()) });
    // The lease, renewed. This is the only place it is ever extended.
    pipeline.expire(key, WORKER_LEASE_SECONDS);
    await pipeline.exec();
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

export { decodeWorker, encodeWorker, WORKER_LEASE_SECONDS, JOB_TTL_SECONDS };
export default { createRegistry, WORKER_STATES };
