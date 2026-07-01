import "server-only";

import type { ArtifactInstance, ArtifactLocator } from "@/lib/db/schema";
import type { Db } from "./runner-core";

import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { artifactInlineMaxBytes } from "@/lib/instance-config";
import {
  DIFF_TRUNCATED_MARKER,
  diffRange,
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
//   resolveArtifactContent  (locator → RAW value; SRP, NO cap, NO divergence)
//   artifactContentToTemplateText  (json → pretty-print; D9)
//   capForInline  (256 KiB body cap; D3 — applied ONLY at the injection seam)
// The payload route uses ONLY resolveArtifactContent, so its HTTP contract stays
// byte-identical (full body, no cap, structured JSON for json locators).

// In-band marker appended when an injected body is cut at the inline cap. A
// structured `{ truncated: true }` rides alongside (the consumer branches on it);
// the marker is the human-visible tail in the prompt itself.
export const ARTIFACT_TRUNCATED_MARKER =
  "\n\n[maister: artifact body truncated — exceeded MAISTER_ARTIFACT_INLINE_MAX_BYTES]\n";

// RAW resolver result — uncapped. `text` for text-shaped payloads, `value` for
// JSON-shaped payloads (gate-verdict / hitl-response). `gone` = the payload
// existed but is now missing (deleted file); `notfound` = the locator does not
// resolve to anything readable (traversal, symlink escape, missing row, unknown
// kind).
export type ResolveArtifactContentResult =
  | { kind: "text"; text: string }
  | { kind: "json"; value: unknown }
  | { kind: "gone" }
  | { kind: "notfound" };

export type ResolveArtifactContentCtx = {
  worktreePath: string;
  projectSlug: string;
  runId: string;
  runtimeRoot: string;
  db: Db;
  // ADR-120 (Codex finding #2): the injection path sets this to bound the `file`
  // locator read to at most `maxBytes` bytes — so a multi-GB file artifact never
  // allocates its full payload in the web process before `capForInline` trims it.
  // The payload API route leaves it UNSET → full uncapped read (contract
  // unchanged). The other locator kinds are already bounded (inline in-memory,
  // git-range/git-log by EXEC_MAX_BUFFER, gate-verdict/hitl small JSON rows).
  maxBytes?: number;
};

// Reads at most `maxBytes` bytes from an already-confined real path without
// loading the whole file (Codex finding #2). A multibyte UTF-8 sequence may be
// split at the byte boundary — that lands only in the tail the caller's
// `capForInline` trims (it reads `cap + 1`, then truncates to `cap` on a
// codepoint boundary), so the injected text is always clean.
async function readBounded(real: string, maxBytes: number): Promise<string> {
  const fh = await open(real, "r");

  try {
    const buf = new Uint8Array(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);

    return new TextDecoder().decode(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

// Port of the payload route's `serveFile` confinement — IDENTICAL semantics so
// the route can delegate without contract drift. Lexical prefix check BEFORE any
// fs access (a `../` traversal never touches the outside path), then a
// symlink-realpath re-confinement. Reads the FULL file unless `maxBytes` bounds
// it (injection path only — D3/Codex #2).
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

  const body =
    maxBytes === undefined
      ? await readFile(real, "utf8")
      : await readBounded(real, maxBytes);

  return { kind: "text", text: body };
}

// Pure locator → content resolution. RAW (no cap, no truncation here — D7). The
// `git-range` case preserves diffRange's OWN truncation marker (pre-existing,
// unrelated to the inline cap) so the route stays byte-identical.
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
      const range = await diffRange({
        worktreePath: ctx.worktreePath,
        baseRef: locator.baseCommit,
        branch: locator.headRef,
      });
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

        return { kind: "text", text: bounded.text };
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
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");

  if (buf.length <= maxBytes) return text;

  let end = maxBytes;

  // Walk back off any continuation byte (0b10xxxxxx) so we cut on a code-point
  // boundary — decoding the slice never yields a replacement char.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;

  return buf.subarray(0, end).toString("utf8");
}

// D3: cap a resolved body for prompt injection. Byte-bounded by `maxBytes`
// (defaults to MAISTER_ARTIFACT_INLINE_MAX_BYTES, read fresh so an env override is
// honored; the runner passes the same value it used to bound the file read so the
// two stay consistent in one operation). UTF-8-safe, appends
// ARTIFACT_TRUNCATED_MARKER on cut. Applied ONLY here — never in the resolver,
// never on the payload route. Never throws on a large body.
export function capForInline(
  text: string,
  maxBytes: number = artifactInlineMaxBytes(),
): {
  text: string;
  truncated: boolean;
} {
  const max = maxBytes;

  if (Buffer.byteLength(text, "utf8") <= max) {
    return { text, truncated: false };
  }

  const head = truncateUtf8(text, max);

  log.debug({ truncated: true }, "capForInline truncated artifact body");

  return { text: head + ARTIFACT_TRUNCATED_MARKER, truncated: true };
}
