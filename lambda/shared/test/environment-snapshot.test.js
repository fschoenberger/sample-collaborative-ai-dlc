import { describe, expect, it } from 'vitest';
import {
  assertDefaultableEnvironment,
  isDefaultableEnvironment,
  resolvePublishedEnvironment,
  resolveEnvironmentSnapshot,
  supportsCompatibilityVersion,
} from '../environment-snapshot.js';

const environment = {
  environmentId: 'custom',
  name: 'Custom',
  status: 'PUBLISHED',
  publishedRevisionId: 'r-1',
};

const revision = {
  environmentId: 'custom',
  revisionId: 'r-1',
  status: 'PUBLISHED',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/custom',
  runtimeVersion: '3',
  runtimeEndpoint: 'revision_r_1',
  runtimeCompatibilityVersion: '2',
  verification: { status: 'PASSED' },
  flattenedRecipe: {
    resolvedTools: [
      { toolId: 'node', versionId: '22', name: 'Node.js', version: '22.17.0' },
      { toolId: 'python', versionId: '3.13', name: 'Python', version: '3.13.5' },
    ],
  },
};

const ddb = (revisionValue = revision) => ({
  send: async (command) =>
    command.input.Key.sk === 'META' ? { Item: environment } : { Item: revisionValue },
});

describe('environment snapshots', () => {
  it('accepts only the current and previous compatibility versions', () => {
    expect(supportsCompatibilityVersion('2', '2')).toBe(true);
    expect(supportsCompatibilityVersion('1', '2')).toBe(true);
    expect(supportsCompatibilityVersion('0', '2')).toBe(false);
    expect(supportsCompatibilityVersion('3', '2')).toBe(false);
  });

  it('returns immutable image and runtime fields from the published revision', async () => {
    await expect(
      resolveEnvironmentSnapshot({
        ddb: ddb(),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).resolves.toMatchObject({
      environmentId: 'custom',
      revisionId: 'r-1',
      imageDigest: revision.imageDigest,
      runtimeArn: revision.runtimeArn,
      runtimeEndpoint: 'revision_r_1',
      compatibilityVersion: '2',
      verification: { status: 'PASSED' },
      tools: revision.flattenedRecipe.resolvedTools,
    });
  });

  it('returns the validated records alongside the immutable snapshot', async () => {
    await expect(
      resolvePublishedEnvironment({
        ddb: ddb(),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).resolves.toMatchObject({
      environment,
      revision,
      snapshot: {
        environmentId: 'custom',
        revisionId: 'r-1',
        compatibilityVersion: '2',
      },
    });
  });

  it('uses the exact configured Standard runtime when the registry is not seeded yet', async () => {
    await expect(
      resolveEnvironmentSnapshot({
        ddb: { send: async () => ({}) },
        tableName: 'registry',
        environmentId: 'standard',
        fallback: {
          revisionId: 'core-4',
          imageDigest: `sha256:${'b'.repeat(64)}`,
          runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/core',
          runtimeVersion: '4',
          compatibilityVersion: '2',
          verification: { status: 'PASSED', source: 'core-runtime' },
        },
      }),
    ).resolves.toMatchObject({
      environmentId: 'standard',
      revisionId: 'core-4',
      runtimeVersion: '4',
      compatibilityVersion: '2',
      verification: { status: 'PASSED', source: 'core-runtime' },
      tools: [],
    });
  });

  it('rejects unverified and unsupported published revisions', async () => {
    await expect(
      resolveEnvironmentSnapshot({
        ddb: ddb({ ...revision, verification: { status: 'FAILED' } }),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_REVISION_UNVERIFIED' });

    await expect(
      resolveEnvironmentSnapshot({
        ddb: ddb({ ...revision, runtimeCompatibilityVersion: '0' }),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_COMPATIBILITY_UNSUPPORTED' });
  });

  it('rejects custom fallbacks and revisions that are not published', async () => {
    await expect(
      resolveEnvironmentSnapshot({
        environmentId: 'custom',
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_PUBLISHED' });

    await expect(
      resolveEnvironmentSnapshot({
        ddb: ddb({ ...revision, status: 'READY' }),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_PUBLISHED' });
  });
});

describe('EC2 environment snapshots', () => {
  const ec2Environment = {
    environmentId: 'cpp-buildhost',
    name: 'C++ buildhost',
    kind: 'EC2',
    status: 'PUBLISHED',
    publishedRevisionId: 'r-9',
  };
  const ec2Revision = {
    environmentId: 'cpp-buildhost',
    revisionId: 'r-9',
    status: 'PUBLISHED',
    kind: 'EC2',
    launchTemplateId: 'lt-0abc',
    launchTemplateVersion: '2',
    launchSpec: { architecture: 'x86_64', instanceTypes: ['c7i.2xlarge'] },
    runtimeCompatibilityVersion: '2',
    verification: { status: 'PASSED', clang: '23.1.0', cmake: '4.3.0' },
  };
  const ec2Ddb = (revisionValue = ec2Revision, environmentValue = ec2Environment) => ({
    send: async (command) =>
      command.input.Key.sk === 'META' ? { Item: environmentValue } : { Item: revisionValue },
  });

  const resolve = (ddbClient) =>
    resolveEnvironmentSnapshot({
      ddb: ddbClient,
      tableName: 'registry',
      environmentId: 'cpp-buildhost',
      fallback: { compatibilityVersion: '2' },
    });

  it('snapshots the frozen launch identity instead of an image digest', async () => {
    await expect(resolve(ec2Ddb())).resolves.toMatchObject({
      environmentId: 'cpp-buildhost',
      kind: 'EC2',
      revisionId: 'r-9',
      launchTemplateId: 'lt-0abc',
      launchTemplateVersion: '2',
      launchSpec: { architecture: 'x86_64' },
      imageDigest: null,
      runtimeArn: null,
    });
  });

  it('judges completeness by the launch template, not the image fields', async () => {
    // Missing runtimeArn/imageDigest is normal for EC2 and must NOT be incomplete.
    const snapshot = await resolve(ec2Ddb());
    expect(snapshot.launchTemplateId).toBe('lt-0abc');

    // A missing launch template IS incomplete, though.
    await expect(resolve(ec2Ddb({ ...ec2Revision, launchTemplateId: null }))).rejects.toMatchObject(
      { code: 'ENVIRONMENT_REVISION_INCOMPLETE' },
    );
    await expect(
      resolve(ec2Ddb({ ...ec2Revision, launchTemplateVersion: null })),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_REVISION_INCOMPLETE' });
    await expect(resolve(ec2Ddb({ ...ec2Revision, launchSpec: null }))).rejects.toMatchObject({
      code: 'ENVIRONMENT_REVISION_INCOMPLETE',
    });
  });

  it('still enforces verification and compatibility gates', async () => {
    await expect(
      resolve(ec2Ddb({ ...ec2Revision, verification: { status: 'FAILED' } })),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_REVISION_UNVERIFIED' });
    await expect(
      resolve(ec2Ddb({ ...ec2Revision, runtimeCompatibilityVersion: '0' })),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_COMPATIBILITY_UNSUPPORTED' });
  });

  it('keeps an AgentCore revision judged on its image fields', async () => {
    // Guard against the completeness branch keying off the wrong kind: an
    // AgentCore revision with no runtimeArn must still be incomplete.
    await expect(
      resolveEnvironmentSnapshot({
        ddb: ddb({ ...revision, runtimeArn: null }),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_REVISION_INCOMPLETE' });
  });

  it('defaults an unlabelled environment to the AgentCore lifecycle', async () => {
    const snapshot = await resolveEnvironmentSnapshot({
      ddb: ddb(),
      tableName: 'registry',
      environmentId: 'custom',
      fallback: { compatibilityVersion: '2' },
    });
    expect(snapshot.kind).toBe('AGENTCORE');
  });
});

describe('the AGENTCORE-default invariant', () => {
  it('permits AgentCore and unlabelled environments as a default', () => {
    expect(isDefaultableEnvironment({ kind: 'AGENTCORE' })).toBe(true);
    expect(isDefaultableEnvironment({})).toBe(true);
    expect(isDefaultableEnvironment(null)).toBe(true);
    expect(() => assertDefaultableEnvironment({ kind: 'AGENTCORE' })).not.toThrow();
  });

  it('refuses an EC2 environment as a default, with a 409 and a named code', () => {
    expect(isDefaultableEnvironment({ kind: 'EC2' })).toBe(false);
    try {
      assertDefaultableEnvironment({ kind: 'EC2' });
      throw new Error('expected assertDefaultableEnvironment to throw');
    } catch (error) {
      expect(error.code).toBe('ENVIRONMENT_KIND_NOT_DEFAULTABLE');
      expect(error.statusCode).toBe(409);
      expect(error.message).toMatch(/bind it to individual stages/);
    }
  });
});
