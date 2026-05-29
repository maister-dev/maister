import "server-only";

import path from "node:path";

import pino from "pino";

const log = pino({
  name: "flow-trust",
  level: process.env.LOG_LEVEL ?? "info",
});

export type TrustStatus = "trusted_by_policy" | "untrusted";

function isLocalSource(source: string): boolean {
  return source.startsWith("file://") || path.isAbsolute(source);
}

function trustedPrefixes(): string[] {
  return (process.env.MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resolve install-time trust for a Flow package source (ADR-021):
// - local/file:// sources are trusted by policy (operator-owned working tree);
// - git sources whose URL starts with a configured
//   MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES entry are trusted by policy;
// - everything else is untrusted until an explicit per-(project, revision)
//   trust confirmation in the UI.
export function resolveTrust(source: string): TrustStatus {
  if (isLocalSource(source)) {
    log.info({ source }, "trust: local source -> trusted_by_policy");

    return "trusted_by_policy";
  }

  for (const prefix of trustedPrefixes()) {
    if (source.startsWith(prefix)) {
      log.info(
        { source, matchedPrefix: prefix },
        "trust: prefix match -> trusted_by_policy",
      );

      return "trusted_by_policy";
    }
  }

  log.info({ source }, "trust: no policy match -> untrusted");

  return "untrusted";
}
