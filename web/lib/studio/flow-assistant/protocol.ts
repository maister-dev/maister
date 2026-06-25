import { z } from "zod";

export const FLOW_ASSISTANT_ACTION_SCHEMA_VERSION =
  "maister_flow_assistant_action.v1" as const;
export const FLOW_ASSISTANT_ACTION_FENCE = "maister-flow-assistant-action";
export const FLOW_ACTION_RESULT_KIND = "flow_action_result" as const;

export type FlowAssistantIntent = "auto" | "ask" | "edit";

const actionPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "path must not contain NUL")
  .refine((value) => !value.startsWith("-"), "path must not start with '-'")
  .refine((value) => !value.startsWith("/"), "path must be relative")
  .refine((value) => !/^[A-Za-z]:[\\/]/.test(value), "path must be relative")
  .refine(
    (value) =>
      !value.split(/[\\/]+/).some((part) => part === "." || part === ".."),
    "path must not contain dot segments",
  );

const baseOperationSchema = z.object({
  path: actionPathSchema,
  baseHash: z.string().min(1).nullable(),
  description: z.string().max(1000).optional(),
});

export const flowAssistantActionOperationSchema = z.discriminatedUnion("op", [
  baseOperationSchema.extend({
    op: z.literal("upsert_file"),
    content: z.string(),
  }),
  baseOperationSchema.extend({
    op: z.literal("delete_file"),
  }),
]);

export const flowAssistantActionSchema = z.object({
  schemaVersion: z.literal(FLOW_ASSISTANT_ACTION_SCHEMA_VERSION),
  actionId: z.string().min(1).max(128).optional(),
  summary: z.string().min(1).max(2000),
  operations: z.array(flowAssistantActionOperationSchema).min(1).max(50),
});

export const flowActionResultStatusSchema = z.enum([
  "applied",
  "invalid",
  "stale",
  "malformed",
  "interrupted",
  "rejected",
]);

export const flowActionResultPayloadSchema = z.object({
  v: z.literal(1),
  kind: z.literal(FLOW_ACTION_RESULT_KIND),
  actionId: z.string(),
  status: flowActionResultStatusSchema,
  summary: z.string(),
  operations: z.array(
    z.object({
      op: z.enum(["upsert_file", "delete_file"]),
      path: z.string(),
    }),
  ),
  touchedPaths: z.array(z.string()),
  issueCount: z.number().int().nonnegative(),
  issues: z.array(z.string()).optional(),
  message: z.string().nullable().optional(),
});

export type FlowAssistantAction = z.infer<typeof flowAssistantActionSchema> & {
  actionId: string;
};
export type FlowAssistantActionOperation =
  FlowAssistantAction["operations"][number];
export type FlowActionResultStatus = z.infer<
  typeof flowActionResultStatusSchema
>;
export type FlowActionResultPayload = z.infer<
  typeof flowActionResultPayloadSchema
>;

export type ParsedAssistantActionBlocks =
  | {
      kind: "none";
      sanitizedText: string;
    }
  | {
      kind: "parsed";
      action: FlowAssistantAction;
      sanitizedText: string;
      rawActionJson: string;
    }
  | {
      kind: "malformed";
      sanitizedText: string;
      issueSummary: string[];
    };

type ActionFence = {
  rawBlock: string;
  json: string;
};

const ACTION_FENCE_RE = new RegExp(
  "```" + FLOW_ASSISTANT_ACTION_FENCE + "\\s*\\n([\\s\\S]*?)\\n```",
  "g",
);

export function normalizeFlowAssistantIntent(
  value: unknown,
): FlowAssistantIntent {
  return value === "ask" || value === "edit" || value === "auto"
    ? value
    : "auto";
}

export function parseFlowActionResultPayload(
  value: unknown,
): FlowActionResultPayload | null {
  const parsed = flowActionResultPayloadSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

export function encodeFlowActionResultPayload(
  payload: FlowActionResultPayload,
): string {
  return JSON.stringify(flowActionResultPayloadSchema.parse(payload));
}

export function parseAssistantActionBlocks(
  markdown: string,
): ParsedAssistantActionBlocks {
  const fences = collectActionFences(markdown);
  const sanitizedText = stripAssistantProtocolBlocks(markdown);

  if (fences.length === 0) return { kind: "none", sanitizedText };
  if (fences.length > 1) {
    return {
      kind: "malformed",
      sanitizedText,
      issueSummary: ["assistant returned more than one action block"],
    };
  }

  const rawActionJson = fences[0].json.trim();
  let decoded: unknown;

  try {
    decoded = JSON.parse(rawActionJson);
  } catch (err) {
    return {
      kind: "malformed",
      sanitizedText,
      issueSummary: [`action JSON parse error: ${asMessage(err)}`],
    };
  }

  const parsed = flowAssistantActionSchema.safeParse(decoded);

  if (!parsed.success) {
    return {
      kind: "malformed",
      sanitizedText,
      issueSummary: parsed.error.issues
        .slice(0, 8)
        .map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ),
    };
  }

  return {
    kind: "parsed",
    action: {
      ...parsed.data,
      actionId: parsed.data.actionId ?? stableActionId(rawActionJson),
    },
    sanitizedText,
    rawActionJson,
  };
}

export function stripAssistantProtocolBlocks(markdown: string): string {
  return markdown
    .replace(ACTION_FENCE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function createMalformedActionResult(args: {
  actionId?: string;
  summary?: string;
  issues: readonly string[];
}): FlowActionResultPayload {
  return {
    v: 1,
    kind: FLOW_ACTION_RESULT_KIND,
    actionId: args.actionId ?? stableActionId(args.issues.join("\n")),
    status: "malformed",
    summary:
      args.summary ?? "The assistant returned an action I could not read.",
    operations: [],
    touchedPaths: [],
    issueCount: args.issues.length,
    issues: args.issues.slice(0, 8),
    message:
      "I hid the raw action protocol and did not change any files. Try asking for the edit again.",
  };
}

export function createRejectedActionResult(args: {
  actionId: string;
  status: Exclude<FlowActionResultStatus, "applied" | "malformed">;
  summary: string;
  operations: readonly FlowAssistantActionOperation[];
  issues: readonly string[];
  message: string;
}): FlowActionResultPayload {
  return {
    v: 1,
    kind: FLOW_ACTION_RESULT_KIND,
    actionId: args.actionId,
    status: args.status,
    summary: args.summary,
    operations: summarizeOperations(args.operations),
    touchedPaths: uniquePaths(
      args.operations.map((operation) => operation.path),
    ),
    issueCount: args.issues.length,
    issues: args.issues.slice(0, 8),
    message: args.message,
  };
}

export function createAppliedActionResult(args: {
  action: FlowAssistantAction;
}): FlowActionResultPayload {
  return {
    v: 1,
    kind: FLOW_ACTION_RESULT_KIND,
    actionId: args.action.actionId,
    status: "applied",
    summary: args.action.summary,
    operations: summarizeOperations(args.action.operations),
    touchedPaths: uniquePaths(
      args.action.operations.map((operation) => operation.path),
    ),
    issueCount: 0,
    issues: [],
    message: "Applied to the local package working tree.",
  };
}

function collectActionFences(markdown: string): ActionFence[] {
  const fences: ActionFence[] = [];

  for (const match of markdown.matchAll(ACTION_FENCE_RE)) {
    fences.push({ rawBlock: match[0], json: match[1] ?? "" });
  }

  return fences;
}

function summarizeOperations(
  operations: readonly FlowAssistantActionOperation[],
): FlowActionResultPayload["operations"] {
  return operations.map((operation) => ({
    op: operation.op,
    path: operation.path,
  }));
}

function uniquePaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b));
}

function stableActionId(rawActionJson: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < rawActionJson.length; i++) {
    hash ^= rawActionJson.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `act_${hash.toString(16).padStart(8, "0")}`;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
