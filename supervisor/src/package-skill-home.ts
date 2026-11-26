import type { WorkspaceResolution } from "./workspace-registry";
import type { AddressedPackageSkill } from "../../runtime/package-skill-tree";

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { isMaisterError } from "../../runtime/maister-error";
import { packageSkillTreeDigest } from "../../runtime/package-skill-tree";

import { SupervisorError, type StartSessionRequest } from "./types";

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

export type AddressedPackageSkillSource = AddressedPackageSkill &
  Readonly<{
    instructionPath: string;
    readFiles(): AsyncIterable<Readonly<{ path: string; bytes: Buffer }>>;
  }>;

export function skillViewIntegrityFailure(cause?: unknown): SupervisorError {
  return new SupervisorError(
    "PRECONDITION",
    "The accepted package skill view is missing or changed",
    { cause, details: { reason: "package_skill_view_integrity" } },
  );
}

async function assertSkillTreeDigest(
  directory: string,
  expectedDigest: string,
): Promise<void> {
  if ((await packageSkillTreeDigest(directory)) !== expectedDigest)
    throw skillViewIntegrityFailure();
}

async function verifiedSettings(file: string, digest: string): Promise<Buffer> {
  const bytes = await readFile(file);

  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw skillViewIntegrityFailure();

  return bytes;
}

async function verifyAddressedSkillDirectory(
  directory: string,
  skills: readonly AddressedPackageSkillSource[],
): Promise<void> {
  const expected = new Set(skills.map(({ slug }) => slug));
  const entries = await readdir(directory);

  if (
    entries.length !== expected.size ||
    entries.some((entry) => !expected.has(entry))
  )
    throw skillViewIntegrityFailure();
  for (const { slug, treeDigest } of skills)
    await assertSkillTreeDigest(path.join(directory, slug), treeDigest);
}

async function copyAddressedSkills(
  directory: string,
  skills: readonly AddressedPackageSkillSource[],
): Promise<void> {
  await mkdir(directory, { mode: 0o700 });

  for (const { slug, readFiles } of skills)
    for await (const file of readFiles()) {
      const destination = path.join(directory, slug, file.path);

      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.bytes, { flag: "wx", mode: 0o444 });
    }
}

async function legacySkillViewSource(
  request: StartSessionRequest,
  workspace: WorkspaceResolution,
): Promise<string> {
  if (
    !request.nodeAttemptId ||
    !/^[A-Za-z0-9_-]+$/.test(request.nodeAttemptId) ||
    !/^[A-Za-z0-9_-]+$/.test(workspace.runId)
  )
    throw new SupervisorError(
      "PRECONDITION",
      "Package skill discovery requires an exact Run and attempt",
    );
  const source = path.join(
    await realpath(workspace.cwd),
    ".maister",
    "capabilities",
    workspace.runId,
    request.nodeAttemptId,
  );

  if ((await realpath(source)) !== source) throw skillViewIntegrityFailure();

  return source;
}

/** The assigned host derives private adapter state from its own adopted workspace and authenticated create payload. */
export async function preparePackageSkillHome(
  request: StartSessionRequest,
  workspace: WorkspaceResolution,
): Promise<Record<string, string>> {
  try {
    return await prepareSkillHome(request, workspace);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;

    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "EISDIR" ||
      code === "ELOOP" ||
      (isMaisterError(error) && error.code === "CONFIG")
    )
      throw skillViewIntegrityFailure(error);
    throw error;
  }
}

async function prepareSkillHome(
  request: StartSessionRequest,
  workspace: WorkspaceResolution,
): Promise<Record<string, string>> {
  const view = request.packageSkillView;
  const addressed = workspace.addressedPackageSkills;

  if (request.addressedPackageSkills !== undefined && addressed === undefined)
    throw skillViewIntegrityFailure();
  if (view === undefined && addressed === undefined) return {};
  const adapterId = request.runner?.adapter ?? request.executor.agent;
  const adapter = adapters[adapterId];

  if (!adapter)
    throw new SupervisorError(
      "PRECONDITION",
      "Unsupported adapter skill discovery",
    );
  const source = view
    ? await legacySkillViewSource(request, workspace)
    : undefined;
  const verifySkills = async (directory: string): Promise<void> => {
    if (view) await assertSkillTreeDigest(directory, view.skillsDigest);
    else if (addressed)
      await verifyAddressedSkillDirectory(directory, addressed);
  };

  const logicalOwner = createHash("sha256")
    .update(
      JSON.stringify([
        adapterId,
        request.sessionName ?? "default",
        !request.sessionName || request.sessionName === "default"
          ? request.stepId
          : null,
        view ??
          addressed?.map(({ slug, treeDigest }) => ({ slug, treeDigest })),
      ]),
    )
    .digest("hex");
  const parent = path.join(await realpath(workspace.runDir), "adapter-homes");

  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent) throw skillViewIntegrityFailure();
  const home = path.join(parent, logicalOwner);
  const config = path.join(home, adapter.suffix);
  const target = path.join(config, "skills");

  const existing = await lstat(home).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    return null;
  });

  if (existing) {
    if ((await realpath(config)) !== config) throw skillViewIntegrityFailure();
    await verifySkills(target);
    if (view?.settingsDigest)
      await verifiedSettings(
        path.join(config, "settings.json"),
        view.settingsDigest,
      );

    return { [adapter.key]: home };
  }
  const staged = await mkdtemp(path.join(parent, ".prepare-"));

  try {
    const stagedConfig = path.join(staged, adapter.suffix);
    const stagedSkills = path.join(stagedConfig, "skills");

    await mkdir(stagedConfig, { recursive: true, mode: 0o700 });
    if (source)
      await cp(path.join(source, "package-skills"), stagedSkills, {
        recursive: true,
      });
    else if (addressed) await copyAddressedSkills(stagedSkills, addressed);
    await verifySkills(stagedSkills);
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
    if (source && view?.settingsDigest) {
      if (adapterId !== "claude")
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
