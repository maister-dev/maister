import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { packageSkillTreeDigest } from "../../runtime/package-skill-tree";
import { SupervisorError, type StartSessionRequest } from "./types";
import type { WorkspaceResolution } from "./workspace-registry";

const adapters = {
  claude: {
    key: "CLAUDE_CONFIG_DIR",
    suffix: "",
    global: ".claude",
    credentials: [".credentials.json"],
  },
  codex: {
    key: "CODEX_HOME",
    suffix: "",
    global: ".codex",
    credentials: ["auth.json", "config.toml"],
  },
  gemini: {
    key: "GEMINI_CLI_HOME",
    suffix: ".gemini",
    global: ".gemini",
    credentials: ["oauth_creds.json", "google_accounts.json", "settings.json"],
  },
  opencode: {
    key: "OPENCODE_CONFIG_DIR",
    suffix: "",
    global: ".config/opencode",
    credentials: [],
  },
  mimo: {
    key: "XDG_CONFIG_HOME",
    suffix: "",
    global: ".config",
    credentials: [],
  },
} as const;

async function verifiedSettings(file: string, digest: string): Promise<Buffer> {
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new SupervisorError(
      "PRECONDITION",
      "The pinned agent adapter settings changed",
    );
  return bytes;
}

/** The assigned host derives private adapter state from its own adopted workspace and authenticated create payload. */
export async function preparePackageSkillHome(
  request: StartSessionRequest,
  workspace: WorkspaceResolution,
): Promise<Record<string, string>> {
  const view = request.packageSkillView;
  if (!view) return {};
  if (
    !request.nodeAttemptId ||
    !/^[A-Za-z0-9_-]+$/.test(request.nodeAttemptId) ||
    !/^[A-Za-z0-9_-]+$/.test(workspace.runId)
  )
    throw new SupervisorError(
      "PRECONDITION",
      "Package skill discovery requires an exact Run and attempt",
    );
  const adapter = adapters[request.executor.agent];
  if (!adapter)
    throw new SupervisorError(
      "PRECONDITION",
      "Unsupported adapter skill discovery",
    );
  const cwd = await realpath(workspace.cwd);
  const source = path.join(
    cwd,
    ".maister",
    "capabilities",
    workspace.runId,
    request.nodeAttemptId,
  );
  if ((await realpath(source)) !== source)
    throw new SupervisorError(
      "PRECONDITION",
      "The selected package skill view has a replaced directory",
    );
  const logicalOwner = createHash("sha256")
    .update(
      JSON.stringify([
        request.executor.agent,
        request.sessionName ?? "default",
        !request.sessionName || request.sessionName === "default"
          ? request.stepId
          : null,
        view,
      ]),
    )
    .digest("hex");
  const parent = path.join(await realpath(workspace.runDir), "adapter-homes");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const home = path.join(parent, logicalOwner);
  const config = path.join(home, adapter.suffix);
  const target = path.join(config, "skills");
  try {
    await lstat(home);
    if (
      (await realpath(home)) !== home ||
      (await packageSkillTreeDigest(target)) !== view.skillsDigest
    )
      throw new SupervisorError(
        "PRECONDITION",
        "The agent's private skill view changed before resume",
      );
    if (view.settingsDigest)
      await verifiedSettings(
        path.join(config, "settings.json"),
        view.settingsDigest,
      );
    return { [adapter.key]: home };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staged = await mkdtemp(path.join(parent, ".prepare-"));
  try {
    const stagedConfig = path.join(staged, adapter.suffix);
    await mkdir(stagedConfig, { recursive: true, mode: 0o700 });
    await cp(
      path.join(source, "package-skills"),
      path.join(stagedConfig, "skills"),
      { recursive: true },
    );
    if (
      (await packageSkillTreeDigest(path.join(stagedConfig, "skills"))) !==
      view.skillsDigest
    )
      throw new SupervisorError(
        "PRECONDITION",
        "The selected skill bytes differ from the accepted view",
      );
    const globalHome = process.env[adapter.key]
      ? path.join(process.env[adapter.key]!, adapter.suffix)
      : path.join(homedir(), adapter.global);
    for (const file of adapter.credentials) {
      const original = path.join(globalHome, file);
      try {
        await lstat(original);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await symlink(original, path.join(stagedConfig, file));
    }
    if (view.settingsDigest) {
      if (request.executor.agent !== "claude")
        throw new SupervisorError(
          "PRECONDITION",
          "Native settings are not supported for this adapter",
        );
      await writeFile(
        path.join(stagedConfig, "settings.json"),
        await verifiedSettings(
          path.join(source, "adapter-settings.json"),
          view.settingsDigest,
        ),
        { mode: 0o600, flag: "wx" },
      );
    }
    await rename(staged, home);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  return { [adapter.key]: home };
}
