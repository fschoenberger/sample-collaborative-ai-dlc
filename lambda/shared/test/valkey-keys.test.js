import { describe, expect, it } from 'vitest';
import {
  environmentIdleKey,
  environmentQueueKey,
  environmentWorkersKey,
  hashTagOf,
  jobMetaKey,
  workerMetaKey,
  workerStreamKey,
} from '../valkey/keys.js';

// These assertions are the ONLY place cluster slot correctness is checked. The
// test Valkey is a single node and will happily execute a pipeline whose keys
// span slots; ElastiCache Serverless will reject it with CROSSSLOT. So the
// contract is proven statically: keys used together in one pipeline or script
// must share a hash tag.
describe('cluster slot co-location', () => {
  it('co-locates a worker with its own addressed stream', () => {
    const id = 'i-0abc123def4567890';
    expect(hashTagOf(workerMetaKey(id))).toBe(hashTagOf(workerStreamKey(id)));
  });

  it('co-locates an environment queue, idle set and worker index', () => {
    const env = 'cpp-buildhost';
    const tags = [
      environmentQueueKey(env),
      environmentIdleKey(env),
      environmentWorkersKey(env),
    ].map(hashTagOf);
    expect(new Set(tags).size).toBe(1);
  });

  it('keeps distinct entities in distinct slots so they are never assumed atomic', () => {
    // A worker's state and its environment's idle set genuinely differ, and the
    // registry must therefore update them in separate round trips. If this ever
    // becomes equal, someone has changed the tags and a Lua script could silently
    // start assuming consistency the design does not provide.
    expect(hashTagOf(workerMetaKey('i-1'))).not.toBe(hashTagOf(environmentIdleKey('cpp')));
  });

  it('separates workers from one another', () => {
    expect(hashTagOf(workerMetaKey('i-1'))).not.toBe(hashTagOf(workerMetaKey('i-2')));
  });

  it('separates environments from one another', () => {
    expect(hashTagOf(environmentQueueKey('a'))).not.toBe(hashTagOf(environmentQueueKey('b')));
  });
});

describe('hashTagOf', () => {
  it('reads the tag from every key builder', () => {
    expect(hashTagOf(workerMetaKey('i-1'))).toBe('w:i-1');
    expect(hashTagOf(environmentQueueKey('std'))).toBe('e:std');
    expect(hashTagOf(jobMetaKey('job-1'))).toBe('j:job-1');
  });

  it('returns null for an untagged or empty-tagged key', () => {
    expect(hashTagOf('plain:key')).toBeNull();
    expect(hashTagOf('{}:key')).toBeNull();
  });
});

describe('key segment validation', () => {
  // Ids reach these builders from operator-authored environment ids as well as
  // from AWS. A brace in a segment would repartition the keyspace silently, so
  // it must be a loud error rather than a key that half-works.
  it.each([
    ['a brace', 'cpp{evil}'],
    ['a closing brace', 'cpp}'],
    ['an empty id', ''],
    ['a leading separator', ':leading'],
    ['whitespace', 'has space'],
  ])('rejects %s', (_label, value) => {
    expect(() => environmentQueueKey(value)).toThrow(/invalid environmentId/);
  });

  it('names the offending field so the error is actionable', () => {
    expect(() => workerMetaKey('bad{id}')).toThrow(/invalid workerId/);
    expect(() => jobMetaKey('bad{id}')).toThrow(/invalid jobId/);
  });

  it('accepts the id shapes AWS and the registry actually produce', () => {
    expect(() => workerMetaKey('i-0abc123def4567890')).not.toThrow();
    // AgentCore session ids are padded to 33+ chars and contain dashes.
    expect(() => workerMetaKey('aidlc-intent-abc123def4567890000000')).not.toThrow();
    expect(() => environmentQueueKey('cpp-buildhost')).not.toThrow();
    expect(() => jobMetaKey('job-1789310981728-a1b2c3')).not.toThrow();
  });
});
