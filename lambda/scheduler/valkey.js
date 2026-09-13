// The Valkey connection.
//
// Two shapes, because production and test differ in a way that cannot be papered
// over: ElastiCache Serverless is ALWAYS cluster-mode-enabled behind a single
// endpoint and requires TLS, while the test container is a plain single node.
// `VALKEY_TLS=off` selects the single-node client; anything else selects the
// cluster client. Both return the same command surface, so nothing downstream
// branches on it.
//
// Connection reuse matters here. A Lambda that opens a fresh TCP+TLS connection
// per invocation would spend more time handshaking than working, so the client is
// created once per execution context and kept on the module. `enableOfflineQueue`
// stays on so commands issued during a reconnect are buffered rather than thrown,
// and `maxRetriesPerRequest` is bounded so a genuinely dead cluster surfaces as an
// error instead of hanging until the Lambda times out.

import Valkey from 'iovalkey';

let client = null;

const options = () => ({
  // A scheduler call sits in front of a stage dispatch; failing fast and letting
  // the orchestrator's retry handle it beats blocking the invocation.
  connectTimeout: 5000,
  commandTimeout: 5000,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: true,
  enableReadyCheck: true,
  // Fixed short backoff: the cluster is in-VPC and either reachable or not.
  retryStrategy: (attempt) => (attempt > 3 ? null : 200 * attempt),
});

export const createClient = ({ env = process.env } = {}) => {
  const host = env.VALKEY_HOST;
  const port = Number(env.VALKEY_PORT || 6379);
  if (!host) {
    throw Object.assign(new Error('VALKEY_HOST is not configured'), {
      code: 'VALKEY_NOT_CONFIGURED',
    });
  }
  if (env.VALKEY_TLS === 'off') {
    return new Valkey({ host, port, ...options() });
  }
  return new Valkey.Cluster([{ host, port }], {
    // Serverless publishes one endpoint that resolves to shard addresses; without
    // this the client rewrites them to private IPs it cannot reach.
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: { tls: {}, ...options() },
    clusterRetryStrategy: (attempt) => (attempt > 3 ? null : 200 * attempt),
  });
};

/** The per-execution-context shared client. */
export const getClient = ({ env = process.env } = {}) => {
  if (!client) client = createClient({ env });
  return client;
};

/** Drop the shared client. Used by tests; also the recovery path for a hard failure. */
export const resetClient = async () => {
  const current = client;
  client = null;
  try {
    await current?.quit();
  } catch {
    // A client that is already broken cannot be closed cleanly, and that is fine
    // — the point of resetting is that the next call builds a new one.
  }
};

export default { createClient, getClient, resetClient };
