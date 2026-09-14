// AgentCore Runtime HTTP server — the container contract.
//
// Bedrock AgentCore Runtime requires a container that listens on 0.0.0.0:8080
// (ARM64) and serves:
//   GET  /ping         → 200 { status: "Healthy" | "HealthyBusy", time_of_last_update }
//                        HealthyBusy keeps the runtime SESSION alive while a stage
//                        runs (a stage can take many minutes).
//   POST /invocations  → run a command; JSON in, JSON out.
//
// The SAME session id routes to the SAME microVM, so the git checkout from
// init-ws persists across run-stage invocations — that's how we keep filesystem
// state between stages without our own pool/lease machinery.
//
// Invocation payloads:
//   { "command": "init-ws",  ...initWs args }
//   { "command": "run-stage", ...runStage args }
//   { "command": "run-stage-start", ...runStage args, stageCallbackId }
//     → accepts in ms, runs the stage as a background job, completes the
//       orchestrator's durable callback on exit (docs/v2-parallel.md WP1).
//       The busy tracker is held for the job's lifetime so /ping reports
//       HealthyBusy and AgentCore keeps the session alive while it runs.
//   { "command": "promote-units", projectId, intentId, executionId, stageInstanceId? }
//     → WP3: re-parse the approved unit-of-work-dependency artifact into the
//       UNITPLAN/UNIT scheduling rows + the Neptune traceability mirror.
//   { "command": "derive-artifacts", projectId, intentId, executionId, stageInstanceId?,
//     artifactTypes?, enrichment?, requestedCli?, cliModels? }
//     → rebuild the fine-grained graph projection from canonical artifact markdown.
//       `enrichment` ('off'|'llm') is the Admin toggle snapshotted on the execution;
//       'llm' adds bounded summary metadata via a one-shot agent-CLI call.
//   { "command": "create-workflow-checkpoint", projectId, intentId, executionId,
//     sourceStageInstanceId? }
//     → freeze the latest completed workflow boundary for native export.
//   { "command": "init-lane",  ...initLane args }   → WP5: prepare a unit
//       lane's session workspace (clone + unit branch off intent HEAD + push).
//   { "command": "merge-lane", ...mergeLane args }  → WP5: serialized --no-ff
//       merge of a finished lane's branch into the intent branch (runs in the
//       INTENT session; the orchestrator holds the merge lock).
//   { "command": "reconcile-lane", ...reconcileLane args } → merge the latest
//       intent head into a unit branch before making its draft PR ready.
//   { "command": "refresh-intent", ...refreshIntentWorkspace args } → reset the
//       intent session checkout to the remote after provider-side integration.
//   { "command": "resolve-conflict", ...resolveConflict args } → WP6: the
//       scoped conflict-resolution stage (lane session; engine merges +
//       verifies + concludes, the agent only edits the conflicted files).
//   { "command": "record-unit-pr", unitPrs:[...] } → best-effort Neptune
//       projection for unit review PRs; DDB remains scheduling truth.
//   { "command": "discussion-assist-start", ...discussion args }
//     → accepts in ms, runs Quorum's one-shot discussion answer in a background
//       job, then updates the pending DiscussionMessage and broadcasts it.
//   { "command": "quorum-edit-plan-start", ...quorum edit args, callbackId }
//     → accepts in ms; a background job analyzes the downstream impact of a
//       requested document edit, produces a structured update plan, and
//       completes the orchestrator's durable callback with it.
//   { "command": "quorum-edit-apply-start", ...quorum edit args, callbackId }
//     → accepts in ms; a background job applies the APPROVED plan (bounded
//       one-shot rewrites + drift bookkeeping + re-derive) and completes the
//       orchestrator's durable callback with the outcome.
//   { "command": "repair-structure", projectId, intentId, executionId,
//     artifactTypes?, requestedCli?, cliModels? }
//     → ops remediation: reconstruct LOST machine-parsed structured blocks
//       from each damaged artifact's own prose (validated through the real
//       extractor before any write), then re-derive the projection.
//
// The dispatcher is pure (handlers injected) so it is unit-tested without a
// socket; createServer wires the real commands + clients.

import http from 'node:http';
import { commandDefinition } from './command-registry.js';

// Track whether a stage is currently running so /ping can report HealthyBusy.
export const createBusyTracker = () => {
  let busy = 0;
  return {
    enter() {
      busy += 1;
    },
    leave() {
      busy = Math.max(0, busy - 1);
    },
    get status() {
      return busy > 0 ? 'HealthyBusy' : 'Healthy';
    },
  };
};

// Dispatch one parsed invocation to the right command handler. PURE of HTTP —
// returns { statusCode, body }. `handlers` = { initWs, runStage }; `busy` is the
// tracker so a long run-stage flips /ping to HealthyBusy.
export const dispatchInvocation = async ({
  payload,
  handlers,
  busy,
  prepareInvocation = null,
  now = () => new Date().toISOString(),
}) => {
  const command = payload?.command;
  if (!command) {
    console.error('[agentcore] rejected invocation with no command');
    return { statusCode: 400, body: { error: 'missing "command"' } };
  }
  const definition = commandDefinition(command);
  const handler = definition ? handlers[definition.handler] : null;
  if (!handler) {
    // LOG it: a 400 travels back to the caller as an opaque SDK error, so an
    // unregistered or misspelled command was previously invisible in CloudWatch —
    // which is exactly where the resulting stage failure tells you to look.
    console.error('[agentcore] unknown command', {
      command,
      known: Boolean(definition),
      handler: definition?.handler ?? null,
    });
    return { statusCode: 400, body: { error: `unknown command "${command}"` } };
  }

  busy?.enter();
  try {
    const context =
      prepareInvocation && definition.agentAuth
        ? await prepareInvocation(payload, definition.agentAuth)
        : {};
    const handlerPayload = { ...payload };
    delete handlerPayload.agentCredentialGrant;
    const result = await handler(handlerPayload, context);
    // Command-level failures are part of the application protocol. Keep them on
    // HTTP 200 so Bedrock AgentCore returns the JSON body to the orchestrator
    // instead of turning the response into an SDK transport exception.
    return { statusCode: 200, body: { ...result, command, at: now() } };
  } catch (e) {
    // LOG it. This return value is the ONLY record of the failure, and on an EC2
    // worker nobody reads it: the queue carries work in and the verdict travels on
    // the durable callback, so a 500 body is discarded and the exception vanished
    // entirely — a stage that died here left two lines in the runner log and no
    // reason in any of them. Over HTTP the body at least reached the orchestrator,
    // which is why this was invisible until the same handler ran off a queue.
    console.error('[agentcore] command threw', {
      command,
      error: e?.message,
      code: e?.code ?? null,
      stack: e?.stack,
    });
    return { statusCode: 500, body: { error: e.message, command } };
  } finally {
    busy?.leave();
  }
};

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

// Build the HTTP server. `handlers` = { initWs, runStage } already bound to their
// deps; `busy` defaults to a fresh tracker.
export const createServer = ({
  handlers,
  busy = createBusyTracker(),
  prepareInvocation = null,
  now = () => new Date().toISOString(),
}) => {
  return http.createServer(async (req, res) => {
    const send = (statusCode, body) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/ping') {
      return send(200, {
        status: busy.status,
        time_of_last_update: Math.floor(Date.parse(now()) / 1000),
      });
    }
    if (req.method === 'POST' && req.url === '/invocations') {
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (e) {
        return send(400, { error: e.message });
      }
      const { statusCode, body } = await dispatchInvocation({
        payload,
        handlers,
        busy,
        prepareInvocation,
        now,
      });
      return send(statusCode, body);
    }
    return send(404, { error: 'not found' });
  });
};

// Container entry: build the handlers, then listen on 8080.
//
// The handler wiring lives in handlers.js because the Valkey worker loop needs
// exactly the same map; keeping it there is what stops the two from drifting.
const main = async () => {
  const { buildHandlers } = await import('./handlers.js');
  const { handlers, busy, invocationContext } = await buildHandlers();

  const server = createServer({
    handlers,
    busy,
    prepareInvocation: invocationContext,
  });
  server.listen(8080, '0.0.0.0', () => console.error('[agentcore] listening on 0.0.0.0:8080'));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[agentcore] fatal:', e);
    process.exit(1);
  });
}
