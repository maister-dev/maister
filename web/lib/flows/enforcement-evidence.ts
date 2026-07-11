import "server-only";

import type {
  AiCodingSettings,
  CapabilityAgent,
  JudgeSettings,
} from "@/lib/config.schema";
import type { SupervisorDiagnosticsStatus } from "@/lib/supervisor-client";

import { MaisterError } from "@/lib/errors";
import { checkSupervisorDiagnostics } from "@/lib/supervisor-client";

import {
  ENFORCEABILITY_BY_AGENT,
  evaluateNodeEnforcement,
  type EnforceabilityTable,
} from "./enforcement";

// ADR-129 (DES-6): the async launch evidence gate for strict tools/mcps. Mirrors
// `assertReadOnlySessionEvidence`. It admits a strict-enforced launch only when the
// resolved adapter's `capabilityEnforcement` smoke is cached `ok`, the runner is not
// `dangerously_skip_permissions` (the seam is structurally inert under skip-perms,
// DES-4), and diagnostics are reachable — otherwise it refuses with
// `EXECUTOR_UNAVAILABLE` naming the missing evidence (never a false-enforce, ADR-032).
export async function assertEnforcementEvidence(args: {
  settings: AiCodingSettings | JudgeSettings | undefined;
  agent: CapabilityAgent;
  permissionPolicy?: string;
  table?: EnforceabilityTable;
  checkDiagnostics?: () => Promise<SupervisorDiagnosticsStatus>;
}): Promise<void> {
  const table = args.table ?? ENFORCEABILITY_BY_AGENT;
  const strictEnforced = evaluateNodeEnforcement(
    args.settings,
    args.agent,
    table,
  ).some(
    (e) =>
      (e.class === "tools" || e.class === "mcps") && e.verdict === "enforced",
  );

  if (!strictEnforced) return;

  if (args.permissionPolicy === "dangerously_skip_permissions") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `agent "${args.agent}" uses dangerously_skip_permissions — incompatible with strict tools/mcps enforcement (capability_guard requires permissionPolicy=default; ADR-129)`,
    );
  }

  const check = args.checkDiagnostics ?? checkSupervisorDiagnostics;
  const diagnostics = await check();

  if (diagnostics.kind !== "ready") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `strict capability enforcement for agent "${args.agent}" cannot launch — supervisor diagnostics unavailable: ${diagnostics.message}`,
    );
  }

  const adapter = diagnostics.diagnostics.adapters.find(
    (item) => item.id === args.agent,
  );
  const evidence = adapter?.smoke.capabilityEnforcement;

  if (!evidence || evidence.status !== "ok") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `strict capability enforcement for agent "${args.agent}" cannot launch — capabilityEnforcement smoke is ${evidence?.status ?? "missing"}: ${evidence?.reason ?? "run the smoke ritual (pnpm -C supervisor smoke:acp --capability-enforcement)"}`,
    );
  }
}
