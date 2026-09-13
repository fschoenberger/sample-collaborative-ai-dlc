import { describe, expect, it } from 'vitest';
import {
  MAX_STAGE_BINDINGS,
  distinctEnvironmentIds,
  mergeStageEnvironments,
  satisfiesRequiresCompute,
  validateStageEnvironments,
} from '../stage-environments.js';

describe('validateStageEnvironments', () => {
  it('treats an absent map as "everything on the default"', () => {
    expect(validateStageEnvironments(null)).toEqual({ valid: true, errors: [], map: {} });
    expect(validateStageEnvironments(undefined).map).toEqual({});
  });

  it('normalizes a valid map', () => {
    const { valid, map } = validateStageEnvironments({
      'construction-code': 'cpp-buildhost',
      'construction-test': ' cpp-buildhost ',
    });
    expect(valid).toBe(true);
    expect(map).toEqual({
      'construction-code': 'cpp-buildhost',
      'construction-test': 'cpp-buildhost',
    });
  });

  it('drops an empty value, which is how the UI clears one override', () => {
    const { valid, map } = validateStageEnvironments({
      'construction-code': 'cpp-buildhost',
      'construction-test': '',
      'inception-req': null,
    });
    expect(valid).toBe(true);
    expect(map).toEqual({ 'construction-code': 'cpp-buildhost' });
  });

  it('rejects a bad stage id', () => {
    const { valid, errors } = validateStageEnvironments({ 'Not A Stage': 'cpp' });
    expect(valid).toBe(false);
    expect(errors[0]).toMatch(/not a valid stage id/);
  });

  it('rejects a bad environment id', () => {
    const { valid, errors } = validateStageEnvironments({ 'construction-code': 'Bad Env!' });
    expect(valid).toBe(false);
    expect(errors[0]).toMatch(/not a valid environment id/);
  });

  it('rejects a non-object', () => {
    expect(validateStageEnvironments('cpp').valid).toBe(false);
    expect(validateStageEnvironments(['cpp']).valid).toBe(false);
  });

  it('caps the number of bindings so a bad client cannot write an unbounded property', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_STAGE_BINDINGS + 1 }, (_, i) => [`stage-${i}`, 'cpp']),
    );
    expect(validateStageEnvironments(many).valid).toBe(false);
  });

  it('returns no map when invalid, so a caller cannot persist a partial one', () => {
    expect(validateStageEnvironments({ BAD: 'x' }).map).toBeNull();
  });
});

describe('mergeStageEnvironments', () => {
  const project = { 'construction-code': 'cpp-buildhost', 'construction-test': 'cpp-buildhost' };

  it('returns the project map when there is no override', () => {
    expect(mergeStageEnvironments(project, null)).toEqual(project);
  });

  it('lets an intent-time override win per stage', () => {
    expect(mergeStageEnvironments(project, { 'construction-code': 'gpu-host' })).toEqual({
      'construction-code': 'gpu-host',
      'construction-test': 'cpp-buildhost',
    });
  });

  it('lets an override REMOVE a project default without resending the whole map', () => {
    expect(mergeStageEnvironments(project, { 'construction-test': null })).toEqual({
      'construction-code': 'cpp-buildhost',
    });
  });

  it('does not mutate the project map', () => {
    const copy = { ...project };
    mergeStageEnvironments(project, { 'construction-code': 'gpu-host' });
    expect(project).toEqual(copy);
  });

  it('handles an empty project map', () => {
    expect(mergeStageEnvironments({}, { 'construction-code': 'gpu-host' })).toEqual({
      'construction-code': 'gpu-host',
    });
  });
});

describe('distinctEnvironmentIds', () => {
  it('collapses repeats so each environment is resolved once', () => {
    expect(
      distinctEnvironmentIds({ a: 'cpp-buildhost', b: 'cpp-buildhost', c: 'gpu-host' }).sort(),
    ).toEqual(['cpp-buildhost', 'gpu-host']);
  });

  it('is empty for an empty or absent map', () => {
    expect(distinctEnvironmentIds({})).toEqual([]);
    expect(distinctEnvironmentIds()).toEqual([]);
  });
});

describe('satisfiesRequiresCompute', () => {
  const ec2 = (launchSpec) => ({ kind: 'EC2', launchSpec });

  it('is satisfied when a stage declares nothing', () => {
    expect(satisfiesRequiresCompute(null, ec2({}))).toEqual({ satisfied: true, reasons: [] });
  });

  it('accepts a matching architecture', () => {
    expect(
      satisfiesRequiresCompute({ architecture: 'x86_64' }, ec2({ architecture: 'x86_64' }))
        .satisfied,
    ).toBe(true);
  });

  it('flags an architecture mismatch', () => {
    const { satisfied, reasons } = satisfiesRequiresCompute(
      { architecture: 'x86_64' },
      ec2({ architecture: 'arm64' }),
    );
    expect(satisfied).toBe(false);
    expect(reasons[0]).toMatch(/architecture x86_64/);
  });

  it('treats an AgentCore environment as arm64', () => {
    // It has no launch spec, and the runtime is arm64 by construction.
    expect(
      satisfiesRequiresCompute({ architecture: 'x86_64' }, { kind: 'AGENTCORE' }).satisfied,
    ).toBe(false);
    expect(
      satisfiesRequiresCompute({ architecture: 'arm64' }, { kind: 'AGENTCORE' }).satisfied,
    ).toBe(true);
  });

  it('recognizes a GPU from attribute-based selection', () => {
    expect(
      satisfiesRequiresCompute(
        { accelerator: 'gpu' },
        ec2({ instanceRequirements: { acceleratorCount: { min: 1 } } }),
      ).satisfied,
    ).toBe(true);
  });

  it('recognizes a GPU from named accelerated instance types', () => {
    for (const type of ['g5.xlarge', 'p5.48xlarge', 'inf2.xlarge', 'trn1.2xlarge']) {
      expect(
        satisfiesRequiresCompute({ accelerator: 'gpu' }, ec2({ instanceTypes: [type] })).satisfied,
      ).toBe(true);
    }
  });

  it('flags a GPU requirement against CPU-only instance types', () => {
    const { satisfied, reasons } = satisfiesRequiresCompute(
      { accelerator: 'gpu' },
      ec2({ instanceTypes: ['c7i.2xlarge', 'm7i.2xlarge'] }),
    );
    expect(satisfied).toBe(false);
    expect(reasons).toContain('stage needs a GPU');
  });

  it('reports every unmet requirement at once, not just the first', () => {
    const { reasons } = satisfiesRequiresCompute(
      { accelerator: 'gpu', architecture: 'x86_64', platform: 'windows' },
      ec2({ architecture: 'arm64', platform: 'linux', instanceTypes: ['c7g.large'] }),
    );
    expect(reasons).toHaveLength(3);
  });
});
