// Client-importable (no `server-only`, no node:*, no fs): the package-artifact
// editors (T4.4) run in the browser and the content-validation gate (T4.2) runs
// on both sides. Frontmatter is the Claude-Code SKILL.md / agent.md convention —
// a leading `---`-fenced yaml block, then a markdown body. We parse it with the
// already-present `yaml` package (NO `gray-matter` dep).

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

/**
 * The outcome of splitting a markdown artifact into its (optional) frontmatter
 * and body. Discriminated so the consumer (T4.2 validation) can tell apart:
 * - `ok:true, frontmatter:undefined` — NO leading fence at all (or an empty
 *   fence): a plain markdown file. NOT a validation failure.
 * - `ok:true, frontmatter:<object>`  — a well-formed leading fence.
 * - `ok:false, malformed:true`       — a leading fence is PRESENT but its yaml
 *   is unparseable / unterminated / not an object. This is the "broken
 *   frontmatter" signal that the runtime would silently choke on.
 */
export type FrontmatterSplit =
  | {
      ok: true;
      frontmatter?: Record<string, unknown>;
      body: string;
      raw: string;
    }
  | { ok: false; malformed: true; raw: string; reason: string };

const FENCE = "---";

// A leading frontmatter block must open with `---` on the very first line.
// Tolerate a UTF-8 BOM and CRLF line endings.
function stripBom(content: string): { bom: string; rest: string } {
  if (content.charCodeAt(0) === 0xfeff) {
    return { bom: content.slice(0, 1), rest: content.slice(1) };
  }

  return { bom: "", rest: content };
}

export function splitFrontmatter(content: string): FrontmatterSplit {
  const { rest } = stripBom(content);

  // Opening fence must be the first line and be exactly `---` (allow trailing
  // CR). Anything else → no frontmatter; the whole content is the body.
  const firstNewline = rest.indexOf("\n");
  const firstLine = (
    firstNewline === -1 ? rest : rest.slice(0, firstNewline)
  ).replace(/\r$/, "");

  if (firstLine !== FENCE || firstNewline === -1) {
    return { ok: true, frontmatter: undefined, body: content, raw: content };
  }

  const afterOpen = rest.slice(firstNewline + 1);

  // Find the closing fence: a line that is exactly `---` (allow trailing CR).
  const closeMatch = afterOpen.match(/(^|\n)---[ \t]*\r?(\n|$)/);

  if (!closeMatch || closeMatch.index === undefined) {
    return {
      ok: false,
      malformed: true,
      raw: content,
      reason: "Frontmatter opening fence has no closing '---'.",
    };
  }

  const yamlText = afterOpen.slice(
    0,
    closeMatch.index + (closeMatch[1] === "\n" ? 1 : 0),
  );
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  // An empty fenced block (no yaml) is a valid no-fields document, not malformed.
  if (yamlText.trim() === "") {
    return { ok: true, frontmatter: undefined, body, raw: content };
  }

  let parsed: unknown;

  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    return {
      ok: false,
      malformed: true,
      raw: content,
      reason:
        error instanceof Error
          ? error.message
          : "Frontmatter yaml failed to parse.",
    };
  }

  if (parsed === null || parsed === undefined) {
    return { ok: true, frontmatter: undefined, body, raw: content };
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      malformed: true,
      raw: content,
      reason: "Frontmatter must be a yaml mapping (key/value object).",
    };
  }

  return {
    ok: true,
    frontmatter: parsed as Record<string, unknown>,
    body,
    raw: content,
  };
}

/**
 * Re-emit `---\n<yaml>\n---\n<body>`. Unknown keys are preserved verbatim (we
 * never touch the object we were handed). `yaml.stringify` is deterministic for
 * a given object — key order is the object's own insertion order, which
 * `splitFrontmatter` produced in document order — so a split→serialize of an
 * untouched doc is a fixed point (round-trip stable).
 *
 * `frontmatter` undefined → body only (no fence), so a plain markdown file
 * round-trips unchanged.
 */
export function serializeFrontmatter(input: {
  frontmatter?: Record<string, unknown>;
  body: string;
}): string {
  if (input.frontmatter === undefined) {
    return input.body;
  }

  // `yaml.stringify` already terminates with a newline.
  return `${FENCE}\n${stringifyYaml(input.frontmatter)}${FENCE}\n${input.body}`;
}

// Required frontmatter for a SKILL.md: `name` + `description`. Everything else
// (argument-hint, allowed-tools, disable-model-invocation, model, …) is optional
// and PRESERVED via `.passthrough()` — the runtime consumes the file verbatim,
// so we never strip vendor keys.
export const skillFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

// Required frontmatter for an agent `.md`: `name` + `description`. Optional
// `tools`/`model`/`permissionMode`/`maxTurns` and any other key are preserved.
export const agentFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .passthrough();

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

// Rule guardrail frontmatter — ALL fields optional (WARN-only shape; no web
// runtime parser exists, per spec §6.1). Shape is checked when present; unknown
// keys preserved.
export const ruleGuardrailSchema = z
  .object({
    allowed_paths: z.array(z.string()).optional(),
    forbidden_paths: z.array(z.string()).optional(),
    allowed_commands: z.array(z.string()).optional(),
    require_structured_response: z.boolean().optional(),
  })
  .passthrough();

export type RuleGuardrail = z.infer<typeof ruleGuardrailSchema>;
