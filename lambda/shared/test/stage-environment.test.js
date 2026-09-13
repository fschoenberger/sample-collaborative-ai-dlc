import { describe, expect, it } from 'vitest';
import {
  AGENTCORE_KIND,
  EC2_KIND,
  resolveRuntimeTarget,
  resolveStageTarget,
  runtimeTargetInput,
  stageSnapshotOf,
} from '../runtime-target.js';

const agentcoreSnapshot = (overrides = {}) => ({
  environmentId: 'standard',
  kind: 'AGENTCORE',
  revisionId: 'r-1',
  runtimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:1:runtime/std',
  runtimeEndpoint: 'live',
  ...overrides,
});

const ec2Snapshot = (overrides = {}) => ({
  environmentId: 'cpp-buildhost',
  kind: 'EC2',
  revisionId: 'r-2',
  launchTemplateId: 'lt-0abc',
  launchTemplateVersion: '3',
  launchSpec: { architecture: 'x86_64', instanceTypes: ['c7i.2xlarge'], parkPolicy: 'release' },
  ...overrides,
});

const metaWith = (stageEnvironments = {}) => ({
  environment: agentcoreSnapshot(),
  stageEnvironments,
});

describe('stageSnapshotOf', () => {
  it('falls back to the intent default when the stage has no override', () => {
    expect(stageSnapshotOf(metaWith(), 'construction-code').environmentId).toBe('standard');
  });

  it('prefers a per-stage override', () => {
    const meta = metaWith({ 'construction-code': ec2Snapshot() });
    expect(stageSnapshotOf(meta, 'construction-code').environmentId).toBe('cpp-buildhost');
  });

  it('only overrides the bound stage', () => {
    const meta = metaWith({ 'construction-code': ec2Snapshot() });
    expect(stageSnapshotOf(meta, 'inception-requirements').environmentId).toBe('standard');
  });

  it('returns the default when no stageId is supplied (non-stage callers)', () => {
    const meta = metaWith({ 'construction-code': ec2Snapshot() });
    expect(stageSnapshotOf(meta, null).environmentId).toBe('standard');
  });

  it('reads the legacy environmentSnapshot key', () => {
    expect(stageSnapshotOf({ environmentSnapshot: agentcoreSnapshot() }, 'x').revisionId).toBe(
      'r-1',
    );
  });
});

describe('resolveStageTarget', () => {
  it('tags an AgentCore stage and carries its invoke arguments', () => {
    expect(resolveStageTarget(metaWith(), 'construction-code')).toEqual({
      kind: AGENTCORE_KIND,
      environmentId: 'standard',
      revisionId: 'r-1',
      agentRuntimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:1:runtime/std',
      qualifier: 'live',
    });
  });

  it('tags an EC2 stage with its frozen launch identity', () => {
    const meta = metaWith({ 'construction-code': ec2Snapshot() });
    expect(resolveStageTarget(meta, 'construction-code')).toEqual({
      kind: EC2_KIND,
      environmentId: 'cpp-buildhost',
      revisionId: 'r-2',
      launchTemplateId: 'lt-0abc',
      launchTemplateVersion: '3',
      launchSpec: expect.objectContaining({ architecture: 'x86_64' }),
    });
  });

  it('uses the fallback runtime ARN when a snapshot predates the registry', () => {
    const target = resolveStageTarget({}, 'construction-code', 'arn:aws:...:runtime/core');
    expect(target).toMatchObject({
      kind: AGENTCORE_KIND,
      environmentId: 'standard',
      agentRuntimeArn: 'arn:aws:...:runtime/core',
    });
  });

  it('omits the qualifier when the revision has no endpoint', () => {
    const meta = { environment: agentcoreSnapshot({ runtimeEndpoint: null }) };
    expect(resolveStageTarget(meta, 'x').qualifier).toBeUndefined();
  });
});

describe('resolveRuntimeTarget (unchanged contract for non-stage callers)', () => {
  it('returns only the invoke arguments, ignoring per-stage overrides', () => {
    const meta = metaWith({ 'construction-code': ec2Snapshot() });
    expect(resolveRuntimeTarget(meta, 'fallback')).toEqual({
      agentRuntimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:1:runtime/std',
      qualifier: 'live',
    });
  });

  it('falls back to the supplied ARN with no snapshot at all', () => {
    expect(resolveRuntimeTarget(null, 'arn:core')).toEqual({
      agentRuntimeArn: 'arn:core',
      qualifier: undefined,
    });
  });
});

describe('runtimeTargetInput', () => {
  it('drops an absent qualifier rather than sending undefined', () => {
    const meta = { environment: agentcoreSnapshot({ runtimeEndpoint: null }) };
    expect(runtimeTargetInput(meta, 'fallback')).toEqual({
      agentRuntimeArn: 'arn:aws:bedrock-agentcore:eu-central-1:1:runtime/std',
    });
  });

  it('refuses an EC2 intent default with a named code (AGENTCORE-default invariant)', () => {
    expect(() => runtimeTargetInput({ environment: ec2Snapshot() }, 'fallback')).toThrow(
      /requires an AgentCore environment/,
    );
    try {
      runtimeTargetInput({ environment: ec2Snapshot() }, 'fallback');
    } catch (error) {
      expect(error.code).toBe('ENVIRONMENT_KIND_UNSUPPORTED');
    }
  });

  it('is unaffected by an EC2 per-stage override', () => {
    const meta = metaWith({ 'construction-code': ec2Snapshot() });
    expect(runtimeTargetInput(meta, 'fallback').agentRuntimeArn).toContain('runtime/std');
  });
});
