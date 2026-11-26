import "server-only";

import type { WorkspaceFlowPersona } from "../../../runtime/workspace-flow-persona";
import type { FlowGraph } from "@/lib/flows/graph/compile";
import type { Db } from "@/lib/execution-host/db";
import type { WorkspaceInputFile } from "@/lib/execution-host/workspace-inputs";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  WORKSPACE_FLOW_PERSONAS_FILE,
  WORKSPACE_FLOW_PERSONAS_MAX_BYTES,
  WORKSPACE_FLOW_ROLE_STEM,
} from "../../../runtime/workspace-flow-persona";
import { agentDefinitionSha256 } from "./activity-snapshot";
import {
  resolveEffectiveAgentDefinition,
  splitQualifiedAgentId,
} from "./effective";

import {
  agents,
  agentProjectLinks,
  packageInstalls,
  projectPackageAttachments,
  runs,
  workspaceInputCaptures,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const trusted = ["trusted", "trusted_by_policy"] as const;
const personasSchema = z
  .array(
    z
      .object({
        stepId: z.string().min(1).max(128),
        agentId: z.string().min(1),
        packageName: z.string().min(1),
        packageInstallId: z.string().min(1),
        definitionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        mode: z.enum(["session", "subagent"]),
        stem: z.string().regex(WORKSPACE_FLOW_ROLE_STEM),
        description: z.string().min(1),
        prompt: z.string().min(1),
      })
      .strict(),
  )
  .max(128);

function personaRefusal(agentId: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "The selected Flow role lacks current package authority",
    {
      details: { reason: "launch_authority_revoked", agentId },
    },
  );
}

export function decodeAddressedFlowPersonas(
  encoded: string,
): readonly WorkspaceFlowPersona[] {
  try {
    return personasSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
  } catch (cause) {
    throw new MaisterError(
      "PRECONDITION",
      "Retained addressed Flow roles are invalid",
      {
        cause,
        details: { reason: "workspace_input_changed" },
      },
    );
  }
}

export async function assertAddressedFlowPersonaAuthority(
  db: Db,
  projectId: string,
  personas: readonly WorkspaceFlowPersona[],
): Promise<void> {
  const unique = new Map(personas.map((persona) => [persona.agentId, persona]));
  for (const persona of unique.values()) {
    const [current] = await db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(
        projectPackageAttachments,
        and(
          eq(projectPackageAttachments.projectId, projectId),
          eq(projectPackageAttachments.packageName, persona.packageName),
        ),
      )
      .innerJoin(
        packageInstalls,
        eq(packageInstalls.id, projectPackageAttachments.packageInstallId),
      )
      .where(
        and(
          eq(agents.id, persona.agentId),
          eq(agents.enabled, true),
          isNull(agents.quarantinedAt),
          eq(packageInstalls.packageStatus, "Installed"),
          inArray(packageInstalls.trustStatus, trusted),
        ),
      )
      .for("share");
    const [original] = await db
      .select({ id: packageInstalls.id })
      .from(packageInstalls)
      .where(
        and(
          eq(packageInstalls.id, persona.packageInstallId),
          eq(packageInstalls.name, persona.packageName),
          eq(packageInstalls.packageStatus, "Installed"),
          inArray(packageInstalls.trustStatus, trusted),
        ),
      )
      .for("share");
    if (!current || !original) throw personaRefusal(persona.agentId);
    if (persona.mode === "subagent") {
      const [attachment] = await db
        .select({ memoryEnabled: agentProjectLinks.memoryEnabled })
        .from(agentProjectLinks)
        .where(
          and(
            eq(agentProjectLinks.agentId, persona.agentId),
            eq(agentProjectLinks.projectId, projectId),
          ),
        )
        .for("share");
      if (attachment?.memoryEnabled)
        throw new MaisterError(
          "PRECONDITION",
          "A shared subagent session cannot hold an independent vault credential",
        );
    }
  }
}

/** Resolve each role from the trusted project package before freezing the Run. */
export async function captureAddressedFlowPersonas(
  db: Db,
  projectId: string,
  graph: FlowGraph,
  drivingAgentId: string | null,
  scope: "ordinary" | "structured",
): Promise<readonly WorkspaceInputFile[]> {
  const personas: WorkspaceFlowPersona[] = [];
  const definitions = new Map<
    string,
    Awaited<ReturnType<typeof resolveEffectiveAgentDefinition>>
  >();
  for (const {
    id: stepId,
    source: { node },
  } of graph.nodes.values()) {
    if (
      node.type !== "ai_coding" &&
      !(scope === "structured" && node.type === "orchestrator")
    )
      continue;
    const explicit = node.settings?.agent;
    const agentId = explicit ?? drivingAgentId;
    if (!agentId) continue;
    const definition =
      definitions.get(agentId) ??
      (await resolveEffectiveAgentDefinition({ projectId, agentId }, db));
    definitions.set(agentId, definition);
    const { parsed, packageName, packageInstallId } = definition;
    if (
      parsed.kind === "operational" ||
      (explicit && !parsed.triggers.includes("flow")) ||
      ((!explicit || scope === "structured") && parsed.mode !== "session")
    )
      throw personaRefusal(agentId);
    personas.push({
      stepId,
      agentId,
      packageName,
      packageInstallId,
      definitionSha256: agentDefinitionSha256(parsed),
      mode: parsed.mode,
      stem: splitQualifiedAgentId(agentId).stem,
      description: parsed.description,
      prompt: parsed.prompt.trim(),
    });
  }
  if (!personas.length) return [];
  const bytes = Buffer.from(JSON.stringify(personas));
  if (
    bytes.byteLength > WORKSPACE_FLOW_PERSONAS_MAX_BYTES ||
    !personasSchema.safeParse(personas).success
  )
    throw new MaisterError(
      "PRECONDITION",
      "A selected Flow role exceeds the addressed input contract",
    );
  await assertAddressedFlowPersonaAuthority(db, projectId, personas);
  return [{ path: WORKSPACE_FLOW_PERSONAS_FILE, bytes }];
}

export async function readAddressedFlowPersona(
  db: Db,
  runId: string,
  stepId: string,
  agentId: string,
): Promise<WorkspaceFlowPersona> {
  const [row] = await db
    .select({
      projectId: workspaces.projectId,
      personas: sql<string | null>`(
      SELECT entry->>'base64' FROM jsonb_array_elements(${workspaceInputCaptures.files}) entry
      WHERE entry->>'path' = ${WORKSPACE_FLOW_PERSONAS_FILE}
    )`,
    })
    .from(workspaces)
    .innerJoin(
      workspaceInputCaptures,
      eq(workspaceInputCaptures.workspaceId, workspaces.id),
    )
    .where(
      and(
        eq(workspaces.runId, runId),
        eq(workspaces.ownershipKind, "host_owned"),
        isNull(workspaces.removedAt),
      ),
    );
  const persona = row?.personas
    ? decodeAddressedFlowPersonas(row.personas).find(
        (entry) => entry.stepId === stepId && entry.agentId === agentId,
      )
    : undefined;
  if (!row?.projectId || !persona) throw personaRefusal(agentId);
  await assertAddressedFlowPersonaAuthority(db, row.projectId, [persona]);
  return persona;
}

/** Keep the native knowledge actor tied to its exact pinned package and assignment input. */
export async function attestAddressedFlowPersona(
  db: Db,
  input: Readonly<{
    runId: string;
    nodeAttemptId?: string;
    persona: WorkspaceFlowPersona;
  }>,
): Promise<string> {
  const { runId, nodeAttemptId, persona } = input;
  if (!nodeAttemptId || persona.mode !== "session")
    throw new MaisterError(
      "PRECONDITION",
      "Native Flow knowledge requires an explicit session role and current node attempt",
      { details: { reason: "native_knowledge_actor_required" } },
    );
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run?.projectId) throw personaRefusal(persona.agentId);
  const { loadProjectAssignmentExecutionInput } =
    await import("@/lib/specialist-assignments/project-admission");
  const inputRevision =
    persona.agentId === run.sourceAgentId
      ? await loadProjectAssignmentExecutionInput(db, run)
      : null;
  const standing = inputRevision?.snapshot.standingDefinition;
  if (
    standing &&
    (standing.agentId !== persona.agentId ||
      standing.packageInstallId !== persona.packageInstallId ||
      standing.definitionSha256 !== persona.definitionSha256)
  )
    throw new MaisterError(
      "CONFLICT",
      "The project coordinator persona differs from its frozen original assignment",
    );
  const { recordNativeKnowledgeActor } =
    await import("@/lib/brain/knowledge-execution-actor");
  await recordNativeKnowledgeActor(db, {
    runId,
    nodeAttemptId,
    actor: {
      schemaVersion: 1,
      agentId: persona.agentId,
      packageName: persona.packageName,
      packageInstallId: persona.packageInstallId,
      definitionSha256: persona.definitionSha256,
    },
  });
  return standing?.configuration === undefined
    ? persona.prompt
    : `${persona.prompt}\n\n## Specialist configuration\n${JSON.stringify(standing.configuration)}`;
}
