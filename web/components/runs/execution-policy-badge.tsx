import type { ReactElement } from "react";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import clsx from "clsx";

export interface ExecutionPolicyBadgeLabels {
  supervised: string;
  assisted: string;
  unattended: string;
  // Suffix marker when the resolved policy carries per-axis overrides.
  custom: string;
}

export interface ExecutionPolicyBadgeProps {
  policy: ExecutionPolicy | null | undefined;
  labels: ExecutionPolicyBadgeLabels;
}

// Honest visibility: a chip for any non-default autonomy level — the assisted /
// unattended presets, or a supervised policy carrying per-axis overrides. The
// plain supervised baseline (today's behaviour) renders nothing.
export function ExecutionPolicyBadge({
  policy,
  labels,
}: ExecutionPolicyBadgeProps): ReactElement | null {
  if (!policy) return null;

  const hasOverrides = Boolean(
    policy.overrides && Object.keys(policy.overrides).length > 0,
  );

  if (policy.preset === "supervised" && !hasOverrides) return null;

  const presetLabel = {
    supervised: labels.supervised,
    assisted: labels.assisted,
    unattended: labels.unattended,
  }[policy.preset];
  const label = hasOverrides ? `${presetLabel} ${labels.custom}` : presetLabel;

  return (
    <span
      className={clsx(
        "inline-flex rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold",
        policy.preset === "unattended"
          ? "border-amber-line bg-amber-soft text-amber"
          : "border-line bg-ivory text-ink-2",
      )}
      data-preset={policy.preset}
      data-testid="execution-policy-badge"
    >
      {label}
    </span>
  );
}
