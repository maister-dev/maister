import "server-only";

import type { CapabilityAgent } from "@/lib/config.schema";
import type { ScratchAdapterLaunch } from "@/lib/db/schema";
import type {
  CapabilityProfileEntry,
  ResolvedCapabilityProfile,
} from "@/lib/capabilities/types";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";

import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";

import { mapProfileToAgentArtifacts } from "@/lib/capabilities/agent-map";
import { atomicWriteJson, atomicWriteText } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "capabilities",
  level: process.env.LOG_LEVEL ?? "info",
});

const execFileAsync = promisify(execFile);

const WORKTREE_EXCLUDE_PATTERNS = [
  ".claude/settings.local.json",
  "*.maister-bak",
] as const;

export type MaterializeCapabilityProfileArgs = {
  runId: string;
  worktreePath: string;
  profile: ResolvedCapabilityProfile;
  executor?: {
    executorRefId: string;
    agent: string;
    model: string;
    router: string | null;
  };
  workMode?: "auto" | "plan_first" | "manual_approval";
  reasoningEffort?: "low" | "high" | "extra" | "ultra";
  nodeAttemptId?: string;
  tools?: string[];
  permissionMode?: "ask" | "allow" | "deny";
};

export type MaterializedCapabilityProfile = {
  rootPath: string;
  profilePath: string;
  instructionsPath: string;
  settingsLocalPath: string | null;
  mcpServers: AgentMcpServer[];
  materializedFiles: string[];
  adapterLaunch: ScratchAdapterLaunch;
};

export function capabilityMaterializationRootPath(
  worktreePath: string,
  runId: string,
  nodeAttemptId?: string,
): string {
  return path.join(
    path.resolve(worktreePath),
    ".maister",
    "capabilities",
    runId,
    ...(nodeAttemptId ? [nodeAttemptId] : []),
  );
}

function assertInsideWorktree(worktreePath: string, childPath: string): void {
  const relative = path.relative(worktreePath, childPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MaisterError(
      "PRECONDITION",
      `capability materialization path is outside worktree: ${childPath}`,
    );
  }
}

function instructionLines(profile: ResolvedCapabilityProfile): string[] {
  const entries = [...profile.enforced, ...profile.instructed];

  if (entries.length === 0) {
    return ["# Capability profile", "", "No capabilities selected."];
  }

  return [
    "# Capability profile",
    "",
    `Plan mode: ${profile.planMode}`,
    `Work mode: ${profile.workMode}`,
    `Reasoning effort: ${profile.reasoningEffort}`,
    "",
    ...entries.map(
      (entry) =>
        `- ${entry.kind}/${entry.capabilityRefId}: ${entry.enforceability}`,
    ),
  ];
}

// ISSUE 2 (R-SECRET): an mcp capability's `material.config` is arbitrary user
// YAML (`z.record(z.string(), z.unknown())`) that — unlike `env`, which upstream
// redacts to key NAMES — is stored verbatim and can carry literal secret values.
// Nothing downstream reads `config`, so strip it from the on-disk profile.json.
// Defense-in-depth: the catalog (`baseMaterial`) also omits it at ingestion, so
// the resolved profile is normally already config-free; this guards any other
// material source.
function stripMaterialConfig<
  T extends { material: CapabilityProfileEntry["material"] },
>(entry: T): T {
  if (!entry.material || !("config" in entry.material)) return entry;

  const material = { ...(entry.material as Record<string, unknown>) };

  delete material.config;

  return { ...entry, material };
}

function redactProfileForDisk(
  profile: ResolvedCapabilityProfile,
): ResolvedCapabilityProfile {
  return {
    ...profile,
    enforced: profile.enforced.map(stripMaterialConfig),
    instructed: profile.instructed.map(stripMaterialConfig),
    supported: profile.supported.map(stripMaterialConfig),
    unsupported: profile.unsupported.map(stripMaterialConfig),
    refused: profile.refused.map(stripMaterialConfig),
    downgraded: profile.downgraded.map(stripMaterialConfig),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);

    return true;
  } catch {
    return false;
  }
}

// Best-effort: keep the transient enforcement files MAIster drops at the
// worktree root (`.claude/settings.local.json` + its `.maister-bak`) out of git's
// untracked set, so a `preserveWorktree` snapshot or a takeover dirty-check never
// captures or trips on them. Writes to the worktree's own info/exclude (resolved
// via git so linked worktrees land on the right file). A git failure must NEVER
// break materialization — this is hardening, not a precondition.
async function ensureWorktreeGitExclude(worktreePath: string): Promise<void> {
  try {
    // Gate on this being a worktree root — a linked worktree has a `.git` file,
    // the main checkout a `.git` dir. Without this, a worktreePath nested inside
    // an unrelated repo would resolve to (and pollute) that repo's exclude.
    if (!(await fileExists(path.join(worktreePath, ".git")))) return;

    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "rev-parse", "--git-path", "info/exclude"],
      { cwd: worktreePath },
    );
    const excludeRel = stdout.trim();

    if (!excludeRel) return;

    const excludePath = path.isAbsolute(excludeRel)
      ? excludeRel
      : path.resolve(worktreePath, excludeRel);

    let existing = "";

    if (await fileExists(excludePath)) {
      existing = await readFile(excludePath, "utf8");
    }

    const lines = new Set(existing.split("\n").map((line) => line.trim()));
    const missing = WORKTREE_EXCLUDE_PATTERNS.filter((p) => !lines.has(p));

    if (missing.length === 0) return;

    await mkdir(path.dirname(excludePath), { recursive: true });

    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";

    await appendFile(excludePath, `${prefix}${missing.join("\n")}\n`);
  } catch (err) {
    log.debug(
      { worktreePath, err: err instanceof Error ? err.message : String(err) },
      "[capabilities.materialize] git-exclude hardening skipped",
    );
  }
}

export async function materializeCapabilityProfile(
  args: MaterializeCapabilityProfileArgs,
): Promise<MaterializedCapabilityProfile> {
  const worktreePath = path.resolve(args.worktreePath);
  const rootPath = capabilityMaterializationRootPath(
    worktreePath,
    args.runId,
    args.nodeAttemptId,
  );

  assertInsideWorktree(worktreePath, rootPath);
  await mkdir(rootPath, { recursive: true });

  const agent: CapabilityAgent = args.profile.executorAgent;
  const artifacts = mapProfileToAgentArtifacts({
    profile: args.profile,
    agent,
    tools: args.tools,
    permissionMode: args.permissionMode,
  });

  const profilePath = path.join(rootPath, "profile.json");
  const instructionsPath = path.join(rootPath, "instructions.md");
  const materializedProfile = {
    ...redactProfileForDisk(args.profile),
    executor: args.executor ?? null,
    workMode: args.workMode ?? args.profile.workMode,
    reasoningEffort: args.reasoningEffort ?? args.profile.reasoningEffort,
  };

  await atomicWriteJson(profilePath, materializedProfile);
  await atomicWriteText(
    instructionsPath,
    `${instructionLines(materializedProfile).join("\n")}\n`,
  );

  // settings.local.json lives at the WORKTREE ROOT `.claude/` — the SDK reads
  // it as the "local" settings tier via cwd, NOT from the node-scoped dir.
  let settingsLocalPath: string | null = null;

  if (artifacts.settingsLocal !== null) {
    const claudeDir = path.join(worktreePath, ".claude");
    const target = path.join(claudeDir, "settings.local.json");

    assertInsideWorktree(worktreePath, target);
    await mkdir(claudeDir, { recursive: true });

    // Preserve a pre-existing settings.local.json so cleanup can restore it.
    // Back up ONCE: create the bak only if it does not already exist, so across
    // multiple materialize calls in one worktree the backup keeps the FIRST
    // (user's original) state, never a later node's config.
    if (
      (await fileExists(target)) &&
      !(await fileExists(`${target}.maister-bak`))
    ) {
      await copyFile(target, `${target}.maister-bak`);
    }

    await atomicWriteJson(target, artifacts.settingsLocal);
    settingsLocalPath = target;

    await ensureWorktreeGitExclude(worktreePath);
  }

  const materializedFiles = settingsLocalPath ? [settingsLocalPath] : [];

  log.debug(
    {
      runId: args.runId,
      nodeAttemptId: args.nodeAttemptId,
      agent,
      settingsLocalWritten: settingsLocalPath !== null,
      mcpCount: artifacts.mcpServers.length,
    },
    "[capabilities.materialize] wrote profile",
  );

  return {
    rootPath,
    profilePath,
    instructionsPath,
    settingsLocalPath,
    mcpServers: artifacts.mcpServers,
    materializedFiles,
    adapterLaunch: {
      env: {
        MAISTER_CAPABILITY_PROFILE_PATH: profilePath,
        MAISTER_CAPABILITY_INSTRUCTIONS_PATH: instructionsPath,
      },
    },
  };
}
