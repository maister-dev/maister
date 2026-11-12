import "server-only";

import { isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { MaisterError } from "@/lib/errors";

/**
 * Address live host data independently of the application bundle. Node accepts
 * file URLs directly; requiring an absolute path prevents an accidental read
 * from the web process working directory. Callers retain their confinement and
 * symlink checks before opening the URL.
 */
export function runtimeFileUrl(absolutePath: string): URL {
  if (!isAbsolute(absolutePath)) {
    throw new MaisterError(
      "CONFIG",
      "Runtime filesystem access requires an absolute path",
      {
        details: { path: absolutePath },
      },
    );
  }

  return pathToFileURL(absolutePath);
}

/** Join runtime-owned names without treating them as application-relative assets. */
export function runtimePathUrl(directory: string, ...parts: string[]): URL {
  runtimeFileUrl(directory);

  return pathToFileURL([directory, ...parts].join(sep));
}
