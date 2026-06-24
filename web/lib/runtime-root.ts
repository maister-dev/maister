import "server-only";

import path from "node:path";

const PACKAGE_CWD_NAMES = new Set(["web", "supervisor"]);

export function defaultRuntimeRoot(cwd: string = process.cwd()): string {
  const resolved = path.resolve(cwd);
  const basename = path.basename(resolved);

  return PACKAGE_CWD_NAMES.has(basename) ? path.dirname(resolved) : resolved;
}

export function runtimeRoot(): string {
  const configured = process.env.MAISTER_RUNTIME_ROOT;

  return configured ? path.resolve(configured) : defaultRuntimeRoot();
}
