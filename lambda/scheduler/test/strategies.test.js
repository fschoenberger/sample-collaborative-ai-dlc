import { describe, expect, it } from 'vitest';
import { isReusableFor, perStageEphemeral, strategyFor, STRATEGY_IDS } from '../strategies.js';

const worker = (overrides = {}) => ({
  workerId: 'i-1',
  kind: 'EC2',
  environmentId: 'cpp-buildhost',
  revisionId: 'r-9',
  state: 'IDLE',
  draining: false,
  ...overrides,
});

const request = (overrides = {}) => ({
  environmentId: 'cpp-buildhost',
  revisionId: 'r-9',
  executionId: 'x-1',
  stageInstanceId: 's-1',
  resumeWorkerId: null,
  ...overrides,
});

const fleet = (workers = [], inFlight = 0) => ({ workers, inFlight, idle: 0 });
const limits = (overrides = {}) => ({
  maxInstances: 4,
  maxConcurrentPlacements: 4,
  ...overrides,
});

describe('isReusableFor', () => {
  it('accepts an idle worker of the same environment and revision', () => {
    expect(isReusableFor(worker(), request())).toBe(true);
  });

  it('rejects a busy or provisioning worker', () => {
    expect(isReusableFor(worker({ state: 'BUSY' }), request())).toBe(false);
    expect(isReusableFor(worker({ state: 'PROVISIONING' }), request())).toBe(false);
  });

  it('rejects a draining worker', () => {
    expect(isReusableFor(worker({ draining: true }), request())).toBe(false);
  });

  it('rejects an older revision of the same environment', () => {
    // Same environment id, different AMI or image. Reusing it would silently run
    // a stage on the machine the operator replaced.
    expect(isReusableFor(worker({ revisionId: 'r-8' }), request())).toBe(false);
  });

  it('rejects a different environment', () => {
    expect(isReusableFor(worker({ environmentId: 'standard' }), request())).toBe(false);
  });
});

describe('per-stage-ephemeral', () => {
  it('provisions a fresh worker for an ordinary stage', () => {
    const result = perStageEphemeral({ request: request(), fleet: fleet(), limits: limits() });
    expect(result).toMatchObject({ action: 'provision', reason: 'per_stage_ephemeral' });
  });

  it('never reuses an idle worker, even a perfectly matching one', () => {
    // The whole point of the strategy: a pristine workspace per stage.
    const result = perStageEphemeral({
      request: request(),
      fleet: fleet([worker()]),
      limits: limits(),
    });
    expect(result.action).toBe('provision');
  });

  it('queues when the instance cap is reached', () => {
    const workers = [worker({ workerId: 'i-1' }), worker({ workerId: 'i-2' })];
    const result = perStageEphemeral({
      request: request(),
      fleet: fleet(workers),
      limits: limits({ maxInstances: 2 }),
    });
    expect(result).toMatchObject({ action: 'queue', reason: 'max_instances_reached' });
  });

  it('does not count terminated or draining workers against the cap', () => {
    const workers = [
      worker({ workerId: 'i-1', state: 'TERMINATED' }),
      worker({ workerId: 'i-2', draining: true }),
    ];
    const result = perStageEphemeral({
      request: request(),
      fleet: fleet(workers),
      limits: limits({ maxInstances: 2 }),
    });
    expect(result.action).toBe('provision');
  });

  it('queues when concurrent placements are saturated', () => {
    const result = perStageEphemeral({
      request: request(),
      fleet: fleet([], 3),
      limits: limits({ maxConcurrentPlacements: 3 }),
    });
    expect(result).toMatchObject({ action: 'queue', reason: 'max_concurrent_placements_reached' });
  });

  describe('resume after a park', () => {
    it('reuses the exact worker holding the parked conversation', () => {
      const held = worker({ workerId: 'i-held', state: 'IDLE' });
      const result = perStageEphemeral({
        request: request({ resumeWorkerId: 'i-held' }),
        fleet: fleet([held]),
        limits: limits(),
      });
      expect(result).toMatchObject({
        action: 'reuse',
        workerId: 'i-held',
        wipe: false,
        reason: 'resume_targets_held_worker',
      });
    });

    it('reuses it even while it is BUSY, since it is the one holding the context', () => {
      const held = worker({ workerId: 'i-held', state: 'BUSY' });
      const result = perStageEphemeral({
        request: request({ resumeWorkerId: 'i-held' }),
        fleet: fleet([held]),
        limits: limits(),
      });
      expect(result.action).toBe('reuse');
    });

    it('provisions with a wipe when the held worker is gone', () => {
      // The conversation died with it, so this becomes a demoted resume: a fresh
      // worker re-runs the stage with the answer injected.
      const result = perStageEphemeral({
        request: request({ resumeWorkerId: 'i-held' }),
        fleet: fleet([]),
        limits: limits(),
      });
      expect(result).toMatchObject({
        action: 'provision',
        wipe: true,
        reason: 'resume_worker_gone',
      });
    });

    it('treats a draining or terminated holder as gone', () => {
      for (const overrides of [{ draining: true }, { state: 'TERMINATED' }]) {
        const result = perStageEphemeral({
          request: request({ resumeWorkerId: 'i-held' }),
          fleet: fleet([worker({ workerId: 'i-held', ...overrides })]),
          limits: limits(),
        });
        expect(result.reason).toBe('resume_worker_gone');
      }
    });

    it('honours a resume even at the instance cap, because it displaces nothing', () => {
      const held = worker({ workerId: 'i-held' });
      const result = perStageEphemeral({
        request: request({ resumeWorkerId: 'i-held' }),
        fleet: fleet([held, worker({ workerId: 'i-2' })]),
        limits: limits({ maxInstances: 1 }),
      });
      expect(result.action).toBe('reuse');
    });
  });
});

describe('strategyFor', () => {
  it('resolves the shipped strategy', () => {
    expect(strategyFor('per-stage-ephemeral')).toBe(perStageEphemeral);
  });

  it('refuses an unknown strategy with a named code', () => {
    try {
      strategyFor('warm-pool');
      throw new Error('expected strategyFor to throw');
    } catch (error) {
      expect(error.code).toBe('UNKNOWN_STRATEGY');
    }
  });

  it('exposes exactly the strategies the launch spec permits', () => {
    expect(STRATEGY_IDS).toEqual(['per-stage-ephemeral']);
  });
});
