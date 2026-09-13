import { describe, expect, it } from 'vitest';
import type { Ec2LaunchSpec } from './ec2LaunchSpec';
import {
  MAX_STAGE_BINDINGS,
  mergeStageEnvironments,
  requiresComputeOf,
  satisfiesRequiresCompute,
  stageEnvironmentDelta,
  validateStageEnvironments,
} from './stageEnvironments';

// Mirrors lambda/shared/stage-environments.js. The three rules worth pinning are
// that an empty value CLEARS rather than binds, that the delta a caller sends is
// exactly what reproduces its intent through the server's merge, and that the
// requiresCompute advisory uses the same two AgentCore defaults the backend does.

const spec = (over: Partial<Ec2LaunchSpec> = {}) =>
  ({
    platform: 'linux',
    architecture: 'x86_64',
    instanceTypes: [],
    instanceFamilies: [],
    instanceRequirements: null,
    ...over,
  }) as Ec2LaunchSpec;

describe('mergeStageEnvironments', () => {
  it('lets the override win per stage and treats an empty value as a removal', () => {
    expect(mergeStageEnvironments({ a: 'one', b: 'two' }, { b: 'three' })).toEqual({
      a: 'one',
      b: 'three',
    });
    expect(mergeStageEnvironments({ a: 'one', b: 'two' }, { a: null })).toEqual({ b: 'two' });
    expect(mergeStageEnvironments({ a: 'one' }, { a: '' })).toEqual({});
  });

  it('returns the base untouched when there is no override', () => {
    expect(mergeStageEnvironments({ a: 'one' }, null)).toEqual({ a: 'one' });
    expect(mergeStageEnvironments()).toEqual({});
  });
});

describe('stageEnvironmentDelta', () => {
  it('sends nothing when the caller changed nothing', () => {
    expect(stageEnvironmentDelta({ a: 'one' }, { a: 'one' })).toEqual({});
  });

  it('sends only what changed, with a removal as an explicit null', () => {
    expect(stageEnvironmentDelta({ a: 'one', b: 'two' }, { a: 'three' })).toEqual({
      a: 'three',
      b: null,
    });
  });

  it('round-trips through the server merge', () => {
    const inherited = { a: 'one', b: 'two' };
    const next = { b: 'two', c: 'four' };
    expect(mergeStageEnvironments(inherited, stageEnvironmentDelta(inherited, next))).toEqual(next);
  });
});

describe('validateStageEnvironments', () => {
  it('accepts an empty map — everything on the default is the common case', () => {
    expect(validateStageEnvironments({})).toEqual([]);
  });

  it('rejects malformed stage and environment ids', () => {
    expect(validateStageEnvironments({ 'Build Stage': 'standard' })).toEqual([
      '"Build Stage" is not a valid stage id',
    ]);
    expect(validateStageEnvironments({ build: 'Not An Id' })).toEqual([
      '"Not An Id" is not a valid environment id',
    ]);
  });

  it('caps the map', () => {
    const map = Object.fromEntries(
      Array.from({ length: MAX_STAGE_BINDINGS + 1 }, (_, index) => [`s${index}`, 'standard']),
    );
    expect(validateStageEnvironments(map)).toEqual([
      `stageEnvironments accepts at most ${MAX_STAGE_BINDINGS} bindings`,
    ]);
  });
});

describe('satisfiesRequiresCompute', () => {
  it('is satisfied when the stage declares nothing', () => {
    expect(satisfiesRequiresCompute(null, null)).toEqual({ satisfied: true, reasons: [] });
  });

  it('treats an environment with no launch spec as linux/arm64 — AgentCore by construction', () => {
    expect(satisfiesRequiresCompute({ platform: 'linux' }, {}).satisfied).toBe(true);
    expect(satisfiesRequiresCompute({ architecture: 'arm64' }, {}).satisfied).toBe(true);
    expect(satisfiesRequiresCompute({ architecture: 'x86_64' }, {}).reasons).toEqual([
      'stage needs architecture x86_64',
    ]);
  });

  it('reads platform and architecture off an EC2 launch spec', () => {
    expect(
      satisfiesRequiresCompute({ architecture: 'x86_64' }, { launchSpec: spec() }).satisfied,
    ).toBe(true);
    expect(
      satisfiesRequiresCompute({ architecture: 'arm64' }, { launchSpec: spec() }).reasons,
    ).toEqual(['stage needs architecture arm64']);
  });

  it('recognizes a GPU from an accelerator floor or from an accelerated instance family', () => {
    expect(satisfiesRequiresCompute({ accelerator: 'gpu' }, {}).reasons).toEqual([
      'stage needs a GPU',
    ]);
    expect(
      satisfiesRequiresCompute(
        { accelerator: 'gpu' },
        { launchSpec: spec({ instanceTypes: ['g5.2xlarge'] }) },
      ).satisfied,
    ).toBe(true);
    expect(
      satisfiesRequiresCompute(
        { accelerator: 'gpu' },
        { launchSpec: spec({ instanceRequirements: { acceleratorCount: { min: 1 } } }) },
      ).satisfied,
    ).toBe(true);
    expect(
      satisfiesRequiresCompute(
        { accelerator: 'gpu' },
        { launchSpec: spec({ instanceTypes: ['c7g.4xlarge'] }) },
      ).satisfied,
    ).toBe(false);
  });

  it('accumulates every reason so the advisory can say all of them at once', () => {
    expect(
      satisfiesRequiresCompute(
        { platform: 'windows', architecture: 'arm64', accelerator: 'gpu' },
        { launchSpec: spec() },
      ).reasons,
    ).toEqual([
      'stage needs platform windows',
      'stage needs architecture arm64',
      'stage needs a GPU',
    ]);
  });
});

describe('requiresComputeOf', () => {
  it('reads the hint off a stage block attribute and ignores anything else', () => {
    expect(requiresComputeOf({ accelerator: 'gpu' })).toEqual({
      platform: undefined,
      architecture: undefined,
      accelerator: 'gpu',
    });
    for (const bad of [null, undefined, 'gpu', [], {}, { unrelated: 1 }]) {
      expect(requiresComputeOf(bad)).toBeNull();
    }
  });
});
