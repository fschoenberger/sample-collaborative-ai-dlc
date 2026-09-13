import { AlertTriangle, Plus, RotateCcw, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ManagedEnvironment } from '@/services/environments';
import { environmentKindOf } from '@/lib/environmentKind';
import {
  MAX_STAGE_BINDINGS,
  satisfiesRequiresCompute,
  type RequiresCompute,
  type StageEnvironmentMap,
} from '@/lib/stageEnvironments';
import type { Ec2LaunchSpec } from '@/lib/ec2LaunchSpec';

// The per-stage environment binding map, as an editor.
//
// Used in two places with the same shape: a space's Environment settings (where
// there is nothing to inherit) and intent creation (where the space's map IS the
// inheritance and every change applies to one run). The difference is entirely
// carried by `inherited` — pass it and rows gain provenance, omit it and the map
// is simply the value.
//
// Clearing is not the same as deleting. A row the caller inherited stays visible
// after it is cleared, because "this stage runs on the default for this run" is a
// decision someone made and needs to be able to undo; a row they added themselves
// just disappears.

export interface StageOption {
  stageId: string;
  name: string;
  requiresCompute: RequiresCompute | null;
}

interface Props {
  stages: StageOption[];
  environments: ManagedEnvironment[];
  /** Published launch specs by environment id, for the requiresCompute advisory. */
  launchSpecs?: Record<string, Ec2LaunchSpec | null | undefined>;
  value: StageEnvironmentMap;
  onChange: (next: StageEnvironmentMap) => void;
  /** The map being overridden, when there is one (intent creation). */
  inherited?: StageEnvironmentMap;
  disabled?: boolean;
}

const stageLabel = (stages: StageOption[], stageId: string) =>
  stages.find((stage) => stage.stageId === stageId)?.name ?? stageId;

const environmentLabel = (environments: ManagedEnvironment[], environmentId: string) =>
  environments.find((item) => item.environmentId === environmentId)?.name ?? environmentId;

export function StageEnvironmentOverrides({
  stages,
  environments,
  launchSpecs = {},
  value,
  onChange,
  inherited,
  disabled = false,
}: Props) {
  const inheritedMap = inherited ?? {};
  // Rows the caller inherited stay listed even once cleared, so the clearing is
  // visible and reversible rather than looking like nothing happened.
  const rowStageIds = [...new Set([...Object.keys(inheritedMap), ...Object.keys(value)])].toSorted(
    (a, b) => stageLabel(stages, a).localeCompare(stageLabel(stages, b)),
  );
  const boundStageIds = new Set(rowStageIds);
  const addableStages = stages.filter((stage) => !boundStageIds.has(stage.stageId));
  const atCap = rowStageIds.length >= MAX_STAGE_BINDINGS;

  const bind = (stageId: string, environmentId: string) =>
    onChange({ ...value, [stageId]: environmentId });

  const clear = (stageId: string) => {
    const next = { ...value };
    delete next[stageId];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium">Per-stage overrides</h4>
        {rowStageIds.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {rowStageIds.length} of {MAX_STAGE_BINDINGS}
          </span>
        )}
      </div>

      {rowStageIds.length === 0 ? (
        <p className="rounded border border-dashed px-3 py-4 text-[11px] text-muted-foreground">
          Every stage runs on the default environment.
        </p>
      ) : (
        <div className="divide-y rounded border">
          {rowStageIds.map((stageId) => {
            const stage = stages.find((item) => item.stageId === stageId) ?? null;
            const bound = value[stageId] ?? null;
            const inheritedId = inheritedMap[stageId] ?? null;
            const cleared = Boolean(inheritedId) && bound === null;
            const changed = Boolean(inherited) && bound !== inheritedId;
            const environment = environments.find((item) => item.environmentId === bound) ?? null;
            const advisory = bound
              ? satisfiesRequiresCompute(stage?.requiresCompute, {
                  launchSpec:
                    environmentKindOf(environment) === 'EC2' ? (launchSpecs[bound] ?? null) : null,
                })
              : { satisfied: true, reasons: [] };
            return (
              <div key={stageId} className="space-y-2 p-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-medium">{stage?.name ?? stageId}</span>
                      {inherited &&
                        (changed ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {cleared ? 'Cleared for this run' : 'Overridden for this run'}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            Inherited
                          </Badge>
                        ))}
                    </div>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {stageId}
                      {cleared && inheritedId
                        ? ` · space binds ${environmentLabel(environments, inheritedId)}`
                        : ''}
                    </span>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    {cleared ? (
                      <>
                        <Badge variant="outline" className="text-[10px]">
                          Default environment
                        </Badge>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          aria-label={`Restore ${stage?.name ?? stageId}`}
                          disabled={disabled}
                          onClick={() => bind(stageId, inheritedId!)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Select
                          value={bound ?? ''}
                          disabled={disabled}
                          onValueChange={(environmentId) => bind(stageId, environmentId)}
                        >
                          <SelectTrigger
                            aria-label={`Environment for ${stage?.name ?? stageId}`}
                            className="h-8 w-56 text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {environments.map((item) => (
                              <SelectItem key={item.environmentId} value={item.environmentId}>
                                {item.name}
                                {environmentKindOf(item) === 'EC2' ? ' · EC2' : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          aria-label={`Remove override for ${stage?.name ?? stageId}`}
                          disabled={disabled}
                          onClick={() => clear(stageId)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {!advisory.satisfied && (
                  <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {environmentLabel(environments, bound ?? '')} may not suit this stage:{' '}
                    {advisory.reasons.join('; ')}. This is advisory — the binding is still used.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="stage-environment-add" className="text-xs">
          Add an override
        </Label>
        <div className="flex items-center gap-2">
          <Select
            value=""
            disabled={disabled || atCap || addableStages.length === 0}
            onValueChange={(stageId) => {
              const fallback = environments[0]?.environmentId;
              if (fallback) bind(stageId, fallback);
            }}
          >
            <SelectTrigger
              id="stage-environment-add"
              aria-label="Stage"
              className="h-8 w-64 text-xs"
            >
              <SelectValue placeholder={atCap ? 'Binding limit reached' : 'Pick a stage'} />
            </SelectTrigger>
            <SelectContent>
              {addableStages.map((stage) => (
                <SelectItem key={stage.stageId} value={stage.stageId}>
                  {stage.name}
                  {stage.requiresCompute ? ' · needs specific compute' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}
