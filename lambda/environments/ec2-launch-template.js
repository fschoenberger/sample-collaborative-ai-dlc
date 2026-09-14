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
// Bumped to 2 when workers started shipping their log to CloudWatch. A published
// revision's template is frozen, so a revision built before this still boots a
// worker whose journal dies with the instance — and this is the field that says
// which revisions those are, without diffing base64 user-data to find out.
export const LAUNCH_TEMPLATE_CONTRACT_VERSION = 2;

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
  // HOME, because systemd gives a service NONE and git refuses to run without
  // one — "fatal: $HOME not set". The first real stage placed on an instance died
  // exactly here: the worker registered, claimed its job and opened the callback
  // heartbeat, then every git call failed and it surfaced as
  // `workspace_restore_failed: could not re-clone`. git also needs it to find
  // ~/.gitconfig and the credential helper the engine writes.
  //
  // Set from user-data as well as in the AMI's unit file, deliberately: an
  // operator's older AMI predates the unit fix, and this makes such an image work
  // rather than fail on its first clone.
  HOME: '/root',
  // The reconciler enforces these, and a self-registering worker can only report
  // them if it is told them.
  AIDLC_MAX_LIFETIME_SECONDS: String(spec.maxLifetimeSeconds ?? 0),
  // One job per worker under per-stage-ephemeral. Set explicitly rather than left
  // to the runner's default so the env file states the strategy's contract, and so
  // a future pooling strategy raises it here where the strategy is known.
  AIDLC_MAX_JOBS: String(spec.strategyId === 'per-stage-ephemeral' ? 1 : 0),
  AIDLC_BOOTSTRAP_TIMEOUT_SECONDS: String(spec.bootstrapTimeoutSeconds ?? 0),
});

// Where the CloudWatch agent lives in the AMI, and what it reads. Fixed paths, all
// three of them created by scripts/provision-worker-ami.sh or by the units it
// installs — nothing here is downloaded at boot.
const CWAGENT_CTL = '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl';
const CWAGENT_CONFIG = '/etc/aidlc-cloudwatch-agent.json';
const RUNNER_LOG = '/var/log/aidlc/runner.log';
const BOOTSTRAP_LOG = '/var/log/aidlc-bootstrap.log';

/**
 * The CloudWatch agent config for one worker.
 *
 * Templated at boot rather than baked into the AMI because the stream carries the
 * environment id, and an image is shared by every environment that names it.
 *
 * `{instance_id}` is the AGENT's placeholder, not ours: it resolves it from IMDS
 * itself, so user-data does not have to fetch a token and query the metadata
 * service just to name a stream.
 *
 * The bootstrap log ships too, and that is the half that matters when a worker
 * never appears at all: if the runner did not start there is no runner log to read,
 * and cloud-init's account of why is the only evidence there will ever be.
 *
 * No `retention_in_days` here on purpose — retention belongs to the Terraform-owned
 * group, and setting it here would demand logs:PutRetentionPolicy on every worker.
 */
export const cloudWatchAgentConfig = ({ environmentId, platform }) => ({
  logs: {
    logs_collected: {
      files: {
        collect_list: [
          {
            file_path: RUNNER_LOG,
            log_group_name: platform.workerLogGroup,
            log_stream_name: `${environmentId}/{instance_id}`,
            timezone: 'UTC',
          },
          {
            file_path: BOOTSTRAP_LOG,
            log_group_name: platform.workerLogGroup,
            log_stream_name: `${environmentId}/{instance_id}/bootstrap`,
            timezone: 'UTC',
          },
        ],
      },
    },
  },
});

/**
 * The user-data fragment that starts log shipping.
 *
 * NEVER fatal, unlike the missing-runner check above it. A worker that cannot ship
 * its log is a worker an operator will struggle to debug; a worker that refuses to
 * boot is a stage that fails outright. The second is strictly worse, so every
 * failure here is a warning and the stage runs anyway.
 *
 * Guarded on the agent binary for the same reason `HOME` is set in two places: an
 * operator's existing AMI predates this change, and an image without the agent must
 * keep working rather than fail on a path that is not there.
 */
const renderLogShipping = ({ environmentId, platform }) => {
  if (!platform.workerLogGroup) {
    return `
echo "[aidlc] WARNING: no worker log group configured; this worker's log will be destroyed with the instance" >&2
`;
  }
  const config = JSON.stringify(cloudWatchAgentConfig({ environmentId, platform }), null, 2);
  return `
# Ship the runner's log to CloudWatch BEFORE the runner starts, because this
# instance is terminated the moment its stage ends (per-stage-ephemeral) and the
# journal is destroyed with it. Group and stream are fixed and greppable:
#   ${platform.workerLogGroup} / ${environmentId}/<instanceId>
if [ -x ${CWAGENT_CTL} ]; then
  cat > ${CWAGENT_CONFIG} <<'AIDLC_CWAGENT'
${config}
AIDLC_CWAGENT
  # HOME, because it is unset here and Go's os.UserHomeDir fails without it. The
  # agent's own translator reads the shared AWS config on start-up.
  if ! HOME=/root ${CWAGENT_CTL} -a fetch-config -m ec2 -s -c file:${CWAGENT_CONFIG}; then
    echo "[aidlc] WARNING: CloudWatch agent did not start; this stage's log will not outlive the instance" >&2
  fi
else
  echo "[aidlc] WARNING: no CloudWatch agent in this AMI; rebuild it with scripts/provision-worker-ami.sh" >&2
fi
`;
};

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
  const logShipping = renderLogShipping({ environmentId, platform });

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
${logShipping}
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
  cloudWatchAgentConfig,
  renderUserData,
  launchTemplateInput,
  createLaunchTemplateForRevision,
};
