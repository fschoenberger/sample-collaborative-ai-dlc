import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, Check, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsCard } from '@/components/settings/SettingsCard';
import {
  environmentsService,
  type EnvironmentDetail,
  type ManagedEnvironment,
  type ProjectEnvironmentAssignment,
} from '@/services/environments';
import { environmentKindOf, isDefaultableEnvironment } from '@/lib/environmentKind';
import { blocksService } from '@/services/blocks';
import { projectsService, type Project } from '@/services/projects';
import {
  StageEnvironmentOverrides,
  type StageOption,
} from '@/components/project-settings/StageEnvironmentOverrides';
import {
  requiresComputeOf,
  validateStageEnvironments,
  type StageEnvironmentMap,
} from '@/lib/stageEnvironments';
import type { Ec2LaunchSpec } from '@/lib/ec2LaunchSpec';

interface Props {
  project: Project;
  canEdit: boolean;
  onProjectUpdated: (updates: Partial<Project>) => void;
}

const sameMap = (a: StageEnvironmentMap, b: StageEnvironmentMap) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
};

const includedTools = (detail: EnvironmentDetail | null) => {
  const recipe = detail?.publishedRevision?.flattenedRecipe;
  if (!recipe) return [];
  if (recipe.schemaVersion === 2) {
    return [
      { name: 'node', version: 'protected' },
      { name: 'python', version: 'protected' },
      ...(recipe.resolvedTools ?? recipe.tools).map((tool) => ({
        name: tool.toolId,
        version: tool.version,
      })),
    ];
  }
  return [...Object.entries(recipe.tools), ...Object.entries(recipe.buildTools)].map(
    ([name, spec]) => ({ name, version: spec.version }),
  );
};

const compatibilityWarnings = (project: Project, detail: EnvironmentDetail | null) => {
  const recipe = detail?.publishedRevision?.flattenedRecipe;
  if (!recipe) return [];
  const available =
    recipe.schemaVersion === 2
      ? new Set([
          'node',
          'python',
          ...(recipe.resolvedTools ?? recipe.tools).map((tool) => tool.toolId),
        ])
      : new Set([...Object.keys(recipe.tools), ...Object.keys(recipe.buildTools)]);
  const stacks = (project.repos ?? [])
    .map((repo) => repo.detectedStack ?? '')
    .join(' ')
    .toLowerCase();
  const requirements: [RegExp, string, string][] = [
    [/\b(node|javascript|typescript|react|vue|angular)\b/, 'node', 'Node.js'],
    [/\bpython\b/, 'python', 'Python'],
    [/\b(java|kotlin|spring)\b/, 'java', 'Java'],
    [/\bmaven\b/, 'maven', 'Maven'],
    [/\bgradle\b/, 'gradle', 'Gradle'],
    [/\bgolang\b|\bgo\b/, 'go', 'Go'],
    [/\brust\b|\bcargo\b/, 'rust', 'Rust'],
    [/(?:\.net\b|\bdotnet\b|\bcsharp\b|\basp\.net\b)/, 'dotnet-sdk', '.NET'],
  ];
  return requirements
    .filter(([pattern, tool]) => pattern.test(stacks) && !available.has(tool))
    .map(([, , label]) => `${label} is detected in a repository but is not included.`);
};

export function EnvironmentTab({ project, canEdit, onProjectUpdated }: Props) {
  const [environments, setEnvironments] = useState<ManagedEnvironment[]>([]);
  const [assignment, setAssignment] = useState<ProjectEnvironmentAssignment | null>(null);
  const [selectedId, setSelectedId] = useState(project.environmentId ?? 'standard');
  const [stageEnvironments, setStageEnvironments] = useState<StageEnvironmentMap>({});
  const [stages, setStages] = useState<StageOption[]>([]);
  // Published launch specs, keyed by environment id, fetched only for the EC2
  // environments the map actually references — the requiresCompute advisory needs
  // the machine shape, and an AgentCore environment has none to fetch.
  const [launchSpecs, setLaunchSpecs] = useState<Record<string, Ec2LaunchSpec | null>>({});
  const [detail, setDetail] = useState<EnvironmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      environmentsService.list(true),
      projectsService.getEnvironment(project.id),
      // The stage catalogue, for labels and for the advisory `requiresCompute`
      // hint. Bindings are keyed by stage id rather than by a workflow placement,
      // so the catalogue — not one workflow — is the right list to offer.
      blocksService.list('stage').catch(() => ({ blocks: [] })),
    ])
      .then(([available, current, stageBlocks]) => {
        if (!active) return;
        setEnvironments(available);
        setAssignment(current);
        setSelectedId(current.environmentId || 'standard');
        setStageEnvironments(current.stageEnvironments ?? {});
        setStages(
          (stageBlocks.blocks ?? [])
            .map((block) => ({
              stageId: block.blockId,
              name: block.name || block.blockId,
              requiresCompute: requiresComputeOf(block.requiresCompute),
            }))
            .toSorted((a, b) => a.name.localeCompare(b.name)),
        );
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load environments');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [project.id]);

  const boundEc2Ids = useMemo(
    () =>
      [...new Set(Object.values(stageEnvironments))].filter(
        (environmentId) =>
          environmentKindOf(environments.find((item) => item.environmentId === environmentId)) ===
          'EC2',
      ),
    [environments, stageEnvironments],
  );

  useEffect(() => {
    let active = true;
    for (const environmentId of boundEc2Ids) {
      if (environmentId in launchSpecs) continue;
      void environmentsService
        .get(environmentId)
        .then((value) => {
          if (active) {
            setLaunchSpecs((current) => ({
              ...current,
              [environmentId]: value.publishedRevision?.launchSpec ?? null,
            }));
          }
        })
        .catch(() => {
          // A spec we cannot read only costs the advisory, never the binding.
          if (active) setLaunchSpecs((current) => ({ ...current, [environmentId]: null }));
        });
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- launchSpecs read for dedupe only
  }, [boundEc2Ids]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setDetailLoading(true);
    environmentsService
      .get(selectedId)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load environment');
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const tools = useMemo(() => includedTools(detail), [detail]);
  const warnings = useMemo(() => compatibilityWarnings(project, detail), [project, detail]);
  // Only AGENTCORE environments are offered as the default: several non-stage
  // operations (init-ws, derive-artifacts, discussion assist…) resolve their
  // runtime straight off it, and an EC2 environment has none for them to invoke.
  // The server enforces the same rule with ENVIRONMENT_KIND_NOT_DEFAULTABLE.
  const defaultOptions = useMemo(
    () => environments.filter((environment) => isDefaultableEnvironment(environment)),
    [environments],
  );
  const changed =
    selectedId !== (assignment?.environmentId ?? project.environmentId ?? 'standard') ||
    !sameMap(stageEnvironments, assignment?.stageEnvironments ?? {});

  const save = async () => {
    const invalid = validateStageEnvironments(stageEnvironments);
    if (invalid.length > 0) {
      setError(invalid[0]);
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = await projectsService.assignEnvironment(
        project.id,
        selectedId,
        stageEnvironments,
      );
      setAssignment(next);
      setStageEnvironments(next.stageEnvironments ?? {});
      onProjectUpdated({ environmentId: next.environmentId });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign environment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={<Boxes />}
      title="Environment"
      badge={
        assignment?.revision ? (
          <Badge variant="outline" className="font-mono text-[10px]">
            {assignment.revision.revisionId}
          </Badge>
        ) : null
      }
      description="Default runtime for newly created intents, plus where individual stages run."
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          <Select value={selectedId} onValueChange={setSelectedId} disabled={!canEdit || saving}>
            <SelectTrigger aria-label="Environment" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {defaultOptions.map((environment) => (
                <SelectItem key={environment.environmentId} value={environment.environmentId}>
                  {environment.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            The default must be an AgentCore environment — EC2 environments are bindable to
            individual stages only.
          </p>

          {detailLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : detail?.publishedRevision ? (
            <div className="space-y-3 border-t pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">{detail.environment.name}</span>
                <Badge variant="secondary" className="text-[10px]">
                  compatibility {detail.publishedRevision.runtimeCompatibilityVersion}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tools.map((tool) => (
                  <Badge key={tool.name} variant="outline" className="font-mono text-[10px]">
                    {tool.name} {tool.version}
                  </Badge>
                ))}
              </div>
              <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Revision</dt>
                  <dd className="break-all font-mono">{detail.publishedRevision.revisionId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Image digest</dt>
                  <dd
                    className="truncate font-mono"
                    title={detail.publishedRevision.imageDigest ?? ''}
                  >
                    {detail.publishedRevision.imageDigest ?? 'Unavailable'}
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}

          <div className="border-t pt-4">
            <StageEnvironmentOverrides
              stages={stages}
              environments={environments}
              launchSpecs={launchSpecs}
              value={stageEnvironments}
              onChange={setStageEnvironments}
              disabled={!canEdit || saving}
            />
          </div>

          {warnings.length > 0 && (
            <div className="space-y-1.5 border-l-2 border-amber-500/60 pl-3">
              {warnings.map((warning) => (
                <p
                  key={warning}
                  className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {warning}
                </p>
              ))}
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          {canEdit && (
            <Button size="sm" onClick={save} disabled={!changed || saving} className="gap-1.5">
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : saved ? (
                <Check className="h-3.5 w-3.5" />
              ) : null}
              {saving ? 'Saving' : saved ? 'Saved' : 'Assign Environment'}
            </Button>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
