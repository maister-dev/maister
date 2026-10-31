import type { AgentWorkspace } from "@/lib/db/schema";
import type { RunResultContract } from "@/lib/run-results/types";
import type { OperationalResultV1 } from "@/lib/run-results/operational-types";

import { parseAgentDefinition } from "@/lib/agents/definition";
import { buildOperationalContract } from "@/lib/agents/launch-contract";

export function operationalContractFixture(
  workspace: AgentWorkspace = "worktree",
): Extract<RunResultContract, { kind: "agent_operational" }> {
  return buildOperationalContract({
    parsed: parseAgentDefinition(
      "fixture:operation",
      `---\nname: Operation\ndescription: Perform an operation\nkind: operational\ncompletion: {contract: operational_v1}\nworkspace: ${workspace}\nmode: session\ntriggers: [manual]\nrisk_tier: standard\nplatform_mcp: false\n---\nPerform the operation.\n`,
    ),
    sourcePath: "/tmp/fixture/maister-agents/operation.md",
    packageName: "fixture",
    packageInstallId: "fixture-install",
    installedPath: "/tmp/fixture",
    manifest: null,
    versionLabel: "v1",
    resolvedRevision: "a".repeat(40),
    execTrust: "trusted",
  });
}

export function operationalSuccessFixture(): OperationalResultV1 {
  return {
    schemaVersion: 1,
    outcome: "success",
    summary: "Complete scan; no new work.",
    coverage: { state: "complete", remainingKnown: 0 },
    counts: {
      scanned: 0,
      attempted: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      created: 0,
    },
    references: [],
    diagnostics: [],
  };
}

export function operationalBlockedFixture(): OperationalResultV1 {
  return {
    ...operationalSuccessFixture(),
    outcome: "blocked",
    summary: "GitHub denied the scan.",
    coverage: { state: "not_started", remainingKnown: null },
    diagnostics: [
      {
        code: "github_http_403",
        severity: "error",
        operation: "list_issues",
        message: "GitHub returned HTTP 403.",
        retryable: false,
        remediation:
          "Restore repository issue access, then start a new attempt.",
        service: "github",
        httpStatus: 403,
      },
    ],
  };
}
