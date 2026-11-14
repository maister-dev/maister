import "server-only";

import type { ArtifactInstance, ArtifactLocator } from "@/lib/db/schema";
import type { Db } from "./runner-core";

import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { readRuntimeObjectContent } from "@/lib/execution-host/runtime-objects";
import { MaisterError } from "@/lib/errors";
import { artifactInlineMaxBytes } from "@/lib/instance-config";
import {
  DIFF_TRUNCATED_MARKER,
  diffRange,
  diffRangeBounded,
  logRange,
  logRangeBounded,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { gateResults, hitlRequests } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "flow-artifact-content",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-120 (P2): the SHARED artifact-content layer. Three named, ordered steps —
// the injection pipeline (D11) is resolve → convert → cap:
//   resolveArtifactContent  (locator → value; optional I/O read budget)
//   artifactContentToTemplateText  (json → pretty-print; D9)
//   capForInline  (256 KiB body cap; D3 — applied ONLY at the injection seam)
// Downloads keep the raw representation. Explicit previews supply a read budget.

// In-band marker appended when an injected body is cut at the inline cap. A
// structured `{ truncated: true }` rides alongside (the consumer branches on it);
// the marker is the human-visible tail in the prompt itself.
export const ARTIFACT_TRUNCATED_MARKER =
  "\n\n[maister: artifact body truncated — exceeded MAISTER_ARTIFACT_INLINE_MAX_BYTES]\n";

// `text` for text-shaped payloads, `value` for
// JSON-shaped payloads (gate-verdict / hitl-response). `gone` = the payload
// existed but is now missing (deleted file); `notfound` = the locator does not
// resolve to anything readable (traversal, symlink escape, missing row, unknown
// kind).
export type ResolveArtifactContentResult =
  | { kind: "text"; text: string; truncated?: true }
  | { kind: "json"; value: unknown }
  | { kind: "gone" }
  | { kind: "notfound" };

export type ResolveArtifactContentCtx = {
  worktreePath: string;
  projectSlug: string;
  runId: string;
  runtimeRoot: string;
  db: Db;
  // Maximum retained source bytes for a file, Git, or runtime object read.
  maxBytes?: number;
};

type TextContent = Extract<ResolveArtifactContentResult, { kind: "text" }>;

function textContent(text: string, truncated: boolean): TextContent {
  return truncated
    ? { kind: "text", text, truncated: true }
    : { kind: "text", text };
}

async function readBounded(
  real: string,
  maxBytes: number,
): Promise<TextContent> {
  const fh = await open(real, "r");

  try {
    const buf = new Uint8Array(maxBytes + 1);
    let offset = 0;

    while (offset < buf.length) {
      const { bytesRead } = await fh.read(
        buf,
        offset,
        buf.length - offset,
        offset,
      );

      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const truncated = offset > maxBytes;
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      buf.subarray(0, Math.min(offset, maxBytes)),
      { stream: truncated },
    );

    return textContent(text, truncated);
  } finally {
    await fh.close();
  }
}

// Port of the payload route's `serveFile` confinement — IDENTICAL semantics so
// the route can delegate without contract drift. Lexical prefix check BEFORE any
// fs access (a `../` traversal never touches the outside path), then a
// symlink-realpath re-confinement. Reads the FULL file unless `maxBytes` bounds
// it.
async function resolveFile(
  locatorPath: string,
  projectSlug: string,
  runId: string,
  runtimeRoot: string,
  maxBytes: number | undefined,
): Promise<ResolveArtifactContentResult> {
  const runDirRoot = path.join(
    runtimeRoot,
    ".maister",
    projectSlug,
    "runs",
    runId,
  );
  const lexical = path.resolve(runDirRoot, locatorPath);
  const rootResolved = path.resolve(runDirRoot);

  if (
    lexical !== rootResolved &&
    !lexical.startsWith(rootResolved + path.sep)
  ) {
    return { kind: "notfound" };
  }

  let real: string;

  try {
    real = await realpath(lexical);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "gone" };
    }
    throw e;
  }

  const rootReal = await realpath(rootResolved);

  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return { kind: "notfound" };
  }

  return maxBytes === undefined
    ? { kind: "text", text: await readFile(real, "utf8") }
    : readBounded(real, maxBytes);
}

// Raw Git diffs retain their historical diffRange truncation marker.
export async function resolveArtifactContent(
  artifact: Pick<ArtifactInstance, "locator">,
  ctx: ResolveArtifactContentCtx,
): Promise<ResolveArtifactContentResult> {
  const locator = artifact.locator as ArtifactLocator;

  log.debug(
    { runId: ctx.runId, locatorKind: locator.kind },
    "resolveArtifactContent",
  );

  switch (locator.kind) {
    case "inline":
      return { kind: "text", text: locator.text };

    case "gate-verdict": {
      const rows = (await ctx.db
        .select()
        .from(gateResults)
        .where(
          and(
            eq(gateResults.id, locator.gateResultId),
            eq(gateResults.runId, ctx.runId),
          ),
        )) as Array<{ id: string; runId: string; verdict: unknown }>;
      const row = rows.find(
        (r) => r.id === locator.gateResultId && r.runId === ctx.runId,
      );

      if (!row) return { kind: "notfound" };

      return { kind: "json", value: row.verdict };
    }

    case "hitl-response": {
      const rows = (await ctx.db
        .select()
        .from(hitlRequests)
        .where(
          and(
            eq(hitlRequests.id, locator.hitlRequestId),
            eq(hitlRequests.runId, ctx.runId),
          ),
        )) as Array<{ id: string; runId: string; response: unknown }>;
      const row = rows.find(
        (r) => r.id === locator.hitlRequestId && r.runId === ctx.runId,
      );

      if (!row) return { kind: "notfound" };

      return { kind: "json", value: row.response };
    }

    case "git-range": {
      const args = {
        worktreePath: ctx.worktreePath,
        baseRef: locator.baseCommit,
        branch: locator.headRef,
      };

      if (ctx.maxBytes !== undefined) {
        const bounded = await diffRangeBounded(args, ctx.maxBytes);

        return textContent(bounded.text, bounded.truncated);
      }
      const range = await diffRange(args);
      const text = range.truncated
        ? range.text + DIFF_TRUNCATED_MARKER
        : range.text;

      return { kind: "text", text };
    }

    case "git-log": {
      // ADR-120 (Codex #2): on the injection path (maxBytes set) stream a bounded
      // read so an oversized commit range TRUNCATES (via capForInline downstream)
      // instead of throwing; the payload route (no maxBytes) keeps the full read.
      if (ctx.maxBytes !== undefined) {
        const bounded = await logRangeBounded(
          {
            worktreePath: ctx.worktreePath,
            baseRef: locator.baseRef,
            branch: locator.headRef,
          },
          ctx.maxBytes,
        );

        return textContent(bounded.text, bounded.truncated);
      }

      const out = await logRange({
        worktreePath: ctx.worktreePath,
        baseRef: locator.baseRef,
        branch: locator.headRef,
      });

      return { kind: "text", text: out };
    }

    case "file":
      return resolveFile(
        locator.path,
        ctx.projectSlug,
        ctx.runId,
        ctx.runtimeRoot,
        ctx.maxBytes,
      );

    case "execution-object": {
      try {
        const content = await readRuntimeObjectContent({
          db: ctx.db,
          runId: ctx.runId,
          objectId: locator.objectId,
          ...(ctx.maxBytes === undefined
            ? {}
            : { range: { start: 0, end: Math.max(0, ctx.maxBytes - 1) } }),
        });

        const truncated =
          ctx.maxBytes !== undefined &&
          content.object.sizeBytes !== null &&
          content.object.sizeBytes > ctx.maxBytes;

        return textContent(
          new TextDecoder().decode(content.content.bytes, {
            stream: truncated,
          }),
          truncated,
        );
      } catch (error) {
        if (error instanceof MaisterError && error.code === "PRECONDITION") {
          return { kind: "gone" };
        }
        throw error;
      }
    }

    default:
      return { kind: "notfound" };
  }
}

// D9: the SINGLE named json→text converter. A `json` locator becomes pretty
// JSON (never `[object Object]`/`undefined`); a `text` locator passes through.
// `gone`/`notfound` are caller errors at the injection seam → strict CONFIG.
export function artifactContentToTemplateText(
  result: ResolveArtifactContentResult,
  artifactId: string,
): string {
  switch (result.kind) {
    case "text":
      return result.text;
    case "json":
      return JSON.stringify(result.value, null, 2);
    case "gone":
      throw new MaisterError(
        "CONFIG",
        `artifact "${artifactId}" body is gone (payload deleted) — cannot inject content`,
      );
    case "notfound":
      throw new MaisterError(
        "CONFIG",
        `artifact "${artifactId}" body not found — cannot inject content`,
      );
  }
}

// UTF-8-boundary-safe byte truncation. Returns the largest prefix whose UTF-8
// encoding is <= maxBytes without splitting a multibyte sequence.
export function boundArtifactText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes)
    return { text, truncated: false };

  const buf = Buffer.alloc(maxBytes);
  const bytesWritten = buf.write(text, 0, maxBytes, "utf8");

  return { text: buf.toString("utf8", 0, bytesWritten), truncated: true };
}

// D3: cap a resolved body for prompt injection. Byte-bounded by `maxBytes`
// (defaults to MAISTER_ARTIFACT_INLINE_MAX_BYTES, read fresh so an env override is
// honored; the runner passes the same value it used to bound the file read so the
// two stay consistent in one operation). Appends ARTIFACT_TRUNCATED_MARKER
// when either the source read or the final UTF-8 encoding was truncated.
export function capForInline(
  input: string | TextContent,
  maxBytes: number = artifactInlineMaxBytes(),
): {
  text: string;
  truncated: boolean;
} {
  const bounded = boundArtifactText(
    typeof input === "string" ? input : input.text,
    maxBytes,
  );

  if (!(typeof input !== "string" && input.truncated) && !bounded.truncated)
    return bounded;
  log.debug({ truncated: true }, "capForInline truncated artifact body");

  return { text: bounded.text + ARTIFACT_TRUNCATED_MARKER, truncated: true };
}
