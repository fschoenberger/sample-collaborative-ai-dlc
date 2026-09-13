// What a stage runs ON, and the one rule that follows from it.
//
// AGENTCORE is a container image composed from the tool catalogue; EC2 is an
// operator-supplied AMI plus a machine shape, with nothing built and therefore no
// build/scan/verify states.
//
// This lives in lib rather than in services/environments because it is a rule, not
// a request: the AGENTCORE-default invariant is load-bearing enough that component
// tests should exercise it directly instead of re-declaring it in a service mock.

export const ENVIRONMENT_KINDS = ['AGENTCORE', 'EC2'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];
export const DEFAULT_ENVIRONMENT_KIND: EnvironmentKind = 'AGENTCORE';

/** Environments created before EC2 support carry no `kind`; they are AgentCore. */
export const environmentKindOf = (
  environment: { kind?: EnvironmentKind | null } | null | undefined,
): EnvironmentKind => environment?.kind ?? DEFAULT_ENVIRONMENT_KIND;

/**
 * May this environment be a project (and therefore intent) DEFAULT?
 *
 * Mirrors shared/environment-snapshot.js isDefaultableEnvironment. Several
 * operations are not stages, never go through the scheduler, and resolve their
 * runtime straight off the default — init-ws, promote-units, derive-artifacts,
 * discussion assist, compose proposals. An EC2 environment has no runtime for them
 * to invoke, so it is bindable only as a per-stage override. The server answers
 * ENVIRONMENT_KIND_NOT_DEFAULTABLE (409) when this is violated.
 */
export const isDefaultableEnvironment = (
  environment: { kind?: EnvironmentKind | null } | null | undefined,
) => environmentKindOf(environment) !== 'EC2';
