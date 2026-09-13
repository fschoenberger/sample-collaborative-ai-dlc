// Client-side mirror of lambda/shared/stage-environments.js.
//
// The per-stage environment binding map: `{ [stageId]: environmentId }`, keyed by
// STAGE id (not stage-instance id) because the binding is authored against the
// workflow's stage and every instance of it belongs on the same kind of machine.
//
// A project holds a default plus this map; whoever starts an intent may adjust the
// map for that one run; intent creation snapshots the result. The three rules that
// matter are all here so the settings tab and the create page cannot disagree:
// an empty value CLEARS an override, the map is capped, and `requiresCompute` is
// advisory.

import type { Ec2LaunchSpec } from './ec2LaunchSpec';

const STAGE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENVIRONMENT_ID = /^[a-z][a-z0-9-]{0,62}$/;

export const MAX_STAGE_BINDINGS = 64;

export type StageEnvironmentMap = Record<string, string>;

/** A submitted delta: null/'' at a stage removes the inherited binding. */
export type StageEnvironmentOverride = Record<string, string | null>;

export const isValidStageId = (stageId: string) => STAGE_ID.test(stageId);
export const isValidEnvironmentId = (environmentId: string) => ENVIRONMENT_ID.test(environmentId);

/**
 * Apply an override on top of the project's defaults.
 *
 * Mirrors mergeStageEnvironments: the project map is the base, the override wins
 * per stage, and an explicit null/empty REMOVES a stage rather than binding it.
 */
export const mergeStageEnvironments = (
  projectMap: StageEnvironmentMap = {},
  override: StageEnvironmentOverride | null = null,
): StageEnvironmentMap => {
  if (override == null) return { ...projectMap };
  const merged: StageEnvironmentMap = { ...projectMap };
  for (const [stageId, environmentId] of Object.entries(override)) {
    if (environmentId == null || environmentId === '') delete merged[stageId];
    else merged[stageId] = String(environmentId);
  }
  return merged;
};

/**
 * The delta to send so the server's merge produces `next` from `inherited`.
 *
 * Sending the whole effective map would work too, but a delta is what makes "this
 * row is overridden for this run" expressible: a removed row has to travel as an
 * explicit null, and an untouched row must not travel at all.
 */
export const stageEnvironmentDelta = (
  inherited: StageEnvironmentMap,
  next: StageEnvironmentMap,
): StageEnvironmentOverride => {
  const delta: StageEnvironmentOverride = {};
  for (const [stageId, environmentId] of Object.entries(next)) {
    if (inherited[stageId] !== environmentId) delta[stageId] = environmentId;
  }
  for (const stageId of Object.keys(inherited)) {
    if (!(stageId in next)) delta[stageId] = null;
  }
  return delta;
};

/** Validate a map the way the project/intent endpoints will. */
export const validateStageEnvironments = (map: StageEnvironmentMap): string[] => {
  const errors: string[] = [];
  const entries = Object.entries(map ?? {});
  if (entries.length > MAX_STAGE_BINDINGS) {
    errors.push(`stageEnvironments accepts at most ${MAX_STAGE_BINDINGS} bindings`);
  }
  for (const [stageId, environmentId] of entries) {
    if (!STAGE_ID.test(stageId)) {
      errors.push(`"${stageId}" is not a valid stage id`);
      continue;
    }
    if (environmentId == null || environmentId === '') continue;
    if (!ENVIRONMENT_ID.test(String(environmentId).trim())) {
      errors.push(`"${environmentId}" is not a valid environment id`);
    }
  }
  return errors;
};

/**
 * A stage block's advisory compute hint. Declared by the methodology; binding an
 * environment is a deployment decision, so a mismatch is never a gate.
 */
export interface RequiresCompute {
  platform?: string;
  architecture?: string;
  accelerator?: string;
}

/** The environment shape the advisory reads: only `launchSpec` matters. */
export interface ComputeSnapshot {
  launchSpec?: Ec2LaunchSpec | null;
}

/** A stage block carries `requiresCompute` as an open type-specific attribute. */
export const requiresComputeOf = (value: unknown): RequiresCompute | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const hint = value as RequiresCompute;
  const platform = typeof hint.platform === 'string' ? hint.platform : undefined;
  const architecture = typeof hint.architecture === 'string' ? hint.architecture : undefined;
  const accelerator = typeof hint.accelerator === 'string' ? hint.accelerator : undefined;
  if (!platform && !architecture && !accelerator) return null;
  return { platform, architecture, accelerator };
};

/**
 * Does the environment satisfy the stage's `requiresCompute` hint?
 *
 * Mirrors satisfiesRequiresCompute, including its two defaults for an AgentCore
 * environment (no launch spec): linux, and arm64 by construction.
 */
export const satisfiesRequiresCompute = (
  requiresCompute: RequiresCompute | null | undefined,
  snapshot: ComputeSnapshot | null | undefined,
): { satisfied: boolean; reasons: string[] } => {
  if (!requiresCompute) return { satisfied: true, reasons: [] };
  const spec = snapshot?.launchSpec ?? null;
  const reasons: string[] = [];
  if (requiresCompute.platform && (spec?.platform ?? 'linux') !== requiresCompute.platform) {
    reasons.push(`stage needs platform ${requiresCompute.platform}`);
  }
  if (requiresCompute.architecture) {
    const arch = spec?.architecture ?? 'arm64';
    if (arch !== requiresCompute.architecture) {
      reasons.push(`stage needs architecture ${requiresCompute.architecture}`);
    }
  }
  if (requiresCompute.accelerator === 'gpu') {
    const accelerated =
      (spec?.instanceRequirements?.acceleratorCount?.min ?? 0) > 0 ||
      (spec?.instanceTypes ?? []).some((type) => /^(g\d|p\d|inf|trn)/.test(type));
    if (!accelerated) reasons.push('stage needs a GPU');
  }
  return { satisfied: reasons.length === 0, reasons };
};
