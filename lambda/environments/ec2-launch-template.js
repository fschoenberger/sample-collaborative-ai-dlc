// The launch template for an EC2 environment revision.
//
// Created when a revision is BUILT, from the operator's submitted spec, and
// stamped onto the revision as `launchTemplateId` + `launchTemplateVersion`. That
// is the exact shape `createRuntimeForRevision` already uses for AgentCore
// runtimes (status.js): platform-owned ingredients come from Terraform via env
// vars, the spec-derived parts come from the revision, and a clientToken makes it
// idempotent.
//
// Per revision rather than one shared template, for a reason the API dictates:
// `ImageId` is NOT among the fields `FleetLaunchTemplateOverridesRequest` accepts
// (it takes availabilityZone, availabilityZoneId, blockDeviceMappings,
// iamInstanceProfile, instanceRequirements, instanceType, keyName, maxPrice,
// metadataOptions, networkInterfaces, placement, priority, subnetId,
// weightedCapacity). So the AMI can only come from the template — and the AMI is
// per environment revision. `userData` is likewise not overridable.
//
// It also gives the property we want anyway: a published revision has a FROZEN
// launch identity, so republishing an environment cannot move where an
// already-running intent places its stages.
//
// WHAT THE AMI MUST PROVIDE. The worker runtime lives IN the AMI: an operator
// builds it with scripts/provision-worker-ami.sh, which installs Node, the agent
// CLIs, the toolchain and the runner itself. user-data therefore only has to hand
// the instance its environment and start the service — nothing is downloaded at
// boot, so a stage is not waiting on a fetch before it can start.

import { CreateLaunchTemplateCommand } from '@aws-sdk/client-ec2';

// Bumped when the generated user-data changes in a way existing revisions should
// not silently inherit. Recorded on the revision alongside the template id.
export const LAUNCH_TEMPLATE_CONTRACT_VERSION = 1;

const shellQuote = (value) => `'${String(value ?? '').replaceAll("'", `'\\''`)}'`;

/**
 * The env file the systemd unit reads. Deliberately a file rather than baked into
 * the unit so the bundle is byte-identical for every environment and can be
 * digest-pinned.
 */
export const runnerEnvironment = ({ spec, environmentId, revisionId, platform }) => ({
  AIDLC_ENVIRONMENT_ID: environmentId,
  AIDLC_REVISION_ID: revisionId,
  VALKEY_HOST: platform.valkeyHost,
  VALKEY_PORT: String(platform.valkeyPort),
  SCHEDULER_FUNCTION: platform.schedulerFunction,
  V2_PROCESS_TABLE: platform.processTable,
  BLOCKS_TABLE: platform.blocksTable,
  ARTIFACTS_BUCKET: platform.artifactsBucket,
  NEPTUNE_ENDPOINT: platform.neptuneEndpoint,
  CONNECTIONS_TABLE: platform.connectionsTable,
  WEBSOCKET_ENDPOINT: platform.websocketEndpoint,
  CREDENTIAL_BROKER_FUNCTION: platform.credentialBrokerFunction,
  SOURCE_CONTROL_FUNCTION: platform.sourceControlFunction,
  MCP_SECRETS_SSM_PREFIX: platform.mcpSecretsPrefix,
  AIDLC_REPO_REF: platform.aidlcRepoRef ?? '',
  BEDROCK_MODEL: platform.bedrockModel ?? '',
  AWS_REGION: platform.region,
  RUNTIME_COMPATIBILITY_VERSION: String(platform.runtimeCompatibilityVersion ?? '1'),
  V2_WORKSPACE_DIR: spec.workspacePath ?? '/mnt/workspace',
});

/**
 * Cloud-init user-data.
 *
 * Ordering matters and is deliberate: the digest is verified BEFORE anything from
 * the bundle is executed, and the unit is only started once the environment file
 * exists, so a worker never starts half-configured and register itself as ready.
 */
export const renderUserData = ({ spec, environmentId, revisionId, platform }) => {
  const env = runnerEnvironment({ spec, environmentId, revisionId, platform });
  const envLines = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const workspace = spec.workspacePath ?? '/mnt/workspace';

  return `#!/usr/bin/env bash
# Managed by AI-DLC. Starts the stage worker that is already installed in the AMI.
set -euo pipefail
exec > >(tee /var/log/aidlc-bootstrap.log) 2>&1

echo "[aidlc] starting worker for environment ${environmentId} revision ${revisionId}"

# The runner is baked into the AMI by scripts/provision-worker-ami.sh. If it is
# missing, this AMI was not provisioned for AI-DLC — fail loudly here rather than
# leave an instance running that will never claim a job.
if [ ! -x /opt/aidlc-runner/bin/aidlc-runner ]; then
  echo "[aidlc] FATAL: /opt/aidlc-runner is missing; this AMI is not provisioned for AI-DLC" >&2
  exit 1
fi

install -d -m 0755 ${shellQuote(workspace)}

cat > /etc/aidlc-runner.env <<'AIDLC_ENV'
${envLines}
AIDLC_ENV
chmod 0600 /etc/aidlc-runner.env

systemctl daemon-reload
systemctl enable --now aidlc-runner.service

echo "[aidlc] worker started"
`;
};

/**
 * Build the CreateLaunchTemplate input.
 *
 * Everything platform-owned is asserted here rather than taken from the spec:
 * IMDSv2-only, encrypted EBS, no public IP by default, the platform instance
 * profile. An operator can add security groups and extra volumes; they cannot
 * weaken these.
 */
export const launchTemplateInput = ({ spec, environmentId, revisionId, platform }) => {
  const volume = spec.rootVolume ?? {};
  return {
    LaunchTemplateName:
      `${platform.projectName}-worker-${platform.environment}-${environmentId}-${revisionId}`.slice(
        0,
        125,
      ),
    VersionDescription: `contract ${LAUNCH_TEMPLATE_CONTRACT_VERSION}`,
    ClientToken: `lt-${environmentId}-${revisionId}`,
    LaunchTemplateData: {
      ImageId: spec.imageId,
      IamInstanceProfile: { Arn: platform.instanceProfileArn },
      // IMDSv2 only. The worker reads its own instance id from IMDS to learn its
      // identity, so the endpoint must be enabled — but v1 must not be.
      MetadataOptions: {
        HttpTokens: 'required',
        HttpEndpoint: 'enabled',
        HttpPutResponseHopLimit: 2,
      },
      Monitoring: { Enabled: false },
      // Top-level SecurityGroupIds, NOT a NetworkInterfaces block. EC2 rejects a
      // request that carries both network interfaces and an instance-level subnet
      // ("Network interfaces and an instance-level subnet ID may not be specified
      // on the same request"), and the scheduler's CreateFleet overrides MUST set
      // SubnetId to spread placement across AZs and fall back on capacity errors.
      // So the subnet comes from the override and the groups come from here.
      SecurityGroupIds: [platform.securityGroupId, ...(spec.securityGroupIds ?? [])],
      BlockDeviceMappings: [
        {
          DeviceName: platform.rootDeviceName ?? '/dev/xvda',
          Ebs: {
            VolumeSize: volume.sizeGiB ?? 100,
            VolumeType: volume.type ?? 'gp3',
            ...(volume.iops ? { Iops: volume.iops } : {}),
            ...(volume.throughput ? { Throughput: volume.throughput } : {}),
            Encrypted: true,
            DeleteOnTermination: true,
          },
        },
      ],
      UserData: Buffer.from(renderUserData({ spec, environmentId, revisionId, platform })).toString(
        'base64',
      ),
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'aidlc:environmentId', Value: environmentId },
            { Key: 'aidlc:revisionId', Value: revisionId },
          ],
        },
      ],
    },
    TagSpecifications: [
      {
        ResourceType: 'launch-template',
        Tags: [
          { Key: 'aidlc:environmentId', Value: environmentId },
          { Key: 'aidlc:revisionId', Value: revisionId },
        ],
      },
    ],
  };
};

/**
 * Create the template for a revision. Returns the frozen launch identity to stamp
 * on it.
 *
 * `ClientToken` makes this idempotent, which matters because the build path can be
 * retried: a second call for the same revision must not leave a second template
 * behind for nobody to clean up.
 */
export const createLaunchTemplateForRevision = async ({
  ec2,
  spec,
  environmentId,
  revisionId,
  platform,
}) => {
  const input = launchTemplateInput({ spec, environmentId, revisionId, platform });
  // 16 KB is the hard user-data limit, and a bootstrap that exceeds it fails at
  // launch rather than here — check while the error can still name the cause.
  const userDataBytes = Buffer.from(input.LaunchTemplateData.UserData, 'base64').length;
  if (userDataBytes > 16_384) {
    throw Object.assign(
      new Error(`generated user-data is ${userDataBytes} bytes, over the 16 KB EC2 limit`),
      { code: 'USER_DATA_TOO_LARGE' },
    );
  }
  const result = await ec2.send(new CreateLaunchTemplateCommand(input));
  const template = result.LaunchTemplate;
  if (!template?.LaunchTemplateId) {
    throw Object.assign(new Error('EC2 did not return a launch template identity'), {
      code: 'LAUNCH_TEMPLATE_INCOMPLETE',
    });
  }
  return {
    launchTemplateId: template.LaunchTemplateId,
    launchTemplateVersion: String(template.LatestVersionNumber ?? 1),
    contractVersion: LAUNCH_TEMPLATE_CONTRACT_VERSION,
  };
};

export default {
  LAUNCH_TEMPLATE_CONTRACT_VERSION,
  runnerEnvironment,
  renderUserData,
  launchTemplateInput,
  createLaunchTemplateForRevision,
};
