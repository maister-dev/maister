import type { WorkspaceResolution } from "./workspace-registry";

import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";

import { SupervisorError } from "./types";
import { executeWorkspaceGit } from "./workspace-source";

type NativeLaunch = Readonly<{ binary: string; arguments: string[] }>;

function protectionUnavailable(cause?: unknown): SupervisorError {
  return new SupervisorError(
    "EXECUTOR_UNAVAILABLE",
    "The selected supervisor cannot enforce read-only checkout writes. Configure its native read-only process driver.",
    { cause, details: { reason: "read_only_process_unavailable" } },
  );
}

/** The process inherits kernel write restrictions for the checkout and its Git worktree metadata. */
export async function protectWorkspaceProcess(
  workspace: WorkspaceResolution,
  launch: NativeLaunch,
): Promise<NativeLaunch> {
  if (workspace.ownershipKind !== "host_owned") return launch;
  const checkouts = [
    ...(workspace.readOnlyCheckout ? [workspace.cwd] : []),
    ...(workspace.contextMounts ?? []).map(({ path }) => path),
  ];
  if (checkouts.length === 0) return launch;

  const roots = new Set<string>();
  for (const checkout of checkouts) {
    roots.add(await realpath(checkout));
    for (const argument of ["--absolute-git-dir", "--git-common-dir"]) {
      const directory = await executeWorkspaceGit([
        "-C",
        checkout,
        "rev-parse",
        "--path-format=absolute",
        argument,
      ]);
      if (!isAbsolute(directory)) throw protectionUnavailable();
      roots.add(await realpath(directory));
    }
  }
  const mountRoots = [...roots].filter(
    (root) =>
      ![...roots].some(
        (parent) => parent !== root && root.startsWith(parent + sep),
      ),
  );
  if (mountRoots.some((root) => root === sep || /[\u0000-\u001f]/u.test(root)))
    throw protectionUnavailable();

  try {
    if (process.platform === "darwin") {
      const binary = "/usr/bin/sandbox-exec";
      await access(binary, constants.X_OK);
      const profile = [
        "(version 1)",
        "(allow default)",
        ...mountRoots.map(
          (root) => `(deny file-write* (subpath ${JSON.stringify(root)}))`,
        ),
      ].join("\n");

      return {
        binary,
        arguments: ["-p", profile, launch.binary, ...launch.arguments],
      };
    }
    if (process.platform === "linux") {
      const binary = "/usr/bin/bwrap";
      await access(binary, constants.X_OK);

      return {
        binary,
        arguments: [
          "--unshare-user",
          "--disable-userns",
          "--assert-userns-disabled",
          "--die-with-parent",
          "--cap-drop",
          "ALL",
          "--bind",
          "/",
          "/",
          "--dev",
          "/dev",
          ...mountRoots.flatMap((root) => ["--ro-bind", root, root]),
          "--",
          launch.binary,
          ...launch.arguments,
        ],
      };
    }
  } catch (cause) {
    throw protectionUnavailable(cause);
  }
  throw protectionUnavailable();
}
