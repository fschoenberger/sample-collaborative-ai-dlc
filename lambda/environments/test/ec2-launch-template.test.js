import { describe, expect, it, vi } from 'vitest';
import {
  LAUNCH_TEMPLATE_CONTRACT_VERSION,
  cloudWatchAgentConfig,
  createLaunchTemplateForRevision,
  launchTemplateInput,
  renderUserData,
  runnerEnvironment,
} from '../ec2-launch-template.js';
import { validateEc2LaunchSpec } from '../ec2-launch-spec.js';

const spec = (overrides = {}) =>
  validateEc2LaunchSpec({
    imageRef: 'ami-0414318400ea0708a',
    architecture: 'x86_64',
    instanceTypes: ['c7i.2xlarge'],
    ...overrides,
  }).spec;

const platform = (overrides = {}) => ({
  projectName: 'collaborative-ai-dlc',
  environment: 'dev',
  region: 'eu-central-1',
  instanceProfileArn: 'arn:aws:iam::1:instance-profile/executor',
  securityGroupId: 'sg-platform',
  valkeyHost: 'cache.example',
  valkeyPort: 6379,
  schedulerFunction: 'collaborative-ai-dlc-scheduler-dev',
  processTable: 'v2-exec',
  blocksTable: 'blocks',
  artifactsBucket: 'artifacts',
  neptuneEndpoint: 'neptune.example',
  connectionsTable: 'connections',
  websocketEndpoint: 'wss://ws.example',
  credentialBrokerFunction: 'broker',
  sourceControlFunction: 'source-control',
  mcpSecretsPrefix: '/collaborative-ai-dlc/dev',
  workerLogGroup: '/aidlc/worker/collaborative-ai-dlc-dev',
  ...overrides,
});

const decodeUserData = (input) =>
  Buffer.from(input.LaunchTemplateData.UserData, 'base64').toString('utf8');

describe('runnerEnvironment', () => {
  it('carries the identity a worker needs to find its own queue', () => {
    const env = runnerEnvironment({
      spec: spec(),
      environmentId: 'cpp-buildhost',
      revisionId: 'r-9',
      platform: platform(),
    });
    expect(env).toMatchObject({
      AIDLC_ENVIRONMENT_ID: 'cpp-buildhost',
      AIDLC_REVISION_ID: 'r-9',
      VALKEY_HOST: 'cache.example',
      VALKEY_PORT: '6379',
      SCHEDULER_FUNCTION: 'collaborative-ai-dlc-scheduler-dev',
    });
  });

  it('honours a spec workspace path', () => {
    const env = runnerEnvironment({
      spec: spec({ workspacePath: '/data/ws' }),
      environmentId: 'e',
      revisionId: 'r',
      platform: platform(),
    });
    expect(env.V2_WORKSPACE_DIR).toBe('/data/ws');
  });
});

describe('renderUserData', () => {
  const userData = () =>
    renderUserData({
      spec: spec(),
      environmentId: 'cpp-buildhost',
      revisionId: 'r-9',
      platform: platform(),
    });

  it('sets HOME, because git refuses to run without one', () => {
    // REGRESSION: systemd gives a service no $HOME, and every git invocation dies
    // with "fatal: $HOME not set". The first stage ever placed on an instance
    // registered, claimed its job and opened the callback heartbeat, then failed as
    // `workspace_restore_failed: could not re-clone` — a one-word omission that
    // breaks the one thing every stage does first.
    expect(userData()).toMatch(/^HOME=\/root$/m);
  });

  it('fails loudly when the AMI has no runner installed', () => {
    // The runner is baked in by provision-worker-ami.sh. If it is absent this AMI
    // was never provisioned for AI-DLC, and an instance that keeps running would
    // just sit there never claiming a job.
    const script = userData();
    expect(script).toContain('/opt/aidlc-runner/bin/aidlc-runner');
    expect(script).toMatch(/FATAL.*not provisioned for AI-DLC/);
    expect(script).toContain('exit 1');
  });

  it('downloads nothing at boot', () => {
    // Everything is in the AMI, so a stage never waits on a fetch before starting.
    const script = userData();
    expect(script).not.toMatch(/\bcurl\b/);
    expect(script).not.toMatch(/aws s3 cp/);
    expect(script).not.toMatch(/sha256sum/);
  });

  it('restricts the environment file, which carries endpoints and table names', () => {
    expect(userData()).toContain('chmod 0600 /etc/aidlc-runner.env');
  });

  it('starts log shipping BEFORE the runner, so no early output is lost', () => {
    // The instance is terminated when its stage ends, so whatever the runner said
    // has to already be in CloudWatch. Start the agent afterwards and the earliest
    // lines — registration, the claim, the first git call — are the ones at risk,
    // and those are exactly the lines that explain a worker that never got going.
    const script = userData();
    expect(script.indexOf('fetch-config')).toBeLessThan(
      script.indexOf('systemctl enable --now aidlc-runner.service'),
    );
  });

  it('names a stream an operator can find from the environment and instance id', () => {
    // The whole point: given a failed stage, an operator knows the environment and
    // the worker id (which IS the instance id) and must be able to go straight to
    // the log. A stream named anything else means searching every stream in the
    // group by timestamp.
    expect(userData()).toContain('"log_stream_name": "cpp-buildhost/{instance_id}"');
    expect(userData()).toContain('"log_group_name": "/aidlc/worker/collaborative-ai-dlc-dev"');
  });

  it('ships the bootstrap log too, for the worker that never starts', () => {
    // If the runner never came up there is no runner log at all, and cloud-init's
    // account of why is the only evidence that will ever exist — on a disk that is
    // about to be deleted.
    expect(userData()).toContain('/var/log/aidlc-bootstrap.log');
  });

  it('never lets log shipping fail the boot', () => {
    // A worker that cannot ship its log is hard to debug. A worker that refuses to
    // boot is a stage that fails outright. Every failure in this block is a warning,
    // including the AMI that has no agent in it at all — an operator's older image
    // must keep placing stages.
    const script = userData();
    expect(script).toMatch(/if \[ -x \/opt\/aws\/amazon-cloudwatch-agent/);
    expect(script).toMatch(/WARNING: no CloudWatch agent in this AMI/);
    expect(script).toMatch(/WARNING: CloudWatch agent did not start/);
  });

  it('says so loudly when no log group is configured, rather than guessing one', () => {
    // The instance role is scoped to the Terraform-owned group, so a made-up group
    // name buys nothing but an AccessDenied inside the agent's own log with nobody
    // watching. An unconfigured deployment still places stages — it just warns.
    const script = renderUserData({
      spec: spec(),
      environmentId: 'cpp-buildhost',
      revisionId: 'r-9',
      platform: platform({ workerLogGroup: '' }),
    });
    expect(script).toMatch(/WARNING: no worker log group configured/);
    expect(script).not.toContain('fetch-config');
    expect(script).toContain('systemctl enable --now aidlc-runner.service');
  });
});

describe('cloudWatchAgentConfig', () => {
  it('sets no retention, because the group is Terraform-owned', () => {
    // retention_in_days here would make the agent call logs:PutRetentionPolicy,
    // which the instance role deliberately does not grant — the group and its
    // retention belong to Terraform so no worker can create an unbounded one.
    const json = JSON.stringify(
      cloudWatchAgentConfig({ environmentId: 'e', platform: platform() }),
    );
    expect(json).not.toContain('retention_in_days');
    expect(json).not.toContain('auto_create_group');
  });

  it('reads files, because the CloudWatch agent has no journald input on Linux', () => {
    // This is why the unit's launcher tees to /var/log/aidlc/runner.log at all. If
    // this ever becomes a journald config, the tee in provision-worker-ami.sh is
    // dead weight and the file it writes is unread.
    const config = cloudWatchAgentConfig({ environmentId: 'e', platform: platform() });
    expect(config.logs.logs_collected.files.collect_list.map((f) => f.file_path)).toContain(
      '/var/log/aidlc/runner.log',
    );
  });
});

describe('launchTemplateInput', () => {
  it('pins the AMI in the template, not in a fleet override', () => {
    // The template is per revision precisely so a republished environment cannot
    // move a running intent's placement.
    const input = launchTemplateInput({
      spec: spec(),
      environmentId: 'e',
      revisionId: 'r',
      platform: platform(),
    });
    expect(input.LaunchTemplateData.ImageId).toBe('ami-0414318400ea0708a');
  });

  it('requires IMDSv2 while leaving the endpoint enabled', () => {
    // The worker reads its own instance id from IMDS to learn its identity, so
    // the endpoint must be on — but v1 must not be.
    const { MetadataOptions } = launchTemplateInput({
      spec: spec(),
      environmentId: 'e',
      revisionId: 'r',
      platform: platform(),
    }).LaunchTemplateData;
    expect(MetadataOptions).toMatchObject({ HttpTokens: 'required', HttpEndpoint: 'enabled' });
  });

  it('encrypts the root volume regardless of the spec', () => {
    const { BlockDeviceMappings } = launchTemplateInput({
      spec: spec({ rootVolume: { sizeGiB: 200, type: 'gp3', throughput: 250 } }),
      environmentId: 'e',
      revisionId: 'r',
      platform: platform(),
    }).LaunchTemplateData;
    expect(BlockDeviceMappings[0].Ebs).toMatchObject({
      Encrypted: true,
      VolumeSize: 200,
      VolumeType: 'gp3',
      Throughput: 250,
      DeleteOnTermination: true,
    });
  });

  it('always attaches the platform security group, before any operator ones', () => {
    const { SecurityGroupIds } = launchTemplateInput({
      spec: spec({ securityGroupIds: ['sg-0abc1234'] }),
      environmentId: 'e',
      revisionId: 'r',
      platform: platform(),
    }).LaunchTemplateData;
    expect(SecurityGroupIds).toEqual(['sg-platform', 'sg-0abc1234']);
  });

  it('uses top-level security groups and NO network interfaces', () => {
    // EC2 rejects a request carrying both a network-interface block and an
    // instance-level subnet, and the scheduler's fleet overrides MUST set SubnetId
    // to spread across AZs and retry on capacity errors. A NetworkInterfaces block
    // here breaks every placement, which is exactly what happened the first time.
    const data = launchTemplateInput({
      spec: spec(),
      environmentId: 'e',
      revisionId: 'r',
      platform: platform(),
    }).LaunchTemplateData;
    expect(data.NetworkInterfaces).toBeUndefined();
    expect(data.SecurityGroupIds).toContain('sg-platform');
    expect(data.SubnetId).toBeUndefined();
  });

  it('is idempotent per revision through its client token', () => {
    const input = launchTemplateInput({
      spec: spec(),
      environmentId: 'cpp-buildhost',
      revisionId: 'r-9',
      platform: platform(),
    });
    expect(input.ClientToken).toBe('lt-cpp-buildhost-r-9');
  });

  it('keeps the template name inside the EC2 length limit', () => {
    const input = launchTemplateInput({
      spec: spec(),
      environmentId: 'a'.repeat(60),
      revisionId: 'r-'.padEnd(60, '9'),
      platform: platform(),
    });
    expect(input.LaunchTemplateName.length).toBeLessThanOrEqual(125);
  });

  it('encodes user-data as base64', () => {
    const input = launchTemplateInput({
      spec: spec(),
      environmentId: 'e',
      revisionId: 'r',
      platform: platform(),
    });
    expect(decodeUserData(input)).toContain('#!/usr/bin/env bash');
  });
});

describe('createLaunchTemplateForRevision', () => {
  const ec2Ok = () => ({
    send: vi.fn(async () => ({
      LaunchTemplate: { LaunchTemplateId: 'lt-0abc', LatestVersionNumber: 1 },
    })),
  });

  it('returns the frozen launch identity to stamp on the revision', async () => {
    await expect(
      createLaunchTemplateForRevision({
        ec2: ec2Ok(),
        spec: spec(),
        environmentId: 'e',
        revisionId: 'r',
        platform: platform(),
      }),
    ).resolves.toEqual({
      launchTemplateId: 'lt-0abc',
      launchTemplateVersion: '1',
      contractVersion: LAUNCH_TEMPLATE_CONTRACT_VERSION,
    });
  });

  it('fails loudly when EC2 returns an incomplete identity', async () => {
    const ec2 = { send: vi.fn(async () => ({ LaunchTemplate: {} })) };
    await expect(
      createLaunchTemplateForRevision({
        ec2,
        spec: spec(),
        environmentId: 'e',
        revisionId: 'r',
        platform: platform(),
      }),
    ).rejects.toMatchObject({ code: 'LAUNCH_TEMPLATE_INCOMPLETE' });
  });

  it('refuses oversized user-data here, where the error can still name the cause', async () => {
    // Otherwise the failure surfaces as an opaque launch error much later.
    const huge = platform({ mcpSecretsPrefix: 'x'.repeat(20_000) });
    await expect(
      createLaunchTemplateForRevision({
        ec2: ec2Ok(),
        spec: spec(),
        environmentId: 'e',
        revisionId: 'r',
        platform: huge,
      }),
    ).rejects.toMatchObject({ code: 'USER_DATA_TOO_LARGE' });
  });
});
