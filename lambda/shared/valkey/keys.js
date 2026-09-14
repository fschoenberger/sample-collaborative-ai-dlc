// Valkey key layout for the scheduler.
//
// CLUSTER MODE IS NOT OPTIONAL. ElastiCache Serverless for Valkey is always
// cluster-mode-enabled behind a single endpoint, so any command touching more
// than one key — MULTI, Lua, ZADD+HSET pairs — fails with CROSSSLOT unless the
// keys hash to the same slot. Slots are computed over the substring inside the
// first `{...}` if one is present, so every key here carries a hash tag naming
// the entity it belongs to.
//
// The four tag families and what they guarantee can be done atomically:
//
//   {w:<workerId>}  worker meta + that worker's addressed stream
//                   → claiming, lease renewal and addressed dispatch are atomic.
//   {e:<envId>}     the environment's unassigned queue + its idle set + counters
//                   → enqueue, capacity checks and idle bookkeeping are atomic.
//   {j:<jobId>}     job meta
//                   → a job's own fields are atomic.
//   {s:scheduler}   deployment-wide indexes (the environment set)
//                   → read and written alone, so atomicity is not at stake.
//
// What is deliberately NOT atomic, because it spans tags: moving a worker
// between the idle set ({e:…}) and its own state ({w:…}). Those are separate
// commands, and a crash between them leaves the registry briefly wrong. That is
// tolerable precisely because Valkey is not the system of record here — the
// durable orchestrator owns attempt lifecycle, EC2 owns instance truth via
// DescribeInstances by tag, and the reconciler rebuilds from both. Never add a
// Lua script that assumes those two are consistent.

const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Ids come from AWS (instance ids, session ids) and our own generators, but they
// also reach here from operator-authored environment ids. A `{` or `}` in a tag
// would silently repartition the keyspace, so reject anything unexpected rather
// than build a key that half-works.
const segment = (value, label) => {
  const raw = String(value ?? '');
  if (!KEY_SEGMENT.test(raw)) {
    throw Object.assign(new Error(`invalid ${label} for a Valkey key: ${JSON.stringify(raw)}`), {
      code: 'INVALID_KEY_SEGMENT',
    });
  }
  return raw;
};

export const workerTag = (workerId) => `{w:${segment(workerId, 'workerId')}}`;
export const environmentTag = (environmentId) => `{e:${segment(environmentId, 'environmentId')}}`;
export const jobTag = (jobId) => `{j:${segment(jobId, 'jobId')}}`;

// Worker-scoped.
export const workerMetaKey = (workerId) => `${workerTag(workerId)}:meta`;
export const workerStreamKey = (workerId) => `${workerTag(workerId)}:stream`;

// Environment-scoped.
export const environmentQueueKey = (environmentId) => `${environmentTag(environmentId)}:queue`;
export const environmentIdleKey = (environmentId) => `${environmentTag(environmentId)}:idle`;
export const environmentWorkersKey = (environmentId) => `${environmentTag(environmentId)}:workers`;

// Job-scoped.
export const jobMetaKey = (jobId) => `${jobTag(jobId)}:meta`;

// The set of environments that have ever had a worker, so the reconciler can
// enumerate what to sweep instead of being TOLD.
//
// It has to exist because the sweep is driven by an EventBridge rule, and a rule's
// input is a static JSON literal — it cannot know which environments an operator
// created at runtime. The rule sent `{"action":"reconcile"}` and reconcile looped
// over `environmentIds = []`, so the abandoned-lease claim, the bootstrap timeout,
// the idle reap and the lifetime cap never ran even once on schedule; every
// leaked instance had to be found and terminated by hand.
//
// A fixed key, and therefore its own slot: it is read alone and written with a
// single SADD, so it never participates in a multi-key command and needs no tag
// shared with anything else. `{s:…}` keeps it inside the scheduler's namespace
// sweep all the same.
export const environmentsKey = () => '{s:scheduler}:environments';

// One consumer group per environment queue. Workers join it as consumers named
// by their own worker id, which is what makes the pending-entries list a map of
// "which worker owes which job" — and therefore what makes XAUTOCLAIM a lease
// expiry rather than a guess.
export const CONSUMER_GROUP = 'workers';

// Every scheduler key lives under one of these tags, so a namespace sweep
// (ops tooling, a dev reset) can enumerate them without touching anything else
// that might share the cluster.
export const KEY_TAG_PREFIXES = ['{w:', '{e:', '{j:', '{s:'];

/**
 * The hash tag a key routes on, or null when it carries none.
 *
 * Two keys with the SAME tag always land in the same slot, which makes this the
 * exact test for whether a multi-key command is legal on a cluster — no CRC16
 * needed. Used by the key tests to prove co-location statically, since a
 * single-node test server cannot reject a cross-slot pipeline.
 */
export const hashTagOf = (key) => {
  const open = String(key).indexOf('{');
  if (open < 0) return null;
  const close = String(key).indexOf('}', open + 1);
  return close > open + 1 ? String(key).slice(open + 1, close) : null;
};

export default {
  workerTag,
  environmentTag,
  jobTag,
  workerMetaKey,
  workerStreamKey,
  environmentQueueKey,
  environmentIdleKey,
  environmentWorkersKey,
  jobMetaKey,
  environmentsKey,
  hashTagOf,
  CONSUMER_GROUP,
  KEY_TAG_PREFIXES,
};
