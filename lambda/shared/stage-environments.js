// The per-stage environment binding map.
//
// A project sets defaults; the person starting an intent may adjust them; the
// intent snapshots the result. This module owns the shape and the validation so
// the project endpoint, intent creation and the UI cannot disagree about it.
//
// Stored as `{ [stageId]: environmentId }` keyed by STAGE id, not stage-instance
// id: the binding is authored against the workflow's stage, and one stage can
// have many instances across parallel units — all of which belong on the same
// kind of machine.

const STAGE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENVIRONMENT_ID = /^[a-z][a-z0-9-]{0,62}$/;

// A bound map is small by nature (a handful of hardware-needing stages). The cap
// exists so a malformed client cannot write an unbounded property onto a vertex.
export const MAX_STAGE_BINDINGS = 64;

/**
 * Validate and normalize a submitted map.
 *
 * Returns `{ valid, errors, map }`. An empty map is valid and means "everything
 * runs on the project default", which is the common case.
 */
export const validateStageEnvironments = (input) => {
  const errors = [];
  if (input == null) return { valid: true, errors, map: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['stageEnvironments must be an object'], map: null };
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_STAGE_BINDINGS) {
    errors.push(`stageEnvironments accepts at most ${MAX_STAGE_BINDINGS} bindings`);
  }
  const map = {};
  for (const [stageId, environmentId] of entries) {
    if (!STAGE_ID.test(stageId)) {
      errors.push(`"${stageId}" is not a valid stage id`);
      continue;
    }
    // An explicit null/empty value means "clear this override", which is how the
    // UI removes one without having to send a whole replacement map.
    if (environmentId == null || environmentId === '') continue;
    const id = String(environmentId).trim();
    if (!ENVIRONMENT_ID.test(id)) {
      errors.push(`"${id}" is not a valid environment id`);
      continue;
    }
    map[stageId] = id;
  }
  return { valid: errors.length === 0, errors, map: errors.length === 0 ? map : null };
};

/** The distinct environment ids a map references, for resolving snapshots once each. */
export const distinctEnvironmentIds = (map = {}) => [...new Set(Object.values(map ?? {}))];

/**
 * Apply an intent-time override on top of the project's defaults.
 *
 * The project map is the base; the override wins per stage. A stage explicitly set
 * to null in the override is REMOVED, so a run can opt out of a project default
 * without the caller reconstructing the whole map.
 */
export const mergeStageEnvironments = (projectMap = {}, override = null) => {
  if (override == null) return { ...projectMap };
  const merged = { ...projectMap };
  for (const [stageId, environmentId] of Object.entries(override)) {
    if (environmentId == null || environmentId === '') delete merged[stageId];
    else merged[stageId] = String(environmentId);
  }
  return merged;
};

/**
 * Does the environment satisfy a stage's advisory `requiresCompute` hint?
 *
 * Advisory only: the answer drives a UI warning, never an execution gate. The
 * methodology declares what a stage NEEDS; binding it is a deployment decision,
 * and an operator is allowed to know better.
 */
export const satisfiesRequiresCompute = (requiresCompute, snapshot) => {
  if (!requiresCompute) return { satisfied: true, reasons: [] };
  const spec = snapshot?.launchSpec ?? null;
  const reasons = [];
  if (requiresCompute.platform && (spec?.platform ?? 'linux') !== requiresCompute.platform) {
    reasons.push(`stage needs platform ${requiresCompute.platform}`);
  }
  if (requiresCompute.architecture) {
    // An AgentCore environment is arm64 by construction.
    const arch = spec?.architecture ?? 'arm64';
    if (arch !== requiresCompute.architecture) {
      reasons.push(`stage needs architecture ${requiresCompute.architecture}`);
    }
  }
  if (requiresCompute.accelerator === 'gpu') {
    const accelerated =
      (spec?.instanceRequirements?.acceleratorCount?.min ?? 0) > 0 ||
      (spec?.instanceTypes ?? []).some((t) => /^(g\d|p\d|inf|trn)/.test(t));
    if (!accelerated) reasons.push('stage needs a GPU');
  }
  return { satisfied: reasons.length === 0, reasons };
};

export default {
  MAX_STAGE_BINDINGS,
  validateStageEnvironments,
  distinctEnvironmentIds,
  mergeStageEnvironments,
  satisfiesRequiresCompute,
};
