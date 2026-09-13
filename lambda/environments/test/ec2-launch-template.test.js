import { describe, expect, it, vi } from 'vitest';
import {
  LAUNCH_TEMPLATE_CONTRACT_VERSION,
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
