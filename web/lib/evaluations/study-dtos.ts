import "server-only";

// Public DTO mappers for the Evaluation Study surface. Studies/participants carry
// no secret (ids are resource handles the UI needs); a launched participant's
// `runIdentity` provenance is bounded/opaque by construction (D3) — never a path,
// session id, adapter env, or credential — so it is safe to surface. Dates are
// serialized to ISO strings so the DTO round-trips through JSON unchanged.

function iso(v: unknown): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

export function toStudyDto(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    title: row.title,
    purpose: row.purpose ?? null,
    status: row.status,
    version: row.version,
    legacyExperimentId: row.legacyExperimentId ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: iso(row.archivedAt),
  };
}

export function toParticipantDto(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: row.id,
    sourceType: row.sourceType,
    runId: row.runId ?? null,
    recipeId: row.recipeId ?? null,
    label: row.label,
    displayOrder: row.displayOrder,
    replicateGroup: row.replicateGroup ?? null,
    replicateOrdinal: row.replicateOrdinal ?? null,
    launchReason: row.launchReason ?? null,
    runIdentity: row.runIdentity ?? null,
    joinedAt: iso(row.joinedAt),
    frozenAt: iso(row.frozenAt),
    removedAt: iso(row.removedAt),
  };
}
