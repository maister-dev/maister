import "server-only";

import type {
  AiCodingSettings,
  CapabilityAgent,
  JudgeSettings,
} from "@/lib/config.schema";

import { createHash } from "node:crypto";

import {
  ENFORCEABILITY_BY_AGENT,
  evaluateNodeEnforcement,
  type EnforceabilityTable,
} from "./enforcement";

import { MaisterError } from "@/lib/errors";

// ADR-129: the web-derived capability-enforcement set delivered to the supervisor
// on `enforcementProfile` (structurally validated by the supervisor's zod schema).
// Distinct from the M14 capabilityProfilePath (child-env only).
export type SessionEnforcementProfile = {
  tools?: { allow: string[] };
  mcps?: { allowServers: string[] };
  enforcedClasses: Array<"tools" | "mcps">;
  escalationThreshold: number;
};

const DEFAULT_ESCALATION_THRESHOLD = 3;

// N, resolved web-side from MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD (M40
// repetition.max pattern), delivered on the profile so the supervisor stays
// config-free. Non-positive / malformed → the default.
export function resolveEscalationThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;

  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_ESCALATION_THRESHOLD;
}

type EnforcementBearing = {
  tools?: Partial<Record<string, string[]>>;
};

// Derive the SessionEnforcementProfile from a node/agent's capability settings,
// filtered to `enforcement.<class>: strict` AND enforceable (`tools`/`mcps` only).
// Allow-list posture (DES-7): a strict class with NO declared allow-set for the
// resolved agent refuses launch (`CONFIG`) — never enforce-nothing (ADR-032). An
// mcps allow-set MAY be empty (deny-all-MCP is a valid enforcement). Returns
// undefined when no class is strict-enforced. Pure — the launch evidence gate
// (assertEnforcementEvidence), not this, refuses an adapter without cached smoke.
export function deriveSessionEnforcementProfile(args: {
  settings: AiCodingSettings | JudgeSettings | undefined;
  agent: CapabilityAgent;
  mcpServerNames: readonly string[];
  table?: EnforceabilityTable;
  escalationThreshold?: number;
}): SessionEnforcementProfile | undefined {
  const { settings, agent } = args;

  if (!settings) return undefined;

  const table = args.table ?? ENFORCEABILITY_BY_AGENT;

  // SSOT: the "which classes are strict-enforced" decision comes from
  // evaluateNodeEnforcement — the SAME verdict the launch evidence gate
  // (assertEnforcementEvidence) consults — never a re-implemented strict+enforceable
  // predicate that could silently drift from it.
  const enforced = new Set(
    evaluateNodeEnforcement(settings, agent, table)
      .filter((e) => e.verdict === "enforced")
      .map((e) => e.class),
  );

  const enforcedClasses: Array<"tools" | "mcps"> = [];
  let tools: { allow: string[] } | undefined;
  let mcps: { allowServers: string[] } | undefined;

  if (enforced.has("tools")) {
    const allow = (settings as EnforcementBearing).tools?.[agent] ?? [];

    if (allow.length === 0) {
      throw new MaisterError(
        "CONFIG",
        `strict enforcement requires a declared tools allow-set for agent "${agent}"`,
      );
    }

    tools = { allow: [...allow] };
    enforcedClasses.push("tools");
  }

  if (enforced.has("mcps")) {
    // ASYMMETRY WITH tools (intentional): an empty resolved server set is NOT a
    // CONFIG refusal here. Empty `tools.allow` means "no tools" — a useless agent,
    // so it refuses (above). Empty `allowServers` means "no MCP server is allowed"
    // — a valid lock-down (the seam denies every `mcp__*` call). The supervisor
    // schema mirrors this (`allowServers` has no `.min(1)`, `tools.allow` does).
    mcps = { allowServers: [...args.mcpServerNames] };
    enforcedClasses.push("mcps");
  }

  if (enforcedClasses.length === 0) return undefined;

  return {
    ...(tools ? { tools } : {}),
    ...(mcps ? { mcps } : {}),
    enforcedClasses,
    escalationThreshold:
      args.escalationThreshold ?? resolveEscalationThreshold(),
  };
}

// ADR-129: admit a system-injected MCP server (the maister delegation facade)
// into an enforced mcps allow-list. The facade is appended to a session's
// mcpServers AFTER capability derivation, so without this an
// `enforcement.mcps: strict` orchestrator would deny its own `mcp__<facade>__*`
// delegation channel and halt with no author remedy. No-op when mcps is not
// governed or the server is already admitted.
export function admitFacadeServer(
  profile: SessionEnforcementProfile,
  facadeName: string,
): SessionEnforcementProfile {
  if (!profile.mcps || profile.mcps.allowServers.includes(facadeName)) {
    return profile;
  }

  return {
    ...profile,
    mcps: { allowServers: [...profile.mcps.allowServers, facadeName] },
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));

    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

// Fold the enforcement profile into the capability profileDigest so the long-lived
// session consistency guard (assertSessionProfileConsistent) refuses a mid-session
// enforcement change. Absent profile → the base digest is returned unchanged, so a
// non-enforced node's digest is byte-identical to before ADR-129.
export function foldEnforcementProfileIntoDigest(
  baseDigest: string,
  profile: SessionEnforcementProfile | undefined,
): string {
  if (!profile) return baseDigest;

  return createHash("sha256")
    .update(`${baseDigest}|${stableStringify(profile)}`)
    .digest("hex");
}
