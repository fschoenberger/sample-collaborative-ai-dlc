import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { intentsService } from '@/services/intents';
import { trackersService, type TrackerIssue } from '@/services/trackers';
import { projectsService, type TrackerBinding } from '@/services/projects';
import { environmentsService, type ManagedEnvironment } from '@/services/environments';
import { environmentKindOf } from '@/lib/environmentKind';
import { blocksService } from '@/services/blocks';
import { sourceControlService } from '@/services/sourceControl';
import {
  StageEnvironmentOverrides,
  type StageOption,
} from '@/components/project-settings/StageEnvironmentOverrides';
import {
  requiresComputeOf,
  stageEnvironmentDelta,
  type StageEnvironmentMap,
} from '@/lib/stageEnvironments';
import type { Ec2LaunchSpec } from '@/lib/ec2LaunchSpec';
import { buildSprintDescription } from '@/lib/buildSprintDescription';
import { formatTrackerSourceLabel } from '@/lib/trackerSourceLabel';
import { IntentSourcePicker } from '@/components/IntentSourcePicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, ArrowLeft, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';

// Step one of intent creation: capture the seed (title/prompt/tracker import/
// base branch) and create the intent as a DRAFT immediately. Everything else —
// the shared prompt refinement, the scope / composed-grid selection, stage
// deselection and Start — happens on the COLLABORATIVE compose page the user
// lands on next (IntentComposePage), so teammates can join the draft live.
export default function NewIntentPage() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const { project, loading: projectLoading } = useProjectCache(projectId ?? null);

  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [source, setSource] = useState<{
    binding: TrackerBinding;
    issue: TrackerIssue;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Base branch (per repo): optional, defaults to each repo's own default
  // branch. Collapsed by default — most intents just want the default. It is
  // create-time only (the branch is derived at create), so it lives here and
  // not on the compose page.
  const [showBaseBranch, setShowBaseBranch] = useState(false);
  const [baseBranchSelections, setBaseBranchSelections] = useState<Record<string, string>>({});
  const [branchOptions, setBranchOptions] = useState<Record<string, string[]>>({});
  const [branchDefaults, setBranchDefaults] = useState<Record<string, string>>({});
  const [branchLoading, setBranchLoading] = useState<Record<string, boolean>>({});
  const [branchLoadError, setBranchLoadError] = useState<Record<string, string>>({});

  // Where stages run. The space holds a default plus a per-stage map; this run may
  // adjust the map, and intent creation snapshots the result. The map is fetched
  // eagerly (one request) so the collapsed header can say whether anything is
  // inherited at all; the environment list and stage catalogue — needed only to
  // EDIT it — wait until the section is opened.
  const [showEnvironments, setShowEnvironments] = useState(false);
  const [defaultEnvironmentName, setDefaultEnvironmentName] = useState<string | null>(null);
  const [inheritedStageEnvironments, setInheritedStageEnvironments] = useState<StageEnvironmentMap>(
    {},
  );
  const [stageEnvironments, setStageEnvironments] = useState<StageEnvironmentMap>({});
  const [environments, setEnvironments] = useState<ManagedEnvironment[]>([]);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [launchSpecs, setLaunchSpecs] = useState<Record<string, Ec2LaunchSpec | null>>({});
  const [environmentsLoading, setEnvironmentsLoading] = useState(false);

  const hasTrackers = (project?.trackers.length ?? 0) > 0;
  const repos = project?.repos ?? [];

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    projectsService
      .getEnvironment(projectId)
      .then((assignment) => {
        if (!active) return;
        setDefaultEnvironmentName(assignment.environment?.name ?? assignment.environmentId);
        setInheritedStageEnvironments(assignment.stageEnvironments ?? {});
        setStageEnvironments(assignment.stageEnvironments ?? {});
      })
      .catch(() => {
        // Placement is optional at create: a run with no adjustments is the
        // common case, so a failure here must not block the draft.
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!showEnvironments || environments.length > 0 || environmentsLoading) return;
    setEnvironmentsLoading(true);
    Promise.all([
      environmentsService.list(true),
      blocksService.list('stage').catch(() => ({ blocks: [] })),
    ])
      .then(([available, stageBlocks]) => {
        setEnvironments(available);
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
      .catch(() => undefined)
      .finally(() => setEnvironmentsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- environments/loading read for dedupe only
  }, [showEnvironments]);

  // Launch specs for the EC2 environments this run binds, for the advisory only.
  useEffect(() => {
    const ec2Ids = [...new Set(Object.values(stageEnvironments))].filter(
      (environmentId) =>
        environmentKindOf(environments.find((item) => item.environmentId === environmentId)) ===
        'EC2',
    );
    let active = true;
    for (const environmentId of ec2Ids) {
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
          if (active) setLaunchSpecs((current) => ({ ...current, [environmentId]: null }));
        });
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- launchSpecs read for dedupe only
  }, [environments, stageEnvironments]);

  // Lazily fetch each repo's branch list (+ its actual default branch) the
  // first time the base-branch picker is expanded — most intents never open
  // it, so there is no reason to hit the git provider on every page load.
  useEffect(() => {
    if (!showBaseBranch || !project || repos.length === 0) return;
    for (const repo of repos) {
      if (branchOptions[repo.url] || branchLoading[repo.url]) continue;
      setBranchLoading((prev) => ({ ...prev, [repo.url]: true }));
      sourceControlService
        .listBranches(project.id, repo.provider || project.gitProvider, repo.url)
        .then(({ branches, defaultBranch }) => {
          setBranchOptions((prev) => ({ ...prev, [repo.url]: branches }));
          if (defaultBranch) {
            setBranchDefaults((prev) => ({ ...prev, [repo.url]: defaultBranch }));
          }
        })
        .catch((e) => {
          setBranchLoadError((prev) => ({
            ...prev,
            [repo.url]: e instanceof Error ? e.message : 'Failed to load branches',
          }));
        })
        .finally(() => {
          setBranchLoading((prev) => ({ ...prev, [repo.url]: false }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- branchOptions/branchLoading read for dedupe only
  }, [showBaseBranch, project, repos]);

  const handleSelectIssue = useCallback(
    async (issue: TrackerIssue, binding: TrackerBinding) => {
      if (!projectId) return;
      setSource({ binding, issue });
      setTitle(issue.title);
      setImporting(true);
      setError(null);
      try {
        let comments: Awaited<ReturnType<typeof trackersService.listComments>> = [];
        try {
          comments = await trackersService.listComments(projectId, binding.id, issue.resourceId);
        } catch {
          // Comments are a best-effort enrichment — fall back to the body alone.
        }
        setPrompt(buildSprintDescription(issue, comments));
      } finally {
        setImporting(false);
      }
    },
    [projectId],
  );

  const clearSource = () => setSource(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!title.trim() && !prompt.trim()) || !projectId) return;
    setCreating(true);
    setError(null);
    try {
      const baseBranches = Object.fromEntries(
        Object.entries(baseBranchSelections).filter(([, branch]) => branch),
      );
      // Only the DELTA against the space's map travels: an untouched run sends
      // nothing and inherits, and a stage this run took back to the default
      // travels as an explicit null (which is how the server removes it).
      const stageDelta = stageEnvironmentDelta(inheritedStageEnvironments, stageEnvironments);
      // Scope is deliberately omitted — the server defaults it and the compose
      // page is where the projection is actually chosen (collaboratively).
      const intent = await intentsService.create(projectId, {
        title: title.trim(),
        prompt: prompt.trim(),
        baseBranches: Object.keys(baseBranches).length ? baseBranches : undefined,
        stageEnvironments: Object.keys(stageDelta).length ? stageDelta : undefined,
        source: source
          ? {
              bindingId: source.binding.id,
              resourceType: source.issue.resourceType,
              resourceId: source.issue.resourceId,
              resourceUrl: source.issue.resourceUrl,
            }
          : undefined,
      });
      navigate(`/space/${projectId}/intent/${intent.id}/compose`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create intent');
    } finally {
      setCreating(false);
    }
  };

  const overrideCount = Object.keys(inheritedStageEnvironments).length;
  const stageChanges = Object.keys(
    stageEnvironmentDelta(inheritedStageEnvironments, stageEnvironments),
  ).length;

  if (projectLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    );
  }

  if (!project) {
    return <div className="text-sm text-destructive">Space not found</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/space/${projectId}`)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          <div className="h-5 w-px bg-border" />
          <h1 className="text-xl font-semibold tracking-tight">New Intent</h1>
        </div>

        {error && (
          <div className="bg-destructive/5 border border-destructive/20 text-destructive px-4 py-3 rounded-md flex items-start justify-between gap-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive hover:text-destructive"
              onClick={() => setError(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        <div className={hasTrackers ? 'grid gap-6 lg:grid-cols-[1fr_1fr]' : 'flex justify-center'}>
          {hasTrackers && (
            <Card className="lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto">
              <CardContent className="p-4 space-y-3">
                <Label className="text-sm font-medium">Import from tracker</Label>
                <IntentSourcePicker
                  project={project}
                  selected={
                    source
                      ? { bindingId: source.binding.id, resourceId: source.issue.resourceId }
                      : null
                  }
                  onSelect={handleSelectIssue}
                />
              </CardContent>
            </Card>
          )}

          <form
            onSubmit={handleSubmit}
            className={hasTrackers ? 'space-y-4' : 'w-full max-w-lg space-y-4'}
          >
            {source && (
              <Badge variant="secondary" className="gap-1.5 text-xs">
                {source.issue.resourceUrl ? (
                  <a
                    href={source.issue.resourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {formatTrackerSourceLabel({
                      provider: source.binding.provider,
                      resourceId: source.issue.resourceId,
                      entityType: source.issue.entityType,
                    })}
                  </a>
                ) : (
                  formatTrackerSourceLabel({
                    provider: source.binding.provider,
                    resourceId: source.issue.resourceId,
                    entityType: source.issue.entityType,
                  })
                )}
                <button
                  type="button"
                  onClick={clearSource}
                  className="ml-0.5 rounded-sm hover:bg-muted p-0.5"
                  aria-label="Clear source"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}

            <div>
              <Label htmlFor="intent-title">Title</Label>
              <Input
                id="intent-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Add user authentication"
                className="mt-1.5"
                autoFocus
              />
            </div>

            <div>
              <Label htmlFor="intent-prompt">
                Prompt
                {importing && (
                  <span className="ml-2 text-xs text-muted-foreground">Importing issue…</span>
                )}
              </Label>
              <textarea
                id="intent-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={10}
                placeholder="Describe the intent — you can refine it together on the next step…"
                className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>

            {repos.length > 0 && (
              <div className="border rounded-md">
                <button
                  type="button"
                  onClick={() => setShowBaseBranch((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-2 text-sm font-medium"
                >
                  {showBaseBranch ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  Base branch
                  <span className="text-xs text-muted-foreground font-normal">
                    (optional — defaults to each repo's own default branch)
                  </span>
                </button>
                {showBaseBranch && (
                  <div className="px-3 pb-3 space-y-3">
                    {repos.map((repo) => {
                      const options = branchOptions[repo.url];
                      const defaultBranch = branchDefaults[repo.url];
                      return (
                        <div key={repo.url}>
                          <Label htmlFor={`base-branch-${repo.url}`} className="text-xs">
                            {repo.url}
                          </Label>
                          {branchLoadError[repo.url] ? (
                            <p className="mt-1.5 text-xs text-destructive">
                              Couldn't load branches: {branchLoadError[repo.url]} — will use the
                              repo's default branch.
                            </p>
                          ) : (
                            <Select
                              value={baseBranchSelections[repo.url] ?? ''}
                              onValueChange={(v) =>
                                setBaseBranchSelections((prev) => ({ ...prev, [repo.url]: v }))
                              }
                              disabled={branchLoading[repo.url] || !options}
                            >
                              <SelectTrigger id={`base-branch-${repo.url}`} className="mt-1.5">
                                <SelectValue
                                  placeholder={
                                    branchLoading[repo.url]
                                      ? 'Loading branches…'
                                      : `Default${defaultBranch ? ` (${defaultBranch})` : ''}`
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {(options ?? []).map((b) => (
                                  <SelectItem key={b} value={b}>
                                    {b}
                                    {b === defaultBranch ? ' (default)' : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="border rounded-md">
              <button
                type="button"
                onClick={() => setShowEnvironments((v) => !v)}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-sm font-medium"
              >
                {showEnvironments ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Where stages run
                <span className="text-xs text-muted-foreground font-normal">
                  {overrideCount === 0
                    ? `(every stage on ${defaultEnvironmentName ?? 'the space default'})`
                    : `(${overrideCount} stage${overrideCount === 1 ? '' : 's'} bound elsewhere)`}
                </span>
                {stageChanges > 0 && (
                  <Badge variant="secondary" className="ml-auto text-[10px]">
                    {stageChanges} change{stageChanges === 1 ? '' : 's'} for this run
                  </Badge>
                )}
              </button>
              {showEnvironments && (
                <div className="px-3 pb-3 space-y-3">
                  <p className="text-[11px] text-muted-foreground">
                    Rows come from the space's settings. Changes here apply to this run only and are
                    snapshotted when the intent is created.
                  </p>
                  {environmentsLoading ? (
                    <Skeleton className="h-24" />
                  ) : (
                    <StageEnvironmentOverrides
                      stages={stages}
                      environments={environments}
                      launchSpecs={launchSpecs}
                      value={stageEnvironments}
                      onChange={setStageEnvironments}
                      inherited={inheritedStageEnvironments}
                      disabled={creating}
                    />
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(`/space/${projectId}`)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating || (!title.trim() && !prompt.trim())}>
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                {creating ? 'Creating…' : 'Continue to Compose'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
