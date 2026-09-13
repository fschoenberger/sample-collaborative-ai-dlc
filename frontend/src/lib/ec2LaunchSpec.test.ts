import { describe, expect, it } from 'vitest';
import {
  EC2_LAUNCH_SPEC_DEFAULTS,
  errorFor,
  fieldErrorsFrom,
  parseImageRef,
  validateEc2LaunchSpecInput,
} from './ec2LaunchSpec';

// This module mirrors lambda/environments/ec2-launch-spec.js. These tests pin the
// mirror to the same verdicts AND the same wording, because a form that rejects
// something the server accepts (or explains it differently) is worse than no
// client-side validation at all.

const valid = {
  imageRef: 'ami-0123456789abcdef0',
  instanceTypes: ['c7g.4xlarge'],
};

const messages = (input: Parameters<typeof validateEc2LaunchSpecInput>[0]) =>
  validateEc2LaunchSpecInput(input).map((entry) => `${entry.field}: ${entry.message}`);

describe('parseImageRef', () => {
  it('accepts both the 8- and 17-character AMI id forms', () => {
    expect(parseImageRef('ami-12345678')).toEqual({ imageId: 'ami-12345678', arn: null });
    expect(parseImageRef('  ami-0123456789abcdef0  ')).toEqual({
      imageId: 'ami-0123456789abcdef0',
      arn: null,
    });
  });

  it('accepts an AMI ARN, including the empty-account public form, and extracts the id', () => {
    expect(
      parseImageRef('arn:aws:ec2:eu-central-1:123456789012:image/ami-0123456789abcdef0'),
    ).toEqual({
      imageId: 'ami-0123456789abcdef0',
      arn: 'arn:aws:ec2:eu-central-1:123456789012:image/ami-0123456789abcdef0',
    });
    expect(parseImageRef('arn:aws:ec2:eu-central-1::image/ami-12345678')?.imageId).toBe(
      'ami-12345678',
    );
  });

  it('rejects anything else', () => {
    for (const bad of [
      '',
      'ami-nothex',
      'ami-123',
      'i-0123456789abcdef0',
      'ami-0123456789ABCDEF0',
    ]) {
      expect(parseImageRef(bad)).toBeNull();
    }
  });
});

describe('validateEc2LaunchSpecInput', () => {
  it('accepts a minimal spec and lets the server apply the defaults', () => {
    expect(validateEc2LaunchSpecInput(valid)).toEqual([]);
  });

  it('rejects a malformed AMI reference with the server wording', () => {
    const errors = validateEc2LaunchSpecInput({ ...valid, imageRef: 'ami-nothex' });
    expect(errorFor(errors, 'imageRef')).toBe('imageRef must be an AMI id (ami-…) or an AMI ARN');
  });

  it('names windows and macos as known-but-unsupported rather than unknown', () => {
    expect(messages({ ...valid, platform: 'windows' })).toContain(
      'platform: platform "windows" is not supported yet (runner bundle is Linux-only)',
    );
    expect(messages({ ...valid, platform: 'plan9' })).toContain(
      'platform: platform must be one of linux, windows, macos',
    );
  });

  it('requires something to select instances on', () => {
    expect(messages({ imageRef: valid.imageRef })).toContain(
      'instanceTypes: declare at least one of instanceTypes, instanceFamilies or instanceRequirements',
    );
    expect(validateEc2LaunchSpecInput({ ...valid, instanceTypes: [] })).not.toEqual([]);
    expect(
      validateEc2LaunchSpecInput({
        imageRef: valid.imageRef,
        instanceRequirements: { vCpuCount: { min: 8 } },
      }),
    ).toEqual([]);
  });

  it('applies the root-volume rules per volume type', () => {
    expect(messages({ ...valid, rootVolume: { type: 'gp2', sizeGiB: 100, iops: 3000 } })).toContain(
      'rootVolume.iops: gp2 volumes do not accept a provisioned iops value',
    );
    expect(
      messages({ ...valid, rootVolume: { type: 'io2', sizeGiB: 100, throughput: 250 } }),
    ).toContain('rootVolume.throughput: throughput is only supported on gp3 volumes');
    expect(
      validateEc2LaunchSpecInput({
        ...valid,
        rootVolume: { type: 'gp3', sizeGiB: 100, iops: 4000, throughput: 250 },
      }),
    ).toEqual([]);
  });

  it('restricts a spot-only price to spot capacity', () => {
    expect(messages({ ...valid, maxPricePerHour: 1.5 })).toContain(
      'maxPricePerHour: maxPricePerHour only applies to spot capacity',
    );
    expect(
      validateEc2LaunchSpecInput({ ...valid, purchaseOption: 'spot', maxPricePerHour: 1.5 }),
    ).toEqual([]);
    expect(messages({ ...valid, purchaseOption: 'spot', maxPricePerHour: 0 })).toContain(
      'maxPricePerHour: maxPricePerHour must be a positive number',
    );
  });

  it('enforces the cross-field rules that are legal in isolation', () => {
    expect(messages({ ...valid, stageTimeoutSeconds: 28800, maxLifetimeSeconds: 3600 })).toContain(
      'stageTimeoutSeconds: stageTimeoutSeconds cannot exceed maxLifetimeSeconds',
    );
    expect(messages({ ...valid, maxInstances: 2, maxConcurrentPlacements: 4 })).toContain(
      'maxConcurrentPlacements: maxConcurrentPlacements cannot exceed maxInstances',
    );
  });

  it('refuses parkPolicy hold unless a lifetime cap bounds the idle bill', () => {
    expect(
      messages({
        ...valid,
        parkPolicy: 'hold',
        maxLifetimeSeconds: EC2_LAUNCH_SPEC_DEFAULTS.maxLifetimeSeconds,
      }),
    ).toContain(
      'parkPolicy: parkPolicy "hold" requires an explicit maxLifetimeSeconds below the maximum, since the instance bills for the whole human wait',
    );
    expect(
      validateEc2LaunchSpecInput({
        ...valid,
        parkPolicy: 'hold',
        maxLifetimeSeconds: 7200,
        stageTimeoutSeconds: 3600,
      }),
    ).toEqual([]);
  });

  it('rejects reserved tag keys and out-of-range bounds', () => {
    expect(messages({ ...valid, tags: { 'aws:owner': 'x' } })).toContain(
      'tags: tag key "aws:owner" uses the reserved aws: prefix',
    );
    expect(messages({ ...valid, maxInstances: 65 })).toContain(
      'maxInstances: maxInstances must be between 1 and 64',
    );
    expect(messages({ ...valid, bootstrapTimeoutSeconds: 90.5 })).toContain(
      'bootstrapTimeoutSeconds: bootstrapTimeoutSeconds must be an integer',
    );
  });

  it('validates the id-shaped lists', () => {
    expect(messages({ ...valid, securityGroupIds: ['sg-nope'] })).toContain(
      'securityGroupIds: "sg-nope" is not a valid security group id',
    );
    expect(messages({ ...valid, availabilityZones: ['eu-central-1'] })).toContain(
      'availabilityZones: "eu-central-1" is not a valid availability zone',
    );
    expect(messages({ ...valid, additionalPolicyArns: ['AmazonS3ReadOnlyAccess'] })).toContain(
      'additionalPolicyArns: "AmazonS3ReadOnlyAccess" is not a valid IAM policy ARN',
    );
  });
});

describe('fieldErrorsFrom', () => {
  it('reads the API errors array off a rejected request', () => {
    expect(
      fieldErrorsFrom({
        body: { error: 'Invalid launch spec', errors: [{ field: 'imageRef', message: 'nope' }] },
      }),
    ).toEqual([{ field: 'imageRef', message: 'nope' }]);
  });

  it('returns nothing for a failure that carries no field detail', () => {
    expect(fieldErrorsFrom(new Error('boom'))).toEqual([]);
    expect(fieldErrorsFrom(null)).toEqual([]);
    expect(fieldErrorsFrom({ body: { error: 'nope' } })).toEqual([]);
  });
});
