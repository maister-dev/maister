import "server-only";

import type { ExecutionEventProjector } from "./projector";
import type { ProjectionWorker } from "./projection-worker";

import { canonicalLifecycleProjector } from "./lifecycle-projector";
import { canonicalPromptProjector } from "./prompt-projector";
import { canonicalRuntimeObjectProjector } from "./runtime-object-projector";
import { canonicalTranscriptProjector } from "./transcript-projector";
import { startProjectionWorker } from "./projection-worker";
import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { isApplicationStopping } from "@/lib/server-lifecycle";
import { canonicalArtifactProjector } from "@/lib/projector/artifact-projector";
import { canonicalCostProjector } from "@/lib/runs/cost-rollups";

export const canonicalProjectors: readonly ExecutionEventProjector[] = [
  canonicalPromptProjector,
  canonicalLifecycleProjector,
  canonicalRuntimeObjectProjector,
  canonicalArtifactProjector,
  canonicalTranscriptProjector,
  canonicalCostProjector,
];

declare global {
  var __maisterCanonicalProjectionWorker: ProjectionWorker | undefined;
}

export function startCanonicalProjectionWorker(): ProjectionWorker {
  if (isApplicationStopping())
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "projection service is shutting down",
    );
  const registered = new Set(
    canonicalProjectors.map((projector) => projector.consumerName),
  );

  if (
    registered.size !== Object.values(CANONICAL_PROJECTION_CONSUMERS).length ||
    Object.values(CANONICAL_PROJECTION_CONSUMERS).some(
      (name) => !registered.has(name),
    )
  ) {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "canonical projection registry and ingest consumer names disagree",
    );
  }
  globalThis.__maisterCanonicalProjectionWorker ??= startProjectionWorker({
    db: getDb(),
    projectors: canonicalProjectors,
  });

  return globalThis.__maisterCanonicalProjectionWorker;
}

export async function stopCanonicalProjectionWorker(): Promise<void> {
  const worker = globalThis.__maisterCanonicalProjectionWorker;

  if (!worker) return;
  await worker.stop();
  if (globalThis.__maisterCanonicalProjectionWorker === worker)
    globalThis.__maisterCanonicalProjectionWorker = undefined;
}
