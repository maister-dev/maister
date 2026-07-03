import pino from "pino";
import { z } from "zod";

import type { LegacyPromotionMode } from "@/lib/runs/delivery-policy";

// ADR-126 §4.2: auto-promotion lane config — the single source of truth for the
// settings PATCH body, the sweep, and the run-detail panel. `.strict()` so an
// unknown key is a validation error (fail-closed, room to grow).

const log = pino({
  name: "auto-promote.config",
  level: process.env.LOG_LEVEL ?? "info",
});

export const laneClassSchema = z.enum(["docs", "tests", "deps", "config"]);

export type LaneClass = z.infer<typeof laneClassSchema>;

// A lane's promotion mode maps 1:1 onto promoteRun's LegacyPromotionMode; an
// omitted mode ⇒ promoteRun resolves its own policy.
export type EffectiveLaneMode = LegacyPromotionMode;

export const autoPromotionLaneSchema = z
  .object({
    class: laneClassSchema,
    enabled: z.boolean(),
    mode: z.enum(["local_merge", "rebase_merge", "pull_request"]).optional(),
    delayMinutes: z.number().int().min(0).max(1440).default(10),
    requireExternalCheckId: z.string().min(1).optional(),
    excludeGlobs: z.array(z.string().min(1)).max(64).optional(),
  })
  .strict();

export type AutoPromotionLane = z.infer<typeof autoPromotionLaneSchema>;

export const autoPromotionConfigSchema = z
  .object({
    // Master toggle, shipped false — flipping it ON with a NULL/never-configured
    // column activates BUILT_IN_LANES with zero tuning (AC-8).
    enabled: z.boolean(),
    lanes: z.array(autoPromotionLaneSchema).max(4),
  })
  .strict();

export type AutoPromotionConfig = z.infer<typeof autoPromotionConfigSchema>;

// All four classes preconfigured, enabled, 10-min grace, no mode/check/excludes:
// the master toggle is the only knob needed to go live.
export const BUILT_IN_LANES: AutoPromotionLane[] = laneClassSchema.options.map(
  (cls) => ({ class: cls, enabled: true, delayMinutes: 10 }),
);

const DISABLED_DEFAULT: AutoPromotionConfig = {
  enabled: false,
  lanes: BUILT_IN_LANES,
};

// Keep the first occurrence of each lane class (a stored config could carry a
// duplicate from an older writer; the classifier assumes at most one lane per
// class).
function dedupeLanes(lanes: AutoPromotionLane[]): AutoPromotionLane[] {
  const seen = new Set<LaneClass>();
  const out: AutoPromotionLane[] = [];

  for (const lane of lanes) {
    if (seen.has(lane.class)) continue;
    seen.add(lane.class);
    out.push(lane);
  }

  return out;
}

type AutoPromotionCarrier = { id: string; autoPromotion?: unknown };

// `default` = NULL column (never configured); `stored` = valid stored config;
// `invalid` = present-but-malformed (fail-closed, surfaced distinctly so the
// panel can say "config invalid" rather than "off").
export type AutoPromotionConfigSource = "default" | "stored" | "invalid";

export interface ResolvedAutoPromotionConfig {
  config: AutoPromotionConfig;
  source: AutoPromotionConfigSource;
}

// NULL column ⇒ shipped defaults with master OFF. A present-but-malformed stored
// config is treated as disabled (fail-closed) with a WARN — never throws, never
// silently ships a half-parsed config into the sweep.
export function resolveAutoPromotionConfig(
  project: AutoPromotionCarrier,
): ResolvedAutoPromotionConfig {
  if (project.autoPromotion == null) {
    return { config: DISABLED_DEFAULT, source: "default" };
  }

  const parsed = autoPromotionConfigSchema.safeParse(project.autoPromotion);

  if (!parsed.success) {
    log.warn(
      { projectId: project.id },
      "invalid stored auto-promotion config — treating as disabled",
    );

    return { config: DISABLED_DEFAULT, source: "invalid" };
  }

  return {
    config: { enabled: parsed.data.enabled, lanes: dedupeLanes(parsed.data.lanes) },
    source: "stored",
  };
}

// Platform-wide kill switch (§4.4 term 1): unset ⇒ on; only the literal `off`
// (case-insensitive) disables. Read direct from process.env per repo convention.
export function autoPromotionEnabledFromEnv(): boolean {
  return process.env.MAISTER_AUTO_PROMOTION?.trim().toLowerCase() !== "off";
}
