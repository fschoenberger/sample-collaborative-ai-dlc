import { describe, expect, it } from 'vitest';
import {
  EC2_LAUNCH_SPEC_SCHEMA_VERSION,
  EC2_LIMITS,
  evaluateImage,
  imageAssertions,
  parseImageRef,
  validateEc2LaunchSpec,
} from '../ec2-launch-spec.js';

// A minimal spec that must always validate: the C++ buildhost shape from the
// acceptance scenario (Fedora AMI, x86_64, compute-optimized types).
const baseSpec = () => ({
  imageRef: 'ami-0414318400ea0708a',
  architecture: 'x86_64',
  instanceTypes: ['c7i.2xlarge', 'm7i.2xlarge'],
});

const fieldsOf = (errors) => errors.map((e) => e.field);

describe('parseImageRef', () => {
  it('accepts a bare 17-character AMI id', () => {
    expect(parseImageRef('ami-0414318400ea0708a')).toEqual({
      imageId: 'ami-0414318400ea0708a',
      arn: null,
    });
  });

  it('accepts the legacy 8-character AMI id', () => {
    expect(parseImageRef('ami-1a2b3c4d')?.imageId).toBe('ami-1a2b3c4d');
  });

  it('extracts the id from an AMI ARN and keeps the ARN', () => {
    const arn = 'arn:aws:ec2:eu-central-1:592872546055:image/ami-0414318400ea0708a';
    expect(parseImageRef(arn)).toEqual({ imageId: 'ami-0414318400ea0708a', arn });
  });

  it('accepts an AMI ARN with an empty account (public image)', () => {
    const arn = 'arn:aws:ec2:eu-central-1::image/ami-0414318400ea0708a';
    expect(parseImageRef(arn)?.imageId).toBe('ami-0414318400ea0708a');
  });

  it.each(['', 'ami-XYZ', 'i-0414318400ea0708a', 'arn:aws:ec2:eu-central-1::snapshot/snap-1'])(
    'rejects %j',
    (value) => {
      expect(parseImageRef(value)).toBeNull();
    },
  );
});

describe('validateEc2LaunchSpec', () => {
  it('normalizes a minimal spec and applies defaults', () => {
    const { valid, errors, spec } = validateEc2LaunchSpec(baseSpec());
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
    expect(spec).toMatchObject({
      schemaVersion: EC2_LAUNCH_SPEC_SCHEMA_VERSION,
      platform: 'linux',
      architecture: 'x86_64',
      imageId: 'ami-0414318400ea0708a',
      purchaseOption: 'on-demand',
      allocationStrategy: 'price-capacity-optimized',
      // release is the default because hold bills for the whole human wait.
      parkPolicy: 'release',
      strategyId: 'per-stage-ephemeral',
      associatePublicIp: false,
      workspacePath: '/mnt/workspace',
      rootVolume: { sizeGiB: 100, type: 'gp3' },
    });
  });

  it('preserves instanceTypes order (it becomes fleet override priority)', () => {
    const { spec } = validateEc2LaunchSpec({
      ...baseSpec(),
      instanceTypes: ['m7i.2xlarge', 'c7i.2xlarge', 'm7i.2xlarge'],
    });
    expect(spec.instanceTypes).toEqual(['m7i.2xlarge', 'c7i.2xlarge']);
  });

  it('requires something to select capacity on', () => {
    const { valid, errors } = validateEc2LaunchSpec({ imageRef: baseSpec().imageRef });
    expect(valid).toBe(false);
    expect(fieldsOf(errors)).toContain('instanceTypes');
  });

  it('accepts instanceRequirements instead of explicit types', () => {
    const { valid, spec } = validateEc2LaunchSpec({
      imageRef: baseSpec().imageRef,
      instanceRequirements: {
        vCpuCount: { min: 8, max: 32 },
        acceleratorCount: { min: 1 },
        acceleratorManufacturers: ['nvidia'],
      },
    });
    expect(valid).toBe(true);
    expect(spec.instanceRequirements).toEqual({
      vCpuCount: { min: 8, max: 32 },
      acceleratorCount: { min: 1 },
      acceleratorManufacturers: ['nvidia'],
    });
  });

  it('rejects an inverted requirement range', () => {
    const { valid, errors } = validateEc2LaunchSpec({
      ...baseSpec(),
      instanceRequirements: { vCpuCount: { min: 32, max: 8 } },
    });
    expect(valid).toBe(false);
    expect(fieldsOf(errors)).toContain('instanceRequirements.vCpuCount');
  });

  it('rejects a bad image reference', () => {
    const { valid, errors } = validateEc2LaunchSpec({ ...baseSpec(), imageRef: 'not-an-ami' });
    expect(valid).toBe(false);
    expect(fieldsOf(errors)).toContain('imageRef');
  });

  it('rejects an unsupported platform as not-yet-supported rather than unknown', () => {
    const { valid, errors } = validateEc2LaunchSpec({ ...baseSpec(), platform: 'windows' });
    expect(valid).toBe(false);
    expect(errors.find((e) => e.field === 'platform')?.message).toMatch(/not supported yet/);
  });

  it('rejects an unknown platform outright', () => {
    const { errors } = validateEc2LaunchSpec({ ...baseSpec(), platform: 'plan9' });
    expect(errors.find((e) => e.field === 'platform')?.message).toMatch(/must be one of/);
  });

  it('rejects maxPricePerHour without spot', () => {
    const { valid, errors } = validateEc2LaunchSpec({ ...baseSpec(), maxPricePerHour: 2 });
    expect(valid).toBe(false);
    expect(fieldsOf(errors)).toContain('maxPricePerHour');
  });

  it('accepts maxPricePerHour with spot', () => {
    const { valid, spec } = validateEc2LaunchSpec({
      ...baseSpec(),
      purchaseOption: 'spot',
      maxPricePerHour: 2,
    });
    expect(valid).toBe(true);
    expect(spec.maxPricePerHour).toBe(2);
  });

  it('rejects throughput on a non-gp3 volume', () => {
    const { valid, errors } = validateEc2LaunchSpec({
      ...baseSpec(),
      rootVolume: { sizeGiB: 200, type: 'io2', throughput: 500 },
    });
    expect(valid).toBe(false);
    expect(fieldsOf(errors)).toContain('rootVolume.throughput');
  });

  it('rejects provisioned iops on gp2', () => {
    const { errors } = validateEc2LaunchSpec({
      ...baseSpec(),
      rootVolume: { sizeGiB: 200, type: 'gp2', iops: 3000 },
    });
    expect(fieldsOf(errors)).toContain('rootVolume.iops');
  });

  it('rejects a stage timeout that outlives the worker', () => {
    const { valid, errors } = validateEc2LaunchSpec({
      ...baseSpec(),
      maxLifetimeSeconds: 3600,
      stageTimeoutSeconds: 7200,
    });
    expect(valid).toBe(false);
    expect(fieldsOf(errors)).toContain('stageTimeoutSeconds');
  });

  it('rejects more concurrent placements than instances', () => {
    const { errors } = validateEc2LaunchSpec({
      ...baseSpec(),
      maxInstances: 2,
      maxConcurrentPlacements: 4,
    });
    expect(fieldsOf(errors)).toContain('maxConcurrentPlacements');
  });

  it('refuses parkPolicy hold without a lifetime cap below the maximum', () => {
    const { valid, errors } = validateEc2LaunchSpec({ ...baseSpec(), parkPolicy: 'hold' });
    expect(valid).toBe(false);
    expect(errors.find((e) => e.field === 'parkPolicy')?.message).toMatch(/human wait/);
  });

  it('allows parkPolicy hold when the lifetime is explicitly bounded', () => {
    const { valid, spec } = validateEc2LaunchSpec({
      ...baseSpec(),
      parkPolicy: 'hold',
      maxLifetimeSeconds: 7200,
      stageTimeoutSeconds: 7200,
    });
    expect(valid).toBe(true);
    expect(spec.parkPolicy).toBe('hold');
  });

  it.each([
    ['maxInstances', EC2_LIMITS.maxInstances.max + 1],
    ['maxLifetimeSeconds', EC2_LIMITS.maxLifetimeSeconds.max + 1],
    ['bootstrapTimeoutSeconds', 1],
  ])('rejects %s outside its bounds', (field, value) => {
    const { valid, errors } = validateEc2LaunchSpec({ ...baseSpec(), [field]: value });
    expect(valid).toBe(false);
    expect(fieldsOf(errors)).toContain(field);
  });

  it('rejects reserved aws: tag keys', () => {
    const { valid, errors } = validateEc2LaunchSpec({
      ...baseSpec(),
      tags: { 'aws:cloudformation:stack': 'x' },
    });
    expect(valid).toBe(false);
    expect(fieldsOf(errors)).toContain('tags');
  });

  it('rejects a non-object spec', () => {
    expect(validateEc2LaunchSpec(null).valid).toBe(false);
    expect(validateEc2LaunchSpec('ami-0414318400ea0708a').valid).toBe(false);
  });

  it('returns no spec when invalid so a caller cannot persist a partial one', () => {
    expect(validateEc2LaunchSpec({ imageRef: 'nope' }).spec).toBeNull();
  });
});

describe('imageAssertions', () => {
  it('scopes owners only when an owner account is declared', () => {
    const { spec } = validateEc2LaunchSpec(baseSpec());
    expect(imageAssertions(spec).owners).toBeNull();
    const { spec: owned } = validateEc2LaunchSpec({
      ...baseSpec(),
      imageOwnerAccountId: '592872546055',
    });
    expect(imageAssertions(owned).owners).toEqual(['592872546055']);
  });
});

describe('evaluateImage', () => {
  const specOf = (overrides = {}) => validateEc2LaunchSpec({ ...baseSpec(), ...overrides }).spec;

  it('passes an available Linux image of the declared architecture', () => {
    const result = evaluateImage(specOf(), { State: 'available', Architecture: 'x86_64' });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('treats an absent Platform as Linux', () => {
    expect(evaluateImage(specOf(), { State: 'available', Architecture: 'x86_64' }).valid).toBe(
      true,
    );
  });

  it('reports a missing image without guessing why', () => {
    const { valid, errors } = evaluateImage(specOf(), null);
    expect(valid).toBe(false);
    expect(errors[0].message).toMatch(/not exist.*deregistered.*shared/s);
  });

  it('rejects an architecture mismatch', () => {
    const { valid, errors } = evaluateImage(specOf(), {
      State: 'available',
      Architecture: 'arm64',
    });
    expect(valid).toBe(false);
    expect(fieldsOf(errors)).toContain('architecture');
  });

  it('rejects a pending image', () => {
    const { errors } = evaluateImage(specOf(), { State: 'pending', Architecture: 'x86_64' });
    expect(fieldsOf(errors)).toContain('imageRef');
  });

  it('rejects a Windows image bound to a linux spec', () => {
    const { errors } = evaluateImage(specOf(), {
      State: 'available',
      Architecture: 'x86_64',
      Platform: 'windows',
    });
    expect(fieldsOf(errors)).toContain('platform');
  });
});
