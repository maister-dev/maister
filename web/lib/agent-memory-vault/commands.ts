import "server-only";

import { z } from "zod";

import {
  MAX_NOTE_CHARS,
  MAX_PAGE_ENTRIES,
  MAX_VAULT_NOTE_COUNT,
} from "./limits";
import {
  canonicalMemoryPath,
  memoryNotePath,
  mutableMemoryPath,
} from "./paths";

import { isMaisterError, MaisterError } from "@/lib/errors";

const id = z.string().min(1).max(192);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const requestKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
const body = z
  .string()
  .max(MAX_NOTE_CHARS)
  .refine((value) => value.isWellFormed() && !value.includes("\0"));

function pathSchema(normalize: (value: string) => string) {
  return z
    .string()
    .max(512)
    .transform((value, context) => {
      try {
        return normalize(value);
      } catch (error) {
        if (!isMaisterError(error) || error.code !== "CONFIG") throw error;
        context.addIssue({ code: "custom", message: error.message });

        return z.NEVER;
      }
    });
}

const path = pathSchema(canonicalMemoryPath);
const notePath = pathSchema(memoryNotePath);
const mutablePath = pathSchema(mutableMemoryPath);
const head = { ifRevisionId: id, ifHash: hash };
const write = { ...head, requestKey };
const tree = {
  ifGeneration: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  heads: z
    .array(z.strictObject({ path: notePath, ...head }))
    .max(MAX_VAULT_NOTE_COUNT),
  requestKey,
};

const memoryView = z.strictObject({
  command: z.literal("view"),
  path,
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_ENTRIES).default(20),
  view_range: z
    .tuple([
      z
        .number()
        .int()
        .min(1)
        .max(MAX_NOTE_CHARS + 1),
      z
        .number()
        .int()
        .min(-1)
        .max(MAX_NOTE_CHARS + 1),
    ])
    .refine(([first, last]) => last === -1 || last >= first)
    .optional(),
});

const memoryMutation = z.union([
  z
    .strictObject({
      command: z.literal("create"),
      path: notePath,
      file_text: body,
      ifRevisionId: id.nullable(),
      ifHash: hash.nullable(),
      requestKey,
    })
    .refine(
      (command) =>
        (command.ifRevisionId === null) === (command.ifHash === null),
    ),
  z.strictObject({
    command: z.literal("str_replace"),
    path: notePath,
    old_str: body.refine((s) => s.length > 0),
    new_str: body,
    ...write,
  }),
  z.strictObject({
    command: z.literal("insert"),
    path: notePath,
    insert_line: z
      .number()
      .int()
      .min(0)
      .max(MAX_NOTE_CHARS + 1),
    insert_text: body,
    ...write,
  }),
  z.strictObject({ command: z.literal("delete"), path: notePath, ...write }),
  z.strictObject({
    command: z.literal("rename"),
    old_path: notePath,
    new_path: notePath,
    ...write,
  }),
  z
    .strictObject({ command: z.literal("delete"), path: mutablePath, ...tree })
    .refine((command) => command.heads.length > 0),
  z
    .strictObject({
      command: z.literal("rename"),
      old_path: mutablePath,
      new_path: mutablePath,
      ...tree,
    })
    .refine((command) => command.heads.length > 0),
  z.strictObject({ command: z.literal("clear"), ...tree }),
  z.strictObject({
    command: z.literal("revert"),
    noteId: id,
    revisionId: id,
    ...write,
    ifHash: hash.nullable(),
  }),
]);

export type AgentMemoryMutation = z.infer<typeof memoryMutation>;
export type AgentMemoryView = z.infer<typeof memoryView>;

export function parseAgentMemoryMutation(input: unknown): AgentMemoryMutation {
  const parsed = memoryMutation.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid memory command");

  return parsed.data;
}

export function parseAgentMemoryView(input: unknown): AgentMemoryView {
  const parsed = memoryView.safeParse(input);

  if (!parsed.success) throw new MaisterError("CONFIG", "Invalid memory view");

  return parsed.data;
}

export function parseAgentSessionMemoryCommand(
  input: unknown,
):
  | AgentMemoryView
  | Exclude<AgentMemoryMutation, { command: "clear" | "revert" }> {
  if (
    typeof input === "object" &&
    input !== null &&
    "command" in input &&
    input.command === "view"
  )
    return parseAgentMemoryView(input);
  const command = parseAgentMemoryMutation(input);

  if (command.command === "clear" || command.command === "revert")
    throw new MaisterError(
      "CONFIG",
      "This command requires the human vault surface",
    );

  return command;
}

export function replaceMemoryText(
  content: string,
  oldText: string,
  newText: string,
): string {
  const offset = content.indexOf(oldText);

  if (offset < 0 || content.indexOf(oldText, offset + 1) >= 0)
    throw new MaisterError(
      "CONFIG",
      "str_replace requires exactly one literal match",
    );

  return (
    content.slice(0, offset) + newText + content.slice(offset + oldText.length)
  );
}

export function insertMemoryText(
  content: string,
  afterLine: number,
  insertion: string,
): string {
  if (afterLine === 0) return insertion + content;
  const lines = content.split("\n");

  if (afterLine > lines.length)
    throw new MaisterError(
      "CONFIG",
      "Memory insertion line is outside the note",
    );

  const offset =
    lines.slice(0, afterLine).join("\n").length +
    (afterLine < lines.length ? 1 : 0);

  return content.slice(0, offset) + insertion + content.slice(offset);
}
