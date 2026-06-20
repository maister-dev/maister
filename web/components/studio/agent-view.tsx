import type { ReactElement } from "react";

// Read-only agent metadata + prompt panel (M36 T1.5). Pure presentational server
// component. CRITICAL: the runner is NEVER surfaced — it is resolved per-project
// at launch, not a property of the package definition. No disk handle crosses in.

export interface AgentViewLabels {
  metadataTitle: string;
  promptTitle: string;
  description: string;
  whenToCall: string;
  riskTier: string;
  workspace: string;
  workspaceRef: string;
  mode: string;
  capabilityProfile: string;
  recommendedCron: string;
  recommendedEvents: string;
  none: string;
}

export interface AgentViewModel {
  name: string;
  description: string;
  // Localized trigger labels (when-to-call).
  triggers: string[];
  riskTier: string;
  workspace: string;
  workspaceRef: string | null;
  mode: string;
  capabilityProfile: Record<string, unknown> | null;
  recommendedCron: string | null;
  recommendedEvents: string[] | null;
  prompt: string;
}

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: ReactElement | string;
}): ReactElement {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 border-b border-line-soft py-2.5 last:border-b-0">
      <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
        {label}
      </span>
      <span className="min-w-0 text-[13px] text-ink">{children}</span>
    </div>
  );
}

export function AgentView({
  agent,
  labels,
}: {
  agent: AgentViewModel;
  labels: AgentViewLabels;
}): ReactElement {
  return (
    <div className="flex flex-col gap-5">
      <section
        className="rounded-[14px] border border-line bg-paper px-5 py-3"
        data-testid="agent-metadata"
      >
        <h2 className="m-0 mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-mute">
          {labels.metadataTitle}
        </h2>
        <MetaRow label={labels.description}>{agent.description}</MetaRow>
        <MetaRow label={labels.whenToCall}>
          {agent.triggers.length > 0 ? (
            <span className="flex flex-wrap gap-1.5">
              {agent.triggers.map((trigger) => (
                <span
                  key={trigger}
                  className="rounded-full border border-line bg-ivory px-2 py-0.5 font-mono text-[11px] text-ink-2"
                >
                  {trigger}
                </span>
              ))}
            </span>
          ) : (
            labels.none
          )}
        </MetaRow>
        <MetaRow label={labels.riskTier}>{agent.riskTier}</MetaRow>
        <MetaRow label={labels.workspace}>{agent.workspace}</MetaRow>
        <MetaRow label={labels.workspaceRef}>
          {agent.workspaceRef ?? labels.none}
        </MetaRow>
        <MetaRow label={labels.mode}>{agent.mode}</MetaRow>
        <MetaRow label={labels.recommendedCron}>
          {agent.recommendedCron ?? labels.none}
        </MetaRow>
        <MetaRow label={labels.recommendedEvents}>
          {agent.recommendedEvents && agent.recommendedEvents.length > 0 ? (
            <span className="flex flex-wrap gap-1.5">
              {agent.recommendedEvents.map((event) => (
                <span
                  key={event}
                  className="rounded-full border border-line bg-ivory px-2 py-0.5 font-mono text-[11px] text-ink-2"
                >
                  {event}
                </span>
              ))}
            </span>
          ) : (
            labels.none
          )}
        </MetaRow>
        <MetaRow label={labels.capabilityProfile}>
          {agent.capabilityProfile ? (
            <pre className="m-0 overflow-auto rounded-lg border border-line bg-ivory p-2.5 font-mono text-[11px] leading-[1.5] text-ink-2">
              {JSON.stringify(agent.capabilityProfile, null, 2)}
            </pre>
          ) : (
            labels.none
          )}
        </MetaRow>
      </section>

      <section data-testid="agent-prompt">
        <h2 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-mute">
          {labels.promptTitle}
        </h2>
        <pre className="overflow-auto rounded-lg border border-line bg-ivory p-4 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-ink">
          {agent.prompt}
        </pre>
      </section>
    </div>
  );
}
