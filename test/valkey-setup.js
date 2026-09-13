import { GenericContainer, Wait } from 'testcontainers';

// One Valkey container for the whole vitest run, shared across projects
// (parallels test/gremlin-setup.js and test/dynamodb-setup.js). The scheduler's
// registry is tested against a REAL server because the semantics it depends on —
// consumer groups, the pending-entries list, and XAUTOCLAIM's idle window — are
// exactly the parts a hand-written fake would get subtly wrong.
//
// This is a single node, so it does NOT reproduce cluster slot routing, which
// ElastiCache Serverless does enforce. Slot co-location is therefore asserted
// separately and statically over the key builders (see lambda/scheduler/keys.js
// and its test) rather than being left to a runtime that cannot catch it.

let container;

export async function setup() {
  container = await new GenericContainer('valkey/valkey:9.1-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // globalSetup runs in a separate process before vitest workers start, so
  // vi.stubEnv is not available here. Direct process.env assignment is the
  // supported channel for handing the container's address to test workers.
  process.env.VALKEY_HOST = container.getHost();
  process.env.VALKEY_PORT = String(container.getMappedPort(6379));
  process.env.VALKEY_TLS = 'off';
}

export async function teardown() {
  await container?.stop();
}
