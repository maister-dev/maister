import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineWorkspace } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const alias = {
  "@": resolve(__dirname, "."),
  "server-only": resolve(__dirname, "node_modules/server-only/empty.js"),
};

// The pinned Vite predates `node:sqlite` in its builtin list, so its resolver
// strips the `node:` prefix and vite-node then fails to load bare `sqlite`
// whenever a suite transitively imports the agent materialization lock.
// Externalization does not help (vite-node still transforms the id), so resolve
// `node:sqlite` to a virtual module that pulls the real builtin through
// `createRequire` at runtime. Mirrors supervisor/vitest.workspace.ts; production
// code imports `node:sqlite` directly.
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
      include: [
        "lib/**/*.test.ts",
        "lib/**/__tests__/**/*.test.ts",
        "app/**/__tests__/**/*.test.ts",
        "components/**/*.test.ts",
        "components/**/__tests__/**/*.test.ts",
        "styles/**/*.test.ts",
        "test-support/**/*.test.ts",
        "test-support/**/__tests__/**/*.test.ts",
        "e2e/**/*.test.ts",
        "e2e/**/__tests__/**/*.test.ts",
      ],
      exclude: [
        "lib/**/*.integration.test.ts",
        "app/**/*.integration.test.ts",
        "test-support/**/*.integration.test.ts",
        "e2e/**/*.integration.test.ts",
      ],
      environment: "node",
    },
  },
  {
    resolve: { alias },
    plugins: [nodeSqliteShim],
    test: {
      name: "integration",
      include: [
        "lib/**/*.integration.test.ts",
        "app/**/*.integration.test.ts",
        "test-support/**/*.integration.test.ts",
        "e2e/**/*.integration.test.ts",
      ],
      environment: "node",
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
