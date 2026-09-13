// The scheduler and a worker, collapsed into one test double.
//
// Stage dispatch now goes orchestrator → scheduler → worker → container, and only
// the last hop is what the orchestrator tests actually care about. This double
// stands in for the two middle hops: it records what placement was ASKED for
// (target, session, callback, attempt) and then drives the caller's existing
// container fake with the payload, exactly as a real worker would after claiming
// the job.
//
// Keeping it in one place means the four orchestrator test files agree on what a
// placement does, and that the `run-stage-start` payload assertions written before
// the scheduler existed stay meaningful.

/**
 * @param invokeRuntime the test's existing container fake, called as
 *   `invokeRuntime(payload, sessionId)` and expected to resolve the stage callback
 *   and return `{ ok: true }` for an accepted dispatch.
 * @param record optional array that receives one entry per placement.
 */
export const makeEnqueueDouble = (invokeRuntime, record = []) => {
  const fn = async ({ payload, target, sessionId, stageCallbackId, resumeWorkerId, attempt }) => {
    record.push({ target, sessionId, stageCallbackId, resumeWorkerId, attempt });
    const accepted = await invokeRuntime(payload, sessionId);
    // A refusal must surface as a value: the orchestrator turns it into a stage
    // failure, and swallowing it here would hide exactly that path.
    if (!accepted?.ok) return accepted ?? { ok: false, reason: 'stage_dispatch_failed' };
    return { ok: true, action: 'provision', jobId: `job-${record.length}`, workerId: 'w-test' };
  };
  fn.placements = record;
  return fn;
};

export default { makeEnqueueDouble };
