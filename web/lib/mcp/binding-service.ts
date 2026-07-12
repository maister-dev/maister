import "server-only";

import type { McpBindingInput } from "@/lib/capabilities/resolver";
import type { McpConfigOverlay } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

// ADR-129 (W-A/W-B/W-C): data layer for project_mcp_bindings. A binding maps a
// capability ref to a concrete MCP target within one project. `project_id` is
// always the caller's server-derived value (from the URL slug), never a body
// field — that scoping IS the security boundary. Secrets never persist as
// values; config_overlay carries NAME-only remaps.

const log = pino({
  name: "mcp-binding",
  level: process.env.LOG_LEVEL ?? "info",
});

const ENV_REF = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export type BindingTargetKind = "platform" | "project" | "package";

const SOURCE_TO_TARGET_KIND: Record<string, BindingTargetKind> = {
  platform: "platform",
  project: "project",
  "flow-package": "package",
};

const SOURCE_PRECEDENCE: Record<string, number> = {
  project: 0,
  platform: 1,
  "flow-package": 2,
};

export type McpTargetSlots = { env: string[]; header: string[] };

export type McpBindingDto = {
  id: string;
  refId: string;
  targetKind: BindingTargetKind;
  targetId: string;
  enabled: boolean;
  configOverlay: McpConfigOverlay;
  recommendedHint: string | null;
};

export type BindingWrite = {
  refId: string;
  targetKind: BindingTargetKind;
  targetId: string;
  configOverlay?: McpConfigOverlay;
  createdBy?: string | null;
};

export type BindingPatch = {
  targetKind?: BindingTargetKind;
  targetId?: string;
  configOverlay?: McpConfigOverlay;
  enabled?: boolean;
};

type BindingDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

type BindingRow = {
  id: string;
  ref_id: string;
  target_kind: BindingTargetKind;
  target_id: string;
  enabled: boolean;
  config_overlay: McpConfigOverlay;
  recommended_hint: string | null;
};

function db(injected?: BindingDb): BindingDb {
  return injected ?? (getDb() as unknown as BindingDb);
}

function rowsOf<T>(result: { rows?: unknown[] }): T[] {
  return (result.rows ?? []) as T[];
}

function bareSlot(k: string): string {
  return k.startsWith("env:") ? k.slice(4) : k;
}

function toDto(row: BindingRow): McpBindingDto {
  return {
    id: row.id,
    refId: row.ref_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    enabled: row.enabled,
    configOverlay: row.config_overlay ?? {},
    recommendedHint: row.recommended_hint,
  };
}

// W-C: config_overlay is validated against the target's DECLARED slots. An
// unknown slot or a non-`env:` remap value is a CONFIG (422). Pure — the sink's
// invariant lives here so both the write path and the materialization defensive
// re-check share it.
export function assertOverlayAgainstSlots(
  overlay: McpConfigOverlay,
  slots: McpTargetSlots,
): void {
  const envSet = new Set(slots.env.map(bareSlot));
  const headerSet = new Set(slots.header.map(bareSlot));

  for (const [slot, value] of Object.entries(overlay.envRemap ?? {})) {
    if (!envSet.has(bareSlot(slot))) {
      throw new MaisterError(
        "CONFIG",
        `overlay envRemap references unknown env slot "${slot}"`,
      );
    }
    if (!ENV_REF.test(value)) {
      throw new MaisterError(
        "CONFIG",
        `overlay envRemap value for "${slot}" must be env:NAME, not a value`,
      );
    }
  }

  for (const [slot, value] of Object.entries(overlay.headerRemap ?? {})) {
    if (!headerSet.has(bareSlot(slot))) {
      throw new MaisterError(
        "CONFIG",
        `overlay headerRemap references unknown header slot "${slot}"`,
      );
    }
    if (!ENV_REF.test(value)) {
      throw new MaisterError(
        "CONFIG",
        `overlay headerRemap value for "${slot}" must be env:NAME, not a value`,
      );
    }
  }
}

export type ResolvedBindTarget = {
  refId: string;
  slots: McpTargetSlots;
  bindableAsExecutable: boolean;
  reason?: string;
};

// Resolve a bind target against server-state (DEC-1): the row MUST exist and
// match `target_kind`; a platform target MUST be enabled + trusted to be bound
// as executable. Returns null when the target row does not exist.
export async function resolveBindTarget(
  database: BindingDb,
  projectId: string,
  targetKind: BindingTargetKind,
  targetId: string,
): Promise<ResolvedBindTarget | null> {
  if (targetKind === "platform") {
    const result = await database.execute(sql`
      SELECT id, env_keys, header_keys, enabled, trust_status
      FROM platform_mcp_servers WHERE id = ${targetId} LIMIT 1
    `);
    const row = rowsOf<{
      id: string;
      env_keys: string[] | null;
      header_keys: string[] | null;
      enabled: boolean;
      trust_status: string;
    }>(result)[0];

    if (!row) return null;

    const trusted =
      row.trust_status === "trusted" ||
      row.trust_status === "trusted_by_policy";

    return {
      refId: row.id,
      slots: { env: row.env_keys ?? [], header: row.header_keys ?? [] },
      bindableAsExecutable: row.enabled && trusted,
      reason: !row.enabled
        ? "platform MCP is disabled"
        : !trusted
          ? "platform MCP is untrusted"
          : undefined,
    };
  }

  const source = targetKind === "project" ? "project" : "flow-package";
  const result = await database.execute(sql`
    SELECT capability_ref_id, material
    FROM capability_records
    WHERE id = ${targetId} AND project_id = ${projectId}
      AND kind = 'mcp' AND source = ${source}
    LIMIT 1
  `);
  const row = rowsOf<{
    capability_ref_id: string;
    material: { envKeys?: string[]; headerKeys?: string[] } | null;
  }>(result)[0];

  if (!row) return null;

  return {
    refId: row.capability_ref_id,
    slots: {
      env: row.material?.envKeys ?? [],
      header: row.material?.headerKeys ?? [],
    },
    bindableAsExecutable: true,
  };
}

// Resolver-facing bindings for a project (W-B). Absent binding = grandfather.
export async function loadProjectMcpBindings(
  projectId: string,
  injected?: BindingDb,
): Promise<McpBindingInput[]> {
  const result = await db(injected).execute(sql`
    SELECT ref_id, target_kind, target_id, enabled
    FROM project_mcp_bindings WHERE project_id = ${projectId}
  `);

  return rowsOf<{
    ref_id: string;
    target_kind: BindingTargetKind;
    target_id: string;
    enabled: boolean;
  }>(result).map((r) => ({
    refId: r.ref_id,
    targetKind: r.target_kind,
    targetId: r.target_id,
    enabled: r.enabled,
  }));
}

// ADR-129 (W-C): per-ref config overlays for a project, applied at
// materialization to rewrite NAMES only. Only ENABLED bindings with a non-empty
// overlay are returned (a disabled binding never materializes).
export async function loadProjectMcpOverlays(
  projectId: string,
  injected?: BindingDb,
): Promise<Map<string, McpConfigOverlay>> {
  const result = await db(injected).execute(sql`
    SELECT ref_id, config_overlay
    FROM project_mcp_bindings
    WHERE project_id = ${projectId} AND enabled = true
  `);
  const map = new Map<string, McpConfigOverlay>();

  for (const row of rowsOf<{
    ref_id: string;
    config_overlay: McpConfigOverlay;
  }>(result)) {
    const overlay = row.config_overlay ?? {};

    if (Object.keys(overlay).length > 0) map.set(row.ref_id, overlay);
  }

  return map;
}

export async function listBindings(
  projectId: string,
  injected?: BindingDb,
): Promise<McpBindingDto[]> {
  const result = await db(injected).execute(sql`
    SELECT id, ref_id, target_kind, target_id, enabled, config_overlay, recommended_hint
    FROM project_mcp_bindings WHERE project_id = ${projectId}
    ORDER BY ref_id ASC
  `);

  return rowsOf<BindingRow>(result).map(toDto);
}

async function loadBindingRow(
  database: BindingDb,
  projectId: string,
  refId: string,
): Promise<BindingRow | null> {
  const result = await database.execute(sql`
    SELECT id, ref_id, target_kind, target_id, enabled, config_overlay, recommended_hint
    FROM project_mcp_bindings WHERE project_id = ${projectId} AND ref_id = ${refId}
    LIMIT 1
  `);

  return rowsOf<BindingRow>(result)[0] ?? null;
}

export async function getBinding(
  projectId: string,
  refId: string,
  injected?: BindingDb,
): Promise<McpBindingDto | null> {
  const row = await loadBindingRow(db(injected), projectId, refId);

  return row ? toDto(row) : null;
}

export async function createBinding(
  projectId: string,
  input: BindingWrite,
  injected?: BindingDb,
): Promise<McpBindingDto> {
  const database = db(injected);
  const target = await resolveBindTarget(
    database,
    projectId,
    input.targetKind,
    input.targetId,
  );

  if (!target) {
    throw new MaisterError(
      "CONFIG",
      `bind target ${input.targetKind}/${input.targetId} not found in this project`,
    );
  }

  // The resolver selects the winning record by (refId, source), so the target
  // MUST implement the same ref the binding declares — otherwise the binding is
  // incoherent (the stored target_id would be silently ignored at resolution and
  // the ref would resolve to a different record or to nothing).
  if (target.refId !== input.refId) {
    throw new MaisterError(
      "CONFIG",
      `bind target ${input.targetKind}/${input.targetId} implements ref "${target.refId}", not "${input.refId}"`,
    );
  }

  if (input.targetKind === "platform" && !target.bindableAsExecutable) {
    throw new MaisterError(
      "CONFLICT",
      `platform MCP "${input.targetId}" cannot be bound as executable: ${target.reason}`,
    );
  }

  const overlay = input.configOverlay ?? {};

  assertOverlayAgainstSlots(overlay, target.slots);

  const id = randomUUID();
  const inserted = await database.execute(sql`
    INSERT INTO project_mcp_bindings (
      id, project_id, ref_id, target_kind, target_id, enabled,
      config_overlay, created_by, created_at, updated_at
    )
    VALUES (
      ${id}, ${projectId}, ${input.refId}, ${input.targetKind}, ${input.targetId},
      true, ${JSON.stringify(overlay)}::jsonb, ${input.createdBy ?? null}, now(), now()
    )
    ON CONFLICT (project_id, ref_id) DO NOTHING
    RETURNING id, ref_id, target_kind, target_id, enabled, config_overlay, recommended_hint
  `);
  const row = rowsOf<BindingRow>(inserted)[0];

  if (!row) {
    throw new MaisterError(
      "CONFLICT",
      `a binding for ref "${input.refId}" already exists in this project`,
    );
  }

  log.info(
    { projectId, refId: input.refId, targetKind: input.targetKind },
    "[mcp.binding] created",
  );

  return toDto(row);
}

export async function updateBinding(
  projectId: string,
  refId: string,
  patch: BindingPatch,
  injected?: BindingDb,
): Promise<McpBindingDto | null> {
  const database = db(injected);
  const current = await loadBindingRow(database, projectId, refId);

  if (!current) return null;

  const targetKind = patch.targetKind ?? current.target_kind;
  const targetId = patch.targetId ?? current.target_id;
  const overlay = patch.configOverlay ?? current.config_overlay ?? {};
  const enabled = patch.enabled ?? current.enabled;

  // A disabled binding is a pure opt-out that never materializes, so its target
  // and overlay validity are irrelevant — a soft-disable/disconnect MUST NOT
  // require the (possibly deleted or now-misconfigured) dependency it is
  // disabling. Only an ENABLED binding is validated against server-state + the
  // target's declared slots.
  if (enabled) {
    const target = await resolveBindTarget(
      database,
      projectId,
      targetKind,
      targetId,
    );

    if (!target) {
      throw new MaisterError(
        "CONFIG",
        `bind target ${targetKind}/${targetId} not found in this project`,
      );
    }

    // The target MUST implement the ref this binding resolves for (see createBinding).
    if (target.refId !== refId) {
      throw new MaisterError(
        "CONFIG",
        `bind target ${targetKind}/${targetId} implements ref "${target.refId}", not "${refId}"`,
      );
    }

    if (targetKind === "platform" && !target.bindableAsExecutable) {
      throw new MaisterError(
        "CONFLICT",
        `platform MCP "${targetId}" cannot be bound as executable: ${target.reason}`,
      );
    }

    assertOverlayAgainstSlots(overlay, target.slots);
  }

  await database.execute(sql`
    UPDATE project_mcp_bindings
    SET target_kind = ${targetKind}, target_id = ${targetId}, enabled = ${enabled},
        config_overlay = ${JSON.stringify(overlay)}::jsonb, updated_at = now()
    WHERE project_id = ${projectId} AND ref_id = ${refId}
  `);

  log.info({ projectId, refId, targetKind, enabled }, "[mcp.binding] updated");

  return getBinding(projectId, refId, database);
}

export async function deleteBinding(
  projectId: string,
  refId: string,
  injected?: BindingDb,
): Promise<boolean> {
  const result = await db(injected).execute(sql`
    DELETE FROM project_mcp_bindings
    WHERE project_id = ${projectId} AND ref_id = ${refId}
    RETURNING id
  `);
  const removed = rowsOf<{ id: string }>(result).length > 0;

  if (removed) log.info({ projectId, refId }, "[mcp.binding] removed");

  return removed;
}

// Connect a platform MCP: an enabled binding target=platform (grandfather pickup
// made explicit). refId defaults to the server's own id.
export async function connectPlatform(
  projectId: string,
  platformServerId: string,
  refId?: string,
  createdBy?: string | null,
  injected?: BindingDb,
): Promise<McpBindingDto> {
  return createBinding(
    projectId,
    {
      refId: refId ?? platformServerId,
      targetKind: "platform",
      targetId: platformServerId,
      createdBy,
    },
    injected,
  );
}

// Disconnect (opt-out) a ref: write/keep a DISABLED binding so the ref becomes
// unresolvable even if a platform row matches. If no binding exists, anchor the
// disabled binding on the current precedence winner among projected records.
export async function disconnectRef(
  projectId: string,
  refId: string,
  createdBy?: string | null,
  injected?: BindingDb,
): Promise<McpBindingDto> {
  const database = db(injected);
  const existing = await loadBindingRow(database, projectId, refId);

  if (existing) {
    const updated = await updateBinding(
      projectId,
      refId,
      { enabled: false },
      database,
    );

    return updated!;
  }

  const candidates = rowsOf<{ id: string; source: string }>(
    await database.execute(sql`
      SELECT id, source FROM capability_records
      WHERE project_id = ${projectId} AND kind = 'mcp'
        AND capability_ref_id = ${refId} AND disabled_at IS NULL
    `),
  );

  if (candidates.length === 0) {
    throw new MaisterError(
      "CONFIG",
      `nothing to disconnect: ref "${refId}" has no MCP candidate in this project`,
    );
  }

  const winner = [...candidates].sort(
    (a, b) =>
      (SOURCE_PRECEDENCE[a.source] ?? Number.MAX_SAFE_INTEGER) -
      (SOURCE_PRECEDENCE[b.source] ?? Number.MAX_SAFE_INTEGER),
  )[0];
  const id = randomUUID();
  const inserted = await database.execute(sql`
    INSERT INTO project_mcp_bindings (
      id, project_id, ref_id, target_kind, target_id, enabled,
      config_overlay, created_by, created_at, updated_at
    )
    VALUES (
      ${id}, ${projectId}, ${refId},
      ${SOURCE_TO_TARGET_KIND[winner.source] ?? "project"}, ${winner.id},
      false, '{}'::jsonb, ${createdBy ?? null}, now(), now()
    )
    ON CONFLICT (project_id, ref_id) DO NOTHING
    RETURNING id, ref_id, target_kind, target_id, enabled, config_overlay, recommended_hint
  `);
  const row = rowsOf<BindingRow>(inserted)[0];

  if (!row) {
    // Lost a race with a concurrent writer — reconverge on the stored row.
    const reread = await getBinding(projectId, refId, database);

    if (reread) return reread;

    throw new MaisterError("CONFLICT", `could not disconnect ref "${refId}"`);
  }

  log.info({ projectId, refId }, "[mcp.binding] disconnected (opt-out)");

  return toDto(row);
}
