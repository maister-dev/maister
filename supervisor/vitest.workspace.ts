import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineWorkspace } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const alias = {
  "@": resolve(__dirname, "src"),
};

// The pinned Vite (5.4.21) predates `node:sqlite` in its builtin list, so its
// resolver strips the `node:` prefix and vite-node then fails to load bare
// `sqlite` whenever a suite transitively imports adapter-smoke-cache-lock.
// Externalization config does not help (vite-node still transforms the id), so
// resolve `node:sqlite` to a virtual module that pulls the real builtin through
// `createRequire` at runtime. Vite only ever transforms `node:module`, which it
// does recognize; production code imports `node:sqlite` directly (Node 26+).
const NODE_SQLITE_SHIM_ID = "\0node-sqlite-shim";
const nodeSqliteShim = {
  name: "node-sqlite-shim",
  enforce: "pre" as const,
  resolveId(id: string) {
    return id === "node:sqlite" || id === "sqlite" ? NODE_SQLITE_SHIM_ID : null;
  },
  load(id: string) {
    if (id !== NODE_SQLITE_SHIM_ID) return null;

    return [
      "import { createRequire } from 'node:module';",
      "const nodeRequire = createRequire(import.meta.url);",
      "const mod = nodeRequire('node:sqlite');",
      "export const DatabaseSync = mod.DatabaseSync;",
      "export default mod;",
    ].join("\n");
  },
};

export default defineWorkspace([
  {
    resolve: { alias },
    plugins: [nodeSqliteShim],
    test: {
      name: "unit",
      include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
      exclude: ["src/**/*.integration.test.ts"],
      environment: "node",
    },
  },
  {
    resolve: { alias },
    plugins: [nodeSqliteShim],
    test: {
      name: "integration",
      include: ["src/**/*.integration.test.ts"],
      environment: "node",
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
