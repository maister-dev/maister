import type { ReactElement } from "react";
import type { PortfolioOnboarding } from "@/lib/portfolio-onboarding";

export interface OnboardingChecklistLabels {
  connected: string;
  flowReady: string;
  taskLaunched: string;
  title: string;
}

export function OnboardingChecklist({
  labels,
  progress,
}: {
  labels: OnboardingChecklistLabels;
  progress: PortfolioOnboarding;
}): ReactElement | null {
  if (progress.connected && progress.flowReady && progress.taskLaunched) {
    return null;
  }

  const steps = [
    ["connected", progress.connected, labels.connected],
    ["flow", progress.flowReady, labels.flowReady],
    ["task", progress.taskLaunched, labels.taskLaunched],
  ] as const;

  return (
    <section
      className="mb-6 rounded-[14px] border border-line bg-paper p-4"
      data-testid="portfolio-onboarding"
    >
      <h2 className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-mute">
        {labels.title}
      </h2>
      <ol className="mt-3 grid list-none gap-2 p-0 md:grid-cols-3">
        {steps.map(([id, complete, label]) => (
          <li
            key={id}
            className="flex items-center gap-2 rounded-lg border border-line bg-ivory px-3 py-2 text-[12px] text-ink"
            data-complete={complete ? "true" : "false"}
          >
            <span
              aria-hidden
              className={complete ? "text-accent-4" : "text-mute"}
            >
              {complete ? "✓" : "○"}
            </span>
            {label}
          </li>
        ))}
      </ol>
    </section>
  );
}
