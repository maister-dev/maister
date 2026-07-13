import { existsSync } from "node:fs";
import path from "node:path";

// Resolve how to spawn the MAIster MCP facade stdio server, in priority order:
//   1. explicit env override (split-host / custom deploy)
//   2. the built bundle run by the SAME node that runs web — prod-safe, with no
//      dependency on `tsx` (a devDep that `--prod` installs drop; the original
//      cause of silent tool-less agent sessions in production)
//   3. dev fallback: `tsx` on the TS source, resolved from the mcp package or
//      the workspace root
// Returns null when nothing is runnable in this deployment; callers fail loud
// only when the agent actually requires the facade.
export function resolveFacadeLaunch(): {
  command: string;
  args: string[];
} | null {
  const override = process.env.MAISTER_MCP_FACADE_COMMAND;

  if (override) {
    return {
      command: override,
      args: process.env.MAISTER_MCP_FACADE_ARGS
        ? process.env.MAISTER_MCP_FACADE_ARGS.split(" ").filter(Boolean)
        : ["--stdio"],
    };
  }

  const mcpDir = path.resolve(process.cwd(), "../mcp");
  const distEntry = path.join(mcpDir, "dist", "main.js");

  if (existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry, "--stdio"] };
  }

  const srcEntry = path.join(mcpDir, "src", "main.ts");

  for (const tsxBin of [
    path.join(mcpDir, "node_modules", ".bin", "tsx"),
    path.resolve(process.cwd(), "..", "node_modules", ".bin", "tsx"),
  ]) {
    if (existsSync(tsxBin) && existsSync(srcEntry)) {
      return { command: tsxBin, args: [srcEntry, "--stdio"] };
    }
  }

  return null;
}
