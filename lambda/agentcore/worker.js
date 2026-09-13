// The worker loop — what an EC2 worker actually does.
//
// Register, claim work off the environment queue, run it through the SAME
// dispatchInvocation the HTTP server uses, ack, exit when told.
//
// EC2 ONLY, deliberately. An AgentCore session cannot run this loop: the platform
// pauses a session whose /ping reports Healthy for idle_runtime_session_timeout
// (900s), and a loop blocked on XREAD reports exactly that — so it would be
// polling a queue only inside windows an invoke happened to open. AgentCore work
// is delivered ON the invoke instead (see lambda/scheduler/provisioners.js). The
// two kinds share the registry, the placement strategy and the release path; they
// do not share delivery.
//
// WHY TWO READERS. A worker watches two streams:
//
//   {e:<envId>}:queue   unassigned work, claimed via a consumer group so exactly
//                       one worker of the environment gets each job.
//   {w:<workerId>}:stream  addressed work — a resume that must land on THIS
//                       worker because it holds the parked conversation, plus
//                       cancel and shutdown.
//
// Those keys are deliberately in different cluster slots (see shared/valkey/keys.js),
// so they CANNOT be read in one XREADGROUP — that would be CROSSSLOT on
// ElastiCache. Hence two loops on two connections; a blocking read monopolizes
// its connection, so they cannot share one either.
//
// WHY THE VERDICT DOES NOT COME BACK THROUGH HERE. The job handler completes the
// orchestrator's durable callback itself, exactly as run-stage-start already does
// over HTTP. Valkey carries work TO a worker and never carries results back, so a
// Valkey outage delays placement but cannot lose a verdict.

import { createRegistry } from '../shared/valkey/registry.js';
import { createClient } from '../shared/valkey/client.js';
import { CONSUMER_GROUP, environmentQueueKey, workerStreamKey } from '../shared/valkey/keys.js';
import { commandDefinition } from './command-registry.js';

const IMDS_BASE = 'http://169.254.169.254';
const HEARTBEAT_MS = 30_000;
const CLAIM_BLOCK_MS = 5_000;

/**
 * An EC2 worker's identity is its own instance id, read from IMDSv2.
 *
 * This is why the launch template can be identical for every worker of a
 * revision — no per-instance user-data and no tag lookup is needed for a worker
 * to know who it is, which is what lets the template be pinned per revision.
 */
export const resolveInstanceId = async ({ fetchImpl = fetch, base = IMDS_BASE } = {}) => {
  const tokenResponse = await fetchImpl(`${base}/latest/api/token`, {
    method: 'PUT',
    headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '60' },
  });
  if (!tokenResponse.ok) throw new Error(`IMDS token request failed: ${tokenResponse.status}`);
  const token = await tokenResponse.text();
  const idResponse = await fetchImpl(`${base}/latest/meta-data/instance-id`, {
    headers: { 'x-aws-ec2-metadata-token': token },
  });
  if (!idResponse.ok) throw new Error(`IMDS instance-id request failed: ${idResponse.status}`);
  return (await idResponse.text()).trim();
};

/**
 * Reconstruct the job payload the handler expects.
 *
 * The orchestrator stores the payload on the job rather than shipping it through
 * the launch, so nothing about a worker's boot path is per-job. `command` is
 * asserted rather than assumed: an unknown command means a version skew between
 * the orchestrator and this image, and running it blind would be worse than
 * failing the stage.
 */
export const jobInvocation = (job) => {
  const payload = job?.payload ?? {};
  if (!payload.command) {
    throw Object.assign(new Error('job payload carries no command'), { code: 'JOB_NO_COMMAND' });
  }
  return {
    ...payload,
    stageCallbackId: job.stageCallbackId || payload.stageCallbackId,
  };
};

export const createWorker = ({
  workerId,
  environmentId,
  revisionId = null,
  client,
  addressedClient,
  dispatchInvocation,
  handlers,
  busy,
  prepareInvocation = null,
  // Asks the scheduler for an agent credential grant. Injected so the loop can be
  // tested without a Lambda, and so the worker never holds the signing secret.
  requestGrant = async () => ({ ok: true, agentCredentialGrant: null }),
  logger = console,
  clock = () => Date.now(),
  heartbeatMs = HEARTBEAT_MS,
  blockMs = CLAIM_BLOCK_MS,
  maxLifetimeSeconds = 0,
  bootstrapTimeoutSeconds = 0,
}) => {
  const registry = createRegistry({ client, clock });
  let running = false;
  let shuttingDown = false;
  let heartbeatTimer = null;

  const runJob = async (job, { entryId = null } = {}) => {
    const worker = await registry.getWorker(workerId);
    // markBusy BEFORE asking for a grant: the scheduler will only mint one for a
    // worker the registry agrees is holding this job.
    if (worker) await registry.markBusy(worker, job.jobId);
    busy?.enter();
    try {
      const payload = jobInvocation(job);
      // Agent credentials. The grant lives 300s, so it is minted now — at claim
      // time — rather than when the orchestrator enqueued this job, which for an
      // EC2 worker was a cold boot ago. The worker deliberately cannot sign its
      // own: it asks the scheduler, which checks the registry first.
      const agentAuth = commandDefinition(payload.command)?.agentAuth;
      if (agentAuth) {
        const grant = await requestGrant({
          workerId,
          jobId: job.jobId,
          purpose: agentAuth,
        });
        if (!grant?.ok) {
          logger.error?.('[worker] no credential grant', {
            jobId: job.jobId,
            reason: grant?.reason,
          });
          await registry.setJobState(job.jobId, 'FAILED', {
            failureReason: grant?.reason ?? 'grant_denied',
          });
          return null;
        }
        if (grant.agentCredentialGrant) payload.agentCredentialGrant = grant.agentCredentialGrant;
      }
      const result = await dispatchInvocation({
        payload,
        handlers,
        busy: null, // already held for the whole job below
        // Without this the container never resolves the grant into CLI
        // credentials, and every authenticated stage would run unauthenticated.
        prepareInvocation,
      });
      await registry.setJobState(job.jobId, result?.statusCode === 200 ? 'DONE' : 'FAILED');
      return result;
    } catch (error) {
      logger.error?.('[worker] job failed', { jobId: job.jobId, error: error?.message });
      await registry.setJobState(job.jobId, 'FAILED', {
        failureReason: error?.code ?? 'job_error',
      });
      // Deliberately swallowed. The stage verdict travels on the durable callback,
      // which the handler owns; a throw here would only kill the loop and turn one
      // failed stage into a dead worker.
      return null;
    } finally {
      busy?.leave();
      // ACK after the job is finished, not when it is claimed: an unacked entry is
      // exactly what lets the reconciler notice a worker that died mid-stage.
      if (entryId) await registry.ackJob({ environmentId, entryId }).catch(() => {});
      const current = await registry.getWorker(workerId);
      if (current) await registry.markIdle(current);
    }
  };

  // Unassigned work. XREADGROUP with a block is the claim: the entry moves into
  // the group's pending list under this worker's name, which IS the lease.
  const claimLoop = async () => {
    while (running && !shuttingDown) {
      let delivered;
      try {
        delivered = await client.xreadgroup(
          'GROUP',
          CONSUMER_GROUP,
          workerId,
          'COUNT',
          1,
          'BLOCK',
          blockMs,
          'STREAMS',
          environmentQueueKey(environmentId),
          '>',
        );
      } catch (error) {
        if (/NOGROUP/i.test(error?.message ?? '')) {
          // The scheduler creates the group when it enqueues; a worker that boots
          // first would otherwise spin on this error.
          await registry.ensureGroup(environmentId);
          continue;
        }
        logger.error?.('[worker] claim read failed', { error: error?.message });
        continue;
      }
      if (!delivered) continue;
      for (const [, entries] of delivered) {
        for (const [entryId, fields] of entries) {
          const map = {};
          for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
          const job = await registry.getJob(map.jobId);
          if (!job) {
            logger.error?.('[worker] claimed an entry with no job row', { jobId: map.jobId });
            await registry.ackJob({ environmentId, entryId }).catch(() => {});
            continue;
          }
          await runJob(job, { entryId });
        }
      }
    }
  };

  // Addressed work. A separate connection because the claim loop's blocking read
  // owns its own, and a separate command because the two streams are in different
  // cluster slots and cannot be read together.
  const addressedLoop = async () => {
    let cursor = '$';
    while (running && !shuttingDown) {
      let delivered;
      try {
        delivered = await addressedClient.xread(
          'BLOCK',
          blockMs,
          'STREAMS',
          workerStreamKey(workerId),
          cursor,
        );
      } catch (error) {
        logger.error?.('[worker] addressed read failed', { error: error?.message });
        continue;
      }
      if (!delivered) continue;
      for (const [, entries] of delivered) {
        for (const [entryId, fields] of entries) {
          cursor = entryId;
          const map = {};
          for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
          if (map.type === 'shutdown' || map.type === 'cancel') {
            logger.error?.('[worker] shutting down', { type: map.type, reason: map.reason });
            shuttingDown = true;
            continue;
          }
          if (map.type === 'job') {
            const job = await registry.getJob(map.jobId);
            if (job) await runJob(job);
          }
        }
      }
    }
  };

  const beat = async () => {
    const alive = await registry.heartbeat(workerId).catch(() => true);
    if (!alive) {
      // The row is gone: this beat came too late to renew the lease, or the
      // reconciler released the worker outright. Either way it has been written
      // off, and a written-off worker that keeps claiming jobs is worse than one
      // that exits — so exit, and let reapOrphans collect the instance.
      logger.error?.('[worker] registry row is gone; exiting');
      shuttingDown = true;
    }
  };

  return {
    async start() {
      running = true;
      // Register with the fields the RECONCILER needs, not just identity. It
      // terminates by instanceId and enforces caps from maxLifetimeSeconds /
      // bootstrapTimeoutSeconds; a self-registered worker missing them is
      // unreapable and leaks an instance.
      await registry.putWorker({
        workerId,
        kind: 'EC2',
        environmentId,
        revisionId,
        state: 'IDLE',
        // The instance id, so the reconciler can terminate this worker. A
        // self-registered row without it is unreapable and leaks an instance.
        instanceId: workerId,
        sessionId: null,
        createdAtMs: clock(),
        maxLifetimeSeconds,
        bootstrapTimeoutSeconds,
      });
      await registry.ensureGroup(environmentId);
      const worker = await registry.getWorker(workerId);
      if (worker) await registry.markIdle(worker);
      heartbeatTimer = setInterval(() => void beat(), heartbeatMs);
      // Both loops run until one of them sets shuttingDown.
      await Promise.all([claimLoop(), addressedLoop()]);
      return { stopped: true };
    },
    async stop() {
      shuttingDown = true;
      running = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
    get shuttingDown() {
      return shuttingDown;
    },
  };
};

/**
 * Runner entry: resolve identity from IMDS, wire the same handlers the HTTP server
 * uses, and run the loop. Started by the systemd unit the AMI carries.
 *
 * Not used by the AgentCore image, which keeps its HTTP server and receives work
 * on the invoke.
 */
export const main = async ({ env = process.env } = {}) => {
  const { dispatchInvocation } = await import('./http-server.js');
  const { buildHandlers } = await import('./handlers.js');
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const { parseLambdaPayload } = await import('../shared/lambda-payload.js');
  const environmentId = env.AIDLC_ENVIRONMENT_ID;
  const revisionId = env.AIDLC_REVISION_ID ?? null;
  if (!environmentId) throw new Error('AIDLC_ENVIRONMENT_ID is not configured');

  const workerId = await resolveInstanceId();
  const client = createClient({ env });
  const addressedClient = createClient({ env });
  const { handlers, busy, invocationContext } = await buildHandlers();

  // Ask the scheduler for a credential grant at claim time. The worker cannot sign
  // one itself by design — that is what makes the grant an authorization rather
  // than a formality.
  const lambdaClient = new LambdaClient({});
  const requestGrant = async (input) => {
    const schedulerFn = env.SCHEDULER_FUNCTION;
    if (!schedulerFn) return { ok: false, reason: 'scheduler_not_configured' };
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: schedulerFn,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify({ action: 'issue-grant', ...input })),
      }),
    );
    if (response.FunctionError) return { ok: false, reason: 'grant_invocation_failed' };
    return parseLambdaPayload(response.Payload) ?? { ok: false, reason: 'grant_empty_response' };
  };

  const worker = createWorker({
    workerId,
    environmentId,
    revisionId,
    maxLifetimeSeconds: Number(env.AIDLC_MAX_LIFETIME_SECONDS || 0),
    bootstrapTimeoutSeconds: Number(env.AIDLC_BOOTSTRAP_TIMEOUT_SECONDS || 0),
    client,
    addressedClient,
    dispatchInvocation,
    handlers,
    busy,
    prepareInvocation: invocationContext,
    requestGrant,
  });
  const stop = () => void worker.stop();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.error(`[worker] starting workerId=${workerId} environment=${environmentId}`);
  await worker.start();
  console.error('[worker] stopped');
};

export default { createWorker, resolveInstanceId, jobInvocation, main };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[worker] fatal:', error);
    process.exit(1);
  });
}
