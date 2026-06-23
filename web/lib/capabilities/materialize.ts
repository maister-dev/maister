import "server-only";

import type { CapabilityAgent } from "@/lib/config.schema";
import type { ScratchAdapterLaunch } from "@/lib/db/schema";
import type {
  CapabilityProfileEntry,
  ResolvedCapabilityProfile,
} from "@/lib/capabilities/types";
import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { HooksConfig } from "@/lib/flows/hooks-config";

import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";

import { mapProfileToAgentArtifacts } from "@/lib/capabilities/agent-map";
import {
  nativeGuardScriptPath,
  resolveNativeHookMaterializer,
} from "@/lib/capabilities/native-hook-materializer";
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
  "*.maister-owned",
  // M38 (ADR-103): the run-context blackboard lives at
  // <worktree>/.maister/run.json — keep MAIster's whole runtime subtree out of
  // git so run.json never appears in `git status` or the base→run diff.
  ".maister/",
] as const;

// Sibling marker written next to a materialized settings.local.json. Its presence
// means "M14 owns the current settings.local.json and has not reclaimed it yet";
// reclaim consumes it and refuses to touch the file when it is absent. This makes
// worktree-settings reclaim idempotent — a repeated run-terminal / cron-sweep pass
// can never delete a user's restored original (#data-loss).
export const SETTINGS_OWNED_MARKER_SUFFIX = ".maister-owned";

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
  // ADR-104 (M40) P4: the resolved guardrail config. When pathGuard is armed and
  // the agent has a native backend (claude), a PreToolUse hook is folded into
  // settings.local.json. Absent / no pathGuard / non-claude → no native hook.
  hooksConfig?: HooksConfig;
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
// M38 (ADR-103): exported so the graph runner can idempotently ensure the
// exclude at run start, BEFORE the first `.maister/run.json` write — capability
// materialization is per-node, so a capability-less flow would otherwise never
// set it.
export async function ensureWorktreeGitExclude(
  worktreePath: string,
): Promise<void> {
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
  // ADR-104 (M40) P4: resolve the native path-guard hook via the per-adapter seam
  // (claude → a PreToolUse command hook; others → undefined). Folded into the
  // SINGLE settings.local.json write below — no separate file write, so the M14
  // ownership-marker / reclaim / cleanup protocol is untouched.
  const nativeHooks = resolveNativeHookMaterializer(
    agent as AdapterId,
  ).buildSettingsHooks({
    hooksConfig: args.hooksConfig,
    guardScriptPath: nativeGuardScriptPath(),
  });
  const artifacts = mapProfileToAgentArtifacts({
    profile: args.profile,
    agent,
    tools: args.tools,
    permissionMode: args.permissionMode,
    model: args.executor?.model,
    nativeHooks,
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
    // Ownership marker: reclaim only touches settings.local.json while this
    // exists, so a restored user-original is never re-deleted (#data-loss).
    await atomicWriteText(
      `${target}${SETTINGS_OWNED_MARKER_SUFFIX}`,
      args.runId,
    );

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
