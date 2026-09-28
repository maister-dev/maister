import "server-only";

import path from "node:path";

import pino from "pino";

import { LIBRARIAN_MCP_SERVER, librarianAllowedToolNames } from "./toolset";

import { resolveFacadeLaunch } from "@/lib/agents/facade-launch";
import { atomicWriteText } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "librarian.session-profile",
  level: process.env.LOG_LEVEL ?? "info",
});

/** ADR-183 D5 L1: the supervisor's capability_guard admits exactly the
 * librarian's facade tools; every built-in is denied inline and the third
 * consecutive denial halts the session. `readOnlySession` is deliberately NOT
 * used — it arbitrates first and auto-allows read/search/fetch. */
export function librarianEnforcementProfile(): {
  tools: { allow: string[] };
  mcps: { allowServers: string[] };
  enforcedClasses: ("tools" | "mcps")[];
  escalationThreshold: number;
} {
  return {
    tools: { allow: librarianAllowedToolNames() },
    mcps: { allowServers: [LIBRARIAN_MCP_SERVER] },
    enforcedClasses: ["tools", "mcps"],
    escalationThreshold: 3,
  };
}

/** A summary cannot call built-ins or MCP tools, even with auto approval. */
export function librarianSummaryEnforcementProfile(): ReturnType<
  typeof librarianEnforcementProfile
> {
  return {
    tools: { allow: [] },
    mcps: { allowServers: [] },
    enforcedClasses: ["tools", "mcps"],
    escalationThreshold: 1,
  };
}

// D5 L2: the built-ins a claude adapter must never run for the librarian.
export const LIBRARIAN_BUILTIN_DENY = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Bash",
  "BashOutput",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Task",
] as const;

const CLAUDE_SETTINGS_RELATIVE = path.join(".claude", "settings.local.json");

/** D5 L2: adapter settings that deny the built-ins. The conversation's
 * directory is created by and private to the librarian, so the file is
 * written whole — there is no user-owned settings file to preserve. Codex has
 * no settings-level deny surface and is refused by the runner guard (ADR-184). */
export async function materializeLibrarianAdapterSettings(
  cwd: string,
  capabilityAgent: string,
): Promise<{ materialized: boolean }> {
  if (capabilityAgent !== "claude") {
    log.debug({ cwd, capabilityAgent }, "librarian L2: no settings surface");

    return { materialized: false };
  }
  await atomicWriteText(
    path.join(cwd, CLAUDE_SETTINGS_RELATIVE),
    `${JSON.stringify(
      {
        permissions: {
          allow: [`mcp__${LIBRARIAN_MCP_SERVER}`],
          deny: [...LIBRARIAN_BUILTIN_DENY],
        },
      },
      null,
      2,
    )}\n`,
  );

  return { materialized: true };
}

export async function materializeLibrarianSummaryAdapterSettings(
  cwd: string,
  capabilityAgent: string,
): Promise<void> {
  if (capabilityAgent !== "claude") return;
  await atomicWriteText(
    path.join(cwd, CLAUDE_SETTINGS_RELATIVE),
    `${JSON.stringify(
      {
        permissions: { allow: [], deny: [...LIBRARIAN_BUILTIN_DENY] },
      },
      null,
      2,
    )}\n`,
  );
}

export type LibrarianFacadeServer = {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** The maister MCP facade for ONE turn, authenticated by that turn's token
 * (ADR-184) and listing only the librarian toolset. One facade process per
 * turn session, so a token never outlives its turn in a live process. */
export function librarianFacadeServer(
  tokenSecret: string,
): LibrarianFacadeServer {
  const launch = resolveFacadeLaunch();

  if (!launch)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The MAIster MCP facade is not runnable in this deployment",
      { details: { reason: "facade_unavailable" } },
    );

  return {
    name: LIBRARIAN_MCP_SERVER,
    transport: "stdio",
    command: launch.command,
    args: launch.args,
    env: {
      MAISTER_API_BASE_URL:
        process.env.MAISTER_API_BASE_URL ?? "http://localhost:3000",
      MAISTER_PROJECT_TOKEN: tokenSecret,
      MAISTER_MCP_TOOLSET: "librarian",
    },
  };
}
