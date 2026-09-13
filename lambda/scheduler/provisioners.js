// The two ways a worker comes into existence.
//
// This is the whole of the asymmetry between the worker kinds. Above this file
// the scheduler deals in workers; below it, one kind is an EC2 instance and the
// other is an AgentCore session, and everything else about them is identical.
//
//   EC2       CreateFleet against the revision's pinned launch template.
//   AGENTCORE InvokeAgentRuntime against the intent's session id.
//
// DELIVERY. Each provisioner also declares HOW work reaches it, because that is
// not the same for the two kinds and pretending otherwise was a mistake:
//
//   EC2       `delivery: 'queue'`  — the instance polls {e:<envId>}:queue for its
//             whole life, so launching it and giving it work are separate acts.
//   AGENTCORE `delivery: 'invoke'` — the invoke IS the delivery.
//
// Why AgentCore cannot use the queue. InvokeAgentRuntime does two things at once:
// it materializes the microVM (creating it, or routing to the existing one for
// that runtimeSessionId) AND delivers the payload. The materialization half cannot
// be dropped — AgentCore has no "start a session and leave it running" API,
// sessions exist only as a side effect of an invoke — and the platform pauses a
// session that reports /ping Healthy for idle_runtime_session_timeout (900s).
//
// So a session cannot be relied on to be polling anything. Routing its work
// through a queue would mean an invoke to make the session exist, followed by a
// queue read that only happens inside the window that invoke opened — all the
// machinery of a queue for none of its benefit, plus a lease and a heartbeat
// fighting the platform's own idle detection. The queue's real benefits (claim
// contention, work stealing, warm pools) all presume fungible, continuously
// polling workers; an AgentCore session is neither. Its id is SEMANTIC — it is one
// intent's warm checkout, which is why placement means "invoke THIS session" and
// why an AgentCore worker's id IS its session id.
//
// What the two kinds do still share is everything above delivery: one registry,
// one placement strategy, one cost and observability surface, one release path.

import { EC2Client, CreateFleetCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';

// Tag every instance we create so the reconciler can rebuild its inventory from
// EC2 rather than trusting Valkey. This is the mechanism that makes Valkey
// disposable, so the tags are not decoration.
export const MANAGED_TAG = 'aidlc:scheduler';

const fleetTags = ({
  projectName,
  environment,
  environmentId,
  revisionId,
  workerId,
  executionId,
  extra = {},
}) => [
  { Key: MANAGED_TAG, Value: 'worker' },
  { Key: 'aidlc:environmentId', Value: environmentId },
  { Key: 'aidlc:revisionId', Value: revisionId ?? '' },
  { Key: 'aidlc:workerId', Value: workerId },
  { Key: 'aidlc:executionId', Value: executionId ?? '' },
  { Key: 'Name', Value: `${projectName}-worker-${environment}-${environmentId}` },
  ...Object.entries(extra).map(([Key, Value]) => ({ Key, Value: String(Value) })),
];

// CreateFleet overrides carry the parts of the spec that vary per placement:
// instance selection, subnet and spot price. The AMI is NOT here because ImageId is
// not an overridable field at all — it can only come from the launch template,
// which is why the template is created per environment revision.
//
// Note an `instant` request permits only ONE subnet id per override, hence one
// override per (subnet, instance type) pair rather than a comma-joined list.
// The caller resolves launchSpec.availabilityZones to the matching subnet ids
// before calling, so by here `subnetIds` is already the permitted set.
const fleetOverrides = ({ launchSpec, subnetIds }) => {
  const overrides = [];
  for (const subnetId of subnetIds) {
    if (launchSpec.instanceTypes?.length) {
      // Priority is 1-based and LOWER is preferred, which is why instanceTypes
      // order is preserved all the way from the operator's spec.
      for (const [index, instanceType] of launchSpec.instanceTypes.entries()) {
        overrides.push({
          InstanceType: instanceType,
          SubnetId: subnetId,
          Priority: index + 1,
          ...(launchSpec.maxPricePerHour ? { MaxPrice: String(launchSpec.maxPricePerHour) } : {}),
        });
      }
      continue;
    }
    // Attribute-based selection. `InstanceRequirements` and `InstanceType` are
    // mutually exclusive in one override, hence the branch rather than a merge.
    overrides.push({
      SubnetId: subnetId,
      InstanceRequirements: instanceRequirementsFor(launchSpec),
      ...(launchSpec.maxPricePerHour ? { MaxPrice: String(launchSpec.maxPricePerHour) } : {}),
    });
  }
  return overrides;
};

// Translate our narrow requirements vocabulary into the EC2 shape. EC2 demands
// VCpuCount and MemoryMiB always, so defaults stand in when the spec omits them
// rather than letting the API reject the fleet.
export const instanceRequirementsFor = (launchSpec) => {
  const requirements = launchSpec.instanceRequirements ?? {};
  const out = {
    VCpuCount: {
      Min: requirements.vCpuCount?.min ?? 2,
      ...(requirements.vCpuCount?.max ? { Max: requirements.vCpuCount.max } : {}),
    },
    MemoryMiB: {
      Min: requirements.memoryMiB?.min ?? 4096,
      ...(requirements.memoryMiB?.max ? { Max: requirements.memoryMiB.max } : {}),
    },
  };
  if (launchSpec.instanceFamilies?.length) {
    // Families are expressed to EC2 as instance-type globs.
    out.AllowedInstanceTypes = launchSpec.instanceFamilies.map((family) => `${family}.*`);
  }
  if (requirements.acceleratorCount) {
    out.AcceleratorCount = {
      Min: requirements.acceleratorCount.min ?? 1,
      ...(requirements.acceleratorCount.max ? { Max: requirements.acceleratorCount.max } : {}),
    };
  }
  if (requirements.acceleratorManufacturers?.length) {
    out.AcceleratorManufacturers = requirements.acceleratorManufacturers;
  }
  if (requirements.acceleratorTypes?.length) {
    out.AcceleratorTypes = requirements.acceleratorTypes;
  }
  return out;
};

export const createEc2Provisioner = ({ client = new EC2Client({}), env = process.env } = {}) => ({
  kind: 'EC2',

  // An EC2 worker polls the environment queue for its whole life, so launching it
  // and giving it work are genuinely separate acts. See DELIVERY above.
  delivery: 'queue',

  /**
   * Launch exactly one worker. `type: 'instant'` makes CreateFleet synchronous:
   * it returns the instance id or the reason it could not, rather than leaving an
   * async request to be polled — which matters because the caller is holding a
   * stage dispatch open.
   *
   * `workerId` here is a PROVISIONAL id, used only as the idempotency token. The
   * worker's registry identity is its instance id, which is what the runner can
   * read about itself from IMDS without needing tags or per-instance user-data —
   * so the launch template stays identical for every worker of a revision, which
   * is what lets it be pinned per revision at all. The caller registers the row
   * under the returned instanceId.
   */
  async provision({ target, workerId, executionId, subnetIds }) {
    const launchSpec = target.launchSpec ?? {};
    const spot = launchSpec.purchaseOption === 'spot';
    const command = new CreateFleetCommand({
      Type: 'instant',
      LaunchTemplateConfigs: [
        {
          LaunchTemplateSpecification: {
            LaunchTemplateId: target.launchTemplateId,
            Version: String(target.launchTemplateVersion),
          },
          Overrides: fleetOverrides({ launchSpec, subnetIds }),
        },
      ],
      TargetCapacitySpecification: {
        TotalTargetCapacity: 1,
        DefaultTargetCapacityType: spot ? 'spot' : 'on-demand',
        ...(spot && launchSpec.spotFallbackToOnDemand
          ? { OnDemandTargetCapacity: 0, SpotTargetCapacity: 1 }
          : {}),
      },
      ...(spot
        ? {
            SpotOptions: {
              AllocationStrategy: launchSpec.allocationStrategy ?? 'price-capacity-optimized',
            },
          }
        : {
            OnDemandOptions: {
              AllocationStrategy:
                launchSpec.allocationStrategy === 'lowest-price' ? 'lowest-price' : 'prioritized',
            },
          }),
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: fleetTags({
            projectName: env.PROJECT_NAME ?? 'aidlc',
            environment: env.ENVIRONMENT ?? 'dev',
            environmentId: target.environmentId,
            revisionId: target.revisionId,
            workerId,
            executionId,
            extra: launchSpec.tags ?? {},
          }),
        },
      ],
      // Our own idempotency: a retried provision for the same worker must not
      // produce a second instance.
      ClientToken: `worker-${workerId}`,
    });
    const result = await client.send(command);
    const instanceId = result.Instances?.[0]?.InstanceIds?.[0] ?? null;
    if (!instanceId) {
      // `instant` reports per-override failures rather than throwing, so an empty
      // instance list means every candidate was refused — usually insufficient
      // capacity. Surface the actual reasons; "provision failed" is useless here.
      const errors = (result.Errors ?? [])
        .map((e) => `${e.ErrorCode}: ${e.ErrorMessage}`)
        .join('; ');
      throw Object.assign(
        new Error(`no capacity for any candidate instance type${errors ? ` (${errors})` : ''}`),
        { code: 'PROVISION_NO_CAPACITY', errors: result.Errors ?? [] },
      );
    }
    return { workerId, instanceId, fleetId: result.FleetId ?? null };
  },

  async terminate({ worker }) {
    if (!worker.instanceId) return { terminated: false, reason: 'no_instance_id' };
    await client.send(new TerminateInstancesCommand({ InstanceIds: [worker.instanceId] }));
    return { terminated: true };
  },
});

export const createAgentCoreProvisioner = ({ client = new BedrockAgentCoreClient({}) } = {}) => ({
  kind: 'AGENTCORE',

  // The invoke that materializes the session also delivers the job, so nothing
  // for this kind travels on the environment queue. See DELIVERY above.
  delivery: 'invoke',

  /**
   * Materialize the session AND hand it the job — one call, because for AgentCore
   * they cannot be separated.
   *
   * `run-stage-start` accepts in milliseconds and runs the stage as a background
   * job that completes the durable callback itself, so this returns fast without
   * any queue in the middle. The busy tracker holds `/ping` at HealthyBusy for the
   * job's lifetime, which is what keeps the session alive while the stage runs.
   */
  async provision({ target, workerId, payload }) {
    // The worker id IS the session id for AgentCore — affinity is what keeps the
    // checkout warm, so the two cannot be allowed to diverge.
    const response = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: target.agentRuntimeArn,
        ...(target.qualifier ? { qualifier: target.qualifier } : {}),
        runtimeSessionId: workerId,
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    // Drain the body: the accept-then-background reply carries no verdict, but
    // leaving it unread holds the socket open.
    const body = response.response?.transformToString
      ? await response.response.transformToString()
      : null;
    // A non-2xx is a delivery failure and must fail the placement, not sit in a
    // queue nobody is draining.
    if (response.statusCode && response.statusCode >= 300) {
      throw Object.assign(
        new Error(`InvokeAgentRuntime returned ${response.statusCode}: ${body}`),
        {
          code: 'AGENTCORE_DELIVERY_FAILED',
        },
      );
    }
    return { workerId, sessionId: workerId, instanceId: null, fleetId: null, delivered: true };
  },

  async terminate({ worker, target }) {
    try {
      await client.send(
        new StopRuntimeSessionCommand({
          runtimeSessionId: worker.sessionId ?? worker.workerId,
          agentRuntimeArn: target?.agentRuntimeArn,
          ...(target?.qualifier ? { qualifier: target.qualifier } : {}),
        }),
      );
      return { terminated: true };
    } catch (error) {
      // An already-stopped or already-reaped session is the normal case for a
      // parked AgentCore worker, and must never fail a release.
      return { terminated: false, reason: error?.message };
    }
  },
});

export const provisionerFor = (kind, provisioners) => {
  const provisioner = provisioners[kind];
  if (!provisioner) {
    throw Object.assign(new Error(`no provisioner for worker kind "${kind}"`), {
      code: 'UNKNOWN_WORKER_KIND',
    });
  }
  return provisioner;
};

export default {
  MANAGED_TAG,
  createEc2Provisioner,
  createAgentCoreProvisioner,
  instanceRequirementsFor,
  provisionerFor,
};
