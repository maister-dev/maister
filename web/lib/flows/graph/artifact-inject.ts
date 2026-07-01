import "server-only";

// ADR-120 (P2): pure string helpers for artifact-body injection into graph node
// prompts. NO I/O — testable in isolation. Two surfaces:
//   1. manual `{{ artifacts.<id>.content }}` template refs, and
//   2. `input.requires[].inline: true` auto-append.
// The content *resolution* (locator → text/json → cap) lives in
// `artifact-content.ts`; this module only (a) discovers which artifact ids a node
// references and (b) composes the auto-append XML tag. Both run BEFORE the shared
// `renderStrict`, so the injected value is already final text in `context` when
// the tag renders (the mustache re-render invariant — a body containing literal
// `{{ … }}` is substituted verbatim, never re-processed).

// Shared, delimiter-aware scan for `{{ artifacts.<id>.content }}` references.
// Matches ONLY inside a `{{ … }}` tag (a bare-text `artifacts.x.content` mention
// is ignored, avoiding false floor-gating / false resolution), captures the
// artifact id (hyphens allowed), and tolerates the `?? default` guard form. This
// is the SINGLE SOURCE OF TRUTH imported by BOTH the load-time engine-floor gate
// (`config.ts`) and the runtime collector — detection can never drift (D5/D10).
const CONTENT_REF_RE = /\{\{[^}]*\bartifacts\.([\w-]+)\.content\b[^}]*\}\}/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns every artifact id referenced via `{{ artifacts.<id>.content }}` in a
// single template string (delimiter-aware). Empty for null/undefined/no-match.
export function scanContentRefs(template: string | null | undefined): string[] {
  if (!template) return [];

  const ids: string[] = [];

  CONTENT_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = CONTENT_REF_RE.exec(template)) !== null) {
    ids.push(m[1]);
  }

  return ids;
}

type ScanGate = { kind?: string; prompt?: unknown; command?: unknown };
type ScanRequire = { inline?: unknown; artifact?: unknown; kind?: unknown };

// Node types whose ACTION renders `action.prompt` (via runAgentStep) vs
// `action.command` (via runCliStep) — mirrors executeNodeAction exactly. The
// action schemas are `.passthrough()`, so a leftover `action.command` on an agent
// node (or `action.prompt` on a cli node) is NEVER rendered; scanning it would
// force the engine floor / resolve a ref the executor ignores (Codex finding).
const PROMPT_ACTION_NODE_TYPES: ReadonlySet<string> = new Set([
  "ai_coding",
  "judge",
  "orchestrator",
]);
const COMMAND_ACTION_NODE_TYPES: ReadonlySet<string> = new Set([
  "cli",
  "check",
]);

// The anchored grammar for an artifact id that participates in body injection.
// It is interpolated into an XML attribute (`<artifact id="X">`) AND a dotted
// Mustache path (`{{ artifacts.X.content }}`), so it MUST be a slug — same
// character class as the scan capture group (`[\w-]+`); a `.`/`:`/quote/space
// would break the XML, the Mustache path, or the scan. Enforced at load for the
// inline surface (config.ts).
const INJECTABLE_ID_RE = /^[A-Za-z0-9_-]+$/;

// True when `id` is a valid body-injectable artifact id (slug grammar above).
export function isInjectableArtifactId(id: string): boolean {
  return INJECTABLE_ID_RE.test(id);
}

// The gate field the EXECUTOR renders through renderStrict (gates-exec.ts), so the
// content scan matches runtime exactly (no load-vs-runtime drift):
//   ai_judgment   → prompt    (runAgentStep)
//   skill_check   → command   (runAgentStep; the `/${skill}` fallback carries no
//                              template ref, so only `command` is scanned)
//   command_check → command   (runCliStep — same render path as a cli node)
// Every other gate kind renders no content-bearing template.
function renderedGateField(gate: ScanGate): string | undefined {
  const field =
    gate?.kind === "ai_judgment"
      ? gate.prompt
      : gate?.kind === "skill_check" || gate?.kind === "command_check"
        ? gate.command
        : undefined;

  return typeof field === "string" ? field : undefined;
}
type ScanNode = {
  type?: string;
  action?: { prompt?: unknown; command?: unknown };
  input?: { requires?: unknown[] };
  pre_finish?: { gates?: ScanGate[] };
};

// Returns true when a requires entry is the inline-object form (`{ artifact,
// kind, inline: true }`).
function isInlineRequire(
  req: unknown,
): req is ScanRequire & { artifact: string } {
  return (
    !!req &&
    typeof req === "object" &&
    (req as ScanRequire).inline === true &&
    typeof (req as ScanRequire).artifact === "string" &&
    ((req as ScanRequire).artifact as string).length > 0
  );
}

export type CollectContentOpts = {
  // Predicate deciding whether a `pre_finish` gate's content refs are collected.
  // Default: include every gate. The runner passes a policy-aware predicate that
  // EXCLUDES execution-policy-skipped gates (`checks=skip`), so a skipped gate's
  // refs are never resolved and can never fail the node (Codex finding #1). The
  // load-time engine-floor gate omits it → all gates considered (authoring time,
  // no runtime policy).
  includeGate?: (gate: { kind?: string }) => boolean;
};

// The union of artifact ids a node references for body injection (D10):
//   - `{{ artifacts.<id>.content }}` in `action.prompt` / `cli.command`,
//   - every `input.requires[].inline: true` entry's artifact id, and
//   - the field each INCLUDED `pre_finish` gate renders (ai_judgment→prompt,
//     skill_check/command_check→command — see `renderedGateField`).
// Deduped, insertion-ordered. With no `includeGate`, returning a non-empty array
// is exactly the load-time engine-floor trigger (config.ts). The runner passes a
// skip-aware `includeGate` so its resolution set omits policy-skipped gates.
export function collectContentArtifactIds(
  node: unknown,
  opts?: CollectContentOpts,
): string[] {
  const n = (node ?? {}) as ScanNode;
  const includeGate = opts?.includeGate ?? (() => true);
  const ids = new Set<string>();

  // Type-aware action scan (Codex finding): scan ONLY the action field the node's
  // executor actually renders — `action.prompt` for agent nodes (runAgentStep),
  // `action.command` for cli/check (runCliStep). The action schemas are
  // `.passthrough()`, so an unused leftover field on the other node type must not
  // trigger resolution or engine-floor gating. An unknown/absent `type` (defensive
  // callers) scans both.
  if (n.type === undefined || PROMPT_ACTION_NODE_TYPES.has(n.type)) {
    const prompt =
      typeof n.action?.prompt === "string" ? n.action.prompt : undefined;

    for (const id of scanContentRefs(prompt)) ids.add(id);
  }
  if (n.type === undefined || COMMAND_ACTION_NODE_TYPES.has(n.type)) {
    const command =
      typeof n.action?.command === "string" ? n.action.command : undefined;

    for (const id of scanContentRefs(command)) ids.add(id);
  }

  for (const req of n.input?.requires ?? []) {
    if (isInlineRequire(req)) ids.add(req.artifact);
  }

  for (const g of n.pre_finish?.gates ?? []) {
    if (!includeGate(g)) continue;
    for (const id of scanContentRefs(renderedGateField(g))) ids.add(id);
  }

  return [...ids];
}

export type InlineRequire = { artifact: string; kind: string };

// The `{ artifact, kind }` pairs a node declares with `inline: true` (D2/D12
// auto-append surface). `kind` defaults to "" if absent (schema requires it, but
// the helper stays defensive).
export function inlineRequires(node: unknown): InlineRequire[] {
  const n = (node ?? {}) as ScanNode;
  const out: InlineRequire[] = [];

  for (const req of n.input?.requires ?? []) {
    if (isInlineRequire(req)) {
      const kind = (req as ScanRequire).kind;

      out.push({
        artifact: req.artifact,
        kind: typeof kind === "string" ? kind : "",
      });
    }
  }

  return out;
}

// True when `rawPrompt` already references `artifacts.<id>.content` inside a
// `{{ … }}` tag — the dedup signal (D2): manual placement wins, single injection.
function referencesContent(rawPrompt: string, id: string): boolean {
  const re = new RegExp(
    `\\{\\{[^}]*\\bartifacts\\.${escapeRegExp(id)}\\.content\\b[^}]*\\}\\}`,
  );

  return re.test(rawPrompt);
}

export type InlineAugmentResult = {
  prompt: string;
  injectedIds: string[];
  skippedIds: string[];
};

// Appends one XML-tag block per inline entry NOT already referenced in
// `rawPrompt` (D1/D2). Each block is `\n<artifact id="X" kind="K">\n{{
// artifacts.X.content }}\n</artifact>` — a TEMPLATE TAG resolved later by the
// shared `renderStrict`, never the resolved body (mustache re-render invariant).
// Deterministic order; appended AFTER whatever `rawPrompt` already contains
// (e.g. the `[Run context: …]` pointer). Pure: the caller logs WARN/INFO with the
// node id from `skippedIds`/`injectedIds`.
export function augmentPromptWithInlineTags(
  rawPrompt: string,
  inlineEntries: ReadonlyArray<InlineRequire>,
): InlineAugmentResult {
  const injectedIds: string[] = [];
  const skippedIds: string[] = [];
  let prompt = rawPrompt;

  for (const entry of inlineEntries) {
    if (
      referencesContent(rawPrompt, entry.artifact) ||
      injectedIds.includes(entry.artifact)
    ) {
      skippedIds.push(entry.artifact);
      continue;
    }

    prompt += `\n<artifact id="${entry.artifact}" kind="${entry.kind}">\n{{ artifacts.${entry.artifact}.content }}\n</artifact>`;
    injectedIds.push(entry.artifact);
  }

  return { prompt, injectedIds, skippedIds };
}
