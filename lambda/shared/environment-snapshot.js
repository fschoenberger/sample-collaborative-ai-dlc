import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { supportsCompatibilityVersion } from './runtime-compatibility.js';

const environmentKey = (environmentId) => ({ pk: `ENV#${environmentId}`, sk: 'META' });
const revisionKey = (environmentId, revisionId) => ({
  pk: `ENV#${environmentId}`,
  sk: `REV#${revisionId}`,
});
const PUBLISHED_REVISION_STATUSES = new Set(['PUBLISHED', 'SUPERSEDED']);
const ENVIRONMENT_RESOLUTION_CODES = new Set([
  'ENVIRONMENT_NOT_PUBLISHED',
  'ENVIRONMENT_REVISION_INCOMPLETE',
  'ENVIRONMENT_REVISION_UNVERIFIED',
  'ENVIRONMENT_COMPATIBILITY_UNSUPPORTED',
]);

const environmentError = (message, code) => Object.assign(new Error(message), { code });

const fallbackSnapshot = (fallback = {}) => ({
  environmentId: 'standard',
  name: 'Standard Node/Python',
  kind: 'AGENTCORE',
  revisionId: fallback.revisionId ?? 'legacy',
  imageDigest: fallback.imageDigest ?? null,
  runtimeVersion: fallback.runtimeVersion ?? null,
  runtimeArn: fallback.runtimeArn ?? null,
  runtimeEndpoint: fallback.runtimeEndpoint ?? null,
  compatibilityVersion: fallback.compatibilityVersion ?? '1',
  verification: fallback.verification ?? { status: 'PASSED', source: 'legacy-runtime' },
  tools: fallback.tools ?? [],
});

const fallbackEnvironment = (fallback = {}) => ({
  environmentId: 'standard',
  name: 'Standard Node/Python',
  status: 'PUBLISHED',
  publishedRevisionId: fallback.revisionId ?? 'legacy',
});

const fallbackResolution = (fallback) => ({
  environment: fallbackEnvironment(fallback),
  revision: null,
  snapshot: fallbackSnapshot(fallback),
});

export const isEnvironmentResolutionError = (error) =>
  ENVIRONMENT_RESOLUTION_CODES.has(error?.code);

// The AGENTCORE-default invariant.
//
// A project's (and therefore an intent's) DEFAULT environment must be an
// AgentCore one. Several operations are not stages, never go through the
// scheduler, and resolve the runtime straight off that default: init-ws,
// promote-units, derive-artifacts, create-workflow-checkpoint, discussion
// assist, compose proposals, quorum edits. An EC2 environment has no runtime for
// them to invoke, so it is bindable only as a per-stage override.
//
// Lives here rather than in either caller because BOTH the project-assignment
// endpoint and intent creation must enforce it, and one implementation with one
// error code is what keeps them from drifting.
export const isDefaultableEnvironment = (environment) =>
  (environment?.kind ?? 'AGENTCORE') !== 'EC2';

export const assertDefaultableEnvironment = (environment) => {
  if (isDefaultableEnvironment(environment)) return;
  throw Object.assign(
    new Error(
      'An EC2 environment cannot be a project default; bind it to individual stages instead',
    ),
    { code: 'ENVIRONMENT_KIND_NOT_DEFAULTABLE', statusCode: 409 },
  );
};

export const resolvePublishedEnvironment = async ({
  ddb,
  tableName,
  environmentId = 'standard',
  fallback = {},
}) => {
  if (!ddb || !tableName) {
    if (environmentId && environmentId !== 'standard') {
      throw environmentError('Assigned environment is not published', 'ENVIRONMENT_NOT_PUBLISHED');
    }
    return fallbackResolution(fallback);
  }
  const { Item: environment } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: environmentKey(environmentId || 'standard'),
      ConsistentRead: true,
    }),
  );
  if (!environment?.publishedRevisionId || environment.status === 'RETIRED') {
    if (environmentId && environmentId !== 'standard') {
      throw environmentError('Assigned environment is not published', 'ENVIRONMENT_NOT_PUBLISHED');
    }
    return fallbackResolution(fallback);
  }
  const { Item: revision } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: revisionKey(environment.environmentId, environment.publishedRevisionId),
      ConsistentRead: true,
    }),
  );
  if (!revision || !PUBLISHED_REVISION_STATUSES.has(revision.status)) {
    throw environmentError('Assigned environment is not published', 'ENVIRONMENT_NOT_PUBLISHED');
  }
  // Completeness means "this revision names the thing a worker is provisioned
  // from", and that thing differs by kind: an AgentCore runtime ARN plus the
  // image digest it was built from, versus the launch template the scheduler
  // hands to CreateFleet. Checking the wrong pair would let a half-built revision
  // publish and fail at first placement.
  const kind = environment.kind ?? 'AGENTCORE';
  const incomplete =
    kind === 'EC2'
      ? !revision?.launchTemplateId || !revision?.launchTemplateVersion || !revision?.launchSpec
      : !revision?.runtimeArn || !revision?.imageDigest;
  if (incomplete) {
    throw environmentError(
      'Published environment revision is incomplete',
      'ENVIRONMENT_REVISION_INCOMPLETE',
    );
  }
  if (revision.verification?.status !== 'PASSED') {
    throw environmentError(
      'Published environment revision is not verified',
      'ENVIRONMENT_REVISION_UNVERIFIED',
    );
  }
  const compatibilityVersion = revision.runtimeCompatibilityVersion ?? '1';
  const currentCompatibilityVersion =
    process.env.RUNTIME_COMPATIBILITY_VERSION ?? fallback.compatibilityVersion ?? '1';
  if (!supportsCompatibilityVersion(compatibilityVersion, currentCompatibilityVersion)) {
    throw environmentError(
      'Published environment compatibility version is unsupported',
      'ENVIRONMENT_COMPATIBILITY_UNSUPPORTED',
    );
  }
  const snapshot = {
    environmentId: environment.environmentId,
    name: environment.name,
    kind,
    revisionId: revision.revisionId,
    imageDigest: revision.imageDigest ?? null,
    runtimeVersion: revision.runtimeVersion ?? null,
    runtimeArn: revision.runtimeArn ?? null,
    runtimeEndpoint: revision.runtimeEndpoint ?? null,
    compatibilityVersion,
    verification: revision.verification ?? null,
    tools: revision.flattenedRecipe?.resolvedTools ?? [],
    // EC2 only. The launch identity is frozen here for exactly the reason
    // imageDigest is: republishing the environment must not change where an
    // already-running intent places its stages.
    ...(kind === 'EC2'
      ? {
          launchTemplateId: revision.launchTemplateId,
          launchTemplateVersion: revision.launchTemplateVersion,
          launchSpec: revision.launchSpec,
        }
      : {}),
  };
  return { environment, revision, snapshot };
};

export const resolveEnvironmentSnapshot = async (options) =>
  (await resolvePublishedEnvironment(options)).snapshot;

export { fallbackSnapshot, supportsCompatibilityVersion };
export default {
  resolvePublishedEnvironment,
  resolveEnvironmentSnapshot,
  isEnvironmentResolutionError,
  isDefaultableEnvironment,
  assertDefaultableEnvironment,
  fallbackSnapshot,
  supportsCompatibilityVersion,
};
