import "server-only";

import { realpath } from "node:fs/promises";
import path from "node:path";

import { assertSafeAgentMaterializationPath } from "@/lib/agents/materialization-manifest";
import { MaisterError } from "@/lib/errors";
import { runtimeRoot } from "@/lib/runtime-root";

function contained(relative: string): boolean {
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Canonicalize the configured root alias, then refuse every symlink inside its managed capture path. */
export async function assertManagedCapturePath(
  candidate: string,
): Promise<string> {
  const configured = path.resolve(runtimeRoot());
  const root = await realpath(configured);
  const absolute = path.resolve(candidate);
  const configuredRelative = path.relative(configured, absolute);
  const physicalRelative = path.relative(root, absolute);
  const relative = contained(configuredRelative)
    ? configuredRelative
    : physicalRelative;

  if (!contained(relative))
    throw new MaisterError(
      "CONFIG",
      "Launch capture must remain inside its configured manager root",
      { details: { reason: "launch_capture_path_invalid" } },
    );
  await assertSafeAgentMaterializationPath(root, relative);

  return path.join(root, relative);
}
