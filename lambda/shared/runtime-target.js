// Where does a piece of work run?
//
// This used to answer with an AgentCore runtime ARN, because AgentCore was the
// only possible answer. With EC2 environments there are two kinds of worker, so
// stage dispatch needs a TAGGED target and branches on `kind`.
//
// Three functions, deliberately distinct, because two very different callers ask
// this question:
//
//   resolveRuntimeTarget / runtimeTargetInput — the InvokeAgentRuntime argument
//     shape, for one-shot NON-STAGE operations (discussion assist, compose
//     proposals, capability checks). These always run on the intent's default
//     environment, and that default is constrained to AGENTCORE, so their
//     contract is unchanged and they never see an EC2 target.
//
//   resolveStageTarget — stage dispatch. Honours the per-stage override map and
//     may return an EC2 target. The scheduler consumes this; the orchestrator
//     only passes it along.

export const AGENTCORE_KIND = 'AGENTCORE';
export const EC2_KIND = 'EC2';

const snapshotOf = (meta) => meta?.environment ?? meta?.environmentSnapshot ?? null;

// The environment a given stage runs on: its override when the intent snapshotted
// one, else the intent default. `stageEnvironments` is keyed by stageId (not
// stageInstanceId) because the binding is authored against the workflow's stage,
// and one stage may have many instances across parallel units — all of which
// belong on the same kind of machine.
export const stageSnapshotOf = (meta, stageId) =>
  (stageId ? meta?.stageEnvironments?.[stageId] : null) ?? snapshotOf(meta);

export const resolveRuntimeTarget = (meta, fallbackRuntimeArn = '') => {
  const snapshot = snapshotOf(meta);
  return {
    agentRuntimeArn: snapshot?.runtimeArn || fallbackRuntimeArn || '',
    qualifier: snapshot?.runtimeEndpoint || undefined,
  };
};

export const runtimeTargetInput = (meta, fallbackRuntimeArn = '') => {
  // Reaching here with an EC2 default would mean the AGENTCORE-default invariant
  // was violated upstream. Fail with a named code rather than handing the SDK an
  // empty ARN and reporting whatever it says about it.
  if (snapshotOf(meta)?.kind === EC2_KIND) {
    throw Object.assign(
      new Error('This operation requires an AgentCore environment, but the intent default is EC2'),
      { code: 'ENVIRONMENT_KIND_UNSUPPORTED' },
    );
  }
  const target = resolveRuntimeTarget(meta, fallbackRuntimeArn);
  return {
    agentRuntimeArn: target.agentRuntimeArn,
    ...(target.qualifier ? { qualifier: target.qualifier } : {}),
  };
};

/**
 * The tagged target for one stage, honouring the per-stage override map.
 *
 * `{ kind: 'AGENTCORE', environmentId, revisionId, agentRuntimeArn, qualifier? }`
 * or
 * `{ kind: 'EC2', environmentId, revisionId, launchTemplateId, launchTemplateVersion, launchSpec }`
 */
export const resolveStageTarget = (meta, stageId, fallbackRuntimeArn = '') => {
  const snapshot = stageSnapshotOf(meta, stageId);
  if (snapshot?.kind === EC2_KIND) {
    return {
      kind: EC2_KIND,
      environmentId: snapshot.environmentId,
      revisionId: snapshot.revisionId,
      launchTemplateId: snapshot.launchTemplateId,
      launchTemplateVersion: snapshot.launchTemplateVersion,
      launchSpec: snapshot.launchSpec,
    };
  }
  return {
    kind: AGENTCORE_KIND,
    environmentId: snapshot?.environmentId ?? 'standard',
    revisionId: snapshot?.revisionId ?? null,
    agentRuntimeArn: snapshot?.runtimeArn || fallbackRuntimeArn || '',
    qualifier: snapshot?.runtimeEndpoint || undefined,
  };
};

export default {
  AGENTCORE_KIND,
  EC2_KIND,
  stageSnapshotOf,
  resolveRuntimeTarget,
  resolveStageTarget,
  runtimeTargetInput,
};
