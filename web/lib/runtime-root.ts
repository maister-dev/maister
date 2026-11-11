import "server-only";

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_CWD_NAMES = new Set(["web", "supervisor"]);

export function defaultRuntimeRoot(cwd: string = process.cwd()): string {
  const resolved = fileURLToPath(pathToFileURL(cwd));
  const basename = path.basename(resolved);

  return PACKAGE_CWD_NAMES.has(basename) ? path.dirname(resolved) : resolved;
}

export function runtimeRoot(): string {
  const configured = process.env.MAISTER_RUNTIME_ROOT;

  return configured
    ? fileURLToPath(pathToFileURL(configured))
    : defaultRuntimeRoot();
}
