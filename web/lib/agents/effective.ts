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

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls, projectPackageAttachments } =
  schemaModule as unknown as Record<string, any>;

type Db = any;

export function splitQualifiedAgentId(agentId: string): {
  packageName: string;
  stem: string;
} {
  assertAgentId(agentId);

  const idx = agentId.indexOf(":");

  if (idx <= 0 || idx === agentId.length - 1) {
    throw new MaisterError(
      "CONFIG",
      `agent id "${agentId}" is not package-qualified (<packageName>:<stem>)`,
    );
  }

  return { packageName: agentId.slice(0, idx), stem: agentId.slice(idx + 1) };
}

export type EffectiveAgentDefinition = {
  parsed: ParsedAgentDefinition;
  sourcePath: string;
  packageName: string;
  packageInstallId: string;
  versionLabel: string;
  // T-B3 exec-trust axis — gates stdio MCP spawn for the agent's
  // capability_profile (RD7). A resolved definition always comes from a
  // trusted / trusted_by_policy install (untrusted is refused below), and
  // trustPackageRevision flips package_installs.trust_status together with the
  // member flow_revisions.exec_trust — so the package's trust IS the agent's
  // exec trust.
  execTrust: "untrusted" | "trusted";
};

// (ADR-106) The platform `agents` row is only the catalog projection — the
// definition a launch in project P actually runs is the
// `maister-agents/<stem>.md` inside P's ATTACHED package install (the
// per-project version pin), behind the package gate (attached + trusted +
// Installed). The per-agent enabled/quarantine gate is the CALLER's
// (launch.ts / flow-binding.ts): a flow-bound agent has no agent_project_links
// row, so the resolver must not require one. Resolved at launch (guards) AND
// again at spawn (prompt body) — the attached install is the source of truth,
// never the catalog index row.
export async function resolveEffectiveAgentDefinition(
  input: { agentId: string; projectId: string },
  db?: Db,
): Promise<EffectiveAgentDefinition> {
  const _db = db ?? getDb();
  const { packageName, stem } = splitQualifiedAgentId(input.agentId);

  const rows = await _db
    .select({
      packageInstallId: packageInstalls.id,
      installedPath: packageInstalls.installedPath,
      packageStatus: packageInstalls.packageStatus,
      trustStatus: packageInstalls.trustStatus,
      versionLabel: packageInstalls.versionLabel,
    })
    .from(projectPackageAttachments)
    .innerJoin(
      packageInstalls,
      eq(projectPackageAttachments.packageInstallId, packageInstalls.id),
    )
    .where(
      and(
        eq(projectPackageAttachments.projectId, input.projectId),
        eq(projectPackageAttachments.packageName, packageName),
      ),
    );
  const install = rows[0];

  if (!install) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${packageName}" is not attached to this project`,
    );
  }

  if (install.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${packageName}" install is ${install.packageStatus}, not Installed`,
    );
  }

  // Allow-list (skill-context): only the two trusted states resolve; untrusted
  // and any future trust state are refused by default.
  if (
    install.trustStatus !== "trusted" &&
    install.trustStatus !== "trusted_by_policy"
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${packageName}" is not trusted — confirm trust before launch`,
    );
  }

  const sourcePath = join(
    install.installedPath as string,
    "maister-agents",
    `${stem}.md`,
  );

  let content: string;

  try {
    content = await readFile(sourcePath, "utf8");
  } catch {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": version ${install.versionLabel} of package "${packageName}" does not ship maister-agents/${stem}.md`,
    );
  }

  return {
    parsed: parseAgentDefinition(input.agentId, content),
    sourcePath,
    packageName,
    packageInstallId: install.packageInstallId as string,
    versionLabel: install.versionLabel as string,
    execTrust: "trusted",
  };
}

// Attach-time gate (ADR-106): the providing package must be attached to the
// target project, so an attach can always name its effective definition
// source. Looser than launch (trust is a launch-time gate) — attachment IS the
// enable (packages have no flow-style enablementState).
export async function assertAgentPackageAttachable(
  input: { agentId: string; projectId: string },
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();
  const { packageName } = splitQualifiedAgentId(input.agentId);

  const rows = await _db
    .select({ id: projectPackageAttachments.id })
    .from(projectPackageAttachments)
    .where(
      and(
        eq(projectPackageAttachments.projectId, input.projectId),
        eq(projectPackageAttachments.packageName, packageName),
      ),
    );

  if (!rows[0]) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${packageName}" is not attached to this project`,
    );
  }
}

// The attach panel's available-list filter: the package names attached to this
// project (ADR-106: attachment IS the enable, so every attached package is
// "enabled" — there is no flow-style enablementState).
export async function listEnabledPackageRefs(
  projectId: string,
  db?: Db,
): Promise<Set<string>> {
  const _db = db ?? getDb();
  const rows = (await _db
    .select({ packageName: projectPackageAttachments.packageName })
    .from(projectPackageAttachments)
    .where(eq(projectPackageAttachments.projectId, projectId))) as Array<{
    packageName: string;
  }>;

  return new Set(rows.map((r) => r.packageName));
}
