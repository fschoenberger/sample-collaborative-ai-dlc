// Placement strategies.
//
// A strategy answers one question and nothing else: given a placement request
// and a view of the fleet, should the scheduler reuse an existing worker,
// provision a new one, or queue the job and wait for capacity?
//
//   place({ request, fleet, limits }) → { action, workerId?, wipe?, reason }
//     action: 'reuse' | 'provision' | 'queue'
//
// Strategies are PURE. They take a snapshot of the fleet and return a decision;
// they never touch Valkey, EC2 or AgentCore. That is what makes the interesting
// behaviour (capacity refusal, reuse eligibility, later work-stealing) testable
// without any infrastructure, and it is why the fleet view is passed in rather
// than fetched.
//
// v1 ships one strategy. Idle yielding, warm pools and stealing are later
// additions to this same interface, and because the interface is per-request
// rather than per-worker-kind they will apply to AgentCore sessions and EC2
// instances alike.

export const PLACEMENT_ACTIONS = ['reuse', 'provision', 'queue'];

const decision = (action, extra = {}) => ({ action, ...extra });

// A worker is only reusable for a request if it is genuinely free and genuinely
// the right machine. `state` is the authority on free; environmentId and
// revisionId together are the authority on right — a worker booted from an older
// revision of the same environment has a different AMI or image and must not
// silently serve a stage pinned to the newer one.
export const isReusableFor = (worker, request) =>
  worker?.state === 'IDLE' &&
  worker.environmentId === request.environmentId &&
  worker.revisionId === request.revisionId &&
  !worker.draining;

/**
 * `per-stage-ephemeral` — v1's only strategy.
 *
 * One worker per stage attempt, terminated when the attempt ends. Nothing is
 * ever reused, so the workspace is always pristine and no stage can be polluted
 * by a predecessor. The cost is a cold provision per stage, which for a build
 * host is minutes; that is the trade this strategy exists to make.
 *
 * Reuse is still expressed in the interface (and tested) rather than omitted,
 * because a resumed stage after a park with `parkPolicy: hold` must land on the
 * SAME worker that holds the parked conversation — that is a reuse decision, and
 * it is the one case this strategy allows.
 */
export const perStageEphemeral = ({ request, fleet, limits }) => {
  // A resume targets one specific live worker: the one holding the conversation.
  // If it is gone, this is not a reuse and not a fresh placement either — the
  // caller must fall back to a new attempt (demoted resume), so say so plainly
  // rather than quietly provisioning a worker that has lost the context.
  if (request.resumeWorkerId) {
    const held = fleet.workers.find((w) => w.workerId === request.resumeWorkerId);
    if (held && !held.draining && held.state !== 'TERMINATED') {
      return decision('reuse', {
        workerId: held.workerId,
        wipe: false,
        reason: 'resume_targets_held_worker',
      });
    }
    return decision('provision', { wipe: true, reason: 'resume_worker_gone' });
  }

  const active = fleet.workers.filter((w) => w.state !== 'TERMINATED' && !w.draining).length;
  if (active >= limits.maxInstances) {
    return decision('queue', {
      reason: 'max_instances_reached',
    });
  }
  if (fleet.inFlight >= limits.maxConcurrentPlacements) {
    return decision('queue', { reason: 'max_concurrent_placements_reached' });
  }
  return decision('provision', { wipe: false, reason: 'per_stage_ephemeral' });
};

const STRATEGIES = {
  'per-stage-ephemeral': perStageEphemeral,
};

export const strategyFor = (strategyId) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy) {
    throw Object.assign(new Error(`unknown placement strategy "${strategyId}"`), {
      code: 'UNKNOWN_STRATEGY',
    });
  }
  return strategy;
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);

export default { PLACEMENT_ACTIONS, STRATEGY_IDS, isReusableFor, perStageEphemeral, strategyFor };
