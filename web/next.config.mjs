import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
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
