import { describe, expect, it, vi } from 'vitest';

import { clientTokenFor, createEc2Provisioner, placementGeneration } from '../provisioners.js';

// The launch identity a stage placement carries. Only `generation` differs between
// the two placements in the tests below — everything else is what a rewind retry of
// an already-resumed stage genuinely re-submits.
const WORKER_ID = 'p-4fdd2e13-b079-40af-a706-3f7932747a69-si-649d151f25dad31b-2';

const target = {
  environmentId: 'cpp-buildhost',
  revisionId: 'r-da07ef5f',
  launchTemplateId: 'lt-05904db9a99c3a35b',
  launchTemplateVersion: '1',
  launchSpec: {
    instanceTypes: ['c7i.4xlarge'],
    purchaseOption: 'on-demand',
    allocationStrategy: 'prioritized',
  },
};

describe('clientTokenFor', () => {
  it('fits EC2 64-character cap', () => {
    expect(clientTokenFor(WORKER_ID, 'run-1').length).toBeLessThanOrEqual(64);
  });

  it('is stable for the same worker within one orchestrator run', () => {
    // The property the token exists for: the durable SDK re-invokes a retried step,
    // and that retry must not leave a second instance running.
    expect(clientTokenFor(WORKER_ID, 'run-A')).toBe(clientTokenFor(WORKER_ID, 'run-A'));
  });

  it('DIFFERS across orchestrator runs for an identical worker id', () => {
    // The field bug. `p-<executionId>-<stageInstanceId>-<attempt>` is identical for
    // two genuinely different placements: a resume-after-park is attempt 2, and so
    // is a later rewind retry of that same stage instance. CreateFleet dedupes on
    // the client token for 24 HOURS, so the second placement had the first's
    // response replayed — a fleetInstanceSet naming an already-terminated instance,
    // errorSet empty, no error anywhere. The scheduler recorded a worker row for a
    // dead machine and the run hung until the 15-minute callback heartbeat.
    expect(clientTokenFor(WORKER_ID, 'run-A')).not.toBe(clientTokenFor(WORKER_ID, 'run-B'));
  });

  it('still separates two different workers in the same run', () => {
    expect(clientTokenFor('p-a-si-1', 'run-A')).not.toBe(clientTokenFor('p-b-si-1', 'run-A'));
  });
});

describe('placementGeneration', () => {
  // The generation the scheduler actually feeds clientTokenFor: run id AND the
  // durable attempt key. The bug this closes is the halt-and-ask RETRY — same run,
  // attempt still 1 — which the run id alone cannot tell apart.
  it('DIFFERS across halt-and-ask retry rounds within one run', () => {
    // domain-theme's two retry rounds: identical runId and workerId, so only the
    // attempt key (halt round) distinguishes them. Before this, both hashed to the
    // same token and the second replayed the first's dead instance.
    const g1 = placementGeneration({ runId: 'run-A', placementKey: 'code-generation-s1-u-domain-theme' });
    const g2 = placementGeneration({
      runId: 'run-A',
      placementKey: 'code-generation-s1-u-domain-theme-round-2',
    });
    expect(g1).not.toBe(g2);
    expect(clientTokenFor(WORKER_ID, g1)).not.toBe(clientTokenFor(WORKER_ID, g2));
  });

  it('DIFFERS across relaunches (new run id) for the same attempt key', () => {
    const key = 'code-generation-s1-u-domain-theme';
    const g1 = placementGeneration({ runId: 'run-A', placementKey: key });
    const g2 = placementGeneration({ runId: 'run-B', placementKey: key });
    expect(clientTokenFor(WORKER_ID, g1)).not.toBe(clientTokenFor(WORKER_ID, g2));
  });

  it('is STABLE for a genuine step re-invocation (same run id + attempt key)', () => {
    // The dedupe the token must preserve: a durable step re-run with identical
    // identity must not leave a second instance.
    const args = { runId: 'run-A', placementKey: 'code-generation-s1-u-domain-theme' };
    expect(placementGeneration(args)).toBe(placementGeneration(args));
    expect(clientTokenFor(WORKER_ID, placementGeneration(args))).toBe(
      clientTokenFor(WORKER_ID, placementGeneration(args)),
    );
  });

  it('does not emit the literal "null" when parts are missing', () => {
    expect(placementGeneration({})).not.toContain('null');
    expect(placementGeneration()).toBe('~');
  });
});

describe('ec2 provisioner', () => {
  const stubClient = (instanceId = 'i-new') => ({
    send: vi.fn(async () => ({
      Instances: [{ InstanceIds: [instanceId] }],
      FleetId: 'fleet-1',
      Errors: [],
    })),
  });

  const tokenFrom = (client) => client.send.mock.calls[0][0].input.ClientToken;

  it('submits a different client token for the same worker in a new run', async () => {
    const first = stubClient();
    const second = stubClient();
    const args = { target, workerId: WORKER_ID, executionId: 'x', subnetIds: ['subnet-a'] };

    await createEc2Provisioner({ client: first, env: {} }).provision({
      ...args,
      generation: 'run-1789370900362-vm776ncm',
    });
    await createEc2Provisioner({ client: second, env: {} }).provision({
      ...args,
      generation: 'run-1789999999999-zz999zzz',
    });

    expect(tokenFrom(first)).not.toBe(tokenFrom(second));
  });

  it('reports no capacity rather than returning a null instance', async () => {
    // `instant` reports per-override failures instead of throwing, so an empty
    // instance list has to become an error here — otherwise the caller writes a
    // worker row with instanceId undefined and waits on a machine that never was.
    const client = {
      send: vi.fn(async () => ({
        Instances: [],
        Errors: [{ ErrorCode: 'InsufficientInstanceCapacity', ErrorMessage: 'none in az' }],
      })),
    };
    await expect(
      createEc2Provisioner({ client, env: {} }).provision({
        target,
        workerId: WORKER_ID,
        executionId: 'x',
        subnetIds: ['subnet-a'],
        generation: 'run-1',
      }),
    ).rejects.toMatchObject({ code: 'PROVISION_NO_CAPACITY' });
  });
});
