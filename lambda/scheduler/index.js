// The scheduler — placement authority for stage work on the EC2 fleet.
//
// EC2 ONLY, deliberately. Every worker here is an instance we launched and must
// eventually terminate, and that single fact is what the whole file is about:
// leases, capacity limits, bootstrap timeouts, lifetime caps, orphan reaping. An
// AgentCore stage never reaches this Lambda — the orchestrator invokes the runtime
// directly, because a session has nothing to provision, no capacity to ration and
// no liveness we could observe (see lambda/scheduler/provisioners.js).
//
// Invoked directly (RequestResponse) by the v2 orchestrator, and on a schedule by
// EventBridge for the reconcile sweep. Actions:
//
//   enqueue-stage   place one stage attempt: decide, provision or reuse a worker,
//                   record the job, and put it where that worker will find it.
//   dispatch        addressed message to one live worker (resume / cancel / shutdown).
//   release         retire a worker, or every worker of an execution.
//   describe-fleet  ops read of the registry.
//   reconcile       the sweep: lifetimes, bootstrap timeouts, abandoned leases,
//                   and orphan instances that Valkey has forgotten about.
//
// WHY THE ORCHESTRATOR GOES THROUGH A LAMBDA. The durable orchestrator is not
// VPC-attached (it reaches DynamoDB, the WebSocket management API and the Lambda
// callback API over public endpoints), and ElastiCache is VPC-only with no public
// endpoint. Rather than drag the most critical component in the system into the
// VPC, this Lambda is the only thing the orchestrator talks to, and it holds the
// single Valkey client.
//
// THE RUNNER DOES NOT GO THROUGH HERE. Workers are already in the VPC and need
// blocking reads and frequent lease renewal; routing those through a Lambda would
// mean paying for a function to sit and wait. They use lambda/shared/valkey
// directly. This file and the runner therefore share the registry module, which is
// why it lives in shared/ rather than in this package.

import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient } from '@aws-sdk/client-ssm';
import { issueAgentCredentialGrant } from '../shared/agent-credential-grants.js';
import { createRegistry } from '../shared/valkey/registry.js';
import { getClient } from '../shared/valkey/client.js';
import { strategyFor } from './strategies.js';
import { MANAGED_TAG, createEc2Provisioner, provisionerFor } from './provisioners.js';

const ec2 = new EC2Client({});
const ssm = new SSMClient({});

const SUBNET_IDS = () =>
  (process.env.EXECUTOR_SUBNET_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// How long a claimed job may go unbeaten before the reconciler calls it
// abandoned. Deliberately shorter than the orchestrator's 15-minute stage
// callback heartbeat timeout, so the scheduler is the one that notices a dead
// worker and the orchestrator learns about it as a stage failure rather than by
// waiting out its own clock.
const LEASE_IDLE_MS = () => Number(process.env.LEASE_IDLE_MS || 5 * 60 * 1000);

// How long a worker may sit IDLE, holding no job, before the sweep retires it.
//
// This is the backstop for a release that did not happen. The orchestrator
// releases a worker directly when its stage ends, which is immediate and free; but
// if the orchestrator dies, or a cancel never reached it, or a callback never
// arrived, the worker is left healthy and idle — and nothing else in this sweep can
// see it. Its lease is renewed (the runner is alive), it is not PROVISIONING, its
// lifetime cap is hours away, and it IS in the registry so reapOrphans skips it. It
// would bill until maxLifetimeSeconds.
//
// Two minutes, because under per-stage-ephemeral nothing ever reuses a worker, so
// an idle one is waste by definition. A pooling strategy would raise this to the
// pool's own idle timeout.
const WORKER_IDLE_MS = () => Number(process.env.WORKER_IDLE_MS || 2 * 60 * 1000);

const jobIdFor = ({ executionId, stageInstanceId, attempt }) =>
  `job-${executionId}-${stageInstanceId}-${attempt ?? 1}`;

// A provisional id, used only as the CreateFleet idempotency token. The EC2
// worker's real identity is its instance id (see provisioners.js).
const provisionalWorkerId = ({ executionId, stageInstanceId, attempt }) =>
  `p-${executionId}-${stageInstanceId}-${attempt ?? 1}`.slice(0, 60);

// Limits come from the operator's launch spec, because this is a fleet we pay for.
const limitsForTarget = (target) => ({
  maxInstances: target.launchSpec?.maxInstances ?? 1,
  maxConcurrentPlacements: target.launchSpec?.maxConcurrentPlacements ?? 1,
});

export const createScheduler = ({
  registry,
  provisioners,
  subnetIds = SUBNET_IDS(),
  describeInstances = (input) => ec2.send(new DescribeInstancesCommand(input)),
  leaseIdleMs = LEASE_IDLE_MS(),
  workerIdleMs = WORKER_IDLE_MS(),
  issueAgentCredentialGrantFn = (claims) => issueAgentCredentialGrant(ssm, claims),
  clock = () => Date.now(),
} = {}) => {
  const enqueueStage = async ({
    executionId,
    stageId,
    stageInstanceId,
    unitSlug = null,
    attempt = 1,
    target,
    stageCallbackId,
    resumeWorkerId = null,
    projectId = null,
    credentialBinding = null,
    payload = {},
  }) => {
    if (!target?.kind) {
      throw Object.assign(new Error('enqueue-stage requires a resolved target'), {
        code: 'TARGET_REQUIRED',
      });
    }
    // Anything but EC2 arriving here is a routing bug upstream, and the honest
    // answer is to say so. Quietly writing a worker row for a machine this Lambda
    // does not own is how ghost rows — leased by nobody, reaped by nobody — got
    // into the registry in the first place.
    if (target.kind !== 'EC2') {
      throw Object.assign(new Error(`the scheduler places EC2 work only, not "${target.kind}"`), {
        code: 'UNSUPPORTED_TARGET_KIND',
      });
    }
    const environmentId = target.environmentId;
    const request = {
      environmentId,
      revisionId: target.revisionId ?? null,
      executionId,
      stageInstanceId,
      resumeWorkerId,
    };
    const fleet = await registry.fleetView(environmentId);
    const strategyId = target.launchSpec?.strategyId ?? 'per-stage-ephemeral';
    const decision = strategyFor(strategyId)({
      request,
      fleet,
      limits: limitsForTarget(target),
    });

    if (decision.action === 'queue') {
      console.error('[scheduler] refusing placement for capacity', {
        environmentId,
        reason: decision.reason,
        active: fleet.workers.length,
        inFlight: fleet.inFlight,
      });
      // Capacity is exhausted. Say so as a value rather than throwing: the
      // orchestrator turns it into a stage failure with a legible reason, and the
      // operator's remedy is a limit change, not a retry.
      return { ok: false, action: 'queue', reason: decision.reason };
    }

    const jobId = jobIdFor({ executionId, stageInstanceId, attempt });
    await registry.putJob({
      jobId,
      executionId,
      projectId,
      // Named provider, no secret. Recorded so the grant can be minted at claim
      // time rather than at dispatch, which would race the 300s grant TTL.
      credentialBinding,
      stageInstanceId,
      stageId,
      unitSlug,
      environmentId,
      revisionId: target.revisionId,
      stageCallbackId,
      attempt,
      payload,
    });

    const provisioner = provisionerFor(target.kind, provisioners);

    // Reuse is an ADDRESSED dispatch: the point of reuse is that this specific
    // instance holds the parked conversation, so putting the job on the shared
    // queue would let any worker take it and lose that context.
    if (decision.action === 'reuse') {
      await registry.dispatchToWorker({ workerId: decision.workerId, type: 'job', jobId });
      const worker = await registry.getWorker(decision.workerId);
      if (worker) await registry.markBusy(worker, jobId);
      return { ok: true, action: 'reuse', jobId, workerId: decision.workerId };
    }

    // Enqueue BEFORE provisioning. A worker that boots fast enough to poll before
    // this write would otherwise find an empty queue and idle out; the reverse
    // order costs nothing, because an unclaimed job is exactly what the queue is
    // for.
    await registry.enqueueJob({ environmentId, jobId });

    let provisioned;
    try {
      provisioned = await provisioner.provision({
        target,
        workerId: provisionalWorkerId({ executionId, stageInstanceId, attempt }),
        executionId,
        subnetIds,
      });
    } catch (error) {
      // LOG it. A provisioning failure used to be returned as a value and never
      // written anywhere, so the stage failure said "check CloudWatch" and
      // CloudWatch had nothing in it.
      console.error('[scheduler] provision failed', {
        kind: target.kind,
        environmentId,
        jobId,
        code: error?.code,
        message: error?.message,
        errors: error?.errors,
      });
      await registry.setJobState(jobId, 'FAILED', {
        failureReason: error.code ?? 'provision_failed',
      });
      return {
        ok: false,
        action: 'provision',
        reason: error.code ?? 'provision_failed',
        detail: error.message,
      };
    }

    const workerId = provisioned.instanceId ?? provisioned.workerId;
    await registry.putWorker({
      workerId,
      kind: target.kind,
      environmentId,
      revisionId: target.revisionId,
      // The instance is launching and has claimed nothing yet: its runner moves the
      // row to IDLE when it registers, and the reconciler releases it if that never
      // happens within bootstrapTimeoutSeconds.
      state: 'PROVISIONING',
      executionId,
      stageInstanceId,
      instanceId: provisioned.instanceId,
      sessionId: provisioned.sessionId,
      fleetId: provisioned.fleetId,
      createdAtMs: clock(),
      maxLifetimeSeconds: target.launchSpec?.maxLifetimeSeconds ?? 0,
      bootstrapTimeoutSeconds: target.launchSpec?.bootstrapTimeoutSeconds ?? 0,
    });
    return { ok: true, action: 'provision', jobId, workerId };
  };

  /**
   * Mint an agent credential grant for a worker that is about to run a job.
   *
   * Grants live 300 seconds (AGENT_CREDENTIAL_GRANT_TTL_SECONDS), and the gap
   * between enqueue and claim is an instance cold boot — minutes — so the
   * orchestrator cannot mint one at dispatch without racing the TTL. It is minted
   * HERE, at claim time, instead.
   *
   * The worker deliberately does not hold the signing secret: a worker able to
   * sign its own grant would make the grant meaningless as an authorization. So it
   * asks, and the answer is gated on the registry agreeing that this worker holds
   * this job. `bindings` come off the job (recorded by the orchestrator, which
   * knows the project's credential binding); they name a provider and carry no
   * secret.
   */
  const issueGrant = async ({ workerId, jobId, purpose }) => {
    const worker = await registry.getWorker(workerId);
    if (!worker) return { ok: false, reason: 'worker_not_found' };
    if (worker.currentJobId !== jobId) {
      return { ok: false, reason: 'worker_does_not_hold_job' };
    }
    const job = await registry.getJob(jobId);
    if (!job) return { ok: false, reason: 'job_not_found' };
    if (!job.credentialBinding) return { ok: true, agentCredentialGrant: null };
    const agentCredentialGrant = await issueAgentCredentialGrantFn({
      purpose,
      projectId: job.projectId,
      executionId: job.executionId,
      bindings: [JSON.parse(job.credentialBinding)],
    });
    return { ok: true, agentCredentialGrant };
  };

  /**
   * Mark a worker as holding a parked stage, or release that mark.
   *
   * The scheduler cannot know a stage parked — the orchestrator owns that fact — and
   * the reconciler needs it, because a held worker is idle ON PURPOSE and its idle
   * reap would otherwise silently turn a `hold` into a `release` and break the
   * resume. The lifetime cap still applies, so an abandoned gate cannot bill forever.
   */
  const parkWorker = async ({ workerId, parked = true }) => {
    const worker = await registry.getWorker(workerId);
    if (!worker) return { ok: false, reason: 'worker_not_found' };
    await registry.setWorkerState(workerId, worker.state, { parked: parked ? '1' : '' });
    return { ok: true, workerId, parked };
  };

  const dispatch = async ({ workerId, type, jobId = '', reason = '' }) => {
    const worker = await registry.getWorker(workerId);
    if (!worker) return { ok: false, reason: 'worker_not_found' };
    await registry.dispatchToWorker({ workerId, type, jobId, reason });
    return { ok: true, workerId, type };
  };

  const releaseWorker = async ({ workerId, target = null }) => {
    const worker = await registry.getWorker(workerId);
    if (!worker) return { ok: true, released: false, reason: 'worker_not_found' };
    // Mark draining first: a concurrent placement must not pick this worker up
    // between the terminate call and the row being removed.
    await registry.setWorkerState(workerId, worker.state, { draining: '1' });
    const provisioner = provisionerFor(worker.kind, provisioners);
    const result = await provisioner.terminate({ worker, target });
    await registry.removeWorker(worker);
    // Forget the consumer too. A consumer name lives in the group until deleted, so
    // under per-stage-ephemeral the group otherwise collects one dead consumer per
    // instance ever launched. The return value is how many pending entries it still
    // held: non-zero means it claimed a job and died without finishing, which is
    // worth saying out loud — that is the shape of the bug where an outgoing worker
    // stole its successor's job.
    const strandedEntries = await registry.forgetConsumer({
      environmentId: worker.environmentId,
      workerId,
    });
    if (strandedEntries) {
      console.error('[scheduler] released a worker still holding queue entries', {
        workerId,
        strandedEntries,
      });
    }
    return { ok: true, released: true, ...result, strandedEntries };
  };

  const releaseExecution = async ({ executionId, environmentIds = [] }) => {
    const released = [];
    for (const environmentId of environmentIds) {
      const workers = await registry.listWorkers(environmentId);
      for (const worker of workers.filter((w) => w.executionId === executionId)) {
        released.push((await releaseWorker({ workerId: worker.workerId })).released);
      }
    }
    return { ok: true, released: released.filter(Boolean).length };
  };

  const describeFleet = async ({ environmentId }) => ({
    ok: true,
    ...(await registry.fleetView(environmentId)),
  });

  /**
   * The sweep. Four independent checks, each of which must be able to run when
   * the others find nothing:
   *
   *   1. abandoned leases   — a claimed job whose holder stopped beating.
   *   2. bootstrap timeouts — an instance that launched but never registered,
   *                           which is what a broken AMI or a failed runner
   *                           bundle fetch looks like. Only reachable inside the
   *                           lease: a launch that never boots loses its row after
   *                           WORKER_LEASE_SECONDS, and then it is check 4's
   *                           problem, because only EC2 knows whether an instance
   *                           came up at all.
   *   3. idle workers       — finished its stage and nobody released it. The
   *                           direct release on stage exit is the mechanism; this
   *                           is the backstop for when that never ran.
   *   4. lifetime caps      — a worker older than its spec allows.
   *   5. orphan instances   — running and tagged as ours, but absent from the
   *                           registry. This is the check that makes Valkey
   *                           disposable: EC2 is the authority on what exists.
   *
   * NOTE WHAT IS NOT HERE: a liveness check. A worker row IS a lease (see
   * lambda/shared/valkey/registry.js) — a polling worker renews its TTL on every
   * heartbeat, and a worker that stops renewing simply ceases to exist, with no
   * sweep needed to notice and no threshold to tune. That makes check 4 load
   * bearing rather than a backstop: an expired lease removes the row but cannot
   * terminate the instance, so the instance that outlives its runner is found by
   * asking EC2, not by reading Valkey.
   */
  const reconcile = async ({ environmentIds = [] } = {}) => {
    const now = clock();
    const abandoned = [];
    const timedOut = [];
    const expired = [];
    const idle = [];

    for (const environmentId of environmentIds) {
      for (const entry of await registry.claimAbandoned({ environmentId, idleMs: leaseIdleMs })) {
        // Mark it and ack it. The orchestrator opens the next attempt — this must
        // NOT redeliver the job, because two workers completing one durable
        // callback is the failure the whole design exists to prevent.
        if (entry.jobId) {
          await registry.setJobState(entry.jobId, 'ABANDONED', {
            abandonedReason: 'lease_expired',
          });
        }
        await registry.ackJob({ environmentId, entryId: entry.entryId });
        abandoned.push(entry.jobId ?? entry.entryId);
      }

      for (const worker of await registry.listWorkers(environmentId)) {
        const ageSeconds = (now - worker.createdAtMs) / 1000;
        if (
          worker.state === 'PROVISIONING' &&
          worker.bootstrapTimeoutSeconds > 0 &&
          ageSeconds > worker.bootstrapTimeoutSeconds
        ) {
          await releaseWorker({ workerId: worker.workerId });
          timedOut.push(worker.workerId);
          continue;
        }
        // Finished its work and nobody released it. `lastSeenAtMs` is the wrong
        // clock here — a live runner keeps that fresh forever — so this is judged on
        // when the worker last went IDLE, which markIdle stamps.
        // A worker holding a parked stage is idle ON PURPOSE — it is waiting for a
        // human, keeping the agent's conversation and checkout alive under
        // parkPolicy `hold`. Reaping it would silently convert a hold into a release
        // and break the resume. Its lifetime cap still applies, so an abandoned gate
        // cannot bill forever.
        if (worker.state === 'IDLE' && !worker.currentJobId && !worker.parked) {
          const idleForMs = now - (worker.idleSinceMs || worker.lastSeenAtMs || worker.createdAtMs);
          if (idleForMs > workerIdleMs) {
            await releaseWorker({ workerId: worker.workerId });
            idle.push(worker.workerId);
            continue;
          }
        }
        if (worker.maxLifetimeSeconds > 0 && ageSeconds > worker.maxLifetimeSeconds) {
          await releaseWorker({ workerId: worker.workerId });
          expired.push(worker.workerId);
        }
      }
    }

    const orphans = await reapOrphans({ environmentIds });
    return { ok: true, abandoned, timedOut, expired, idle, orphans };
  };

  // EC2 is the authority on which instances exist. Anything running with our tag
  // that the registry has never heard of is an instance nobody will ever reap —
  // a pure cost leak — so it is terminated. Deliberately conservative: only
  // instances old enough that a slow registration cannot explain the absence.
  const reapOrphans = async ({ environmentIds, minAgeMs = 15 * 60 * 1000 } = {}) => {
    const known = new Set();
    for (const environmentId of environmentIds) {
      for (const worker of await registry.listWorkers(environmentId)) {
        if (worker.instanceId) known.add(worker.instanceId);
      }
    }
    const response = await describeInstances({
      Filters: [
        { Name: `tag:${MANAGED_TAG}`, Values: ['worker'] },
        { Name: 'instance-state-name', Values: ['pending', 'running'] },
      ],
    });
    const orphans = [];
    const now = clock();
    for (const reservation of response.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (known.has(instance.InstanceId)) continue;
        const launched = instance.LaunchTime ? new Date(instance.LaunchTime).getTime() : now;
        if (now - launched < minAgeMs) continue;
        const kind = 'EC2';
        await provisionerFor(kind, provisioners).terminate({
          worker: { instanceId: instance.InstanceId, kind },
        });
        orphans.push(instance.InstanceId);
      }
    }
    return orphans;
  };

  return {
    enqueueStage,
    dispatch,
    parkWorker,
    releaseWorker,
    releaseExecution,
    describeFleet,
    issueGrant,
    reconcile,
    reapOrphans,
  };
};

const defaultScheduler = () => {
  const client = getClient();
  return createScheduler({
    registry: createRegistry({ client }),
    provisioners: { EC2: createEc2Provisioner() },
  });
};

export const handler = async (event, _context, scheduler = defaultScheduler()) => {
  const action = event?.action;
  try {
    switch (action) {
      case 'enqueue-stage':
        return await scheduler.enqueueStage(event);
      case 'dispatch':
        return await scheduler.dispatch(event);
      case 'park':
        return await scheduler.parkWorker(event);
      case 'release':
        return event.executionId
          ? await scheduler.releaseExecution(event)
          : await scheduler.releaseWorker(event);
      case 'describe-fleet':
        return await scheduler.describeFleet(event);
      case 'issue-grant':
        return await scheduler.issueGrant(event);
      case 'reconcile':
        return await scheduler.reconcile(event);
      default:
        return { ok: false, reason: 'unknown_action', action: action ?? null };
    }
  } catch (error) {
    console.error('[scheduler] failed', { action, error: error?.message, code: error?.code });
    return { ok: false, reason: error?.code ?? 'scheduler_error', detail: error?.message };
  }
};

export default { handler, createScheduler };
