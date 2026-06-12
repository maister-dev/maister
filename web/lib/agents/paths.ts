import "server-only";

import os from "node:os";
import path from "node:path";

import { assertAgentId } from "@/lib/agents/definition";

// The host agent catalog (ADR-088). Owner-editable, NOT @sha-pinned —
// unlike the flow/capability caches — and never inside project repos.
// MAISTER_AGENTS_ROOT is the ops/test override, mirroring MAISTER_REPOS_ROOT.
export function systemAgentsRoot(): string {
  return (
    process.env.MAISTER_AGENTS_ROOT ??
    path.join(os.homedir(), ".maister", "agents")
  );
}

export function agentDirPath(agentId: string): string {
  return path.join(systemAgentsRoot(), assertAgentId(agentId));
}

export function agentFilePath(agentId: string): string {
  return path.join(agentDirPath(agentId), "agent.md");
}
