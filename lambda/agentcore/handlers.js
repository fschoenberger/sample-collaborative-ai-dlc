// Handler wiring for the AgentCore container.
//
// Extracted from http-server.js so the HTTP server and the Valkey worker loop
// share ONE construction of the command handlers rather than two that drift.
// The AgentCore image serves /ping and /invocations (the runtime health contract)
// AND runs the worker loop; an EC2 worker runs only the loop. Both need the same
// handlers, built the same way.
//
// Returns { handlers, busy, invocationContext }:
//   handlers           the command map dispatchInvocation routes over
//   busy               the tracker /ping reads, held for a job's lifetime
//   invocationContext  resolves agent credentials for commands that declare
//                      agentAuth, and narrows availableClis to the authenticated
//                      ones

import { createProcessStore } from '../shared/v2-process-store.js';
import { createBusyTracker } from './http-server.js';

export const buildHandlers = async () => {
  const {
    ddb,
    s3,
    openGraph,
    broadcastToIntent,
    sendStageCallbackSuccess,
    sendStageCallbackHeartbeat,
  } = await import('./clients.js');
  const { initWs } = await import('./commands/init-ws.js');
  const { runStage } = await import('./commands/run-stage.js');
  const { createRunStageStart } = await import('./commands/run-stage-start.js');
  const { createDiscussionAssistStart } = await import('./commands/discussion-assist-start.js');
  const { createComposePlanStart } = await import('./commands/compose-plan-start.js');
  const { createQuorumEditPlanStart } = await import('./commands/quorum-edit-plan-start.js');
  const { createQuorumEditApplyStart } = await import('./commands/quorum-edit-apply-start.js');
  const { repairStructure } = await import('./commands/repair-structure.js');
  const { promoteUnits } = await import('./commands/promote-units.js');
  const { deriveArtifacts } = await import('./commands/derive-artifacts.js');
  const { createWorkflowCheckpoint } = await import('./commands/create-workflow-checkpoint.js');
  const { recordPr } = await import('./commands/record-pr.js');
  const { recordUnitPr } = await import('./commands/record-unit-pr.js');
  const { initLane, mergeLane, reconcileLane, refreshIntentWorkspace } =
    await import('./commands/lane.js');
  const { resolveConflict } = await import('./commands/resolve-conflict.js');
  const { inspect } = await import('./commands/inspect.js');
  const { capabilities } = await import('./commands/capabilities.js');
  const { managedRuntimeCheck } = await import('./commands/managed-runtime-check.js');
  const { verifyMcp } = await import('./commands/verify-mcp.js');
  const { loadLibrary, loadBlockBody, loadBlockScript, loadConductor } =
    await import('./block-loader.js');
  const { materializeStage, renderRulesDoc } = await import('./stage-materializer.js');
  const { checkoutRepos } = await import('./workspace.js');
  const { discoverInstalledClis } = await import('./cli/discover.js');
  const { authenticatedClisForEnv, resolveInvocationAgentAuth } =
    await import('./auth-resolver.js');

  const workspaceDir = process.env.V2_WORKSPACE_DIR || '/mnt/workspace';
  const mcpEntry = process.env.V2_MCP_ENTRY || new URL('./mcp/index.js', import.meta.url).pathname;
  const store = createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE });
  const installedClis = await discoverInstalledClis();
  const invocationContext = async (payload, authMode) => {
    const auth = await resolveInvocationAgentAuth({
      payload,
      authMode,
      store,
      env: process.env,
    });
    return {
      ...auth,
      availableClis: authenticatedClisForEnv({ installed: installedClis, env: auth.env }),
    };
  };

  // Publish a process-state payload on the intent's realtime channel. The
  // payload carries its own intentId (the command stamps it), so fan-out is keyed
  // off the payload rather than a closed-over id.
  const broadcast = (payload) => broadcastToIntent(payload?.intentId, payload);

  const handlers = {
    initWs: (p) => initWs(p, { store, openGraph, checkoutRepos, workspaceDir, broadcast }),
    runStage: (p, context) =>
      runStage(
        { ...p, workspaceDir },
        {
          store,
          loadLibrary,
          loadBlockBody,
          loadBlockScript,
          loadConductor,
          materializeStage,
          renderRulesDoc,
          mcpEntry,
          openGraph,
          availableClis: context.availableClis,
          credentialBindings: context.credentialBindings,
          missingCredentialBindings: context.missingCredentialBindings,
          broadcast,
          env: context.env,
        },
      ),
    inspect: (p) => inspect(p, { openGraph }),
    capabilities: (p, context) =>
      capabilities(p, {
        env: context.env,
        discoverInstalledClis: async () => installedClis,
      }),
    managedRuntimeCheck: (p) => managedRuntimeCheck(p, { workspaceDir }),
    verifyMcp: (p) => verifyMcp(p),
    // WP3: freeze the approved unit DAG into UNITPLAN/UNIT rows + the graph
    // mirror. Dispatched by the orchestrator after the producing stage
    // succeeds (docs/v2-parallel.md).
    promoteUnits: (p) => promoteUnits(p, { store, openGraph, broadcast }),
    deriveArtifacts: (p, context) =>
      deriveArtifacts(p, {
        store,
        openGraph,
        broadcast,
        availableClis: context.availableClis,
        env: context.env,
      }),
    createWorkflowCheckpoint: (p) =>
      createWorkflowCheckpoint(p, {
        store,
        openGraph,
        s3,
        bucket: process.env.ARTIFACTS_BUCKET,
      }),
    // Fan-in PR record: write the opened PR(s) into the graph (the orchestrator
    // has no Neptune access, so it forwards the structured PR data here).
    recordPr: (p) => recordPr(p, { store, openGraph, broadcast }),
    recordUnitPr: (p) => recordUnitPr(p, { store, openGraph, broadcast }),
    // WP5 unit lanes: engine-owned lane git (docs/v2-parallel.md A3). init-lane
    // runs in the lane's own session; merge-lane in the intent session.
    initLane: (p) => initLane({ ...p, workspaceDir }, { store, broadcast }),
    mergeLane: (p) => mergeLane({ ...p, workspaceDir }, { store, broadcast }),
    reconcileLane: (p) => reconcileLane({ ...p, workspaceDir }, { store, broadcast }),
    refreshIntent: (p) => refreshIntentWorkspace({ ...p, workspaceDir }, {}),
    // WP6: the scoped conflict-resolution stage (lane session). The engine
    // merges/verifies/concludes; the agent CLI only edits conflicted files.
    resolveConflict: (p, context) =>
      resolveConflict(
        { ...p, workspaceDir },
        {
          store,
          availableClis: context.availableClis,
          mcpEntry,
          broadcast,
          env: context.env,
        },
      ),
  };
  // Async stage invocation (WP1): shares the sync handler's whole deps bag; the
  // background job holds the SAME busy tracker the server uses for /ping, so
  // the session stays HealthyBusy for the job's lifetime.
  const busy = createBusyTracker();
  const stageJobs = new Map();
  handlers.runStageStart = (p, context) =>
    createRunStageStart({
      runStage: (q) => handlers.runStage(q, context),
      sendCallbackSuccess: sendStageCallbackSuccess,
      sendCallbackHeartbeat: sendStageCallbackHeartbeat,
      busy,
      activeJobs: stageJobs,
    })(p);
  const discussionJobs = new Map();
  handlers.discussionAssistStart = (p, context) =>
    createDiscussionAssistStart({
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      env: context.env,
      mcpEntry,
      busy,
      activeJobs: discussionJobs,
    })(p);
  // Composer proposals (Adaptive Workflows): grounded scope/grid proposals for
  // a DRAFT intent (front/report) or a parked run (inflight). Proposal-only —
  // applying it is the intents lambda's job, never this container's.
  const composeJobs = new Map();
  handlers.composePlanStart = (p, context) =>
    createComposePlanStart({
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      env: context.env,
      busy,
      activeJobs: composeJobs,
    })(p);
  // Quorum-supported artifact edits: plan (impact analysis) + apply (approved
  // rewrites). Same accept-then-background contract as run-stage-start; the
  // apply job re-derives through the SAME deriveArtifacts handler stages use.
  const quorumPlanJobs = new Map();
  handlers.quorumEditPlanStart = (p, context) =>
    createQuorumEditPlanStart({
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      env: context.env,
      sendCallbackSuccess: sendStageCallbackSuccess,
      sendCallbackHeartbeat: sendStageCallbackHeartbeat,
      busy,
      activeJobs: quorumPlanJobs,
    })(p);
  const quorumApplyJobs = new Map();
  handlers.quorumEditApplyStart = (p, context) =>
    createQuorumEditApplyStart({
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      env: context.env,
      deriveArtifacts: (q) => handlers.deriveArtifacts(q, context),
      sendCallbackSuccess: sendStageCallbackSuccess,
      sendCallbackHeartbeat: sendStageCallbackHeartbeat,
      busy,
      activeJobs: quorumApplyJobs,
    })(p);
  // Ops remediation: reconstruct lost structured blocks (see command header).
  handlers.repairStructure = (p, context) =>
    repairStructure(p, {
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      deriveArtifacts: (q) => handlers.deriveArtifacts(q, context),
      env: context.env,
    });

  return { handlers, busy, invocationContext };
};

export default { buildHandlers };
