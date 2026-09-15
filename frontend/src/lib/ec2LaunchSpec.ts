// Client-side mirror of lambda/environments/ec2-launch-spec.js.
//
// The server is still the authority — every message here is worded exactly as the
// lambda words it, so a spec the form accepts and the server then rejects reads
// identically either way. The point of duplicating it is latency, not trust: an
// operator pasting an AMI id should learn it is malformed before a round trip,
// and field-level errors need somewhere to attach in the form.
//
// `associatePublicIp` is deliberately absent: the server always writes false and
// rejects an explicit true, so there is nothing for a form to offer.

export const EC2_LAUNCH_SPEC_SCHEMA_VERSION = 1;

export const EC2_PLATFORMS = ['linux', 'windows', 'macos'] as const;
export const SUPPORTED_EC2_PLATFORMS = ['linux'] as const;
export const EC2_ARCHITECTURES = ['x86_64', 'arm64'] as const;
export const EC2_PURCHASE_OPTIONS = ['on-demand', 'spot'] as const;
export const EC2_ALLOCATION_STRATEGIES = [
  'price-capacity-optimized',
  'capacity-optimized',
  'lowest-price',
  'diversified',
] as const;
export const EC2_VOLUME_TYPES = ['gp3', 'gp2', 'io2', 'io1'] as const;
export const EC2_PARK_POLICIES = ['hold', 'release'] as const;
export const EC2_SCHEDULER_STRATEGIES = ['per-stage-ephemeral'] as const;

export type Ec2Platform = (typeof EC2_PLATFORMS)[number];
export type Ec2Architecture = (typeof EC2_ARCHITECTURES)[number];
export type Ec2PurchaseOption = (typeof EC2_PURCHASE_OPTIONS)[number];
export type Ec2AllocationStrategy = (typeof EC2_ALLOCATION_STRATEGIES)[number];
export type Ec2VolumeType = (typeof EC2_VOLUME_TYPES)[number];
export type Ec2ParkPolicy = (typeof EC2_PARK_POLICIES)[number];
export type Ec2SchedulerStrategy = (typeof EC2_SCHEDULER_STRATEGIES)[number];

const AMI_ID_PATTERN = /^ami-[0-9a-f]{8}([0-9a-f]{9})?$/;
const AMI_ARN_PATTERN =
  /^arn:[a-z0-9-]+:ec2:[a-z0-9-]+:\d*:image\/(ami-[0-9a-f]{8}([0-9a-f]{9})?)$/;
const INSTANCE_TYPE_PATTERN = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
const INSTANCE_FAMILY_PATTERN = /^[a-z][a-z0-9-]*$/;
const ACCOUNT_PATTERN = /^\d{12}$/;
const SECURITY_GROUP_PATTERN = /^sg-[0-9a-f]{8}([0-9a-f]{9})?$/;
const POLICY_ARN_PATTERN = /^arn:[a-z0-9-]+:iam::(aws|\d{12}):policy\/.+$/;
const ROLE_ARN_PATTERN = /^arn:[a-z0-9-]+:iam::\d{12}:role\/.+$/;
const AZ_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d[a-z]$/;
const ACCELERATOR_MANUFACTURER_PATTERN = /^[a-z0-9-]+$/;
const ACCELERATOR_TYPE_PATTERN = /^[a-z]+$/;

export interface Ec2Bounds {
  min: number;
  max: number;
}

export const EC2_LIMITS = {
  rootVolumeGiB: { min: 8, max: 16384 },
  maxInstances: { min: 1, max: 64 },
  maxConcurrentPlacements: { min: 1, max: 64 },
  maxLifetimeSeconds: { min: 300, max: 28800 },
  stageTimeoutSeconds: { min: 300, max: 28800 },
  bootstrapTimeoutSeconds: { min: 120, max: 3600 },
  instanceTypes: { max: 20 },
  instanceFamilies: { max: 20 },
  availabilityZones: { max: 6 },
  securityGroupIds: { max: 5 },
  additionalPolicyArns: { max: 10 },
  maxHourlyCostUsd: { min: 0.01, max: 1000 },
} as const;

export const EC2_LAUNCH_SPEC_DEFAULTS = {
  platform: 'linux' as Ec2Platform,
  architecture: 'x86_64' as Ec2Architecture,
  purchaseOption: 'on-demand' as Ec2PurchaseOption,
  spotFallbackToOnDemand: true,
  allocationStrategy: 'price-capacity-optimized' as Ec2AllocationStrategy,
  rootVolume: { sizeGiB: 100, type: 'gp3' as Ec2VolumeType },
  workspaceOnInstanceStore: false,
  workspacePath: '/mnt/workspace',
  parkPolicy: 'release' as Ec2ParkPolicy,
  strategyId: 'per-stage-ephemeral' as Ec2SchedulerStrategy,
  maxInstances: 4,
  maxConcurrentPlacements: 4,
  maxLifetimeSeconds: 28800,
  stageTimeoutSeconds: 28800,
  bootstrapTimeoutSeconds: 900,
} as const;

export interface Ec2Range {
  min?: number;
  max?: number;
}

export interface Ec2InstanceRequirements {
  vCpuCount?: Ec2Range;
  memoryMiB?: Ec2Range;
  acceleratorCount?: Ec2Range;
  acceleratorManufacturers?: string[];
  acceleratorTypes?: string[];
}

export interface Ec2RootVolume {
  sizeGiB: number;
  type: Ec2VolumeType;
  iops?: number;
  throughput?: number;
}

/** The canonical stored form, as the lambda normalizes and persists it. */
export interface Ec2LaunchSpec {
  schemaVersion: number;
  platform: Ec2Platform;
  architecture: Ec2Architecture;
  imageRef: string | null;
  imageId: string | null;
  imageOwnerAccountId: string | null;
  instanceTypes: string[];
  instanceFamilies: string[];
  instanceRequirements: Ec2InstanceRequirements | null;
  purchaseOption: Ec2PurchaseOption;
  spotFallbackToOnDemand: boolean;
  allocationStrategy: Ec2AllocationStrategy;
  maxPricePerHour: number | null;
  availabilityZones: string[];
  rootVolume: Ec2RootVolume;
  workspaceOnInstanceStore: boolean;
  associatePublicIp: boolean;
  securityGroupIds: string[];
  additionalPolicyArns: string[];
  instanceRoleArn: string | null;
  workspacePath: string;
  parkPolicy: Ec2ParkPolicy;
  strategyId: Ec2SchedulerStrategy;
  maxInstances: number;
  maxConcurrentPlacements: number;
  maxLifetimeSeconds: number;
  stageTimeoutSeconds: number;
  bootstrapTimeoutSeconds: number;
  maxHourlyCostUsd: number | null;
  tags: Record<string, string>;
}

/** What the form submits — every field optional, the server applies defaults. */
export interface Ec2LaunchSpecInput {
  platform?: string;
  architecture?: string;
  imageRef?: string;
  imageOwnerAccountId?: string | null;
  instanceTypes?: string[];
  instanceFamilies?: string[];
  instanceRequirements?: Ec2InstanceRequirements | null;
  purchaseOption?: string;
  spotFallbackToOnDemand?: boolean;
  allocationStrategy?: string;
  maxPricePerHour?: number | null;
  availabilityZones?: string[];
  rootVolume?: {
    sizeGiB?: number;
    type?: string;
    iops?: number | null;
    throughput?: number | null;
  };
  workspaceOnInstanceStore?: boolean;
  securityGroupIds?: string[];
  additionalPolicyArns?: string[];
  instanceRoleArn?: string | null;
  workspacePath?: string;
  parkPolicy?: string;
  strategyId?: string;
  maxInstances?: number;
  maxConcurrentPlacements?: number;
  maxLifetimeSeconds?: number;
  stageTimeoutSeconds?: number;
  bootstrapTimeoutSeconds?: number;
  maxHourlyCostUsd?: number | null;
  tags?: Record<string, string>;
}

/** One field-level complaint, matching the API's `errors: [{ field, message }]`. */
export interface FieldError {
  field: string;
  message: string;
}

const err = (field: string, message: string): FieldError => ({ field, message });

export const parseImageRef = (value: unknown): { imageId: string; arn: string | null } | null => {
  const raw = String(value ?? '').trim();
  if (AMI_ID_PATTERN.test(raw)) return { imageId: raw, arn: null };
  const arnMatch = AMI_ARN_PATTERN.exec(raw);
  if (arnMatch) return { imageId: arnMatch[1], arn: raw };
  return null;
};

const checkList = (
  value: string[] | undefined,
  {
    field,
    pattern,
    max,
    label,
    errors,
  }: { field: string; pattern: RegExp; max: number; label: string; errors: FieldError[] },
) => {
  if (value == null) return;
  if (value.length > max) errors.push(err(field, `${field} accepts at most ${max} entries`));
  for (const entry of value) {
    const item = String(entry ?? '').trim();
    if (!pattern.test(item)) errors.push(err(field, `"${item}" is not a valid ${label}`));
  }
};

const checkBoundedInteger = (
  value: number | null | undefined,
  { field, bounds, errors }: { field: string; bounds: Ec2Bounds; errors: FieldError[] },
) => {
  if (value == null) return;
  if (!Number.isInteger(value)) {
    errors.push(err(field, `${field} must be an integer`));
    return;
  }
  if (value < bounds.min || value > bounds.max) {
    errors.push(err(field, `${field} must be between ${bounds.min} and ${bounds.max}`));
  }
};

const checkEnum = (
  value: string | undefined,
  { field, allowed, errors }: { field: string; allowed: readonly string[]; errors: FieldError[] },
) => {
  if (value == null) return;
  if (!allowed.includes(String(value))) {
    errors.push(err(field, `${field} must be one of ${allowed.join(', ')}`));
  }
};

const checkRange = (
  key: keyof Ec2InstanceRequirements,
  raw: Ec2Range | undefined,
  bounds: Ec2Bounds,
  errors: FieldError[],
) => {
  if (raw == null) return;
  for (const edge of ['min', 'max'] as const) {
    checkBoundedInteger(raw[edge], {
      field: `instanceRequirements.${key}.${edge}`,
      bounds,
      errors,
    });
  }
  if (raw.min != null && raw.max != null && raw.min > raw.max) {
    errors.push(err(`instanceRequirements.${key}`, `${key}.min cannot exceed ${key}.max`));
  }
};

const hasInstanceRequirements = (requirements: Ec2InstanceRequirements | null | undefined) =>
  Boolean(requirements) && Object.keys(requirements ?? {}).length > 0;

/**
 * Validate a form-submitted launch spec against the same rules the lambda applies.
 *
 * Returns the field-level errors in no particular order; an empty array means the
 * server is expected to accept it.
 */
export const validateEc2LaunchSpecInput = (input: Ec2LaunchSpecInput): FieldError[] => {
  const errors: FieldError[] = [];

  checkEnum(input.platform, { field: 'platform', allowed: EC2_PLATFORMS, errors });
  const platform = input.platform ?? EC2_LAUNCH_SPEC_DEFAULTS.platform;
  if (
    (EC2_PLATFORMS as readonly string[]).includes(platform) &&
    !(SUPPORTED_EC2_PLATFORMS as readonly string[]).includes(platform)
  ) {
    errors.push(
      err('platform', `platform "${platform}" is not supported yet (runner bundle is Linux-only)`),
    );
  }
  checkEnum(input.architecture, { field: 'architecture', allowed: EC2_ARCHITECTURES, errors });

  if (!parseImageRef(input.imageRef)) {
    errors.push(err('imageRef', 'imageRef must be an AMI id (ami-…) or an AMI ARN'));
  }
  if (input.imageOwnerAccountId != null && input.imageOwnerAccountId !== '') {
    if (!ACCOUNT_PATTERN.test(String(input.imageOwnerAccountId).trim())) {
      errors.push(err('imageOwnerAccountId', 'imageOwnerAccountId must be a 12-digit account id'));
    }
  }

  checkList(input.instanceTypes, {
    field: 'instanceTypes',
    pattern: INSTANCE_TYPE_PATTERN,
    max: EC2_LIMITS.instanceTypes.max,
    label: 'instance type',
    errors,
  });
  checkList(input.instanceFamilies, {
    field: 'instanceFamilies',
    pattern: INSTANCE_FAMILY_PATTERN,
    max: EC2_LIMITS.instanceFamilies.max,
    label: 'instance family',
    errors,
  });
  const requirements = input.instanceRequirements ?? null;
  checkRange('vCpuCount', requirements?.vCpuCount, { min: 1, max: 1024 }, errors);
  checkRange('memoryMiB', requirements?.memoryMiB, { min: 512, max: 24_576_000 }, errors);
  checkRange('acceleratorCount', requirements?.acceleratorCount, { min: 0, max: 64 }, errors);
  checkList(requirements?.acceleratorManufacturers, {
    field: 'instanceRequirements.acceleratorManufacturers',
    pattern: ACCELERATOR_MANUFACTURER_PATTERN,
    max: 5,
    label: 'accelerator manufacturer',
    errors,
  });
  checkList(requirements?.acceleratorTypes, {
    field: 'instanceRequirements.acceleratorTypes',
    pattern: ACCELERATOR_TYPE_PATTERN,
    max: 5,
    label: 'accelerator type',
    errors,
  });
  if (
    (input.instanceTypes?.length ?? 0) === 0 &&
    (input.instanceFamilies?.length ?? 0) === 0 &&
    !hasInstanceRequirements(requirements)
  ) {
    errors.push(
      err(
        'instanceTypes',
        'declare at least one of instanceTypes, instanceFamilies or instanceRequirements',
      ),
    );
  }

  checkEnum(input.purchaseOption, {
    field: 'purchaseOption',
    allowed: EC2_PURCHASE_OPTIONS,
    errors,
  });
  checkEnum(input.allocationStrategy, {
    field: 'allocationStrategy',
    allowed: EC2_ALLOCATION_STRATEGIES,
    errors,
  });
  const purchaseOption = input.purchaseOption ?? EC2_LAUNCH_SPEC_DEFAULTS.purchaseOption;
  if (input.maxPricePerHour != null) {
    const price = Number(input.maxPricePerHour);
    if (!Number.isFinite(price) || price <= 0) {
      errors.push(err('maxPricePerHour', 'maxPricePerHour must be a positive number'));
    } else if (purchaseOption !== 'spot') {
      errors.push(err('maxPricePerHour', 'maxPricePerHour only applies to spot capacity'));
    }
  }

  checkList(input.availabilityZones, {
    field: 'availabilityZones',
    pattern: AZ_PATTERN,
    max: EC2_LIMITS.availabilityZones.max,
    label: 'availability zone',
    errors,
  });
  checkList(input.securityGroupIds, {
    field: 'securityGroupIds',
    pattern: SECURITY_GROUP_PATTERN,
    max: EC2_LIMITS.securityGroupIds.max,
    label: 'security group id',
    errors,
  });
  checkList(input.additionalPolicyArns, {
    field: 'additionalPolicyArns',
    pattern: POLICY_ARN_PATTERN,
    max: EC2_LIMITS.additionalPolicyArns.max,
    label: 'IAM policy ARN',
    errors,
  });
  if (input.instanceRoleArn != null && String(input.instanceRoleArn).trim() !== '') {
    if (!ROLE_ARN_PATTERN.test(String(input.instanceRoleArn).trim())) {
      errors.push(err('instanceRoleArn', 'must be an IAM role ARN in this account'));
    }
  }

  const volumeType = (input.rootVolume?.type ??
    EC2_LAUNCH_SPEC_DEFAULTS.rootVolume.type) as Ec2VolumeType;
  checkEnum(input.rootVolume?.type, {
    field: 'rootVolume.type',
    allowed: EC2_VOLUME_TYPES,
    errors,
  });
  checkBoundedInteger(input.rootVolume?.sizeGiB, {
    field: 'rootVolume.sizeGiB',
    bounds: EC2_LIMITS.rootVolumeGiB,
    errors,
  });
  if (input.rootVolume?.iops != null) {
    if (volumeType === 'gp2') {
      errors.push(err('rootVolume.iops', 'gp2 volumes do not accept a provisioned iops value'));
    } else {
      checkBoundedInteger(input.rootVolume.iops, {
        field: 'rootVolume.iops',
        bounds: { min: 100, max: 256000 },
        errors,
      });
    }
  }
  if (input.rootVolume?.throughput != null) {
    if (volumeType !== 'gp3') {
      errors.push(err('rootVolume.throughput', 'throughput is only supported on gp3 volumes'));
    } else {
      checkBoundedInteger(input.rootVolume.throughput, {
        field: 'rootVolume.throughput',
        bounds: { min: 125, max: 1000 },
        errors,
      });
    }
  }

  checkEnum(input.parkPolicy, { field: 'parkPolicy', allowed: EC2_PARK_POLICIES, errors });
  checkEnum(input.strategyId, { field: 'strategyId', allowed: EC2_SCHEDULER_STRATEGIES, errors });
  checkBoundedInteger(input.maxInstances, {
    field: 'maxInstances',
    bounds: EC2_LIMITS.maxInstances,
    errors,
  });
  checkBoundedInteger(input.maxConcurrentPlacements, {
    field: 'maxConcurrentPlacements',
    bounds: EC2_LIMITS.maxConcurrentPlacements,
    errors,
  });
  checkBoundedInteger(input.maxLifetimeSeconds, {
    field: 'maxLifetimeSeconds',
    bounds: EC2_LIMITS.maxLifetimeSeconds,
    errors,
  });
  checkBoundedInteger(input.stageTimeoutSeconds, {
    field: 'stageTimeoutSeconds',
    bounds: EC2_LIMITS.stageTimeoutSeconds,
    errors,
  });
  checkBoundedInteger(input.bootstrapTimeoutSeconds, {
    field: 'bootstrapTimeoutSeconds',
    bounds: EC2_LIMITS.bootstrapTimeoutSeconds,
    errors,
  });

  if (input.maxHourlyCostUsd != null) {
    const cost = Number(input.maxHourlyCostUsd);
    if (
      !Number.isFinite(cost) ||
      cost < EC2_LIMITS.maxHourlyCostUsd.min ||
      cost > EC2_LIMITS.maxHourlyCostUsd.max
    ) {
      errors.push(
        err(
          'maxHourlyCostUsd',
          `maxHourlyCostUsd must be between ${EC2_LIMITS.maxHourlyCostUsd.min} and ${EC2_LIMITS.maxHourlyCostUsd.max}`,
        ),
      );
    }
  }

  // The cross-field rules, which are where a plausible-looking spec usually
  // fails: each of these is legal in isolation.
  const stageTimeout = input.stageTimeoutSeconds ?? EC2_LAUNCH_SPEC_DEFAULTS.stageTimeoutSeconds;
  const maxLifetime = input.maxLifetimeSeconds ?? EC2_LAUNCH_SPEC_DEFAULTS.maxLifetimeSeconds;
  if (stageTimeout > maxLifetime) {
    errors.push(err('stageTimeoutSeconds', 'stageTimeoutSeconds cannot exceed maxLifetimeSeconds'));
  }
  const placements =
    input.maxConcurrentPlacements ?? EC2_LAUNCH_SPEC_DEFAULTS.maxConcurrentPlacements;
  const instances = input.maxInstances ?? EC2_LAUNCH_SPEC_DEFAULTS.maxInstances;
  if (placements > instances) {
    errors.push(
      err('maxConcurrentPlacements', 'maxConcurrentPlacements cannot exceed maxInstances'),
    );
  }
  const parkPolicy = input.parkPolicy ?? EC2_LAUNCH_SPEC_DEFAULTS.parkPolicy;
  if (parkPolicy === 'hold' && maxLifetime === EC2_LIMITS.maxLifetimeSeconds.max) {
    errors.push(
      err(
        'parkPolicy',
        'parkPolicy "hold" requires an explicit maxLifetimeSeconds below the maximum, since the instance bills for the whole human wait',
      ),
    );
  }

  for (const key of Object.keys(input.tags ?? {})) {
    if (/^aws:/i.test(key)) {
      errors.push(err('tags', `tag key "${key}" uses the reserved aws: prefix`));
    }
  }

  return errors;
};

/**
 * Field-level errors carried by a rejected API call.
 *
 * The environments endpoint answers `{ error, errors: [{ field, message }] }`, and
 * ApiError keeps the parsed body — so a server rejection can be attached to the
 * same inputs client-side validation marks. Duck-typed rather than instanceof so a
 * test double does not have to construct an ApiError.
 */
export const fieldErrorsFrom = (reason: unknown): FieldError[] => {
  const body = (reason as { body?: { errors?: unknown } } | null)?.body;
  const raw = Array.isArray(body?.errors) ? body.errors : [];
  return raw
    .map((entry) => entry as { field?: unknown; message?: unknown })
    .filter((entry) => typeof entry?.message === 'string')
    .map((entry) => err(String(entry.field ?? 'spec'), String(entry.message)));
};

/** The first message for a field, for rendering next to its input. */
export const errorFor = (errors: FieldError[], field: string): string | null =>
  errors.find((entry) => entry.field === field)?.message ?? null;
