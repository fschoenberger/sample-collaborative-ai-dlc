// The scheduler — placement authority for stage work.
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
import { commandDefinition } from '../shared/agent-command-registry.js';
import { createRegistry } from '../shared/valkey/registry.js';
import { getClient } from '../shared/valkey/client.js';
import { strategyFor } from './strategies.js';
import {
  MANAGED_TAG,
  createAgentCoreProvisioner,
  createEc2Provisioner,
  provisionerFor,
} from './provisioners.js';

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

const jobIdFor = ({ executionId, stageInstanceId, attempt }) =>
  `job-${executionId}-${stageInstanceId}-${attempt ?? 1}`;

// A provisional id, used only as the CreateFleet idempotency token. The EC2
// worker's real identity is its instance id (see provisioners.js).
const provisionalWorkerId = ({ executionId, stageInstanceId, attempt }) =>
  `p-${executionId}-${stageInstanceId}-${attempt ?? 1}`.slice(0, 60);

// EC2 limits come from the operator's launch spec. AgentCore has no launch spec,
// and bounds its own concurrency, so a session placement is never refused for
// capacity here — our own cap would only be a second, worse limit.
const limitsForTarget = (target) =>
  target.kind === 'EC2'
    ? {
        maxInstances: target.launchSpec?.maxInstances ?? 1,
        maxConcurrentPlacements: target.launchSpec?.maxConcurrentPlacements ?? 1,
      }
    : {
        maxInstances: Number.POSITIVE_INFINITY,
        maxConcurrentPlacements: Number.POSITIVE_INFINITY,
      };

export const createScheduler = ({
  registry,
  provisioners,
  subnetIds = SUBNET_IDS(),
  describeInstances = (input) => ec2.send(new DescribeInstancesCommand(input)),
  leaseIdleMs = LEASE_IDLE_MS(),
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
    sessionId = null,
    projectId = null,
    credentialBinding = null,
    payload = {},
  }) => {
    if (!target?.kind) {
      throw Object.assign(new Error('enqueue-stage requires a resolved target'), {
        code: 'TARGET_REQUIRED',
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

    // Reuse of a QUEUE-delivered worker is an addressed dispatch: the point of
    // reuse is that this specific instance holds the parked conversation, so
    // putting the job on the shared queue would let any worker take it and lose
    // that context.
    //
    // For an INVOKE-delivered worker there is no such thing as a reuse-without-
    // delivery: the session may have been paused out from under us at any moment
    // (idle_runtime_session_timeout, or the park's own stopRuntimeSession), and
    // nothing tells us when. So reuse and provision collapse into the same act —
    // invoke this session id — and the code below handles both. Writing to an
    // addressed stream instead would have hung every AgentCore park-resume, which
    // is the only reuse case the v1 strategy has.
    if (decision.action === 'reuse' && provisioner.delivery === 'queue') {
      await registry.dispatchToWorker({ workerId: decision.workerId, type: 'job', jobId });
      const worker = await registry.getWorker(decision.workerId);
      if (worker) await registry.markBusy(worker, jobId);
      return { ok: true, action: 'reuse', jobId, workerId: decision.workerId };
    }

    // AgentCore's worker id IS its session id, because affinity is what keeps the
    // checkout warm across stages. EC2's is its instance id, known only after the
    // fleet call returns.
    const provisionalId =
      target.kind === 'AGENTCORE'
        ? (sessionId ??
          (() => {
            throw Object.assign(new Error('an AgentCore placement requires a sessionId'), {
              code: 'SESSION_ID_REQUIRED',
            });
          })())
        : provisionalWorkerId({ executionId, stageInstanceId, attempt });

    // QUEUE delivery: enqueue BEFORE provisioning. A worker that boots fast enough
    // to poll before this write would otherwise find an empty queue and idle out;
    // the reverse order costs nothing, because an unclaimed job is exactly what the
    // queue is for.
    if (provisioner.delivery === 'queue') {
      await registry.enqueueJob({ environmentId, jobId });
    }

    // INVOKE delivery carries the payload on the call itself, so the credential
    // grant is minted HERE. For a queued job the worker asks at claim time via
    // issue-grant (a cold boot away, which would race the 300s TTL); for an invoke
    // there is no such gap, so the same minting path is used without the round
    // trip. Both end up handing the container an identical payload.
    let invokePayload = null;
    if (provisioner.delivery === 'invoke') {
      const purpose = commandDefinition(payload.command)?.agentAuth;
      const agentCredentialGrant = purpose
        ? await mintGrant({
            purpose,
            projectId,
            executionId,
            credentialBinding,
          })
        : null;
      invokePayload = {
        ...payload,
        stageCallbackId: stageCallbackId ?? payload.stageCallbackId,
        ...(agentCredentialGrant ? { agentCredentialGrant } : {}),
      };
    }

    let provisioned;
    try {
      provisioned = await provisioner.provision({
        target,
        workerId: provisionalId,
        executionId,
        subnetIds,
        payload: invokePayload,
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
      // Invoke delivery means the job was accepted by the time we get here, so the
      // worker is already BUSY. Calling it PROVISIONING would be a lie the
      // reconciler acts on: it fails a PROVISIONING worker that never registers
      // within bootstrapTimeoutSeconds, and an AgentCore session never registers
      // because it has no poll loop to register from.
      state: provisioned.delivered ? 'BUSY' : 'PROVISIONING',
      ...(provisioned.delivered ? { currentJobId: jobId } : {}),
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
    const agentCredentialGrant = await mintGrant({
      purpose,
      projectId: job.projectId,
      executionId: job.executionId,
      credentialBinding: job.credentialBinding ? JSON.parse(job.credentialBinding) : null,
    });
    return { ok: true, agentCredentialGrant };
  };

  /**
   * The actual minting, shared by both delivery modes.
   *
   * Split out from `issueGrant` because that function's registry check is a guard
   * on the WORKER asking — a worker must not be able to mint a grant for a job it
   * does not hold. When the scheduler mints for its own invoke-delivery it has
   * nothing to prove to itself, and the worker row does not exist yet anyway.
   */
  const mintGrant = async ({ purpose, projectId, executionId, credentialBinding }) => {
    if (!credentialBinding) return null;
    return issueAgentCredentialGrantFn({
      purpose,
      projectId,
      executionId,
      bindings: [credentialBinding],
    });
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
    return { ok: true, released: true, ...result };
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
   *                           bundle fetch looks like.
   *   3. lifetime caps      — a worker older than its spec allows.
   *   4. orphan instances   — running and tagged as ours, but absent from the
   *                           registry. This is the check that makes Valkey
   *                           disposable: EC2 is the authority on what exists.
   */
  const reconcile = async ({ environmentIds = [] } = {}) => {
    const now = clock();
    const abandoned = [];
    const timedOut = [];
    const expired = [];

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
        if (worker.maxLifetimeSeconds > 0 && ageSeconds > worker.maxLifetimeSeconds) {
          await releaseWorker({ workerId: worker.workerId });
          expired.push(worker.workerId);
        }
      }
    }

    const orphans = await reapOrphans({ environmentIds });
    return { ok: true, abandoned, timedOut, expired, orphans };
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
    provisioners: {
      EC2: createEc2Provisioner(),
      AGENTCORE: createAgentCoreProvisioner(),
    },
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
