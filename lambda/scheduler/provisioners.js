// How an EC2 worker comes into existence, and how it stops existing.
//
// CreateFleet against the revision's pinned launch template, TerminateInstances to
// take it away again. That is the whole of this file.
//
// AGENTCORE IS NOT PROVISIONED HERE, and that is not an omission. A session is not
// a machine we own: there is nothing to launch, nothing to terminate, no capacity
// to ration and no liveness we could observe, because the Bedrock AgentCore
// platform owns a session's lifecycle — it is materialized by InvokeAgentRuntime
// and reaped by the platform's own idle timeout. So an AgentCore stage is
// dispatched straight from the orchestrator (see `runStage` in
// lambda/v2-orchestrator/index.js), the same way every other container command
// there is, and never reaches this Lambda.
//
// Everything on this side of that line exists because an EC2 instance keeps
// costing money until somebody kills it: the registry, the leases, the limits and
// the reconcile sweep are all consequences of ownership, and none of them has an
// AgentCore meaning.

import { createHash } from 'node:crypto';
import { EC2Client, CreateFleetCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';

// Tag every instance we create so the reconciler can rebuild its inventory from
// EC2 rather than trusting Valkey. This is the mechanism that makes Valkey
// disposable, so the tags are not decoration.
export const MANAGED_TAG = 'aidlc:scheduler';

/**
 * The CreateFleet idempotency token: a HASH of the worker id AND the placement
 * generation, never a truncation of either.
 *
 * EC2 caps a client token at 64 characters. `worker-${workerId}` blew that,
 * because the caller's id already carries an executionId plus a stageInstanceId.
 * Truncating to fit would be worse than the error it replaces: two stages whose
 * ids share a prefix would submit the SAME token, and CreateFleet would dedupe
 * and hand both of them the same instance. Hashing is fixed-length and keeps the
 * property the token exists for — a retried provision for one worker must not
 * produce a second instance.
 *
 * `generation` is what makes the token unique per PLACEMENT rather than per stage
 * attempt, and it is not optional. The worker id is
 * `p-<executionId>-<stageInstanceId>-<attempt>`, which is identical for two
 * genuinely different placements of the same attempt number — a resume-after-park
 * is attempt 2, and so is a later rewind retry of that same stage. CreateFleet's
 * idempotency window is 24 HOURS, so the second call got the first call's response
 * replayed: a `fleetInstanceSet` naming an instance that had already been
 * terminated, with `errorSet` empty and no error anywhere to notice. The scheduler
 * wrote a worker row for a dead instance, the orchestrator suspended on a callback
 * nobody would ever complete, and the run hung until the 15-minute heartbeat.
 * Observed exactly that, twice over the same stage instance.
 *
 * The orchestrator run id is the right generation: the durable SDK re-invokes a
 * retried step with the same run id, so a genuine retry still dedupes, while every
 * relaunch (rewind, retry-from-failed) mints a new one and therefore places afresh.
 */
export const clientTokenFor = (workerId, generation) =>
  `worker-${createHash('sha256')
    .update(`${String(workerId)}|${String(generation ?? '')}`)
    .digest('hex')
    .slice(0, 40)}`;

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
  async provision({ target, workerId, executionId, subnetIds, generation = null }) {
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
      // Our own idempotency: a retried provision for the same worker WITHIN one
      // orchestrator run must not produce a second instance. Across runs it must,
      // which is what `generation` carries — see clientTokenFor.
      ClientToken: clientTokenFor(workerId, generation),
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
  instanceRequirementsFor,
  provisionerFor,
};
