import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";

import {
  assertAgentId,
  parseAgentDefinition,
  type ParsedAgentDefinition,
} from "@/lib/agents/definition";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { resolveEffectiveFlowRevision } from "@/lib/flows/lifecycle";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { flows, flowRevisions } = schemaModule as unknown as Record<string, any>;

type Db = any;

// Mirror of lib/services/runs.ts LAUNCHABLE_ENABLEMENT_STATES (M10/ADR-021):
// only an explicitly enabled package (or one with a newer install available
// while its enabled pointer stays live) may resolve. `Installed` is NOT
// launchable — trust alone must not collapse the trust+enable lifecycle.
const LAUNCHABLE_ENABLEMENT_STATES = new Set<string>([
  "Enabled",
  "UpdateAvailable",
]);

export function splitQualifiedAgentId(agentId: string): {
  flowRefId: string;
  stem: string;
} {
  assertAgentId(agentId);

  const idx = agentId.indexOf(":");

  if (idx <= 0 || idx === agentId.length - 1) {
    throw new MaisterError(
      "CONFIG",
      `agent id "${agentId}" is not package-qualified (<flowRefId>:<stem>)`,
    );
  }

  return { flowRefId: agentId.slice(0, idx), stem: agentId.slice(idx + 1) };
}

export type EffectiveAgentDefinition = {
  parsed: ParsedAgentDefinition;
  sourcePath: string;
  flowRefId: string;
  flowId: string;
  revisionId: string;
  versionLabel: string;
  // T-B3 exec-trust axis of the pinned revision — gates stdio MCP spawn for
  // the agent's capability_profile (RD7).
  execTrust: "untrusted" | "trusted";
};

// ADR-089 rework (RD4): the platform `agents` row is only the catalog
// projection — the definition a launch in project P actually runs is the
// `agents/<stem>.md` inside P's PINNED revision of the providing package,
// behind the same enablement/trust gates that gate a flow launch
// (lib/services/runs.ts precedent). Resolved at launch (guards) AND again at
// spawn (prompt body) — the pin is the source of truth, never the index row.
export async function resolveEffectiveAgentDefinition(
  input: { agentId: string; projectId: string },
  db?: Db,
): Promise<EffectiveAgentDefinition> {
  const _db = db ?? getDb();
  const { flowRefId, stem } = splitQualifiedAgentId(input.agentId);

  const flowRows = await _db
    .select()
    .from(flows)
    .where(
      and(eq(flows.projectId, input.projectId), eq(flows.flowRefId, flowRefId)),
    );
  const flow = flowRows[0];

  if (!flow) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${flowRefId}" is not configured in this project`,
    );
  }

  if (!flow.enabledRevisionId) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${flowRefId}" has no enabled revision`,
    );
  }

  if (!LAUNCHABLE_ENABLEMENT_STATES.has(flow.enablementState as string)) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${flowRefId}" is ${flow.enablementState}, not launchable (enable it first)`,
    );
  }

  if (flow.trustStatus === "untrusted") {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${flowRefId}" is not trusted — confirm trust before launch`,
    );
  }

  const effectiveRevisionId =
    (await resolveEffectiveFlowRevision(_db, flow)) ?? flow.enabledRevisionId;

  const revisionRows = await _db
    .select({
      id: flowRevisions.id,
      versionLabel: flowRevisions.versionLabel,
      installedPath: flowRevisions.installedPath,
      packageStatus: flowRevisions.packageStatus,
      execTrust: flowRevisions.execTrust,
    })
    .from(flowRevisions)
    .where(eq(flowRevisions.id, effectiveRevisionId));
  const revision = revisionRows[0];

  if (!revision) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": enabled revision not found for package "${flowRefId}"`,
    );
  }

  if (revision.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package revision is ${revision.packageStatus}, not Installed`,
    );
  }

  const sourcePath = join(
    revision.installedPath as string,
    "maister-agents",
    `${stem}.md`,
  );

  let content: string;

  try {
    content = await readFile(sourcePath, "utf8");
  } catch {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": version ${revision.versionLabel} of package "${flowRefId}" does not ship maister-agents/${stem}.md`,
    );
  }

  return {
    parsed: parseAgentDefinition(input.agentId, content),
    sourcePath,
    flowRefId,
    flowId: flow.id as string,
    revisionId: revision.id as string,
    versionLabel: revision.versionLabel as string,
    execTrust: (revision.execTrust ?? "untrusted") as "untrusted" | "trusted",
  };
}

// Attach-time gate (RD4): the providing package must be configured AND in a
// launchable enablement state in the target project — looser than launch
// (trust is a launch-time gate), strict enough that an attach can always
// name its effective definition source.
export async function assertAgentPackageAttachable(
  input: { agentId: string; projectId: string },
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();
  const { flowRefId } = splitQualifiedAgentId(input.agentId);

  const flowRows = await _db
    .select({
      id: flows.id,
      enablementState: flows.enablementState,
      enabledRevisionId: flows.enabledRevisionId,
    })
    .from(flows)
    .where(
      and(eq(flows.projectId, input.projectId), eq(flows.flowRefId, flowRefId)),
    );
  const flow = flowRows[0];

  if (!flow) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${flowRefId}" is not configured in this project`,
    );
  }

  if (
    !flow.enabledRevisionId ||
    !LAUNCHABLE_ENABLEMENT_STATES.has(flow.enablementState as string)
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${flowRefId}" is not enabled in this project`,
    );
  }
}

// The attach panel's available-list filter: flow_ref_ids with a live enabled
// pin in this project.
export async function listEnabledPackageRefs(
  projectId: string,
  db?: Db,
): Promise<Set<string>> {
  const _db = db ?? getDb();
  const rows = (await _db
    .select({
      flowRefId: flows.flowRefId,
      enablementState: flows.enablementState,
      enabledRevisionId: flows.enabledRevisionId,
    })
    .from(flows)
    .where(eq(flows.projectId, projectId))) as Array<{
    flowRefId: string;
    enablementState: string;
    enabledRevisionId: string | null;
  }>;

  return new Set(
    rows
      .filter(
        (r) =>
          r.enabledRevisionId !== null &&
          LAUNCHABLE_ENABLEMENT_STATES.has(r.enablementState),
      )
      .map((r) => r.flowRefId),
  );
}
