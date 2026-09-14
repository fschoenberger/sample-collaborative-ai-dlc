import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { EC2Client, DescribeImagesCommand } from '@aws-sdk/client-ec2';
import { buildResponse } from '../shared/response.js';
import { isPlatformAdmin, requirePlatformAdmin } from '../shared/authz.js';
import {
  applyToolPrerequisites,
  generateBuildContext,
  normalizeEnvironmentId,
  orderRebuilds,
} from './fixed-tool-recipe.js';
import {
  CATALOG_RECIPE_SCHEMA_VERSION,
  generateCatalogEnvironmentBuildContext,
  rebuildCatalogEnvironmentRecipe,
  resolveCatalogEnvironmentRecipe,
} from './catalog-recipe.js';
import { uploadBuildContext } from './build-lifecycle.js';
import {
  actorFrom,
  createRetryableInitializer,
  parseBody,
  pathParts,
  requireUser,
  responseError,
} from './request.js';
import { createEnvironmentStore } from './store.js';
import { evaluateImage, imageAssertions, validateEc2LaunchSpec } from './ec2-launch-spec.js';
import { createLaunchTemplateForRevision } from './ec2-launch-template.js';
import { createToolStore } from './tool-store.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const codebuild = new CodeBuildClient({});
const ec2 = new EC2Client({});
const defaultStore = createEnvironmentStore({ ddb });
const defaultToolStore = createToolStore({ ddb });

const configuredCore = () => ({
  coreImageUri: process.env.CORE_IMAGE_URI,
  coreImageDigest: process.env.CORE_IMAGE_DIGEST,
  coreRuntimeArn: process.env.CORE_RUNTIME_ARN,
  coreRuntimeVersion: process.env.CORE_RUNTIME_VERSION || '1',
  coreImageSizeBytes: Number(process.env.CORE_IMAGE_SIZE_BYTES || 0) || null,
});

const ensureSeeded = async (store) => {
  const core = configuredCore();
  if (!core.coreImageUri || !core.coreImageDigest || !core.coreRuntimeArn) {
    throw Object.assign(new Error('Managed environment core runtime is not configured'), {
      statusCode: 503,
    });
  }
  await store.seedSystemEnvironments(core);
  await store.stageCoreRevision(core);
  await store.reconcileBaseUpdates();
};

const requirePublishedBaseImage = async (store, environmentId) => {
  const environment = await store.getEnvironment(environmentId);
  if (!environment || environment.status === 'RETIRED' || !environment.publishedRevisionId) {
    throw Object.assign(new Error('Base environment must have a published revision'), {
      statusCode: 409,
    });
  }
  const revision = await store.getRevision(environmentId, environment.publishedRevisionId);
  if (!revision?.imageUri || !revision?.imageDigest) {
    throw Object.assign(new Error('Base environment image is unavailable'), {
      statusCode: 409,
    });
  }
  return { environment, revision };
};

const assertAcyclicBase = async (store, environmentId, baseEnvironmentId) => {
  const visited = new Set();
  let candidateId = baseEnvironmentId;
  while (candidateId) {
    if (candidateId === environmentId) {
      throw Object.assign(new Error('Environment base dependency would create a cycle'), {
        statusCode: 409,
      });
    }
    if (visited.has(candidateId)) {
      throw Object.assign(new Error('Environment base dependency contains a cycle'), {
        statusCode: 409,
      });
    }
    visited.add(candidateId);
    const candidate = await store.getEnvironment(candidateId);
    candidateId = candidate?.baseEnvironmentId ?? null;
  }
};

const prepareCatalogRecipe = async (store, toolStore, input, baseEnvironmentId) => {
  const { revision: baseRevision } = await requirePublishedBaseImage(store, baseEnvironmentId);
  return resolveCatalogEnvironmentRecipe({
    input: {
      ...input,
      schemaVersion: CATALOG_RECIPE_SCHEMA_VERSION,
    },
    baseEnvironmentId,
    baseRevision,
    toolStore,
  });
};

const assertCatalogRevision = (environmentId, revision) => {
  // EC2 revisions have no recipe at all — the operator brings an AMI, so there is
  // no tool composition to be legacy about. Without this the guard rejects every
  // EC2 revision as a "fixed-tool recipe" it cannot rebuild.
  if (revision?.kind === 'EC2') return;
  if (
    environmentId !== 'standard' &&
    revision?.recipe?.schemaVersion !== CATALOG_RECIPE_SCHEMA_VERSION
  ) {
    throw Object.assign(
      new Error(
        'Fixed-tool recipe environments cannot be rebuilt; recreate the environment with catalog tools',
      ),
      {
        statusCode: 409,
        code: 'FIXED_TOOL_RECIPE_UNSUPPORTED',
      },
    );
  }
};

// The launch-template ingredients Terraform hands this lambda, mirroring how
// MANAGED_RUNTIME_ROLE_ARN and friends are already supplied for AgentCore
// runtimes. Read lazily so a deployment without EC2 support configured still
// serves every AgentCore path.
const launchTemplatePlatform = () => ({
  projectName: process.env.PROJECT_NAME ?? 'aidlc',
  environment: process.env.ENVIRONMENT ?? 'dev',
  region: process.env.AWS_REGION,
  instanceProfileArn: process.env.EXECUTOR_INSTANCE_PROFILE_ARN,
  securityGroupId: process.env.EXECUTOR_SECURITY_GROUP_ID,
  // Where the worker ships its runner log so it survives the instance. Not part of
  // the EC2-configured check below: a deployment that has not applied the log group
  // yet must still be able to place stages, it just cannot explain them afterwards.
  workerLogGroup: process.env.WORKER_LOG_GROUP,
  valkeyHost: process.env.VALKEY_HOST,
  valkeyPort: process.env.VALKEY_PORT ?? '6379',
  schedulerFunction: process.env.SCHEDULER_FUNCTION,
  processTable: process.env.V2_PROCESS_TABLE,
  blocksTable: process.env.BLOCKS_TABLE,
  artifactsBucket: process.env.ARTIFACTS_BUCKET,
  neptuneEndpoint: process.env.NEPTUNE_ENDPOINT,
  connectionsTable: process.env.CONNECTIONS_TABLE,
  websocketEndpoint: process.env.WEBSOCKET_ENDPOINT,
  credentialBrokerFunction: process.env.CREDENTIAL_BROKER_FUNCTION,
  sourceControlFunction: process.env.SOURCE_CONTROL_FUNCTION,
  mcpSecretsPrefix: process.env.MCP_SECRETS_SSM_PREFIX,
  aidlcRepoRef: process.env.AIDLC_REPO_REF,
  bedrockModel: process.env.BEDROCK_MODEL,
  runtimeCompatibilityVersion: process.env.RUNTIME_COMPATIBILITY_VERSION,
});

/**
 * Make an EC2 revision usable.
 *
 * There is no build. The AMI is built outside this system and the operator gives
 * us its id, so all the platform does is check the image is actually usable and
 * create the launch template `CreateFleet` needs. The template is per revision so
 * a published revision's launch identity is frozen — republishing an environment
 * must not move where a running intent places its stages.
 *
 * On success the revision is READY (publishable). On an unusable AMI it is FAILED
 * with the specific reasons, because a wrong architecture or a deregistered image
 * is the operator's most likely mistake and should say so here rather than at
 * first placement.
 */
// Is this deployment able to run EC2 workers at all? Checked BEFORE anything is
// created: a 503 raised after createEnvironment would leave an orphan record that
// no retry could get past, because the create is conditional on the key being
// absent. (Learned the hard way.)
const assertEc2Configured = () => {
  const platform = launchTemplatePlatform();
  if (!platform.instanceProfileArn || !platform.securityGroupId || !platform.valkeyHost) {
    throw Object.assign(new Error('EC2 environments are not configured in this deployment'), {
      statusCode: 503,
      code: 'EC2_NOT_CONFIGURED',
    });
  }
  return platform;
};

// Check the image and build the revision's launch template. `spec` is passed in
// rather than read back off the revision row: the caller has just validated it,
// and re-reading it would make this depend on the write having echoed it back.
const readyEc2Revision = async ({ store, environment, revision, spec, deps }) => {
  const platform = assertEc2Configured();

  const assertions = imageAssertions(spec);
  const described = await deps.ec2
    .send(
      new deps.DescribeImagesCommand({
        ImageIds: [assertions.imageId],
        ...(assertions.owners ? { Owners: assertions.owners } : {}),
      }),
    )
    .catch(() => ({ Images: [] }));
  const verdict = evaluateImage(spec, described.Images?.[0] ?? null);
  if (!verdict.valid) {
    return store.updateRevision(environment.environmentId, revision.revisionId, {
      status: 'FAILED',
      failure: { code: 'IMAGE_UNUSABLE', errors: verdict.errors },
    });
  }

  const launch = await createLaunchTemplateForRevision({
    ec2: deps.ec2,
    spec,
    environmentId: environment.environmentId,
    revisionId: revision.revisionId,
    platform,
  });
  return store.updateRevision(environment.environmentId, revision.revisionId, {
    status: 'READY',
    launchTemplateId: launch.launchTemplateId,
    launchTemplateVersion: launch.launchTemplateVersion,
    failure: null,
  });
};

const startBuild = async ({ store, environment, revision, actor, deps }) => {
  if (revision.status !== 'DRAFT') {
    throw Object.assign(new Error(`Revision is ${revision.status} and cannot be built`), {
      statusCode: 409,
    });
  }
  if ((environment.kind ?? 'AGENTCORE') === 'EC2') {
    // An EC2 environment has nothing to build. The AMI is built outside this
    // system and the operator supplies its id; the only platform-side artifact is
    // the launch template, created when the environment is saved.
    throw Object.assign(new Error('EC2 environments are not built; they are published directly'), {
      statusCode: 409,
      code: 'EC2_HAS_NO_BUILD',
    });
  }
  const maxImageBytes = Number(process.env.MAX_ENVIRONMENT_IMAGE_MB || 2048) * 1024 * 1024;
  if (
    revision.projectedImageSizeBytes &&
    Number(revision.projectedImageSizeBytes) > maxImageBytes
  ) {
    throw Object.assign(
      new Error(
        `Projected image size exceeds the ${Math.round(maxImageBytes / 1024 / 1024)} MiB runtime limit`,
      ),
      { statusCode: 409, code: 'PROJECTED_IMAGE_SIZE_EXCEEDED' },
    );
  }
  const catalogRecipe = revision.recipe?.schemaVersion === CATALOG_RECIPE_SCHEMA_VERSION;
  const recipe = catalogRecipe ? revision.recipe : applyToolPrerequisites(revision.recipe);
  const flattenedRecipe = catalogRecipe
    ? revision.flattenedRecipe
    : applyToolPrerequisites(revision.flattenedRecipe);
  const context = catalogRecipe
    ? generateCatalogEnvironmentBuildContext({
        environment,
        revision,
        recipe,
        flattenedRecipe,
      })
    : generateBuildContext({
        environment,
        revision,
        flattenedRecipe,
      });
  const prefix = `managed-environments/contexts/${environment.environmentId}/${revision.revisionId}`;
  await uploadBuildContext({ files: context.files, prefix, s3Client: deps.s3 });
  await store.updateRevision(
    environment.environmentId,
    revision.revisionId,
    {
      status: 'QUEUED',
      recipe,
      flattenedRecipe,
      contextPrefix: prefix,
      generatedDockerfile: context.dockerfile,
      failure: null,
    },
    { fromStatus: revision.status },
  );
  let started;
  try {
    started = await deps.codebuild.send(
      new StartBuildCommand({
        projectName: process.env.ENVIRONMENT_CODEBUILD_PROJECT,
        environmentVariablesOverride: [
          {
            name: 'CONTEXT_BUCKET',
            value: process.env.BUILD_CONTEXT_BUCKET,
            type: 'PLAINTEXT',
          },
          { name: 'CONTEXT_PREFIX', value: prefix, type: 'PLAINTEXT' },
          {
            name: 'ENVIRONMENT_ID',
            value: environment.environmentId,
            type: 'PLAINTEXT',
          },
          {
            name: 'REVISION_ID',
            value: revision.revisionId,
            type: 'PLAINTEXT',
          },
          {
            name: 'IMAGE_REPOSITORY_URI',
            value: process.env.ENVIRONMENT_ECR_REPOSITORY_URI,
            type: 'PLAINTEXT',
          },
          {
            name: 'IMAGE_REPOSITORY_NAME',
            value: process.env.ENVIRONMENT_ECR_REPOSITORY_NAME,
            type: 'PLAINTEXT',
          },
          { name: 'IMAGE_TAG', value: revision.revisionId, type: 'PLAINTEXT' },
        ],
      }),
    );
  } catch (error) {
    const failure = {
      reason: 'image_build_start_failed',
      detail: error.message,
      failedAt: new Date().toISOString(),
    };
    try {
      await store.updateRevision(
        environment.environmentId,
        revision.revisionId,
        { status: 'FAILED', failure },
        { fromStatus: 'QUEUED' },
      );
      await store.updateEnvironment(
        environment.environmentId,
        {
          status: 'FAILED',
        },
        {
          ifCurrentRevisionId: revision.revisionId,
          unlessRetired: true,
        },
      );
    } catch (stateError) {
      console.error('Unable to record environment image build start failure:', stateError.message);
    }
    throw Object.assign(new Error('Unable to start environment image build'), {
      statusCode: 502,
      code: 'IMAGE_BUILD_START_FAILED',
    });
  }
  const build = started.build;
  const updatedRevision = await store.updateRevision(
    environment.environmentId,
    revision.revisionId,
    {
      status: 'BUILDING',
      buildId: build?.id ?? null,
      buildArn: build?.arn ?? null,
      buildLogUrl: build?.logs?.deepLink ?? null,
      failure: null,
    },
    { fromStatus: 'QUEUED' },
  );
  try {
    await store.updateEnvironment(
      environment.environmentId,
      { status: 'BUILDING' },
      {
        ifCurrentRevisionId: revision.revisionId,
        unlessRetired: true,
      },
    );
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
  }
  return {
    environment: await store.getEnvironment(environment.environmentId),
    revision: updatedRevision,
    requestedBy: actor,
  };
};

const cloneOnLatestBase = async ({ store, environment, actor }) => {
  if (environment.status === 'RETIRED') {
    throw Object.assign(new Error('Retired environments cannot be rebuilt'), {
      statusCode: 409,
    });
  }
  const sourceRevisionId = environment.publishedRevisionId ?? environment.currentRevisionId;
  if (!sourceRevisionId) {
    throw Object.assign(new Error('Environment has no recipe to rebuild'), {
      statusCode: 409,
    });
  }
  if (!environment.baseEnvironmentId) {
    throw Object.assign(new Error('The Standard environment follows the core runtime'), {
      statusCode: 409,
    });
  }
  const sourceRevision = await store.getRevision(environment.environmentId, sourceRevisionId);
  if (!sourceRevision?.recipe) {
    throw Object.assign(new Error('Environment recipe is unavailable'), {
      statusCode: 409,
    });
  }
  const { revision: latestBase } = await requirePublishedBaseImage(
    store,
    environment.baseEnvironmentId,
  );
  const { recipe, flattenedRecipe } = rebuildCatalogEnvironmentRecipe({
    sourceRecipe: sourceRevision.recipe,
    baseEnvironmentId: environment.baseEnvironmentId,
    baseRevision: latestBase,
  });
  return store.createRevision({
    environment,
    recipe,
    flattenedRecipe,
    createdBy: actor,
    reason: 'latest-base',
    clearUpdateAvailable: true,
  });
};

export const createHandler = ({
  store = defaultStore,
  toolStore = defaultToolStore,
  s3Client = s3,
  codebuildClient = codebuild,
  ec2Client = ec2,
} = {}) => {
  const deps = { s3: s3Client, codebuild: codebuildClient, ec2: ec2Client, DescribeImagesCommand };
  const initialize = createRetryableInitializer(() => ensureSeeded(store));
  return async (event) => {
    const response = buildResponse(event);
    if (event.httpMethod === 'OPTIONS') return response(200, {});
    const missingUser = requireUser(event);
    if (missingUser) return response(missingUser.statusCode, { error: missingUser.error });
    try {
      await initialize();
      const parts = pathParts(event);
      const environmentIndex = parts.lastIndexOf('environments');
      const tail = environmentIndex >= 0 ? parts.slice(environmentIndex + 1) : [];
      const environmentId = tail[0] ?? null;
      const revisionIndex = tail.indexOf('revisions');
      const revisionId = revisionIndex >= 0 ? tail[revisionIndex + 1] : null;
      const action = tail.at(-1);
      const actor = actorFrom(event);
      const admin = isPlatformAdmin(event);

      if (event.httpMethod === 'GET' && tail.length === 0) {
        const publishedOnly = event.queryStringParameters?.published === 'true' || !admin;
        return response(200, await store.listEnvironments({ publishedOnly }));
      }

      if (event.httpMethod === 'POST' && tail.length === 0) {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        const data = parseBody(event);
        if (!data.name?.trim()) return response(400, { error: 'name is required' });
        const id = normalizeEnvironmentId(data.environmentId || data.name);
        if (id === 'rebuild') {
          return response(400, { error: 'environmentId is reserved by the platform' });
        }
        // An EC2 environment is an AMI plus a machine shape. No recipe, no base
        // environment to inherit tools from, and nothing to build.
        if (String(data.kind ?? 'AGENTCORE').toUpperCase() === 'EC2') {
          assertEc2Configured();
          const validated = validateEc2LaunchSpec(data.launchSpec ?? data);
          if (!validated.valid) {
            return response(400, { error: 'Invalid launch spec', errors: validated.errors });
          }
          const createdEc2 = await store.createEnvironment({
            environmentId: id,
            name: data.name.trim(),
            description: String(data.description ?? '').trim(),
            kind: 'EC2',
            launchSpec: validated.spec,
            createdBy: actor,
          });
          const readied = await readyEc2Revision({
            store,
            environment: createdEc2.environment,
            revision: createdEc2.revision,
            spec: validated.spec,
            deps,
          });
          return response(201, { ...createdEc2, revision: readied });
        }
        const baseEnvironmentId = data.baseEnvironmentId || 'standard';
        await assertAcyclicBase(store, id, baseEnvironmentId);
        const prepared = await prepareCatalogRecipe(
          store,
          toolStore,
          data.recipe,
          baseEnvironmentId,
        );
        const created = await store.createEnvironment({
          environmentId: id,
          name: data.name.trim(),
          description: String(data.description ?? '').trim(),
          baseEnvironmentId,
          recipe: prepared.recipe,
          flattenedRecipe: prepared.flattenedRecipe,
          createdBy: actor,
        });
        return response(201, created);
      }

      if (event.httpMethod === 'POST' && tail.length === 1 && !environmentId) {
        return response(404, { error: 'Environment not found' });
      }

      if (event.httpMethod === 'POST' && environmentId === 'rebuild') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        const data = parseBody(event);
        const all = await store.listEnvironments();
        const selected = Array.isArray(data.environmentIds)
          ? all.filter((item) => data.environmentIds.includes(item.environmentId))
          : all.filter((item) => item.updateAvailable);
        const builds = [];
        for (const environment of orderRebuilds(
          selected.filter((item) => item.baseEnvironmentId),
        )) {
          const revision = await cloneOnLatestBase({
            store,
            environment,
            actor,
          });
          builds.push(
            await startBuild({
              store,
              environment: await store.getEnvironment(environment.environmentId),
              revision,
              actor,
              deps,
            }),
          );
        }
        return response(202, { builds });
      }

      const environment = environmentId ? await store.getEnvironment(environmentId) : null;
      if (!environment) return response(404, { error: 'Environment not found' });

      if (event.httpMethod === 'GET' && tail.length === 1) {
        if (!admin && (!environment.publishedRevisionId || environment.status === 'RETIRED')) {
          return response(404, { error: 'Environment not found' });
        }
        const revisions = admin ? await store.listRevisions(environmentId) : [];
        const publishedRevision = environment.publishedRevisionId
          ? await store.getRevision(environmentId, environment.publishedRevisionId)
          : null;
        return response(200, { environment, revisions, publishedRevision });
      }

      if (event.httpMethod !== 'GET' && environment.status === 'RETIRED') {
        return response(409, {
          error: 'Retired environments cannot be changed',
        });
      }

      if (event.httpMethod === 'PUT' && tail.length === 1) {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (environmentId === 'standard') {
          return response(409, {
            error: 'The Standard environment follows the protected core runtime',
          });
        }
        // An EC2 environment revises its LAUNCH SPEC, not a tool recipe. It must be
        // revisable: an AMI moves (patches, a newer toolchain), and recreating the
        // environment instead would change its id and silently orphan every
        // project's { stageId: environmentId } binding. The new revision gets its
        // own launch template, leaving the published one intact until this revision
        // is published in turn.
        //
        // Falling through to the AGENTCORE path is what must not happen: it would
        // run prepareCatalogRecipe and store launchSpec: undefined, leaving a
        // corrupt DRAFT as currentRevisionId.
        if ((environment.kind ?? 'AGENTCORE') === 'EC2') {
          assertEc2Configured();
          const ec2Data = parseBody(event);
          // The spec lives on the REVISION, not the environment row, so a partial
          // edit — the common case, "same machine shape, new AMI" — has to merge
          // onto the current revision's spec. Reading it off `environment` would
          // silently merge onto undefined and validate a spec missing every field
          // the caller did not resend.
          const currentEc2Revision = environment.currentRevisionId
            ? await store.getRevision(environmentId, environment.currentRevisionId)
            : null;
          const validated = validateEc2LaunchSpec({
            ...currentEc2Revision?.launchSpec,
            ...(ec2Data.launchSpec ?? ec2Data),
          });
          if (!validated.valid) {
            return response(400, { error: 'Invalid launch spec', errors: validated.errors });
          }
          const revised = await store.createRevision({
            environment,
            launchSpec: validated.spec,
            createdBy: actor,
            reason: 'edited',
          });
          const readied = await readyEc2Revision({
            store,
            environment,
            revision: revised,
            spec: validated.spec,
            deps,
          });
          const updatedEc2 = await store.updateEnvironment(environmentId, {
            ...(ec2Data.name?.trim() ? { name: ec2Data.name.trim() } : {}),
            ...(ec2Data.description !== undefined
              ? { description: String(ec2Data.description).trim() }
              : {}),
          });
          return response(200, { environment: updatedEc2, revision: readied });
        }
        assertCatalogRevision(
          environmentId,
          await store.getRevision(environmentId, environment.currentRevisionId),
        );
        const data = parseBody(event);
        const baseEnvironmentId =
          data.baseEnvironmentId || environment.baseEnvironmentId || 'standard';
        await assertAcyclicBase(store, environmentId, baseEnvironmentId);
        const prepared = await prepareCatalogRecipe(
          store,
          toolStore,
          data.recipe,
          baseEnvironmentId,
        );
        const revision = await store.createRevision({
          environment,
          recipe: prepared.recipe,
          flattenedRecipe: prepared.flattenedRecipe,
          createdBy: actor,
        });
        const updated = await store.updateEnvironment(environmentId, {
          ...(data.name?.trim() ? { name: data.name.trim() } : {}),
          ...(data.description !== undefined
            ? { description: String(data.description).trim() }
            : {}),
        });
        return response(200, { environment: updated, revision });
      }

      if (event.httpMethod === 'POST' && action === 'rebuild') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        const revision = await cloneOnLatestBase({ store, environment, actor });
        return response(
          202,
          await startBuild({
            store,
            environment: await store.getEnvironment(environmentId),
            revision,
            actor,
            deps,
          }),
        );
      }

      const effectiveRevisionId =
        revisionId || (action === 'build' ? environment.currentRevisionId : null);
      const revision = effectiveRevisionId
        ? await store.getRevision(environmentId, effectiveRevisionId)
        : null;

      if (event.httpMethod === 'GET' && revisionId && action === revisionId) {
        if (!admin && revisionId !== environment.publishedRevisionId) {
          return response(404, { error: 'Revision not found' });
        }
        return revision ? response(200, revision) : response(404, { error: 'Revision not found' });
      }

      if (event.httpMethod === 'GET' && action === 'logs') {
        if (!admin)
          return response(403, {
            error: 'Platform administrator access required',
          });
        return revision
          ? response(200, {
              buildId: revision.buildId,
              buildLogUrl: revision.buildLogUrl,
              failure: revision.failure,
              scanFindings: revision.scanFindings,
              verification: revision.verification,
            })
          : response(404, { error: 'Revision not found' });
      }

      if (event.httpMethod === 'POST' && action === 'build') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (!revision) return response(404, { error: 'Revision not found' });
        assertCatalogRevision(environmentId, revision);
        if (environment.updateAvailable) {
          return response(409, {
            error: 'A newer base is available; rebuild on the latest base',
            code: 'BASE_UPDATE_AVAILABLE',
          });
        }
        return response(202, await startBuild({ store, environment, revision, actor, deps }));
      }

      if (event.httpMethod === 'POST' && action === 'retry') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (!revision) return response(404, { error: 'Revision not found' });
        assertCatalogRevision(environmentId, revision);
        if (environment.updateAvailable) {
          return response(409, {
            error: 'A newer base is available; rebuild on the latest base',
            code: 'BASE_UPDATE_AVAILABLE',
          });
        }
        if (revision.status !== 'FAILED') {
          return response(409, {
            error: 'Only failed revisions can be retried',
          });
        }
        const replacement = await store.createRevision({
          environment,
          recipe: revision.recipe,
          flattenedRecipe: revision.flattenedRecipe,
          createdBy: actor,
          reason: 'retry',
        });
        return response(
          202,
          await startBuild({
            store,
            environment: await store.getEnvironment(environmentId),
            revision: replacement,
            actor,
            deps,
          }),
        );
      }

      if (event.httpMethod === 'POST' && action === 'acknowledge') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (!revision) return response(404, { error: 'Revision not found' });
        const legacySecurityFailure =
          revision.status === 'FAILED' &&
          revision.failure?.reason === 'critical_vulnerability_findings' &&
          Boolean(revision.imageDigest);
        if (revision.status !== 'SECURITY_REVIEW' && !legacySecurityFailure) {
          return response(409, {
            error: 'Revision is not awaiting security findings acceptance',
          });
        }
        const acceptedAt = new Date().toISOString();
        const acceptance = {
          securityFindingsAcceptedAt: acceptedAt,
          securityFindingsAcceptedBy: actor,
        };
        let acknowledged;
        try {
          acknowledged = await store.updateRevision(
            environmentId,
            revision.revisionId,
            {
              ...(legacySecurityFailure ? { status: 'SECURITY_REVIEW', failure: null } : {}),
              ...acceptance,
            },
            { fromStatus: revision.status },
          );
        } catch (error) {
          if (!legacySecurityFailure || error?.name !== 'ConditionalCheckFailedException') {
            throw error;
          }
          const latest = await store.getRevision(environmentId, revision.revisionId);
          if (latest?.status !== 'SECURITY_REVIEW') throw error;
          acknowledged = await store.updateRevision(
            environmentId,
            revision.revisionId,
            acceptance,
            { fromStatus: 'SECURITY_REVIEW' },
          );
        }
        let updatedEnvironment = environment;
        if (legacySecurityFailure && environment.currentRevisionId === revision.revisionId) {
          try {
            updatedEnvironment = await store.updateEnvironment(
              environmentId,
              { status: 'SECURITY_REVIEW' },
              {
                ifCurrentRevisionId: revision.revisionId,
                unlessRetired: true,
              },
            );
          } catch (error) {
            if (error?.name !== 'ConditionalCheckFailedException') throw error;
          }
        }
        return response(202, {
          environment: updatedEnvironment,
          revision: acknowledged,
          pending: true,
        });
      }

      if (event.httpMethod === 'POST' && action === 'publish') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (!revision) return response(404, { error: 'Revision not found' });
        assertCatalogRevision(environmentId, revision);
        if (revision.status !== 'READY') {
          return response(409, {
            error: 'Only READY revisions can be published',
          });
        }
        if (environmentId !== 'standard' && revision.recipe?.base?.environmentId) {
          await assertAcyclicBase(store, environmentId, revision.recipe.base.environmentId);
        }
        const published = await store.publishRevision({
          environment,
          revision,
          actor,
        });
        const dependents = await store.markDependentsUpdateAvailable(
          environmentId,
          revision.revisionId,
        );
        return response(200, { ...published, dependents });
      }

      if (
        (event.httpMethod === 'POST' && action === 'retire') ||
        (event.httpMethod === 'DELETE' && tail.length === 1)
      ) {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (environmentId === 'standard') {
          return response(409, {
            error: 'The Standard environment cannot be retired',
          });
        }
        if (['BUILDING', 'VERIFYING'].includes(environment.status)) {
          return response(409, {
            error: 'Wait for active environment validation to finish before retiring',
          });
        }
        const retired = await store.updateEnvironment(environmentId, {
          status: 'RETIRED',
          retiredAt: new Date().toISOString(),
          retiredBy: actor,
        });
        return response(200, retired);
      }

      return response(405, { error: 'Method not allowed' });
    } catch (error) {
      console.error('Managed environment request failed:', error.message);
      return responseError(response, error);
    }
  };
};

export const handler = createHandler();

export { startBuild, cloneOnLatestBase, prepareCatalogRecipe, assertAcyclicBase };
