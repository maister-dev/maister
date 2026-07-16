import "server-only";

import { and, asc, eq, or, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/triage.ts).
const { flows } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "flows-resolve-ref",
  level: process.env.LOG_LEVEL ?? "info",
});

export type FlowRefMismatch = {
  field: "flowId";
  expected: string;
  received: string;
  validRefs: string[];
};

export type FlowRefResolution =
  | { ok: true; flowId: string }
  | { ok: false; detail: FlowRefMismatch };

const EXPECTED =
  "a flow UUID (flows.id) or the project's flow ref (flows.flow_ref_id), as returned by flow_list";

/**
 * Resolve a body-controlled flow reference to the flow's `flows.id`, scoped to
 * `projectId`.
 *
 * A `ref` may be either namespace: the `flows.id` id or the human
 * `flows.flow_ref_id`. `flows_project_ref_uq (project_id, flow_ref_id)` makes
 * the ref unique per project, and ids are UUIDs in practice — but BOTH columns
 * are `text`, so a collision (one flow's id equal to a sibling's ref) is not
 * schema-forbidden. The id match therefore wins deterministically rather than
 * relying on that convention.
 *
 * Returns a discriminated result rather than throwing: each call site maps a
 * miss onto its own error taxonomy (`CONFIG` for triage/task writes,
 * `PRECONDITION` for launch) while surfacing the same self-correcting detail.
 */
export async function resolveFlowRef(
  projectId: string,
  ref: string,
  db?: Db,
): Promise<FlowRefResolution> {
  const _db = db ?? getDb();

  log.debug({ projectId, ref }, "resolve-flow-ref");

  const rows = await _db
    .select({ id: flows.id })
    .from(flows)
    .where(
      and(
        eq(flows.projectId, projectId),
        or(eq(flows.id, ref), eq(flows.flowRefId, ref)),
      ),
    )
    .orderBy(sql`case when ${flows.id} = ${ref} then 0 else 1 end`)
    .limit(1);

  const flowId = rows[0]?.id;

  if (flowId) {
    log.debug({ projectId, ref, flowId }, "resolve-flow-ref hit");

    return { ok: true, flowId };
  }

  const refRows = await _db
    .select({ flowRefId: flows.flowRefId })
    .from(flows)
    .where(eq(flows.projectId, projectId))
    .orderBy(asc(flows.flowRefId));

  const validRefs = refRows.map((row: { flowRefId: string }) => row.flowRefId);

  log.debug({ projectId, ref, validRefs }, "resolve-flow-ref miss");

  return {
    ok: false,
    detail: { field: "flowId", expected: EXPECTED, received: ref, validRefs },
  };
}

/**
 * Render a mismatch as the message text carried by the caller's MaisterError.
 *
 * `validRefs` lists every ref INSTALLED in the project, which is deliberately
 * wider than `flow_list` (launchable-only): task creation accepts any installed
 * flow, so filtering here would hide legitimate choices. Launchability is a
 * separate gate with its own message, so the wording promises existence — not
 * assignability — to avoid steering a caller onto a disabled flow.
 */
export function formatFlowRefError(detail: FlowRefMismatch): string {
  const refs =
    detail.validRefs.length > 0 ? detail.validRefs.join(", ") : "(none)";

  return `invalid ${detail.field}: expected ${detail.expected}; received "${detail.received}"; refs installed in this project: ${refs} (a triage verdict additionally requires the flow to be launchable)`;
}
