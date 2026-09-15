// EC2 launch specs — the `EC2` environment kind.
//
// An AGENTCORE environment is a RECIPE: the platform composes catalog tools onto
// a protected base and builds an image. An EC2 environment is the opposite
// contract: the operator brings an AMI, the platform layers NOTHING onto it, and
// the "build" step produces only a LAUNCH TEMPLATE that carries the
// platform-owned invariants (instance profile, IMDSv2, encrypted EBS, the runner
// bootstrap) around that opaque image.
//
// So this module is validation and normalization only. There is no Dockerfile
// generator, no tool resolution, and no size projection — a spec is a machine
// shape, and the AMI's contents are the operator's business. What the platform
// does assert is that the image EXISTS, is usable, and matches the declared
// architecture (see `imageAssertions`, evaluated against DescribeImages by the
// caller, which owns the AWS client).
//
// The spec is stored verbatim on the revision, so it is immutable once published
// exactly like a recipe: `launchTemplateId` + `launchTemplateVersion` are stamped
// on the revision at build time and are the frozen launch identity a running
// intent keeps, the way `imageDigest` is for an image.

export const EC2_LAUNCH_SPEC_SCHEMA_VERSION = 1;

// Linux is the only platform the runner bundle ships for today. The other two
// are declared so a spec that names them round-trips as a KNOWN value and fails
// with an explicit "not supported yet" rather than "unknown platform" — the
// forward path (Windows service wrapper, macOS dedicated hosts) is real work,
// not a typo.
export const EC2_PLATFORMS = ['linux', 'windows', 'macos'];
export const SUPPORTED_EC2_PLATFORMS = ['linux'];
export const EC2_ARCHITECTURES = ['x86_64', 'arm64'];
export const EC2_PURCHASE_OPTIONS = ['on-demand', 'spot'];
// `price-capacity-optimized` is the default because a build host is
// interruption-sensitive but not latency-sensitive: we would rather pay slightly
// more than have a spot reclaim kill a half-hour compile.
export const EC2_ALLOCATION_STRATEGIES = [
  'price-capacity-optimized',
  'capacity-optimized',
  'lowest-price',
  'diversified',
];
export const EC2_VOLUME_TYPES = ['gp3', 'gp2', 'io2', 'io1'];
// What a worker does when its stage parks on a human gate. AgentCore has a
// managed persistent mount and releases compute on park; EC2 has no equivalent,
// so this is a per-environment choice rather than a platform-wide one:
//   hold    — keep the instance, conversation stays in memory, resume continues
//             mid-thought. Pays for an idle instance across the whole wait.
//   release — terminate, and let the answer drive a fresh attempt through the
//             existing demoted-resume path (run-stage.js recoverLostConversation),
//             which re-runs the stage with the answer injected.
export const EC2_PARK_POLICIES = ['hold', 'release'];

// v1's only scheduler strategy: one worker per stage attempt, terminated on
// exit. Warm pools, idle yielding and work stealing are later strategies; the
// field exists now so adding them is configuration rather than a schema change.
export const EC2_SCHEDULER_STRATEGIES = ['per-stage-ephemeral'];

const AMI_ID_PATTERN = /^ami-[0-9a-f]{8}([0-9a-f]{9})?$/;
// arn:aws:ec2:<region>:<account>:image/ami-…  — account may be empty for
// public/Amazon-owned images, which is why the field is not \d{12}.
const AMI_ARN_PATTERN =
  /^arn:[a-z0-9-]+:ec2:[a-z0-9-]+:\d*:image\/(ami-[0-9a-f]{8}([0-9a-f]{9})?)$/;
const INSTANCE_TYPE_PATTERN = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
const INSTANCE_FAMILY_PATTERN = /^[a-z][a-z0-9-]*$/;
const ACCOUNT_PATTERN = /^\d{12}$/;
const SECURITY_GROUP_PATTERN = /^sg-[0-9a-f]{8}([0-9a-f]{9})?$/;
const POLICY_ARN_PATTERN = /^arn:[a-z0-9-]+:iam::(aws|\d{12}):policy\/.+$/;
// A customer-account role ARN — never `aws`, since an instance role must live in
// the deploying account for the platform to wrap it in an instance profile and to
// simulate its policies at ready-time.
const ROLE_ARN_PATTERN = /^arn:[a-z0-9-]+:iam::\d{12}:role\/.+$/;
const AZ_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d[a-z]$/;

// Bounds. These are guardrails against a typo becoming a five-figure bill or an
// instance that outlives the run that spawned it — not opinions about workloads.
export const EC2_LIMITS = {
  rootVolumeGiB: { min: 8, max: 16384 },
  maxInstances: { min: 1, max: 64 },
  maxConcurrentPlacements: { min: 1, max: 64 },
  // 8h matches the AgentCore runtime ceiling (max_lifetime = 28800), so a stage
  // cannot legitimately outlive it on either worker kind. 5 min floor keeps a
  // fat-fingered value from terminating a worker mid-bootstrap.
  maxLifetimeSeconds: { min: 300, max: 28800 },
  stageTimeoutSeconds: { min: 300, max: 28800 },
  // A cold GPU/build AMI plus a runner-bundle fetch is minutes, not seconds.
  bootstrapTimeoutSeconds: { min: 120, max: 3600 },
  instanceTypes: { max: 20 },
  instanceFamilies: { max: 20 },
  availabilityZones: { max: 6 },
  securityGroupIds: { max: 5 },
  additionalPolicyArns: { max: 10 },
  maxHourlyCostUsd: { min: 0.01, max: 1000 },
};

export const EC2_LAUNCH_SPEC_DEFAULTS = {
  platform: 'linux',
  architecture: 'x86_64',
  purchaseOption: 'on-demand',
  spotFallbackToOnDemand: true,
  allocationStrategy: 'price-capacity-optimized',
  rootVolume: { sizeGiB: 100, type: 'gp3' },
  workspaceOnInstanceStore: false,
  associatePublicIp: false,
  workspacePath: '/mnt/workspace',
  // HOLD by default. A parked stage is SUSPENDED, not finished: the agent asked a
  // question and is waiting for an answer, and its conversation plus its checkout
  // exist only on that instance. Releasing there means the resume lands on a fresh
  // machine with an empty workspace, re-clones, and loses the thread — which is
  // exactly what it did before this default changed. `release` remains available for
  // an environment that would rather pay a re-clone than hold an instance across a
  // human gate, but it must be chosen deliberately.
  parkPolicy: 'hold',
  strategyId: 'per-stage-ephemeral',
  maxInstances: 4,
  maxConcurrentPlacements: 4,
  // Four hours, not the 28800 maximum. With `hold` as the default park policy an
  // instance can be kept across a human gate, so the default lifetime IS the bound on
  // what an unanswered gate can cost — leaving it at the maximum would make the
  // common case an 8-hour bill nobody chose. An operator who wants longer sets it.
  maxLifetimeSeconds: 14400,
  // Matches the default lifetime: a stage cannot usefully outlive the instance it
  // runs on, and stageTimeoutSeconds > maxLifetimeSeconds is refused below.
  stageTimeoutSeconds: 14400,
  bootstrapTimeoutSeconds: 900,
};

const err = (field, message) => ({ field, message });

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Pull the bare ami-… out of either accepted form. Returns null when neither
// matches, so the caller reports one clear error instead of two.
export const parseImageRef = (value) => {
  const raw = String(value ?? '').trim();
  if (AMI_ID_PATTERN.test(raw)) return { imageId: raw, arn: null };
  const arnMatch = AMI_ARN_PATTERN.exec(raw);
  if (arnMatch) return { imageId: arnMatch[1], arn: raw };
  return null;
};

const validateStringList = (value, { field, pattern, max, errors, label }) => {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push(err(field, `${field} must be an array of ${label}`));
    return [];
  }
  if (value.length > max) {
    errors.push(err(field, `${field} accepts at most ${max} entries`));
  }
  const normalized = [];
  for (const entry of value) {
    const item = String(entry ?? '').trim();
    if (!pattern.test(item)) {
      errors.push(err(field, `"${item}" is not a valid ${label}`));
      continue;
    }
    // Order is meaningful for instanceTypes (it becomes CreateFleet override
    // Priority), so de-duplicate while PRESERVING first-seen position.
    if (!normalized.includes(item)) normalized.push(item);
  }
  return normalized;
};

const validateBoundedInteger = (value, { field, bounds, fallback, errors }) => {
  if (value == null) return fallback;
  if (!Number.isInteger(value)) {
    errors.push(err(field, `${field} must be an integer`));
    return fallback;
  }
  if (value < bounds.min || value > bounds.max) {
    errors.push(err(field, `${field} must be between ${bounds.min} and ${bounds.max}`));
    return fallback;
  }
  return value;
};

const validateEnum = (value, { field, allowed, fallback, errors }) => {
  if (value == null) return fallback;
  const item = String(value);
  if (!allowed.includes(item)) {
    errors.push(err(field, `${field} must be one of ${allowed.join(', ')}`));
    return fallback;
  }
  return item;
};

const validateRootVolume = (value, errors) => {
  const fallback = { ...EC2_LAUNCH_SPEC_DEFAULTS.rootVolume };
  if (value == null) return fallback;
  if (!isPlainObject(value)) {
    errors.push(err('rootVolume', 'rootVolume must be an object'));
    return fallback;
  }
  const type = validateEnum(value.type, {
    field: 'rootVolume.type',
    allowed: EC2_VOLUME_TYPES,
    fallback: fallback.type,
    errors,
  });
  const sizeGiB = validateBoundedInteger(value.sizeGiB, {
    field: 'rootVolume.sizeGiB',
    bounds: EC2_LIMITS.rootVolumeGiB,
    fallback: fallback.sizeGiB,
    errors,
  });
  const volume = { sizeGiB, type };
  // iops/throughput are only meaningful on the types that expose them; silently
  // storing them elsewhere would produce a launch template EC2 rejects at fleet
  // time, which is a much worse place to find out.
  if (value.iops != null) {
    if (type === 'gp2') {
      errors.push(err('rootVolume.iops', 'gp2 volumes do not accept a provisioned iops value'));
    } else {
      volume.iops = validateBoundedInteger(value.iops, {
        field: 'rootVolume.iops',
        bounds: { min: 100, max: 256000 },
        fallback: undefined,
        errors,
      });
    }
  }
  if (value.throughput != null) {
    if (type !== 'gp3') {
      errors.push(err('rootVolume.throughput', 'throughput is only supported on gp3 volumes'));
    } else {
      volume.throughput = validateBoundedInteger(value.throughput, {
        field: 'rootVolume.throughput',
        bounds: { min: 125, max: 1000 },
        fallback: undefined,
        errors,
      });
    }
  }
  return volume;
};

// Attribute-based selection, the alternative to naming instance types. Only the
// attributes a build/render host actually selects on are admitted — the full
// InstanceRequirements surface is enormous and every field we accept is a field
// we must keep meaningful in the fleet request.
const validateInstanceRequirements = (value, errors) => {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    errors.push(err('instanceRequirements', 'instanceRequirements must be an object'));
    return null;
  }
  const requirements = {};
  const range = (key, bounds) => {
    const raw = value[key];
    if (raw == null) return;
    if (!isPlainObject(raw)) {
      errors.push(
        err(`instanceRequirements.${key}`, `${key} must be an object with min and/or max`),
      );
      return;
    }
    const out = {};
    for (const edge of ['min', 'max']) {
      if (raw[edge] == null) continue;
      out[edge] = validateBoundedInteger(raw[edge], {
        field: `instanceRequirements.${key}.${edge}`,
        bounds,
        fallback: undefined,
        errors,
      });
    }
    if (out.min != null && out.max != null && out.min > out.max) {
      errors.push(err(`instanceRequirements.${key}`, `${key}.min cannot exceed ${key}.max`));
    }
    if (Object.keys(out).length > 0) requirements[key] = out;
  };
  range('vCpuCount', { min: 1, max: 1024 });
  range('memoryMiB', { min: 512, max: 24_576_000 });
  range('acceleratorCount', { min: 0, max: 64 });
  if (value.acceleratorManufacturers != null) {
    requirements.acceleratorManufacturers = validateStringList(value.acceleratorManufacturers, {
      field: 'instanceRequirements.acceleratorManufacturers',
      pattern: /^[a-z0-9-]+$/,
      max: 5,
      errors,
      label: 'accelerator manufacturer',
    });
  }
  if (value.acceleratorTypes != null) {
    requirements.acceleratorTypes = validateStringList(value.acceleratorTypes, {
      field: 'instanceRequirements.acceleratorTypes',
      pattern: /^[a-z]+$/,
      max: 5,
      errors,
      label: 'accelerator type',
    });
  }
  return Object.keys(requirements).length > 0 ? requirements : null;
};

/**
 * Validate and normalize an operator-submitted EC2 launch spec.
 *
 * Returns `{ valid, errors, spec }`. `spec` is the canonical form to persist on
 * the revision — defaults applied, lists de-duplicated, order preserved — and is
 * only meaningful when `valid` is true.
 */
export const validateEc2LaunchSpec = (input) => {
  const errors = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: [err('spec', 'launch spec must be an object')], spec: null };
  }

  const platform = validateEnum(input.platform, {
    field: 'platform',
    allowed: EC2_PLATFORMS,
    fallback: EC2_LAUNCH_SPEC_DEFAULTS.platform,
    errors,
  });
  if (EC2_PLATFORMS.includes(platform) && !SUPPORTED_EC2_PLATFORMS.includes(platform)) {
    errors.push(
      err('platform', `platform "${platform}" is not supported yet (runner bundle is Linux-only)`),
    );
  }

  const architecture = validateEnum(input.architecture, {
    field: 'architecture',
    allowed: EC2_ARCHITECTURES,
    fallback: EC2_LAUNCH_SPEC_DEFAULTS.architecture,
    errors,
  });

  const image = parseImageRef(input.imageRef);
  if (!image) {
    errors.push(err('imageRef', 'imageRef must be an AMI id (ami-…) or an AMI ARN'));
  }

  let imageOwnerAccountId = null;
  if (input.imageOwnerAccountId != null) {
    imageOwnerAccountId = String(input.imageOwnerAccountId).trim();
    if (!ACCOUNT_PATTERN.test(imageOwnerAccountId)) {
      errors.push(err('imageOwnerAccountId', 'imageOwnerAccountId must be a 12-digit account id'));
      imageOwnerAccountId = null;
    }
  }

  const instanceTypes = validateStringList(input.instanceTypes, {
    field: 'instanceTypes',
    pattern: INSTANCE_TYPE_PATTERN,
    max: EC2_LIMITS.instanceTypes.max,
    errors,
    label: 'instance type',
  });
  const instanceFamilies = validateStringList(input.instanceFamilies, {
    field: 'instanceFamilies',
    pattern: INSTANCE_FAMILY_PATTERN,
    max: EC2_LIMITS.instanceFamilies.max,
    errors,
    label: 'instance family',
  });
  const instanceRequirements = validateInstanceRequirements(input.instanceRequirements, errors);
  // A fleet request needs SOMETHING to select on. Without this the spec would
  // publish and then fail at first placement, which is the worst time to learn.
  if (
    instanceTypes.length === 0 &&
    instanceFamilies.length === 0 &&
    instanceRequirements === null
  ) {
    errors.push(
      err(
        'instanceTypes',
        'declare at least one of instanceTypes, instanceFamilies or instanceRequirements',
      ),
    );
  }

  const purchaseOption = validateEnum(input.purchaseOption, {
    field: 'purchaseOption',
    allowed: EC2_PURCHASE_OPTIONS,
    fallback: EC2_LAUNCH_SPEC_DEFAULTS.purchaseOption,
    errors,
  });
  const allocationStrategy = validateEnum(input.allocationStrategy, {
    field: 'allocationStrategy',
    allowed: EC2_ALLOCATION_STRATEGIES,
    fallback: EC2_LAUNCH_SPEC_DEFAULTS.allocationStrategy,
    errors,
  });
  let maxPricePerHour = null;
  if (input.maxPricePerHour != null) {
    const price = Number(input.maxPricePerHour);
    if (!Number.isFinite(price) || price <= 0) {
      errors.push(err('maxPricePerHour', 'maxPricePerHour must be a positive number'));
    } else if (purchaseOption !== 'spot') {
      errors.push(err('maxPricePerHour', 'maxPricePerHour only applies to spot capacity'));
    } else {
      maxPricePerHour = price;
    }
  }

  if (input.associatePublicIp === true) {
    errors.push(
      err(
        'associatePublicIp',
        "workers run in private subnets; a public IP would require a network-interface block that cannot coexist with the scheduler's subnet override",
      ),
    );
  }

  const availabilityZones = validateStringList(input.availabilityZones, {
    field: 'availabilityZones',
    pattern: AZ_PATTERN,
    max: EC2_LIMITS.availabilityZones.max,
    errors,
    label: 'availability zone',
  });
  const securityGroupIds = validateStringList(input.securityGroupIds, {
    field: 'securityGroupIds',
    pattern: SECURITY_GROUP_PATTERN,
    max: EC2_LIMITS.securityGroupIds.max,
    errors,
    label: 'security group id',
  });
  const additionalPolicyArns = validateStringList(input.additionalPolicyArns, {
    field: 'additionalPolicyArns',
    pattern: POLICY_ARN_PATTERN,
    max: EC2_LIMITS.additionalPolicyArns.max,
    errors,
    label: 'IAM policy ARN',
  });

  // The instance role this environment's workers run as. This is the PER-ENVIRONMENT
  // IAM hook: an S3 vcpkg cache, ECR pull, a Secrets Manager read — anything a
  // specific build class needs — belongs on THIS role, not smeared across the shared
  // default profile where every other environment's workers would inherit it too.
  //
  // A role, not a policy list (the old additionalPolicyArns, which nothing ever
  // attached): a role is the thing whose EFFECTIVE permissions can be simulated, so
  // ready-time can prove it still grants the baseline a worker needs before the
  // revision is allowed to publish (see assertRoleCoversWorkerBaseline). When unset
  // the platform's default executor profile is used, exactly as before.
  let instanceRoleArn = null;
  if (input.instanceRoleArn != null && String(input.instanceRoleArn).trim() !== '') {
    const raw = String(input.instanceRoleArn).trim();
    if (!ROLE_ARN_PATTERN.test(raw)) {
      errors.push(err('instanceRoleArn', 'must be an IAM role ARN in this account'));
    } else {
      instanceRoleArn = raw;
    }
  }

  const spec = {
    schemaVersion: EC2_LAUNCH_SPEC_SCHEMA_VERSION,
    platform,
    architecture,
    imageRef: image ? (image.arn ?? image.imageId) : null,
    imageId: image?.imageId ?? null,
    imageOwnerAccountId,
    instanceTypes,
    instanceFamilies,
    instanceRequirements,
    purchaseOption,
    spotFallbackToOnDemand:
      input.spotFallbackToOnDemand == null
        ? EC2_LAUNCH_SPEC_DEFAULTS.spotFallbackToOnDemand
        : Boolean(input.spotFallbackToOnDemand),
    allocationStrategy,
    maxPricePerHour,
    availabilityZones,
    rootVolume: validateRootVolume(input.rootVolume, errors),
    workspaceOnInstanceStore:
      input.workspaceOnInstanceStore == null
        ? EC2_LAUNCH_SPEC_DEFAULTS.workspaceOnInstanceStore
        : Boolean(input.workspaceOnInstanceStore),
    // Always false. A public IP can only be requested through a NetworkInterfaces
    // block, which cannot coexist with the subnet override the scheduler needs to
    // spread placement and retry on capacity errors. Workers live in private
    // subnets with NAT egress, so this costs nothing real.
    associatePublicIp: false,
    securityGroupIds,
    additionalPolicyArns,
    instanceRoleArn,
    workspacePath: String(input.workspacePath ?? EC2_LAUNCH_SPEC_DEFAULTS.workspacePath),
    parkPolicy: validateEnum(input.parkPolicy, {
      field: 'parkPolicy',
      allowed: EC2_PARK_POLICIES,
      fallback: EC2_LAUNCH_SPEC_DEFAULTS.parkPolicy,
      errors,
    }),
    strategyId: validateEnum(input.strategyId, {
      field: 'strategyId',
      allowed: EC2_SCHEDULER_STRATEGIES,
      fallback: EC2_LAUNCH_SPEC_DEFAULTS.strategyId,
      errors,
    }),
    maxInstances: validateBoundedInteger(input.maxInstances, {
      field: 'maxInstances',
      bounds: EC2_LIMITS.maxInstances,
      fallback: EC2_LAUNCH_SPEC_DEFAULTS.maxInstances,
      errors,
    }),
    maxConcurrentPlacements: validateBoundedInteger(input.maxConcurrentPlacements, {
      field: 'maxConcurrentPlacements',
      bounds: EC2_LIMITS.maxConcurrentPlacements,
      fallback: EC2_LAUNCH_SPEC_DEFAULTS.maxConcurrentPlacements,
      errors,
    }),
    maxLifetimeSeconds: validateBoundedInteger(input.maxLifetimeSeconds, {
      field: 'maxLifetimeSeconds',
      bounds: EC2_LIMITS.maxLifetimeSeconds,
      fallback: EC2_LAUNCH_SPEC_DEFAULTS.maxLifetimeSeconds,
      errors,
    }),
    stageTimeoutSeconds: validateBoundedInteger(input.stageTimeoutSeconds, {
      field: 'stageTimeoutSeconds',
      bounds: EC2_LIMITS.stageTimeoutSeconds,
      fallback: EC2_LAUNCH_SPEC_DEFAULTS.stageTimeoutSeconds,
      errors,
    }),
    bootstrapTimeoutSeconds: validateBoundedInteger(input.bootstrapTimeoutSeconds, {
      field: 'bootstrapTimeoutSeconds',
      bounds: EC2_LIMITS.bootstrapTimeoutSeconds,
      fallback: EC2_LAUNCH_SPEC_DEFAULTS.bootstrapTimeoutSeconds,
      errors,
    }),
    maxHourlyCostUsd: null,
    tags: {},
  };

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
    } else {
      spec.maxHourlyCostUsd = cost;
    }
  }

  // A stage cannot outlive the worker that runs it, and a spec that says
  // otherwise is a silent mid-compile termination.
  if (spec.stageTimeoutSeconds > spec.maxLifetimeSeconds) {
    errors.push(err('stageTimeoutSeconds', 'stageTimeoutSeconds cannot exceed maxLifetimeSeconds'));
  }
  if (spec.maxConcurrentPlacements > spec.maxInstances) {
    errors.push(
      err('maxConcurrentPlacements', 'maxConcurrentPlacements cannot exceed maxInstances'),
    );
  }
  // `hold` keeps a machine billing for the entire human wait. Legal, but it must
  // be deliberate, so it is refused unless a lifetime cap bounds the exposure.
  if (spec.parkPolicy === 'hold' && spec.maxLifetimeSeconds === EC2_LIMITS.maxLifetimeSeconds.max) {
    errors.push(
      err(
        'parkPolicy',
        'parkPolicy "hold" requires an explicit maxLifetimeSeconds below the maximum, since the instance bills for the whole human wait',
      ),
    );
  }
  if (input.tags != null) {
    if (!isPlainObject(input.tags)) {
      errors.push(err('tags', 'tags must be an object of string keys to string values'));
    } else {
      for (const [key, value] of Object.entries(input.tags)) {
        // aws: is reserved, and letting an operator set it produces a confusing
        // fleet-time rejection rather than a clear validation error.
        if (/^aws:/i.test(key)) {
          errors.push(err('tags', `tag key "${key}" uses the reserved aws: prefix`));
          continue;
        }
        spec.tags[key] = String(value ?? '');
      }
    }
  }

  return { valid: errors.length === 0, errors, spec: errors.length === 0 ? spec : null };
};

/**
 * What DescribeImages must confirm before an EC2 revision may be published.
 *
 * Returned as data rather than performed here so this module stays free of an
 * AWS client and unit-testable, matching how the rest of the environments
 * package keeps validation separate from control-plane calls.
 */
export const imageAssertions = (spec) => ({
  imageId: spec.imageId,
  owners: spec.imageOwnerAccountId ? [spec.imageOwnerAccountId] : null,
  expectedArchitecture: spec.architecture,
  expectedState: 'available',
  expectedPlatform: spec.platform,
});

/**
 * Evaluate a DescribeImages result against a spec. `image` is one entry of
 * `Images`, or null when the call returned nothing (missing, deregistered, or
 * not shared with this account — indistinguishable from outside, so the message
 * names all three).
 */
export const evaluateImage = (spec, image) => {
  const errors = [];
  if (!image) {
    return {
      valid: false,
      errors: [
        err(
          'imageRef',
          `AMI ${spec.imageId} was not found — it may not exist, may be deregistered, or may not be shared with this account`,
        ),
      ],
    };
  }
  if (image.State && image.State !== 'available') {
    errors.push(err('imageRef', `AMI ${spec.imageId} is ${image.State}, not available`));
  }
  if (image.Architecture && image.Architecture !== spec.architecture) {
    errors.push(
      err(
        'architecture',
        `AMI ${spec.imageId} is ${image.Architecture} but the spec declares ${spec.architecture}`,
      ),
    );
  }
  // EC2 reports `Platform: 'windows'` for Windows and omits it for Linux, so an
  // absent value means Linux rather than unknown.
  const reported = image.Platform ? String(image.Platform).toLowerCase() : 'linux';
  if (reported !== spec.platform) {
    errors.push(
      err(
        'platform',
        `AMI ${spec.imageId} is a ${reported} image but the spec declares ${spec.platform}`,
      ),
    );
  }
  return { valid: errors.length === 0, errors };
};

export default {
  EC2_LAUNCH_SPEC_SCHEMA_VERSION,
  EC2_PLATFORMS,
  SUPPORTED_EC2_PLATFORMS,
  EC2_ARCHITECTURES,
  EC2_PURCHASE_OPTIONS,
  EC2_ALLOCATION_STRATEGIES,
  EC2_VOLUME_TYPES,
  EC2_PARK_POLICIES,
  EC2_SCHEDULER_STRATEGIES,
  EC2_LIMITS,
  EC2_LAUNCH_SPEC_DEFAULTS,
  parseImageRef,
  validateEc2LaunchSpec,
  imageAssertions,
  evaluateImage,
};
