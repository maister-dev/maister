import "server-only";

import type { BuiltInSourceKind } from "./chunkers/types";

import { MaisterError } from "@/lib/errors";

export const BRAIN_INDEXING_PROFILE_VALUES = [
  "docs",
  "docs_source",
  "all",
] as const;

export type BrainIndexingProfile =
  (typeof BRAIN_INDEXING_PROFILE_VALUES)[number];

export interface BrainProfileSourceInput {
  path: string;
  kind: BuiltInSourceKind;
  chunkerId: string;
}

const DOC_SOURCE_INPUTS = [
  { path: "README.md", kind: "markdown", chunkerId: "markdown" },
  { path: "AGENTS.md", kind: "markdown", chunkerId: "markdown" },
  { path: "CLAUDE.md", kind: "markdown", chunkerId: "markdown" },
  { path: "docs/**/*.md", kind: "markdown", chunkerId: "markdown" },
  { path: "docs/decisions.md", kind: "markdown", chunkerId: "markdown" },
  { path: "docs/ROADMAP.md", kind: "markdown", chunkerId: "markdown" },
  { path: "docs/api/*.yaml", kind: "openapi", chunkerId: "openapi" },
  { path: "maister.yaml", kind: "flow_yaml", chunkerId: "flow_yaml" },
] as const satisfies readonly BrainProfileSourceInput[];

const CODE_SOURCE_INPUTS = [
  {
    path: "src/**/*.{ts,tsx,js,jsx,py,rs,go,java}",
    kind: "code",
    chunkerId: "code",
  },
  {
    path: "app/**/*.{ts,tsx,js,jsx}",
    kind: "code",
    chunkerId: "code",
  },
  {
    path: "components/**/*.{ts,tsx,js,jsx}",
    kind: "code",
    chunkerId: "code",
  },
  {
    path: "lib/**/*.{ts,tsx,js,jsx,py,rs,go,java}",
    kind: "code",
    chunkerId: "code",
  },
  {
    path: "web/app/**/*.{ts,tsx}",
    kind: "code",
    chunkerId: "code",
  },
  {
    path: "web/components/**/*.{ts,tsx}",
    kind: "code",
    chunkerId: "code",
  },
  {
    path: "web/lib/**/*.{ts,tsx}",
    kind: "code",
    chunkerId: "code",
  },
  {
    path: "supervisor/src/**/*.ts",
    kind: "code",
    chunkerId: "code",
  },
  { path: "mcp/src/**/*.ts", kind: "code", chunkerId: "code" },
  { path: "scripts/**/*.{ts,js,mjs}", kind: "code", chunkerId: "code" },
  { path: "package.json", kind: "text", chunkerId: "text" },
  { path: "web/package.json", kind: "text", chunkerId: "text" },
  { path: "supervisor/package.json", kind: "text", chunkerId: "text" },
  { path: "pnpm-workspace.yaml", kind: "text", chunkerId: "text" },
] as const satisfies readonly BrainProfileSourceInput[];

const INTERNAL_SOURCE_INPUTS = [
  { path: ".ai-factory/**/*.md", kind: "markdown", chunkerId: "markdown" },
  { path: ".ai-factory/**/*.yaml", kind: "text", chunkerId: "text" },
  { path: ".agents/**/*.md", kind: "agent_md", chunkerId: "agent_md" },
  { path: ".codex/**/*.md", kind: "markdown", chunkerId: "markdown" },
  { path: ".claude/**/*.md", kind: "markdown", chunkerId: "markdown" },
] as const satisfies readonly BrainProfileSourceInput[];

function sourceKey(source: BrainProfileSourceInput): string {
  return `${source.kind}\0${source.path}`;
}

export function normalizeBrainIndexingProfile(
  value: unknown,
): BrainIndexingProfile {
  if (
    typeof value === "string" &&
    (BRAIN_INDEXING_PROFILE_VALUES as readonly string[]).includes(value)
  ) {
    return value as BrainIndexingProfile;
  }

  throw new MaisterError(
    "CONFIG",
    `invalid Brain indexing profile: ${String(value)}`,
  );
}

export function brainSourceInputsForProfile(
  profile: BrainIndexingProfile,
): BrainProfileSourceInput[] {
  const inputs =
    profile === "docs"
      ? DOC_SOURCE_INPUTS
      : profile === "docs_source"
        ? [...DOC_SOURCE_INPUTS, ...CODE_SOURCE_INPUTS]
        : [...DOC_SOURCE_INPUTS, ...CODE_SOURCE_INPUTS, ...INTERNAL_SOURCE_INPUTS];
  const seen = new Set<string>();

  return inputs.filter((source) => {
    const key = sourceKey(source);

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}
