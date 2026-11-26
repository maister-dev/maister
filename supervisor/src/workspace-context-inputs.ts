import type { WorkspaceContextInput } from "../../runtime/workspace-context-input";
import type { ContextMount } from "./types";

import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
} from "node:fs/promises";
import { join, relative } from "node:path";

import { z } from "zod";

import { GIT_OBJECT_ID } from "../../runtime/wait-head";
import { workspaceEvidenceDigest } from "../../runtime/workspace-prepare";

import { prepareGitWorktree } from "./prepare-owned-workspace";
import { SupervisorError } from "./types";
import { isUnderRoot } from "./workspace-roots";
import { executeWorkspaceGit } from "./workspace-source";

const contextSchema = z
  .object({
    stepId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.-]+$/),
    repositoryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    slug: z
      .string()
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    ref: z.string().min(1).max(255),
    declaredRef: z.string().min(1).max(255).nullable(),
    commit: z.string().regex(GIT_OBJECT_ID),
  })
  .strict();
const contextInputs = z.array(contextSchema).max(64);

function rejectContext(reason: string): SupervisorError {
  return new SupervisorError("PRECONDITION", reason, {
    details: { reason: "workspace_rejected" },
  });
}

export function parseWorkspaceContextInputs(
  bytes: Buffer | null,
): readonly WorkspaceContextInput[] {
  if (bytes === null) return [];
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw rejectContext("The sealed context declaration is invalid JSON");
  }
  const parsed = contextInputs.safeParse(input);
  if (!parsed.success)
    throw rejectContext("The sealed context declaration is invalid");
  const perStep = new Map<string, Set<string>>();

  for (const context of parsed.data) {
    const slugs = perStep.get(context.stepId) ?? new Set<string>();

    if (slugs.has(context.slug) || slugs.size >= 8)
      throw rejectContext(
        "A step has duplicate or too many context repositories",
      );
    slugs.add(context.slug);
    perStep.set(context.stepId, slugs);
  }

  return parsed.data;
}

function contextPath(
  runDir: string,
  manifest: string,
  context: WorkspaceContextInput,
): string {
  return join(runDir, "context", workspaceEvidenceDigest([manifest, context]));
}

async function verifyContextCheckout(
  path: string,
  revision: string,
): Promise<void> {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
    throw rejectContext("Context repository escaped its private checkout root");
  const head = await executeWorkspaceGit([
    "-C",
    path,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  const status = await executeWorkspaceGit([
    "-C",
    path,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignored",
  ]);

  if (head !== revision || status !== "")
    throw rejectContext(
      "The retained context checkout differs from its authorized revision",
    );
}

async function protectContextFiles(
  root: string,
  directory: string,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);

    if (entry.isDirectory()) await protectContextFiles(root, candidate);
    else if (entry.isFile()) {
      const stat = await lstat(candidate);

      await chmod(candidate, stat.mode & 0o555);
    } else if (entry.isSymbolicLink()) {
      const target = await realpath(candidate);
      if (
        !isUnderRoot(root, target) ||
        relative(root, target).split("/").includes(".git")
      )
        throw rejectContext(
          "Context repository contains a link outside its source files",
        );
    } else
      throw rejectContext(
        "Context repository contains unsupported filesystem content",
      );
  }
}

export async function materializeWorkspaceContextInputs(
  input: Readonly<{
    runDir: string;
    runtimeRoot: string;
    manifestDigest: string;
    contexts: readonly WorkspaceContextInput[];
    sources: ReadonlyMap<string, string>;
    assertOwner: () => void;
  }>,
): Promise<void> {
  if (input.contexts.length === 0) return;
  const approved = input.contexts.map((context) => {
    const source = input.sources.get(context.repositoryId);

    if (!source)
      throw rejectContext(
        "Context repository is not approved on this supervisor",
      );
    return { context, source };
  });
  const parent = join(input.runDir, "context");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent)
    throw rejectContext("Context root is not canonical");

  for (const { context, source } of approved) {
    const workspacePath = contextPath(
      input.runDir,
      input.manifestDigest,
      context,
    );

    await prepareGitWorktree({
      managedRoot: join(input.runtimeRoot, ".maister", "managed-workspaces"),
      source,
      workspacePath,
      commit: context.commit,
      assertOwner: input.assertOwner,
    });
    await verifyContextCheckout(workspacePath, context.commit);
    await protectContextFiles(workspacePath, workspacePath);
  }
}

export async function loadWorkspaceContextMounts(
  input: Readonly<{
    runDir: string;
    manifestDigest: string;
    contexts: readonly WorkspaceContextInput[];
  }>,
): Promise<ContextMount[]> {
  const mounts: ContextMount[] = [];

  for (const context of input.contexts) {
    const path = contextPath(input.runDir, input.manifestDigest, context);

    await verifyContextCheckout(path, context.commit);
    mounts.push({
      path,
      slug: context.slug,
      ref: context.ref,
      commit: context.commit,
    });
  }

  return mounts;
}
