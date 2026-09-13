import { TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  EC2_ALLOCATION_STRATEGIES,
  EC2_ARCHITECTURES,
  EC2_LAUNCH_SPEC_DEFAULTS,
  EC2_LIMITS,
  EC2_PARK_POLICIES,
  EC2_PLATFORMS,
  EC2_PURCHASE_OPTIONS,
  EC2_SCHEDULER_STRATEGIES,
  EC2_VOLUME_TYPES,
  errorFor,
  type Ec2LaunchSpec,
  type Ec2LaunchSpecInput,
  type FieldError,
} from '@/lib/ec2LaunchSpec';

// The EC2 half of the environment form.
//
// An AGENTCORE environment is composed from the tool catalogue; an EC2 one is an
// operator-supplied AMI plus a machine shape, so there is no catalogue, no base to
// inherit from and nothing to build. Every field here is a field of the launch
// spec (lambda/environments/ec2-launch-spec.js) with one deliberate omission:
// `associatePublicIp` is not settable — workers live in private subnets and the
// server rejects an explicit true.
//
// State is kept as strings so a half-typed number is not silently coerced; the
// conversion to the wire shape happens once, in `launchSpecFromForm`.

export interface Ec2FormState {
  platform: string;
  architecture: string;
  imageRef: string;
  imageOwnerAccountId: string;
  instanceTypes: string;
  instanceFamilies: string;
  vCpuMin: string;
  vCpuMax: string;
  memoryMinMiB: string;
  memoryMaxMiB: string;
  acceleratorMin: string;
  acceleratorMax: string;
  acceleratorManufacturers: string;
  acceleratorTypes: string;
  purchaseOption: string;
  spotFallbackToOnDemand: boolean;
  maxPricePerHour: string;
  allocationStrategy: string;
  availabilityZones: string;
  rootVolumeSizeGiB: string;
  rootVolumeType: string;
  rootVolumeIops: string;
  rootVolumeThroughput: string;
  maxInstances: string;
  maxConcurrentPlacements: string;
  maxLifetimeSeconds: string;
  stageTimeoutSeconds: string;
  bootstrapTimeoutSeconds: string;
  parkPolicy: string;
  strategyId: string;
  securityGroupIds: string;
  additionalPolicyArns: string;
  maxHourlyCostUsd: string;
  tags: string;
}

export const emptyEc2Form = (): Ec2FormState => ({
  platform: EC2_LAUNCH_SPEC_DEFAULTS.platform,
  architecture: EC2_LAUNCH_SPEC_DEFAULTS.architecture,
  imageRef: '',
  imageOwnerAccountId: '',
  instanceTypes: '',
  instanceFamilies: '',
  vCpuMin: '',
  vCpuMax: '',
  memoryMinMiB: '',
  memoryMaxMiB: '',
  acceleratorMin: '',
  acceleratorMax: '',
  acceleratorManufacturers: '',
  acceleratorTypes: '',
  purchaseOption: EC2_LAUNCH_SPEC_DEFAULTS.purchaseOption,
  spotFallbackToOnDemand: EC2_LAUNCH_SPEC_DEFAULTS.spotFallbackToOnDemand,
  maxPricePerHour: '',
  allocationStrategy: EC2_LAUNCH_SPEC_DEFAULTS.allocationStrategy,
  availabilityZones: '',
  rootVolumeSizeGiB: String(EC2_LAUNCH_SPEC_DEFAULTS.rootVolume.sizeGiB),
  rootVolumeType: EC2_LAUNCH_SPEC_DEFAULTS.rootVolume.type,
  rootVolumeIops: '',
  rootVolumeThroughput: '',
  maxInstances: String(EC2_LAUNCH_SPEC_DEFAULTS.maxInstances),
  maxConcurrentPlacements: String(EC2_LAUNCH_SPEC_DEFAULTS.maxConcurrentPlacements),
  maxLifetimeSeconds: String(EC2_LAUNCH_SPEC_DEFAULTS.maxLifetimeSeconds),
  stageTimeoutSeconds: String(EC2_LAUNCH_SPEC_DEFAULTS.stageTimeoutSeconds),
  bootstrapTimeoutSeconds: String(EC2_LAUNCH_SPEC_DEFAULTS.bootstrapTimeoutSeconds),
  parkPolicy: EC2_LAUNCH_SPEC_DEFAULTS.parkPolicy,
  strategyId: EC2_LAUNCH_SPEC_DEFAULTS.strategyId,
  securityGroupIds: '',
  additionalPolicyArns: '',
  maxHourlyCostUsd: '',
  tags: '',
});

// Lists are entered as free text: commas, whitespace and newlines all separate,
// because an operator pasting from the console or from a terraform file should not
// have to reformat. Order is preserved — it becomes CreateFleet override priority.
const parseList = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const parseInteger = (value: string): number | undefined => {
  const raw = value.trim();
  if (!raw) return undefined;
  return Number(raw);
};

const parseNumber = parseInteger;

const parseTags = (value: string): Record<string, string> => {
  const tags: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator > 0)
      tags[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    else tags[trimmed] = '';
  }
  return tags;
};

const range = (min: string, max: string) => {
  const value: { min?: number; max?: number } = {};
  const minValue = parseInteger(min);
  const maxValue = parseInteger(max);
  if (minValue !== undefined) value.min = minValue;
  if (maxValue !== undefined) value.max = maxValue;
  return Object.keys(value).length > 0 ? value : undefined;
};

/** The wire shape, with every untouched field omitted so the server defaults it. */
export const launchSpecFromForm = (form: Ec2FormState): Ec2LaunchSpecInput => {
  const requirements: NonNullable<Ec2LaunchSpecInput['instanceRequirements']> = {};
  const vCpuCount = range(form.vCpuMin, form.vCpuMax);
  if (vCpuCount) requirements.vCpuCount = vCpuCount;
  const memoryMiB = range(form.memoryMinMiB, form.memoryMaxMiB);
  if (memoryMiB) requirements.memoryMiB = memoryMiB;
  const acceleratorCount = range(form.acceleratorMin, form.acceleratorMax);
  if (acceleratorCount) requirements.acceleratorCount = acceleratorCount;
  const manufacturers = parseList(form.acceleratorManufacturers);
  if (manufacturers.length) requirements.acceleratorManufacturers = manufacturers;
  const acceleratorTypes = parseList(form.acceleratorTypes);
  if (acceleratorTypes.length) requirements.acceleratorTypes = acceleratorTypes;

  const rootVolume: NonNullable<Ec2LaunchSpecInput['rootVolume']> = {
    type: form.rootVolumeType,
  };
  const sizeGiB = parseInteger(form.rootVolumeSizeGiB);
  if (sizeGiB !== undefined) rootVolume.sizeGiB = sizeGiB;
  const iops = parseInteger(form.rootVolumeIops);
  if (iops !== undefined) rootVolume.iops = iops;
  const throughput = parseInteger(form.rootVolumeThroughput);
  if (throughput !== undefined) rootVolume.throughput = throughput;

  const tags = parseTags(form.tags);
  const price = parseNumber(form.maxPricePerHour);
  const cost = parseNumber(form.maxHourlyCostUsd);

  return {
    platform: form.platform,
    architecture: form.architecture,
    imageRef: form.imageRef.trim(),
    ...(form.imageOwnerAccountId.trim()
      ? { imageOwnerAccountId: form.imageOwnerAccountId.trim() }
      : {}),
    instanceTypes: parseList(form.instanceTypes),
    instanceFamilies: parseList(form.instanceFamilies),
    instanceRequirements: Object.keys(requirements).length > 0 ? requirements : null,
    purchaseOption: form.purchaseOption,
    spotFallbackToOnDemand: form.spotFallbackToOnDemand,
    allocationStrategy: form.allocationStrategy,
    ...(price === undefined ? {} : { maxPricePerHour: price }),
    availabilityZones: parseList(form.availabilityZones),
    rootVolume,
    securityGroupIds: parseList(form.securityGroupIds),
    additionalPolicyArns: parseList(form.additionalPolicyArns),
    parkPolicy: form.parkPolicy,
    strategyId: form.strategyId,
    ...(parseInteger(form.maxInstances) === undefined
      ? {}
      : { maxInstances: parseInteger(form.maxInstances) }),
    ...(parseInteger(form.maxConcurrentPlacements) === undefined
      ? {}
      : { maxConcurrentPlacements: parseInteger(form.maxConcurrentPlacements) }),
    ...(parseInteger(form.maxLifetimeSeconds) === undefined
      ? {}
      : { maxLifetimeSeconds: parseInteger(form.maxLifetimeSeconds) }),
    ...(parseInteger(form.stageTimeoutSeconds) === undefined
      ? {}
      : { stageTimeoutSeconds: parseInteger(form.stageTimeoutSeconds) }),
    ...(parseInteger(form.bootstrapTimeoutSeconds) === undefined
      ? {}
      : { bootstrapTimeoutSeconds: parseInteger(form.bootstrapTimeoutSeconds) }),
    ...(cost === undefined ? {} : { maxHourlyCostUsd: cost }),
    tags,
  };
};

function FieldMessage({ errors, field }: { errors: FieldError[]; field: string }) {
  const message = errorFor(errors, field);
  if (!message) return null;
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-destructive">
      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
      {message}
    </p>
  );
}

function TextField({
  id,
  label,
  hint,
  value,
  field,
  errors,
  disabled,
  placeholder,
  onChange,
  mono = true,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  field: string;
  errors: FieldError[];
  disabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={mono ? 'h-9 font-mono text-sm' : 'h-9 text-sm'}
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      <FieldMessage errors={errors} field={field} />
    </div>
  );
}

function EnumField({
  id,
  label,
  value,
  options,
  field,
  errors,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  field: string;
  errors: FieldError[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} aria-label={label} className="h-9 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldMessage errors={errors} field={field} />
    </div>
  );
}

function ListField({
  id,
  label,
  hint,
  value,
  field,
  errors,
  disabled,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  field: string;
  errors: FieldError[];
  disabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Textarea
        id={id}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-20 font-mono text-xs"
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      <FieldMessage errors={errors} field={field} />
    </div>
  );
}

export function Ec2LaunchSpecEditor({
  form,
  onChange,
  errors,
  disabled,
}: {
  form: Ec2FormState;
  onChange: (next: Ec2FormState) => void;
  errors: FieldError[];
  disabled: boolean;
}) {
  const set = <K extends keyof Ec2FormState>(key: K, value: Ec2FormState[K]) =>
    onChange({ ...form, [key]: value });
  const spot = form.purchaseOption === 'spot';

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h4 className="text-xs font-medium">Image</h4>
        <p className="text-[11px] text-muted-foreground">
          The platform layers nothing onto the AMI — its contents are yours. It is checked to exist,
          be available, and match the declared architecture before the environment becomes
          publishable.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id="ec2-image-ref"
            label="AMI"
            value={form.imageRef}
            field="imageRef"
            errors={errors}
            disabled={disabled}
            placeholder="ami-0123456789abcdef0"
            onChange={(value) => set('imageRef', value)}
          />
          <TextField
            id="ec2-image-owner"
            label="Image owner account (optional)"
            value={form.imageOwnerAccountId}
            field="imageOwnerAccountId"
            errors={errors}
            disabled={disabled}
            placeholder="123456789012"
            onChange={(value) => set('imageOwnerAccountId', value)}
          />
          <EnumField
            id="ec2-platform"
            label="Platform"
            value={form.platform}
            options={EC2_PLATFORMS}
            field="platform"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('platform', value)}
          />
          <EnumField
            id="ec2-architecture"
            label="Architecture"
            value={form.architecture}
            options={EC2_ARCHITECTURES}
            field="architecture"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('architecture', value)}
          />
        </div>
      </div>

      <div className="space-y-2 border-t pt-4">
        <h4 className="text-xs font-medium">Machine shape</h4>
        <p className="text-[11px] text-muted-foreground">
          Declare at least one of instance types, instance families or attribute requirements — a
          fleet request needs something to select on.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <ListField
            id="ec2-instance-types"
            label="Instance types"
            hint={`In priority order, at most ${EC2_LIMITS.instanceTypes.max}.`}
            value={form.instanceTypes}
            field="instanceTypes"
            errors={errors}
            disabled={disabled}
            placeholder="c7g.4xlarge, c7g.8xlarge"
            onChange={(value) => set('instanceTypes', value)}
          />
          <ListField
            id="ec2-instance-families"
            label="Instance families"
            hint={`At most ${EC2_LIMITS.instanceFamilies.max}.`}
            value={form.instanceFamilies}
            field="instanceFamilies"
            errors={errors}
            disabled={disabled}
            placeholder="c7g, m7g"
            onChange={(value) => set('instanceFamilies', value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            id="ec2-vcpu-min"
            label="vCPU min"
            value={form.vCpuMin}
            field="instanceRequirements.vCpuCount.min"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('vCpuMin', value)}
          />
          <TextField
            id="ec2-vcpu-max"
            label="vCPU max"
            value={form.vCpuMax}
            field="instanceRequirements.vCpuCount.max"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('vCpuMax', value)}
          />
          <div className="sm:col-span-1">
            <FieldMessage errors={errors} field="instanceRequirements.vCpuCount" />
          </div>
          <TextField
            id="ec2-memory-min"
            label="Memory min (MiB)"
            value={form.memoryMinMiB}
            field="instanceRequirements.memoryMiB.min"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('memoryMinMiB', value)}
          />
          <TextField
            id="ec2-memory-max"
            label="Memory max (MiB)"
            value={form.memoryMaxMiB}
            field="instanceRequirements.memoryMiB.max"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('memoryMaxMiB', value)}
          />
          <div className="sm:col-span-1">
            <FieldMessage errors={errors} field="instanceRequirements.memoryMiB" />
          </div>
          <TextField
            id="ec2-accelerator-min"
            label="Accelerators min"
            value={form.acceleratorMin}
            field="instanceRequirements.acceleratorCount.min"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('acceleratorMin', value)}
          />
          <TextField
            id="ec2-accelerator-max"
            label="Accelerators max"
            value={form.acceleratorMax}
            field="instanceRequirements.acceleratorCount.max"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('acceleratorMax', value)}
          />
          <div className="sm:col-span-1">
            <FieldMessage errors={errors} field="instanceRequirements.acceleratorCount" />
          </div>
          <TextField
            id="ec2-accelerator-manufacturers"
            label="Accelerator manufacturers"
            value={form.acceleratorManufacturers}
            field="instanceRequirements.acceleratorManufacturers"
            errors={errors}
            disabled={disabled}
            placeholder="nvidia"
            onChange={(value) => set('acceleratorManufacturers', value)}
          />
          <TextField
            id="ec2-accelerator-types"
            label="Accelerator types"
            value={form.acceleratorTypes}
            field="instanceRequirements.acceleratorTypes"
            errors={errors}
            disabled={disabled}
            placeholder="gpu"
            onChange={(value) => set('acceleratorTypes', value)}
          />
        </div>
      </div>

      <div className="space-y-2 border-t pt-4">
        <h4 className="text-xs font-medium">Capacity</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <EnumField
            id="ec2-purchase-option"
            label="Purchase option"
            value={form.purchaseOption}
            options={EC2_PURCHASE_OPTIONS}
            field="purchaseOption"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('purchaseOption', value)}
          />
          <EnumField
            id="ec2-allocation-strategy"
            label="Allocation strategy"
            value={form.allocationStrategy}
            options={EC2_ALLOCATION_STRATEGIES}
            field="allocationStrategy"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('allocationStrategy', value)}
          />
          {spot && (
            <>
              <TextField
                id="ec2-max-price"
                label="Max price per hour (USD)"
                hint="Spot only."
                value={form.maxPricePerHour}
                field="maxPricePerHour"
                errors={errors}
                disabled={disabled}
                onChange={(value) => set('maxPricePerHour', value)}
              />
              <div className="flex items-center justify-between gap-3 rounded border px-3 py-2">
                <Label htmlFor="ec2-spot-fallback" className="text-xs">
                  Fall back to on-demand
                </Label>
                <Switch
                  id="ec2-spot-fallback"
                  aria-label="Fall back to on-demand"
                  checked={form.spotFallbackToOnDemand}
                  disabled={disabled}
                  onCheckedChange={(checked) => set('spotFallbackToOnDemand', checked)}
                />
              </div>
            </>
          )}
          <TextField
            id="ec2-availability-zones"
            label="Availability zones"
            hint={`Optional, at most ${EC2_LIMITS.availabilityZones.max}.`}
            value={form.availabilityZones}
            field="availabilityZones"
            errors={errors}
            disabled={disabled}
            placeholder="eu-central-1a, eu-central-1b"
            onChange={(value) => set('availabilityZones', value)}
          />
          <TextField
            id="ec2-max-hourly-cost"
            label="Max hourly cost (USD, optional)"
            value={form.maxHourlyCostUsd}
            field="maxHourlyCostUsd"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('maxHourlyCostUsd', value)}
          />
          <TextField
            id="ec2-max-instances"
            label="Max instances"
            value={form.maxInstances}
            field="maxInstances"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('maxInstances', value)}
          />
          <TextField
            id="ec2-max-concurrent-placements"
            label="Max concurrent placements"
            value={form.maxConcurrentPlacements}
            field="maxConcurrentPlacements"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('maxConcurrentPlacements', value)}
          />
        </div>
      </div>

      <div className="space-y-2 border-t pt-4">
        <h4 className="text-xs font-medium">Root volume</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <EnumField
            id="ec2-root-volume-type"
            label="Type"
            value={form.rootVolumeType}
            options={EC2_VOLUME_TYPES}
            field="rootVolume.type"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('rootVolumeType', value)}
          />
          <TextField
            id="ec2-root-volume-size"
            label="Size (GiB)"
            value={form.rootVolumeSizeGiB}
            field="rootVolume.sizeGiB"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('rootVolumeSizeGiB', value)}
          />
          {form.rootVolumeType !== 'gp2' && (
            <TextField
              id="ec2-root-volume-iops"
              label="Provisioned IOPS (optional)"
              value={form.rootVolumeIops}
              field="rootVolume.iops"
              errors={errors}
              disabled={disabled}
              onChange={(value) => set('rootVolumeIops', value)}
            />
          )}
          {form.rootVolumeType === 'gp3' && (
            <TextField
              id="ec2-root-volume-throughput"
              label="Throughput (MiB/s, optional)"
              hint="gp3 only."
              value={form.rootVolumeThroughput}
              field="rootVolume.throughput"
              errors={errors}
              disabled={disabled}
              onChange={(value) => set('rootVolumeThroughput', value)}
            />
          )}
        </div>
      </div>

      <div className="space-y-2 border-t pt-4">
        <h4 className="text-xs font-medium">Lifecycle</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id="ec2-max-lifetime"
            label="Max lifetime (seconds)"
            value={form.maxLifetimeSeconds}
            field="maxLifetimeSeconds"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('maxLifetimeSeconds', value)}
          />
          <TextField
            id="ec2-stage-timeout"
            label="Stage timeout (seconds)"
            value={form.stageTimeoutSeconds}
            field="stageTimeoutSeconds"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('stageTimeoutSeconds', value)}
          />
          <TextField
            id="ec2-bootstrap-timeout"
            label="Bootstrap timeout (seconds)"
            value={form.bootstrapTimeoutSeconds}
            field="bootstrapTimeoutSeconds"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('bootstrapTimeoutSeconds', value)}
          />
          <EnumField
            id="ec2-park-policy"
            label="On a human gate"
            value={form.parkPolicy}
            options={EC2_PARK_POLICIES}
            field="parkPolicy"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('parkPolicy', value)}
          />
          <EnumField
            id="ec2-strategy"
            label="Scheduler strategy"
            value={form.strategyId}
            options={EC2_SCHEDULER_STRATEGIES}
            field="strategyId"
            errors={errors}
            disabled={disabled}
            onChange={(value) => set('strategyId', value)}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">hold</span> keeps the instance while a human
          answers, so it needs a lifetime below the {EC2_LIMITS.maxLifetimeSeconds.max}s maximum;{' '}
          <span className="font-medium text-foreground">release</span> terminates and resumes on a
          fresh worker.
        </p>
      </div>

      <div className="space-y-2 border-t pt-4">
        <h4 className="text-xs font-medium">Access</h4>
        <p className="text-[11px] text-muted-foreground">
          Workers run in private subnets with NAT egress; a public IP is not configurable.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <ListField
            id="ec2-security-groups"
            label="Additional security groups"
            hint={`Optional, at most ${EC2_LIMITS.securityGroupIds.max}.`}
            value={form.securityGroupIds}
            field="securityGroupIds"
            errors={errors}
            disabled={disabled}
            placeholder="sg-0123456789abcdef0"
            onChange={(value) => set('securityGroupIds', value)}
          />
          <ListField
            id="ec2-policy-arns"
            label="Additional IAM policies"
            hint={`Optional, at most ${EC2_LIMITS.additionalPolicyArns.max}.`}
            value={form.additionalPolicyArns}
            field="additionalPolicyArns"
            errors={errors}
            disabled={disabled}
            placeholder="arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"
            onChange={(value) => set('additionalPolicyArns', value)}
          />
          <div className="sm:col-span-2">
            <ListField
              id="ec2-tags"
              label="Tags"
              hint="One NAME=value per line. The aws: prefix is reserved."
              value={form.tags}
              field="tags"
              errors={errors}
              disabled={disabled}
              placeholder="CostCenter=platform"
              onChange={(value) => set('tags', value)}
            />
          </div>
        </div>
      </div>

      <FieldMessage errors={errors} field="spec" />
    </div>
  );
}

const formatRange = (value: { min?: number; max?: number } | undefined) =>
  value ? `${value.min ?? '–'}…${value.max ?? '–'}` : null;

/** A published EC2 spec, read-only: an EC2 revision is immutable once created. */
export function Ec2LaunchSpecSummary({ spec }: { spec: Ec2LaunchSpec }) {
  const selectors = [
    spec.instanceTypes.length ? spec.instanceTypes.join(', ') : null,
    spec.instanceFamilies.length ? `${spec.instanceFamilies.join(', ')} (families)` : null,
    formatRange(spec.instanceRequirements?.vCpuCount)
      ? `${formatRange(spec.instanceRequirements?.vCpuCount)} vCPU`
      : null,
    formatRange(spec.instanceRequirements?.memoryMiB)
      ? `${formatRange(spec.instanceRequirements?.memoryMiB)} MiB`
      : null,
    formatRange(spec.instanceRequirements?.acceleratorCount)
      ? `${formatRange(spec.instanceRequirements?.acceleratorCount)} accelerators`
      : null,
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline" className="font-mono text-[10px]">
          {spec.platform} · {spec.architecture}
        </Badge>
        <Badge variant="outline" className="font-mono text-[10px]">
          {spec.purchaseOption}
          {spec.purchaseOption === 'spot' && spec.spotFallbackToOnDemand ? ' + on-demand' : ''}
        </Badge>
        <Badge variant="outline" className="font-mono text-[10px]">
          {spec.rootVolume.sizeGiB} GiB {spec.rootVolume.type}
        </Badge>
        <Badge variant="outline" className="font-mono text-[10px]">
          park {spec.parkPolicy}
        </Badge>
      </div>
      <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">AMI</dt>
          <dd className="break-all font-mono">{spec.imageRef ?? spec.imageId ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Selection</dt>
          <dd className="break-words font-mono">{selectors.join(' · ') || 'Unavailable'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Limits</dt>
          <dd className="font-mono">
            {spec.maxInstances} instances · {spec.maxConcurrentPlacements} concurrent
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Timeouts</dt>
          <dd className="font-mono">
            stage {spec.stageTimeoutSeconds}s · lifetime {spec.maxLifetimeSeconds}s · bootstrap{' '}
            {spec.bootstrapTimeoutSeconds}s
          </dd>
        </div>
        {spec.availabilityZones.length > 0 && (
          <div>
            <dt className="text-muted-foreground">Zones</dt>
            <dd className="font-mono">{spec.availabilityZones.join(', ')}</dd>
          </div>
        )}
        {spec.maxPricePerHour != null && (
          <div>
            <dt className="text-muted-foreground">Max spot price</dt>
            <dd className="font-mono">${spec.maxPricePerHour}/h</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
