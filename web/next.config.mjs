import path from "node:path";
import { fileURLToPath } from "node:url";

import createNextIntlPlugin from "next-intl/plugin";

import { buildMaxWorkers } from "../scripts/validation-resources.mjs";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");
// The pnpm workspace root is the module-resolution boundary (web imports
// ../runtime/node-version). Left to inference, Next walks up to the nearest
// lockfile, so a stray lockfile above the checkout (e.g. in $HOME) becomes the
// root instead and every dev boot warns about it.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const buildWorkers = buildMaxWorkers(process.env);

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    authInterrupts: true,
    // Persisted compilation data need not occupy RAM throughout an idle dev
    // session. Keep source maps and on-demand rebuilding available.
    turbopackMemoryEviction: "full",
    turbopackLazyDynamicImports: true,
    turbopackLazyDynamicImportsSSR: true,
    ...(buildWorkers === undefined ? {} : { cpus: buildWorkers }),
  },
  // Test fixture builds run type checking in a separate validation lane.
  typescript: {
    tsconfigPath: "tsconfig.build.json",
    ignoreBuildErrors: process.env.MAISTER_TEST_WEB_BUILD === "1",
  },
  // These server dependencies already run in Node. Bundling their module graphs
  // again for instrumentation and every route inflates dev compilation memory.
  serverExternalPackages: ["pg", "drizzle-orm", "undici", "yaml", "zod"],
  turbopack: {
    root: repoRoot,
    resolveAlias: {
      // FINDING G (ADR-066): replace git-diff-view's lowlight/highlight.js
      // engine with a grammar-free stub. The diff syntax bundle is built
      // server-side with Shiki and hydrated with `diffViewHighlight={true}` +
      // NO client highlighter, so git-diff-view restores the pre-merged syntax
      // without invoking the default engine — this keeps ~hundreds of KB of
      // highlight.js grammars out of the diff client chunk. See
      // `lib/diff/lowlight-stub.ts`.
      "@git-diff-view/lowlight": "./lib/diff/lowlight-stub.ts",
    },
  },
};

export default withNextIntl(nextConfig);
