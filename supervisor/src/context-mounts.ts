import type { GuardrailToolCall } from "./guardrail-hooks";
import type { ContextMount, SessionRecord } from "./types";

import { realpath } from "node:fs/promises";
import path from "node:path";

import { extractWritePath, toRootRelative } from "./guardrail-hooks";

// ADR-157: read-only sibling-repo context mounts. The supervisor never
// materializes or removes a mount — it only tells the agent they exist (the
// preamble) and enforces that they stay read-only (L2, below). The env var
// (`MAISTER_CONTEXT_REPOS`) is derived in spawn.ts.

// Realpath the deepest EXISTING segment and re-join the missing tail. A lexical
// `path.resolve` is not enough on either side of the comparison: a symlinked
// ancestor lets the same file be spelled two ways (macOS `/tmp` ->
// `/private/tmp`), and an agent can point a symlink at a mount and write
// "outside" it. Never throws — an unresolvable path falls back to its lexical
// form, and the caller compares BOTH forms so a failed realpath can only ever
// deny more, never less.
export async function realpathNearestExisting(p: string): Promise<string> {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cursor = abs;

  for (;;) {
    try {
      return path.join(await realpath(cursor), ...tail);
    } catch {
      const parent = path.dirname(cursor);

      if (parent === cursor) return abs;

      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export type ContextMountDecision =
  | { readonly decision: "allow" }
  | {
      readonly decision: "deny";
      readonly mount: ContextMount;
      readonly path: string;
    }
  // A write-class call whose path the adapter never reported (no
  // `toolCall.locations`): no mount root can be checked. NOT a deny — that would
  // break every write on the kind-only adapters (gemini / opencode / mimo),
  // including writes to the session's own worktree. L3 (terminal dirty check) is
  // the backstop; the caller WARNs once.
  | { readonly decision: "unverifiable" };

// Both spellings of a path: lexical, and realpath-normalized. Compared as a set
// so a symlinked ancestor cannot hide a path from the guard.
async function resolvedForms(p: string): Promise<string[]> {
  return [...new Set([path.resolve(p), await realpathNearestExisting(p)])];
}

function isUnderAnyRoot(
  roots: readonly string[],
  candidates: readonly string[],
): boolean {
  return roots.some((root) =>
    candidates.some((candidate) => toRootRelative(root, candidate) !== null),
  );
}

// L2 (ADR-157): the pure mount-guard decision — deny a write-class tool call
// whose path resolves under any declared mount root. Containment is decided by
// `toRootRelative`, the SAME resolver `path_guard` uses; only the realpath
// normalization is added on top of it.
export async function resolveContextMountDecision(args: {
  mounts: readonly ContextMount[] | undefined;
  toolCall: GuardrailToolCall;
}): Promise<ContextMountDecision> {
  const { mounts, toolCall } = args;

  if (!mounts || mounts.length === 0) return { decision: "allow" };
  // `extractWritePath` stays the SSOT for "is this call write-class".
  if (!extractWritePath(toolCall).isWrite) return { decision: "allow" };

  // EVERY reported location, not just `locations[0]`: a move/rename reports
  // source and destination separately, and either one landing in a mount is a
  // write to that mount.
  const targets = (toolCall.locations ?? [])
    .map((l) => l.path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  if (targets.length === 0) return { decision: "unverifiable" };

  const mountRoots = await Promise.all(
    mounts.map(async (mount) => ({
      mount,
      roots: await resolvedForms(mount.path),
    })),
  );

  for (const target of targets) {
    const candidates = await resolvedForms(target);
    const hit = mountRoots.find(({ roots }) =>
      isUnderAnyRoot(roots, candidates),
    );

    if (hit) return { decision: "deny", mount: hit.mount, path: target };
  }

  return { decision: "allow" };
}

// ADR-157: the session's prompt preamble. `MAISTER_CONTEXT_REPOS` serves
// scripts; this is how the AGENT learns the mounts exist at all. Returns null
// when the session has no mounts (the prompt is then forwarded untouched).
export function renderContextMountPreamble(
  mounts: readonly ContextMount[] | undefined,
): string | null {
  if (!mounts || mounts.length === 0) return null;

  const lines = mounts.map(
    (m) => `- ${m.slug}: ${m.path} (ref ${m.ref}) — READ-ONLY`,
  );

  return [
    "Read-only context repositories mounted for this session:",
    ...lines,
    "Each is a detached checkout of another project, mounted so you can READ it.",
    "Every write under those paths is denied by the supervisor — make all changes in your own worktree.",
  ].join("\n");
}

// One-shot: the preamble goes on the FIRST prompt of a session and never again
// (a resume rebuilds the record, so a respawned session re-grounds once).
export function takeContextMountPreamble(
  record: Pick<SessionRecord, "contextMounts" | "contextMountPreambleSent">,
): string | null {
  if (record.contextMountPreambleSent) return null;

  const preamble = renderContextMountPreamble(record.contextMounts);

  if (preamble) record.contextMountPreambleSent = true;

  return preamble;
}
