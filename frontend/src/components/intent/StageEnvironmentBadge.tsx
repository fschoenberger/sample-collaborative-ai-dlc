import { Cpu } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { IntentEnvironmentSnapshot } from '@/services/intents';

// Where a stage ran, when that is not where the rest of the run ran.
//
// The execution record carries a snapshot per bound stage. A stage on the intent
// default needs no badge — that is the whole run's environment and is already
// shown once, in the configuration dialog — so this renders only for stages that
// were placed somewhere else, which is exactly the surprising case.

export const stageEnvironmentLabel = (snapshot: IntentEnvironmentSnapshot) =>
  snapshot.kind === 'EC2'
    ? `${snapshot.name} · ${snapshot.launchSpec?.instanceTypes?.[0] ?? snapshot.launchSpec?.instanceFamilies?.[0] ?? 'EC2'}`
    : snapshot.name;

export function StageEnvironmentBadge({
  snapshot,
  defaultEnvironmentId,
  className,
}: {
  snapshot: IntentEnvironmentSnapshot | null | undefined;
  defaultEnvironmentId: string | null | undefined;
  className?: string;
}) {
  if (!snapshot || snapshot.environmentId === defaultEnvironmentId) return null;
  const detail = [
    snapshot.environmentId,
    `revision ${snapshot.revisionId}`,
    snapshot.kind === 'EC2' && snapshot.launchSpec
      ? `${snapshot.launchSpec.platform}/${snapshot.launchSpec.architecture}`
      : null,
    snapshot.launchTemplateId
      ? `template ${snapshot.launchTemplateId} v${snapshot.launchTemplateVersion ?? '?'}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Badge variant="outline" className={className ?? 'gap-1 px-1 py-0 text-[9px]'} title={detail}>
      <Cpu className="h-2.5 w-2.5" />
      ran on {stageEnvironmentLabel(snapshot)}
    </Badge>
  );
}
