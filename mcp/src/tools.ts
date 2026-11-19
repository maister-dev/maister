import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import taskQualificationSchema from "../../runtime/task-qualification.schema.json";
import askHumanInputSchema from "../../runtime/ask-human-input.schema.json";
import agentMemorySchema from "../../runtime/agent-memory.schema.json";

import { type AuthContext, resolveAuthHeader } from "./auth";
import {
  callExt,
  structuredResponseToToolError,
  restResponseToToolError,
} from "./rest";
import { isToolsetName, TOOLSETS } from "./toolsets";
import {
  isTaskLaunchTool,
  isLaunchAdmissionTool,
  LEGACY_RUN_LAUNCH_TOOL_SPEC,
  taskLaunchArgumentIssues,
  taskLaunchRouting,
  TASK_LAUNCH_TOOL_SPECS,
} from "./task-launch-tools";
import {
  KNOWLEDGE_TOOL_SPECS,
  isKnowledgeTool,
  parseKnowledgeToolArguments,
  knowledgeToolRouting,
} from "./knowledge-tools";

export type ToolSpec = {
  description: string;
  inputSchema: Tool["inputSchema"];
  annotations?: Tool["annotations"];
};

const standOperationSelector: ToolSpec["inputSchema"] = {
  type: "object",
  additionalProperties: false,
  required: ["operationId"],
  properties: { operationId: { type: "string", minLength: 1, maxLength: 128 } },
};
const agentMemoryInput = z.fromJSONSchema(
  agentMemorySchema as unknown as z.core.JSONSchema.JSONSchema,
);
const vaultPage = {
  cursor: { type: "string", minLength: 1, maxLength: 2048 },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
};
const vaultIndexRoutes = {
  memory_search: "search",
  memory_backlinks: "backlinks",
  memory_tags: "tags",
} as const;
type VaultIndexTool = keyof typeof vaultIndexRoutes;

function isVaultIndexTool(name: string): name is VaultIndexTool {
  return Object.hasOwn(vaultIndexRoutes, name);
}

// ADR-206: mirrors `TaskSourceInput` in the external OpenAPI.
const TASK_SOURCE_PROPERTIES = {
  kind: { type: "string", pattern: "^[a-z][a-z0-9_-]{1,31}$" },
  instance: {
    type: "string",
    minLength: 1,
    maxLength: 253,
    pattern: "^[a-z0-9][a-z0-9._-]*$",
  },
  scope: { type: "string", minLength: 1, maxLength: 256 },
  externalId: { type: "string", minLength: 1, maxLength: 256 },
  externalKey: { type: "string", minLength: 1, maxLength: 64 },
  url: { type: "string", maxLength: 2048, pattern: "^https://[^/@\\s]+(/|$)" },
};

export const TOOL_SPECS: Record<string, ToolSpec> = {
  ...TASK_LAUNCH_TOOL_SPECS,
  ...KNOWLEDGE_TOOL_SPECS,
  stand_operation_get: {
    description:
      "Read the current effect, independent verification, and receipt IDs for an operation appointed to this specialist.",
    inputSchema: standOperationSelector,
    annotations: { readOnlyHint: true },
  },
  stand_operation_logs: {
    description:
      "Read a bounded sanitized log excerpt for the appointed stand operation under a current logs grant.",
    inputSchema: standOperationSelector,
    annotations: { readOnlyHint: true },
  },
  stand_operation_observe: {
    description:
      "Observe the exact configured service before an approved restart. Retains the target observation as evidence.",
    inputSchema: standOperationSelector,
  },
  stand_operation_dispatch: {
    description:
      "Dispatch one already approved restart under the current execution fence. If delivery is uncertain, inspect the original operation and use the human recovery flow.",
    inputSchema: standOperationSelector,
  },
  stand_operation_verify: {
    description:
      "Run a fresh independent health probe after the operation has a confirmed applied restart receipt.",
    inputSchema: standOperationSelector,
  },
  stand_operation_create: {
    description:
      "Retain one exact operation intent for a configured component appointed to this assignment, or adopt the exact restart successor already appointed by a human. Reuse the same idempotency key and input on replay. A restart intent awaits exact human approval and current execution authorization.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "assignmentId",
        "expectedRevision",
        "inputRevision",
        "componentId",
        "action",
        "idempotencyKey",
      ],
      properties: {
        assignmentId: { type: "string", minLength: 1, maxLength: 128 },
        expectedRevision: { type: "integer", minimum: 1, maximum: 2147483647 },
        inputRevision: { type: "integer", minimum: 1, maximum: 2147483647 },
        componentId: { type: "string", minLength: 1, maxLength: 128 },
        action: {
          type: "string",
          enum: ["inspect", "logs", "restart", "verify"],
        },
        idempotencyKey: {
          type: "string",
          minLength: 8,
          maxLength: 128,
          pattern: "^[A-Za-z0-9._:-]+$",
        },
      },
    },
  },
  task_create: {
    description:
      "Create a new task in a project (flowId optional — a flowless task is a simple-intent task awaiting triage). `flowId` accepts either the flow's UUID or its ref (e.g. `aif-bugfix`), as returned by `flow_list` (`id` or `ref`).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        title: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        statement: {
          type: "object",
          properties: {
            context: { type: "string", minLength: 1 },
            goal: { type: "string", minLength: 1 },
            acceptance: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            constraints: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            outOfScope: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            links: { type: "array", items: { type: "string", minLength: 1 } },
            openQuestions: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
          },
          required: [
            "context",
            "goal",
            "acceptance",
            "constraints",
            "outOfScope",
            "links",
            "openQuestions",
          ],
        },
        flowId: { type: "string", minLength: 1 },
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Idempotency key for this effect (sent as the Idempotency-Key header). Required when acting as the librarian: reuse the SAME key when retrying the same effect, and a new key for a new effect.",
        },
        source: {
          type: "object",
          description:
            "Structured external source identity (ADR-206). Identity is kind+instance+externalId within the project; a bound identity is refused 409 source_already_bound naming the existing task.",
          properties: TASK_SOURCE_PROPERTIES,
          required: ["kind", "instance", "scope", "externalId"],
        },
      },
      required: ["slug", "title"],
    },
  },
  task_statement_accept: {
    description:
      "Accept a typed task statement at the current task revision. The task must still be in Backlog.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        statement: {
          type: "object",
          properties: {
            context: { type: "string", minLength: 1 },
            goal: { type: "string", minLength: 1 },
            acceptance: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            constraints: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            outOfScope: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            links: { type: "array", items: { type: "string", minLength: 1 } },
            openQuestions: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
          },
          required: [
            "context",
            "goal",
            "acceptance",
            "constraints",
            "outOfScope",
            "links",
            "openQuestions",
          ],
        },
        expectedRevision: { type: "integer", minimum: 0 },
        operationKey: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: [
        "slug",
        "taskId",
        "statement",
        "expectedRevision",
        "operationKey",
      ],
    },
  },
  task_send_to_triage: {
    description:
      "Send a task to triage and choose whether a later triage verdict may auto-launch it.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        launchIntent: {
          type: "string",
          enum: ["triage_only", "triage_then_launch"],
        },
        operationKey: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["slug", "taskId", "launchIntent", "operationKey"],
    },
  },
  task_publish_excerpt: {
    description:
      "Explicitly publish a quoted excerpt from this conversation as a task comment visible to project members. The private transcript stays private.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        excerpt: { type: "string", minLength: 1, maxLength: 5000 },
        operationKey: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["slug", "taskId", "excerpt", "operationKey"],
    },
  },
  clarification_request: {
    description:
      "Ask a specific project member to clarify a task before execution. A blocking request holds launch until answered or cancelled.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        recipientUserId: { type: "string", minLength: 1 },
        question: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
        answerFormat: { type: "string", enum: ["text", "choice", "yes_no"] },
        blocking: { type: "boolean" },
        operationKey: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: [
        "slug",
        "taskId",
        "recipientUserId",
        "question",
        "reason",
        "answerFormat",
        "blocking",
        "operationKey",
      ],
    },
  },
  clarification_cancel: {
    description: "Cancel an open task clarification you requested.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        clarificationId: { type: "string" },
        operationKey: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["slug", "taskId", "clarificationId", "operationKey"],
    },
  },
  clarification_list: {
    description: "List task clarifications and their current states.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["slug", "taskId"],
    },
  },
  project_members_list: {
    description:
      "List active project members eligible to receive an addressed clarification.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
  },
  task_list: {
    description: "List tasks in a project",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
      },
      required: ["slug"],
    },
  },
  task_find_by_source: {
    description:
      "Find the task bound to an external source identity (kind + instance + externalId) in a project, across every task status. Returns {task: null} when the identity is unbound — look up before creating an imported task.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", minLength: 1 },
        kind: TASK_SOURCE_PROPERTIES.kind,
        instance: TASK_SOURCE_PROPERTIES.instance,
        externalId: TASK_SOURCE_PROPERTIES.externalId,
      },
      required: ["slug", "kind", "instance", "externalId"],
    },
  },
  task_source_bind: {
    description:
      "Bind an external source identity to an unbound task (ADR-206). Same identity → no-op; a task bound to another identity → 409 source_conflict; an identity bound to another task → 409 source_already_bound. There is no tool to detach.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", minLength: 1 },
        taskId: { type: "string", format: "uuid" },
        ...TASK_SOURCE_PROPERTIES,
        expectedRevision: { type: "integer", minimum: 0 },
      },
      required: ["slug", "taskId", "kind", "instance", "scope", "externalId"],
    },
  },
  task_get: {
    description: "Get a single task by ID",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["slug", "taskId"],
    },
  },
  flow_list: {
    description:
      "List the project's launchable flows a triage verdict may assign (only enabled + trusted flows are returned, with their routing metadata: title/summary/route_when/labels)",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
      },
      required: ["slug"],
    },
  },
  runner_list: {
    description:
      "List the enabled platform ACP runners a triage verdict may assign (runners are platform-scoped; the slug is used only for auth/scope)",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
      },
      required: ["slug"],
    },
  },
  evaluation_context_get: {
    description:
      "Get the token-bound judge attempt context (ADR-145): attempt identity, method rubric, blind candidate order, and evidence/digest summary. Requires evaluations:context:read. The attempt is bound by the token — takes no ids and returns no real participant id, peer result, path, or session handle. A pairwise attempt (ADR-147) also gets `match: {a, b}` — which blinded candidate is match side a and which is b (the `winner` pick refers to these sides) — with candidates/evidence scoped to that pair; `match` is null for a scalar attempt.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  evaluation_evidence_list: {
    description:
      "List the token-bound evidence snapshot's item metadata, cursor-paginated. Requires evaluations:evidence:read. Real participant ids are blinded to candidate labels; locators/host keys are never exposed. For a pairwise attempt the listing is scoped to the attempt's match pair plus shared (participant-less) items.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  evaluation_evidence_read: {
    description:
      "Read a server-capped window of one bound-snapshot evidence item. Requires evaluations:evidence:read. itemId must come from evaluation_evidence_list; offset/length are clamped and a capped read is flagged truncated. For a pairwise attempt only the match pair's items (or shared, participant-less items) are readable.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        length: { type: "integer", minimum: 1 },
      },
      required: ["itemId"],
    },
  },
  evaluation_objective_results: {
    description:
      "Get structured objective check + metric facts for the token-bound execution (ADR-145). Requires evaluations:objective:read. Missing/absent statuses keep their reason; never infer PASS from source appearance. For a pairwise attempt the facts are scoped to the attempt's match pair plus shared (participant-less) rows.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  evaluation_result_submit: {
    description:
      "Submit a strict per-criterion judge result for the token-bound attempt (ADR-145/ADR-147). Requires evaluations:result:submit. Always score `criteria`; a pairwise attempt ALSO sends `winner` (a|b|tie) — required for a pairwise attempt, rejected otherwise (422 either way). `winner` refers to the context's `match.a`/`match.b` blinded sides, never to candidate list position. Attribution is server-derived; extra keys are rejected. An invalid criteria result seals a terminal-invalid attempt (valid:false, HTTP 200).",
    inputSchema: {
      type: "object",
      properties: {
        winner: { type: "string", enum: ["a", "b", "tie"] },
        criteria: { type: "array" },
      },
      required: ["criteria"],
    },
  },
  memory_recall: {
    description:
      "Recall relevant project-memory items (ADR-122) via hybrid vector + lexical ranking. No LLM at read. Requires the project's Brain to be enabled and (for agent tokens) can_read_brain.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        q: { type: "string", minLength: 1, maxLength: 2000 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "lesson",
              "observation",
              "state_fact",
              "decision",
              "direction",
            ],
          },
        },
        minConfidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["slug", "q"],
    },
  },
  memory_clusters: {
    description:
      "List recurring Project Brain evidence clusters for an improver agent. Server-computed from embedding proximity and shared provenance. Requires memory:read and can_read_brain for agent tokens.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: ["lesson", "observation", "state_fact"],
          },
        },
        minRecurrence: { type: "integer", minimum: 2, maximum: 20 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["slug"],
    },
  },
  memory_propose: {
    description:
      "Create a Project Brain improvement proposal from evidence and a draft. Project autonomy may auto-draft allowed low-risk catalog proposals, but this never publishes or writes repo files. Requires memory:write and can_write_brain for agent tokens.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        kind: {
          type: "string",
          enum: ["rule", "skill", "flow", "adr", "roadmap", "state"],
        },
        evidenceItemIds: {
          type: "array",
          items: { type: "string" },
        },
        draft: {
          type: "object",
          additionalProperties: true,
        },
        blastRadius: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
        clusterHash: { type: ["string", "null"] },
        rationale: { type: "string" },
      },
      required: ["slug", "kind", "draft"],
    },
  },
  memory_retain: {
    description:
      "Retain a project-memory item (ADR-122). Embeds; an exact duplicate is a no-op, a near item is recorded as a review candidate, never merged. Requires the project's Brain to be enabled and (for agent tokens) can_write_brain. The body carries no project id.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        content: { type: "string", minLength: 1, maxLength: 32000 },
        kind: {
          type: "string",
          enum: [
            "lesson",
            "observation",
            "state_fact",
            "decision",
            "direction",
          ],
        },
        title: { type: "string", minLength: 1, maxLength: 512 },
        tags: {
          type: "array",
          maxItems: 10,
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
      required: ["slug", "content", "kind"],
    },
  },
  memory: {
    description:
      "Work in the current session's private /memories vault. View one note or a directory page, create a note, replace one literal occurrence, insert text, delete or rename a note or folder. Pass the observed revision and hash for changes and reuse a request key for retries.",
    inputSchema: agentMemorySchema as ToolSpec["inputSchema"],
  },
  memory_search: {
    description: "Search current visible notes in the session vault. Use lexical mode by default; vector requires installation configuration. A tag alone lists notes with that tag.",
    inputSchema: {
      type: "object", additionalProperties: false,
      anyOf: [{ required: ["q"] }, { required: ["tag"], properties: { mode: { const: "lexical" } } }],
      properties: {
        ...vaultPage, q: { type: "string", minLength: 1, maxLength: 2000 },
        tag: { type: "string", minLength: 1, maxLength: 128 },
        mode: { type: "string", enum: ["lexical", "vector"] },
      },
    },
    annotations: { readOnlyHint: true },
  },
  memory_backlinks: {
    description: "List visible current notes linking to the specified vault note path.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["path"],
      properties: { ...vaultPage, path: { type: "string", minLength: 1, maxLength: 512, pattern: "^/memories(?:/[^/]+)*$" } },
    },
    annotations: { readOnlyHint: true },
  },
  memory_tags: {
    description: "List frontmatter tags and counts of visible current notes.",
    inputSchema: { type: "object", additionalProperties: false, properties: vaultPage },
    annotations: { readOnlyHint: true },
  },
  agent_memory_write: {
    description:
      "Deprecated for one release. Use the memory tool for new work. This compatibility command replaces /memories/index.md in the current session vault. Supply its current ifHash, or null for a first write. A conflict includes the authorized current index state.",
    inputSchema: {
      type: "object",
      // D24: `dispatchTool` silently drops args it does not destructure, and the
      // project-scope prompt block tells the agent to always pass `slug` — so a
      // habitual `slug` here must be a VISIBLE client-side validation failure,
      // never a silent drop.
      additionalProperties: false,
      properties: {
        // The DEFAULT MAISTER_AGENT_MEMORY_MAX_CHARS. The server is the
        // authority and may be configured lower or higher; this bound only
        // stops an obviously oversized payload client-side, and the route still
        // answers 422 CONFIG against the live cap.
        content: { type: "string", maxLength: 32768 },
        // JSON Schema, not OpenAPI: `nullable: true` is not a keyword here and
        // a validating client would reject the documented first-writer form.
        // Same spelling as triage_set's clear-path nullables.
        ifHash: { type: ["string", "null"] },
      },
      required: ["content"],
    },
  },
  task_update: {
    description:
      "Update fields on a task (title/prompt — e.g. triage clarify-mode sharpening the statement)",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        title: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Idempotency key for this effect (sent as the Idempotency-Key header). Required when acting as the librarian: reuse the SAME key when retrying the same effect, and a new key for a new effect.",
        },
      },
      required: ["slug", "taskId"],
    },
  },
  task_complete: {
    description:
      "Mark a task Done only after its newest Flow run has completed delivery. This does not promote a run: the latest run must already be Done with a completed merge, or with an observed merged pull request. The operation is idempotent and requires a global personal token; project, agent, service, run-bound, and librarian tokens are refused.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 0 },
      },
      required: ["slug", "taskId"],
    },
  },
  run_launch: LEGACY_RUN_LAUNCH_TOOL_SPEC,
  run_get: {
    description:
      "Get a run by ID. A Failed, Crashed or Abandoned run carries terminalCause {code, reason?, source} — why it ended; null otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
    },
  },
  activity_pulse: {
    description:
      "Get the assistant pulse for the token-bound project: persisted happened facts, the current active-run snapshot, and pending needs-you items. Requires a project-bound token with runs:read.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string" },
        salience: {
          type: "string",
          enum: ["high", "normal", "low"],
        },
      },
    },
  },
  run_activity: {
    description:
      "Get semantic assistant activity for one run, with mutation-horizon replay via sinceId. Requires a project-bound token with runs:read.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        sinceId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        salience: {
          type: "string",
          enum: ["high", "normal", "low"],
        },
      },
      required: ["runId"],
    },
  },
  run_delegate: {
    description:
      "Delegate work to a governed child run. Task-backed delivery effects require operationKey; accepted queued responses return intentId with null runId/childRunId until real binding. Reuse the same key and body after an uncertain response. Supply EXACTLY ONE target: target.agentId = a single-purpose catalog agent (one session, one turn-loop, package-qualified <flowRefId>:<stem>); target.flowId = a governed multi-node process from the project's enabled+trusted flows (its own graph, gates, review). An agent target whose definition names a Flow requires mode:task. Flow targets and these agent facades accept only title and runnerOverride — workspace, workspaceMode, persistent, addressableKey, resultProfile are standalone-agent-only and are refused, not ignored; a flow child always gets a linked board task (childTaskId is always returned) and run_rework/run_message do not apply to it. For an agent target, mode:'task' also creates a child board task linked parent_of under the orchestrator's task and mode:'run' spawns a board-less child; for a flow target mode is only recorded (the carrier task always exists). The parent orchestrator run is derived from the calling token — never accepted in the body. An untrusted/disabled/incompatible target, or one with no Ready platform runner, is refused and no child run is created.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      // Claude omits tools with a root union. Dispatch enforces the conditional key.
      properties: {
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Required stable key for every task-backed effect; replay the same key/body after an uncertain response.",
        },
        target: {
          oneOf: [
            {
              type: "object",
              title: "AgentTarget",
              properties: {
                agentId: { type: "string", minLength: 1 },
              },
              required: ["agentId"],
              additionalProperties: false,
            },
            {
              type: "object",
              title: "FlowTarget",
              properties: {
                flowId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "The flow's UUID or the project's flow ref, as returned by flow_list.",
                },
              },
              required: ["flowId"],
              additionalProperties: false,
            },
          ],
        },
        mode: { type: "string", enum: ["task", "run"] },
        prompt: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        workspace: {
          type: "string",
          enum: ["none", "repo_read", "worktree"],
        },
        workspaceMode: {
          type: "string",
          enum: ["own", "shared"],
        },
        persistent: {
          type: "boolean",
          description:
            "Spawn a PERSISTENT addressable swarm member that parks between turns instead of running to terminal (re-message it later with run_message by its addressableKey). Requires addressableKey.",
        },
        addressableKey: {
          type: "string",
          minLength: 1,
          description:
            "Stable key, unique within this orchestrator tree, used to address a persistent child via run_message. Required when persistent is true.",
        },
        runnerOverride: { type: "string", minLength: 1 },
        assignmentWork: {
          type: "object",
          additionalProperties: false,
          description:
            "Exact native assignment work. Use a workspace-none agent with a required result contract or a reviewed company result-only Flow. The server resolves ownership and installed bindings.",
          required: ["selector", "expectedOutcome"],
          properties: {
            expectedOutcome: { type: "string", minLength: 1, maxLength: 4000 },
            selector: {
              type: "object",
              additionalProperties: false,
              required: [
                "schemaVersion",
                "assignmentId",
                "expectedRevision",
                "inputRevision",
                "contextRevision",
                "logicalWorkId",
                "workRevision",
              ],
              properties: {
                schemaVersion: { type: "integer", const: 1 },
                assignmentId: { type: "string", minLength: 1, maxLength: 128 },
                expectedRevision: {
                  type: "integer",
                  minimum: 1,
                  maximum: 2147483647,
                },
                inputRevision: {
                  type: "integer",
                  minimum: 1,
                  maximum: 2147483647,
                },
                contextRevision: {
                  type: "integer",
                  minimum: 0,
                  maximum: 2147483647,
                },
                logicalWorkId: {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                  pattern: "^[A-Za-z0-9._:-]+$",
                },
                workRevision: {
                  type: "integer",
                  minimum: 1,
                  maximum: 2147483647,
                },
              },
            },
          },
        },
        resultProfile: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[A-Za-z0-9._-]+$",
          description:
            "AGENT targets only. Name of a result_profiles entry declared by the package that owns THIS orchestrator's pinned flow revision. The child must end its final turn with a ```json maister:output block matching that profile's schema; MAIster validates and stores it before the child becomes collectable, and run_collect returns it as result.value. Refused on a flow target (a flow declares its own result.export), with persistent:true, for an unknown name, or below engine 3.7.0. A missing or malformed required result FAILS the child.",
        },
      },
      required: ["target", "mode", "prompt"],
    },
  },
  run_plan: {
    description:
      "Emit a task-DAG of as-plan child tasks under the calling orchestrator. Requires operationKey; replay the exact whole plan/key after an uncertain response. Accepted source entries may have intentId, accepted:true and null runId/childRunId before actual binding. Each entry supplies EXACTLY ONE target — target.agentId (a catalog agent) or target.flowId (a governed multi-node process from the project's enabled+trusted flows) — plus a unique `key` and a `dependsOn` list of in-batch keys; a batch may mix both kinds and the DAG must be acyclic. `workspace` is agent-only and is refused on a flow entry, not ignored. Every task is created launch_mode='auto' and linked parent_of under the orchestrator's task; dependencies become success-gated `requires` relations. Source tasks (empty dependsOn) are launched right after the DAG commits: a refused source is reported on its result row as `launchError` (and as a system comment on the task) and is retried when a sibling child next settles; when EVERY source is refused the committed DAG is abandoned and the call fails with the refusal's code — re-plan. Downstream tasks auto-launch once their requires-dependencies all complete successfully. The orchestrator run is derived from the calling token — never accepted in the body. Returns { tasks: [{ key, taskId, childRunId?, launchError? }] } (childRunId only for launched sources, launchError only for refused ones).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Required stable operation key; reuse it with the same entire plan after an uncertain response.",
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string", minLength: 1 },
              target: {
                oneOf: [
                  {
                    type: "object",
                    title: "AgentTarget",
                    properties: {
                      agentId: { type: "string", minLength: 1 },
                    },
                    required: ["agentId"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    title: "FlowTarget",
                    properties: {
                      flowId: {
                        type: "string",
                        minLength: 1,
                        description:
                          "The flow's UUID or the project's flow ref, as returned by flow_list.",
                      },
                    },
                    required: ["flowId"],
                    additionalProperties: false,
                  },
                ],
              },
              prompt: { type: "string", minLength: 1 },
              title: { type: "string", minLength: 1 },
              workspace: {
                type: "string",
                enum: ["none", "repo_read", "worktree"],
              },
              runnerOverride: { type: "string", minLength: 1 },
              resultProfile: {
                type: "string",
                minLength: 1,
                maxLength: 64,
                pattern: "^[A-Za-z0-9._-]+$",
                description:
                  "AGENT entries only. Same as run_delegate.resultProfile — the child publishes a validated public result under this named contract. Refused on a flow entry; a violating entry creates NO tasks.",
              },
              dependsOn: { type: "array", items: { type: "string" } },
            },
            required: ["key", "target", "prompt", "dependsOn"],
          },
        },
      },
      required: ["tasks", "operationKey"],
    },
  },
  run_collect: {
    description:
      "Collect results, status, and produced artifacts from the orchestrator's delegated child runs. Pass exactly one of childRunId (one child) or all:true (every child). result.value is the validated public result — use it, not outputText (deprecated); resultStatus says why it is absent (pending|valid|absent|missing|stale|invalid|unavailable) and resultFailure carries the reason. Collect is idempotent and shows only your DIRECT children. Research flow children finish by themselves when they publish a result and change nothing; collect BEFORE run_cancel — a failure-terminal child reports unavailable. Operational agents (engine >=3.9.0) return operationalOutcome with reported/effective outcomes, counts, references, diagnostics, integrity and cleanup evidence. Partial/blocked/failed operations remain failure-terminal with resultStatus unavailable; operationalOutcome is diagnostic evidence, never a success substitute. Operational delegation cannot use persistent, shared writable workspace, or resultProfile. Native children also return assignmentWork with exact work, input and business revisions for rework. A project caller with only assignment scope must name the exact childRunId. Returns an array of { childRunId, status, settled, resultStatus, result, resultRevision, assignmentWork?, resultFailure, operationalOutcome, artifacts, diffRef?, outputText? }.",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: { type: "string" },
        all: { type: "boolean" },
      },
    },
  },
  run_cancel: {
    description:
      "Cancel a delegated child run of the calling orchestrator: the child ends Abandoned (agent and flow children alike; a flow child's worktree is retained until GC), which frees its fan-out slot. The child must be a direct child of the bound orchestrator run. Returns { childRunId, status }.",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: { type: "string" },
      },
      required: ["childRunId"],
    },
  },
  run_stop: {
    description:
      "Stop a run through the operator stop path. Returns the run's resulting status.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        operationKey: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["runId", "operationKey"],
    },
  },
  run_operator_message: {
    description:
      "Send an owner message to a scratch or persistent agent run. A Flow run returns the rework controls needed instead.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1, maxLength: 60_000 },
        operationKey: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["runId", "message", "operationKey"],
    },
  },
  librarian_memory_remember: {
    description:
      "Remember an explicit fact, goal, commitment or preference the owner asked to retain. Only an owner-message turn may call this tool.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["preference", "goal", "commitment", "fact"],
        },
        content: { type: "string", minLength: 1, maxLength: 2000 },
        scope: { type: "string", enum: ["general", "project"] },
        projectSlug: { type: "string", minLength: 1 },
        validUntil: { type: "string" },
        operationKey: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["kind", "content", "scope", "operationKey"],
    },
  },
  librarian_history_search: {
    description:
      "Search the owner's librarian conversation history. Results from older segments are labeled and current project visibility is enforced.",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["q"],
    },
  },
  librarian_card_propose: {
    description:
      "Propose a statement change, human confirmation, or inferred memory suggestion card. The owner reviews and decides it in the MAIster panel; this tool never performs the proposed action.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "statement_accept",
            "hitl_respond",
            "run_promote",
            "run_discard",
            "memory_suggest",
          ],
        },
        taskId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 0 },
        statement: { type: "object" },
        runId: { type: "string" },
        hitlRequestId: { type: "string" },
        response: { type: "object" },
        mode: {
          type: "string",
          enum: ["local_merge", "rebase_merge", "pull_request"],
        },
        reviewedTargetCommit: { type: "string" },
        memory: { type: "object" },
        operationKey: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["action", "operationKey"],
    },
  },
  run_message: {
    description:
      "Send a follow-up to a child agent. For native assignment work, the exact originating professional must specify childRunId, mode 'steer', and requestKey. The finite child needs an active turn on a steering-capable session. It never queues a successor on refusal. Reuse the same key and prompt to inspect an uncertain outcome. For a persistent child in the caller's tree, use exactly one of addressableKey or childRunId. The default 'queue' mode waits for its next turn, and 'steer' queues if the running turn cannot accept it. Input is saved before dispatch. Different input under the same key is refused. Flow children require their own continuation. Returns { childRunId, messageId, status, messageState, delivery }.",
    inputSchema: {
      type: "object",
      properties: {
        addressableKey: { type: "string", minLength: 1 },
        childRunId: { type: "string" },
        prompt: { type: "string", minLength: 1, maxLength: 1000000 },
        requestKey: { type: "string", minLength: 1, maxLength: 128 },
        mode: { type: "string", enum: ["steer", "queue"] },
      },
      required: ["prompt"],
    },
  },
  run_promote: {
    description:
      "Promote (merge) a reviewed delegated child of the calling orchestrator — its branch is merged into its target and the child becomes Done. The child must be a direct child of the bound orchestrator run and currently in Review. A merge conflict returns CONFLICT and leaves the child in Review for a human to resolve (never auto-resolved). Returns { childRunId, status, commit? }.",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: { type: "string" },
      },
      required: ["childRunId"],
    },
  },
  run_rework: {
    description:
      "Request rework from an exact direct child. Native result-only work uses the work and result revisions from run_collect. For an interrupted first read-only company attempt, set assignmentWork.mode to recover_interrupted and supply the original objective as prompt. Recovery requires the platform's causal crash receipt and physical retirement, keeps the original input and consumes the remaining budget. Retry the same requestKey with identical input to read the same continuation. Legacy project rework resumes a direct agent child in Review. Returns { childRunId, status }.",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: { type: "string" },
        prompt: { type: "string", minLength: 1, maxLength: 1_000_000 },
        assignmentWork: {
          type: "object",
          additionalProperties: false,
          properties: {
            schemaVersion: { type: "integer", const: 1 },
            expectedRevision: { type: "integer", minimum: 1 },
            workRevision: { type: "integer", minimum: 1 },
            inputRevision: { type: "integer", minimum: 1 },
            resultRevision: { type: "integer", minimum: 1 },
            mode: { type: "string", const: "recover_interrupted" },
            requestKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" },
          },
          required: [
            "schemaVersion",
            "expectedRevision",
            "workRevision",
            "inputRevision",
            "resultRevision",
            "requestKey",
          ],
        },
      },
      required: ["childRunId", "prompt"],
    },
  },
  specialist_assignment_work_decide: {
    description:
      "Accept or reject a collected direct child result using its exact assignment, work, input and result revisions. Requires current acceptance authority. The decision is retained and the assignment stays open for separate review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        assignmentId: { type: "string", minLength: 1, maxLength: 128 },
        workId: { type: "string", minLength: 1, maxLength: 128 },
        decision: { type: "string", enum: ["accept", "reject"] },
        expectedRevision: { type: "integer", minimum: 1, maximum: 2147483647 },
        workRevision: { type: "integer", minimum: 1, maximum: 2147483647 },
        inputRevision: { type: "integer", minimum: 1, maximum: 2147483647 },
        resultRevision: { type: "integer", minimum: 1, maximum: 2147483647 },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
        idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" },
      },
      required: [
        "assignmentId",
        "workId",
        "decision",
        "expectedRevision",
        "workRevision",
        "inputRevision",
        "resultRevision",
        "reason",
        "idempotencyKey",
      ],
    },
  },
  run_sync: {
    description:
      "Sync a Review run's branch onto its promotion target (rebase by default, or merge), force-with-lease pushing when the branch is published. On conflict with agent=true (the default) an AI resolver session is launched; with agent=false the conflicted state is aborted. Returns { runId, attemptId, outcome, behind, pushed } where outcome is noop | synced | conflict | agent_launched.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        strategy: { type: "string", enum: ["rebase", "merge"] },
        agent: { type: "boolean" },
        push: { type: "boolean" },
        runnerId: { type: "string" },
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Idempotency key for this effect (sent as the Idempotency-Key header). Required when acting as the librarian: reuse the SAME key when retrying the same effect, and a new key for a new effect.",
        },
      },
      required: ["runId"],
    },
  },
  run_reopen: {
    description:
      "Reopen a Done run whose PR is still open or has conflicts — flips it back to Review, re-arming review and auto-promotion exclusion and reviving a garbage-collected worktree if needed. Re-promotion in pull_request mode reuses the same provider PR. Returns { runId, status }.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Idempotency key for this effect (sent as the Idempotency-Key header). Required when acting as the librarian: reuse the SAME key when retrying the same effect, and a new key for a new effect.",
        },
      },
      required: ["runId"],
    },
  },
  run_recover: {
    description:
      "Recover a Crashed run. An agent node (ai_coding, judge or orchestrator) re-enters the flow graph at the crashed node and continues that node's own prior ACP session; a session-less node (cli, check, guard, human, form) is re-dispatched only when the flow declares it retry_safe. Terminal evidence the crashed turn already produced is applied before any new prompt, so recovering never pays for a turn that already finished. Returns { ok, state, runStatus } — state 'resumed'|'redispatched' means the run continues (runStatus is the committed status: usually Running, or WaitingOnChildren when a coordinator was handed back to its child-wait gate), 'queued' means the concurrency cap was full and the scheduler will resume it. Refusals are terminal, not retryable: 'discard-only' and 'unresumable' mean this run cannot continue, so call run_discard instead; 'conflict' means the run was not Crashed or another recover won the race. The three 409 refusals are distinguishable on details.reason (discard_only, recover_cas_lost, workspace_removed). Only 'transient' (503) is worth retrying.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Idempotency key for this effect (sent as the Idempotency-Key header). Required when acting as the librarian: reuse the SAME key when retrying the same effect, and a new key for a new effect.",
        },
      },
      required: ["runId"],
    },
  },
  run_discard: {
    description:
      "Discard a finished or unrecoverable run — ends it Abandoned and frees its worktree, archiving the branch first so no work is lost. Use after run_recover refuses with 'discard-only' or 'unresumable', to close the attempt out instead of leaving a Crashed run holding a worktree. You do NOT need this to launch the task again — a Crashed run is already launchable. Refused while the run is live or claimed by a human. Returns { ok, runId, operation, runStatus, workspaceRemoved, idempotent, preservationOutcome, archivedBranch }.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
      },
      required: ["runId"],
    },
  },
  readiness_get: {
    description: "Get the readiness status of a run",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
    },
  },
  gate_report: {
    description: "Report the result of an external gate check for a run",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        gateId: { type: "string" },
        status: { type: "string", enum: ["passed", "failed"] },
        externalRunUrl: { type: "string" },
        commitSha: { type: "string" },
        summary: { type: "string" },
        payload: { type: "object" },
      },
      required: ["runId", "gateId", "status"],
    },
  },
  hitl_list: {
    description: "List pending human-in-the-loop requests for a run",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
    },
  },
  hitl_inbox: {
    description:
      "List pending HITL requests across projects visible to the owner of a global personal token",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  hitl_respond: {
    description:
      "Answer a pending permission/form HITL request for a run. Human-kind requests require a global personal token with exact hitl:respond:human scope; project tokens and wildcard scopes are refused for human gates. A valid upstream JSON error body is returned unchanged in tool content with isError=true; clients can use code and details.reason without parsing message text. Missing-token, network and non-JSON upstream failures use plain-text tool errors.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        hitlRequestId: { type: "string" },
        optionId: { type: "string", minLength: 1 },
        response: { type: "object" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["runId", "hitlRequestId"],
    },
  },
  ask_human: {
    description:
      'Create a task-bound Human-ask clarification for this running standalone agent. The server derives the requesting agent and source run from the ephemeral token; use reTriggerMode="triage" only from core:triager. schema is the MAIster form grammar, NOT JSON Schema. Example: {"schemaVersion":1,"fields":[{"name":"scope","type":"string","required":true,"label":"Delivery scope","options":["sort_first","manual_rank"]}]}. Options suggest answers; the human can supply another value. Use fields for nested objects and items for typed arrays; supported field types are string, number, boolean, enum, array, object and json.',
    inputSchema: {
      ...askHumanInputSchema,
      type: "object",
    },
  },
  comment_list: {
    description:
      'List comments on a task (markdown bodies with mentions already expanded). Two expanded forms appear: `[KEY-N](/projects/<slug>/tasks/<n>)` is a real task link, while `[@<agentId>](/agents/<agentId>)` marks an AGENT MENTION — that href is a marker, not a route, so read it as "this comment mentioned <agentId>" and never follow it.',
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["slug", "taskId"],
    },
  },
  comment_create: {
    description:
      "Add a markdown comment to a task; KEY-N mentions are expanded to task links at write time. An `@<agentId>` handle summons that platform agent to this task: use the canonical `@<package>:<stem>` form (a bare `@<stem>` resolves only when exactly one eligible agent in the project carries that stem). Handles inside fenced code blocks, inline code spans, or existing markdown links are inert, and an unresolved handle stays literal text. The response reports every handle that resolved, each with `summonable`. `summonable: false` means it rendered as a chip but nothing will launch until a project admin enables a mention trigger. `summonable: true` is NOT a receipt that a run started — it means the handle resolved and the grant existed when you posted; the trigger consumer decides afterwards and may still skip (you cannot summon yourself), suppress (that agent already has an active run on this task), or refuse the launch. Poll the task's runs if you need to know a run actually started.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        body: { type: "string", minLength: 1 },
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Idempotency key for this effect (sent as the Idempotency-Key header). Required when acting as the librarian: reuse the SAME key when retrying the same effect, and a new key for a new effect.",
        },
      },
      required: ["slug", "taskId", "body"],
    },
  },
  triage_set: {
    description:
      "Submit a triage verdict for a task. Required requests need qualification, requestKey and both expected revisions from task_get; a bound qualifier receives a 202 candidate receipt, published only after clean validated completion. Legacy task behavior: any of flowId/runnerId/baseBranch/targetBranch/promotionMode stamps triage_status='triaged'; `flag: true` instead holds the task for a human (mutually exclusive with verdict fields). `flowId` accepts either the flow's UUID or its ref (e.g. `aif-bugfix`), as returned by `flow_list` (`id` or `ref`). `enqueue: true` sets the auto-launch intent (valid only with a verdict that yields a flow). `priority` (queue admission order) and `confidence` (0..1, advisory) are independent and may accompany either shape — send `null` to clear (priority → 'normal', confidence → none).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        flowId: { type: "string", minLength: 1 },
        runnerId: { type: "string", minLength: 1 },
        baseBranch: { type: "string", minLength: 1 },
        targetBranch: { type: "string", minLength: 1 },
        promotionMode: {
          type: "string",
          enum: ["local_merge", "pull_request"],
        },
        flag: { type: "boolean" },
        enqueue: { type: "boolean" },
        priority: {
          type: ["string", "null"],
          enum: ["low", "normal", "high", "urgent", null],
        },
        confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
        requestKey: { type: "string", format: "uuid" },
        expectedInputRevision: {
          type: "integer",
          minimum: 1,
          maximum: 2147483647,
        },
        expectedQualificationRevision: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 2147483647,
        },
        qualification: taskQualificationSchema,
      },
      required: ["slug", "taskId"],
    },
  },
  relation_list: {
    description:
      "List a task's typed relations. A relation may point at a task in ANOTHER " +
      "project; when you are not authorized to read that project the row still " +
      "carries the counterpart's taskKey and number but returns title=null, " +
      "status=null and redacted=true. That is a permission boundary, not missing " +
      "data — do not retry it.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["slug", "taskId"],
    },
  },
  relation_add: {
    description:
      "Add a typed relation from this task to another task. Address the target with EXACTLY ONE of `toNumber` (per-project number, same project only) or `toTaskKey` (platform-unique `KEY-N` such as `API-42`, which may name a task in ANOTHER project). `duplicate_of` marks this task as a duplicate of the target — a non-blocking annotation used by triage dedup. `requires` is SUCCESS-gated: unlike `depends_on` it does NOT release when the counterpart reaches `Abandoned` or `Failed`, so a wrong `requires` edge blocks its dependent until a human removes it — reach for `depends_on` when you want the self-healing kind.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        kind: {
          type: "string",
          enum: [
            "blocks",
            "depends_on",
            "parent_of",
            "requires",
            "duplicate_of",
          ],
        },
        toNumber: { type: "integer", minimum: 1 },
        toTaskKey: { type: "string" },
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Idempotency key for this effect (sent as the Idempotency-Key header). Required when acting as the librarian: reuse the SAME key when retrying the same effect, and a new key for a new effect.",
        },
      },
      required: ["slug", "taskId", "kind"],
    },
  },
  relation_remove: {
    description:
      "Remove a typed relation from this task (idempotent — missing relation is a no-op). Address the target with EXACTLY ONE of `toNumber` or `toTaskKey` (platform-unique `KEY-N`, may name another project's task). All five kinds are removable here, including the `requires` edges the orchestrator mints — removing one is the only way to unblock a dependent wedged behind a failed dependency.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        kind: {
          type: "string",
          enum: [
            "blocks",
            "depends_on",
            "parent_of",
            "requires",
            "duplicate_of",
          ],
        },
        toNumber: { type: "integer", minimum: 1 },
        toTaskKey: { type: "string" },
        operationKey: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Idempotency key for this effect (sent as the Idempotency-Key header). Required when acting as the librarian: reuse the SAME key when retrying the same effect, and a new key for a new effect.",
        },
      },
      required: ["slug", "taskId", "kind"],
    },
  },
  project_list: {
    description:
      "List the projects the token's owner can see (id, slug, name). Nothing outside the owner's visibility is ever listed.",
    inputSchema: { type: "object", properties: {} },
  },
  project_get: {
    description:
      "A project's routing directory: purpose (first README paragraph, or null when the owner may not read repository files), launchable flows, default runner, whether a triager is configured, whether Project Brain is enabled, and `asOf`. A project the owner cannot see answers like a missing one (404).",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
  },
  task_search: {
    description:
      "Search tasks by title, prompt or key (`KEY-12`) across the owner's visible projects, 25 per page, newest first. `truncated: true` means more matches exist — pass `nextCursor` as `cursor` or narrow `q`; never treat a truncated page as the complete answer.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", minLength: 1 },
        cursor: { type: "string" },
      },
      required: ["q"],
    },
  },
  work_list: {
    description:
      "The owner's cross-project work table: every task in the owner's visible projects with its derived work stage, blocked flag, latest run, readiness and who it waits on.",
    inputSchema: { type: "object", properties: {} },
  },
  decisions_list: {
    description:
      "The owner's own decision queue (HITL questions, promotable, crashed and triage-flagged work). Read-only: a human-only decision is answered by the owner in the UI, never through this tool.",
    inputSchema: {
      type: "object",
      properties: {
        operationalGrouping: {
          type: "string",
          enum: ["agent"],
          default: "agent",
          description:
            "Group repeated operational failures by project and agent.",
        },
      },
    },
  },
  activity_feed: {
    description:
      "The owner's cross-project activity feed, newest first. `projectId` narrows to one visible project (a project the owner cannot see yields an empty feed).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        kind: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
};

type DispatchResult =
  | { isError?: false; [key: string]: unknown }
  | {
      isError: true;
      status: number;
      code?: string;
      message?: string;
      publicBody?: Record<string, unknown>;
    };

export function isDelegationAdmissionTool(
  name: string,
): name is "run_delegate" | "run_plan" {
  return name === "run_delegate" || name === "run_plan";
}

export async function dispatchTool(opts: {
  name: string;
  args: Record<string, unknown>;
  ctx: AuthContext;
  baseUrl: string;
  signal?: AbortSignal;
}): Promise<DispatchResult> {
  const { name, args, ctx, baseUrl, signal } = opts;

  const authHeader = resolveAuthHeader(ctx);

  if (!authHeader) {
    return { isError: true, status: 401, message: "Missing bearer token" };
  }

  if (name === "memory" && !agentMemoryInput.safeParse(args).success)
    return {
      isError: true,
      status: 422,
      code: "CONFIG",
      message: "Invalid agent memory command",
    };

  if (isDelegationAdmissionTool(name)) {
    const parsed = z
      .fromJSONSchema(
        TOOL_SPECS[name].inputSchema as z.core.JSONSchema.JSONSchema,
      )
      .safeParse(args);
    const taskBacked =
      name === "run_plan" ||
      args.mode !== "run" ||
      args.target === null ||
      typeof args.target !== "object" ||
      !("agentId" in args.target);

    if (!parsed.success || (taskBacked && args.operationKey === undefined)) {
      const publicBody = {
        code: "CONFIG",
        message:
          "Delegation launch arguments are invalid; supply a stable operationKey for task-backed work",
        details: {
          reason: "delegation_launch_arguments_invalid",
          issues: parsed.success
            ? [{ path: ["operationKey"], code: "required" }]
            : parsed.error.issues.map((issue) => ({
                path: issue.path.map(String),
                code: issue.code,
              })),
        },
      };

      return { isError: true, status: 422, ...publicBody, publicBody };
    }
  }

  if (isLaunchAdmissionTool(name)) {
    const issues = taskLaunchArgumentIssues(name, args);

    if (issues) {
      const publicBody = {
        code: "CONFIG",
        message: "Task launch arguments are invalid",
        details: { reason: "task_launch_arguments_invalid", issues },
      };

      return { isError: true, status: 422, ...publicBody, publicBody };
    }
  }

  const nativeArguments = isKnowledgeTool(name)
    ? parseKnowledgeToolArguments(name, args)
    : args;

  if (nativeArguments === null) {
    const publicBody = {
      code: "CONFIG",
      message: "Invalid structured knowledge tool input",
      details: { reason: "knowledge_tool_input_invalid" },
    };

    return {
      isError: true,
      status: 400,
      code: publicBody.code,
      message: publicBody.message,
      publicBody,
    };
  }

  // ADR-187: the librarian's operation key rides the `Idempotency-Key` header,
  // never the body — the ext routes validate their bodies strictly.
  const { operationKey, ...routedArgs } = nativeArguments;
  const { method, path, body } = resolveRouting(
    name,
    coerceNumericArgs(name, routedArgs),
  );
  const headers =
    typeof operationKey === "string" && operationKey.length > 0
      ? { "Idempotency-Key": operationKey }
      : undefined;

  let res: Response;

  try {
    res = await callExt({
      baseUrl,
      authHeader,
      method,
      path,
      body,
      headers,
      signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { isError: true, status: 0, code: "NETWORK", message };
  }

  if (!res.ok) {
    if (
      name === "hitl_respond" ||
      name === "ask_human" ||
      isLaunchAdmissionTool(name) ||
      isDelegationAdmissionTool(name) ||
      name === "memory" ||
      isVaultIndexTool(name) ||
      name === "agent_memory_write" ||
      isKnowledgeTool(name) ||
      name.startsWith("stand_operation_")
    )
      return structuredResponseToToolError(res);

    return restResponseToToolError(res);
  }

  try {
    return (await res.json()) as { [key: string]: unknown };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { isError: true, status: res.status, code: "UPSTREAM", message };
  }
}

function propertyIsNumeric(prop: unknown): boolean {
  if (typeof prop !== "object" || prop === null) return false;
  const type = (prop as { type?: unknown }).type;
  const numeric = (t: unknown) => t === "number" || t === "integer";

  return numeric(type) || (Array.isArray(type) && type.some(numeric));
}

// LLMs routinely emit numeric arguments as JSON strings ("0.8" instead of 0.8).
// The ext routes own input validation, so such a string would reach their
// strict z.number() gate and fail 422. Normalize every arg whose
// declared inputSchema type admits a number: a finite numeric string becomes a
// number; anything else (null, non-numeric string, an already-numeric value) is
// left untouched so genuinely bad input still surfaces at the route.
function coerceNumericArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (
    TOOL_SPECS[name]?.inputSchema as
      { properties?: Record<string, unknown> } | undefined
  )?.properties;

  if (!properties) return args;

  const out: Record<string, unknown> = { ...args };

  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== "string" || !propertyIsNumeric(properties[key])) {
      continue;
    }

    const trimmed = value.trim();

    if (trimmed === "") continue;
    const parsed = Number(trimmed);

    if (Number.isFinite(parsed)) out[key] = parsed;
  }

  return out;
}

function resolveRouting(
  name: string,
  args: Record<string, unknown>,
): {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
} {
  if (isTaskLaunchTool(name)) return taskLaunchRouting(name, args);
  if (isKnowledgeTool(name)) return knowledgeToolRouting(name, args);

  switch (name) {
    case "stand_operation_get":
    case "stand_operation_logs":
    case "stand_operation_observe":
    case "stand_operation_dispatch":
    case "stand_operation_verify": {
      const id = encodeURIComponent(String(args.operationId));
      const path = `/api/v1/ext/stand-operations/${id}`;

      if (name === "stand_operation_get") return { method: "GET", path };
      const action =
        name === "stand_operation_verify"
          ? "verification"
          : name.slice("stand_operation_".length);

      return { method: "POST", path: `${path}/${action}` };
    }
    case "stand_operation_create": {
      const { assignmentId, ...body } = args as {
        assignmentId: string;
      } & Record<string, unknown>;

      return {
        method: "POST",
        path: `/api/v1/ext/specialist-assignments/${encodeURIComponent(assignmentId)}/operations`,
        body,
      };
    }
    case "project_list":
      return { method: "GET", path: `/api/v1/ext/projects` };
    case "project_get": {
      const { slug } = args as { slug: string };

      return {
        method: "GET",
        path: `/api/v1/ext/projects/${slug}/directory`,
      };
    }
    case "task_search": {
      const { q, cursor } = args as { q: string; cursor?: string };
      const sp = new URLSearchParams({ q });

      if (cursor !== undefined) sp.set("cursor", cursor);

      return {
        method: "GET",
        path: `/api/v1/ext/tasks/search?${sp.toString()}`,
      };
    }
    case "work_list":
      return { method: "GET", path: `/api/v1/ext/work` };
    case "decisions_list": {
      const { operationalGrouping = "agent" } = args as {
        operationalGrouping?: string;
      };
      const search = new URLSearchParams({ operationalGrouping });

      return {
        method: "GET",
        path: `/api/v1/ext/decisions?${search.toString()}`,
      };
    }
    case "activity_feed": {
      const { projectId, kind, limit } = args as {
        projectId?: string;
        kind?: string;
        limit?: number;
      };
      const sp = new URLSearchParams();

      if (projectId !== undefined) sp.set("projectId", projectId);
      if (kind !== undefined) sp.set("kind", kind);
      if (limit !== undefined) sp.set("limit", String(limit));

      const suffix = sp.size > 0 ? `?${sp.toString()}` : "";

      return { method: "GET", path: `/api/v1/ext/activity/feed${suffix}` };
    }
    case "task_create": {
      const { slug, title, prompt, statement, flowId, source } = args as {
        slug: string;
        title: string;
        prompt?: string;
        statement?: Record<string, unknown>;
        flowId?: string;
        source?: Record<string, unknown>;
      };
      const body: Record<string, unknown> = { title };

      if (prompt !== undefined) body.prompt = prompt;
      if (statement !== undefined) body.statement = statement;
      if (flowId !== undefined) body.flowId = flowId;
      if (source !== undefined) body.source = source;

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks`,
        body,
      };
    }
    case "task_statement_accept": {
      const { slug, taskId, statement, expectedRevision } = args as {
        slug: string;
        taskId: string;
        statement: Record<string, unknown>;
        expectedRevision: number;
      };

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/statement`,
        body: { statement, expectedRevision },
      };
    }
    case "task_send_to_triage": {
      const { slug, taskId, launchIntent } = args as {
        slug: string;
        taskId: string;
        launchIntent: "triage_only" | "triage_then_launch";
      };

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/send-to-triage`,
        body: { launchIntent },
      };
    }
    case "task_publish_excerpt": {
      const { slug, taskId, excerpt } = args as {
        slug: string;
        taskId: string;
        excerpt: string;
      };

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/publish-excerpt`,
        body: { excerpt },
      };
    }
    case "clarification_request": {
      const {
        slug,
        taskId,
        recipientUserId,
        question,
        reason,
        answerFormat,
        blocking,
      } = args as {
        slug: string;
        taskId: string;
        recipientUserId: string;
        question: string;
        reason: string;
        answerFormat: "text" | "choice" | "yes_no";
        blocking: boolean;
      };

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/clarifications`,
        body: { recipientUserId, question, reason, answerFormat, blocking },
      };
    }
    case "clarification_cancel": {
      const { slug, taskId, clarificationId } = args as {
        slug: string;
        taskId: string;
        clarificationId: string;
      };

      return {
        method: "DELETE",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/clarifications/${clarificationId}`,
      };
    }
    case "clarification_list": {
      const { slug, taskId } = args as { slug: string; taskId: string };

      return {
        method: "GET",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/clarifications`,
      };
    }
    case "project_members_list": {
      const { slug } = args as { slug: string };

      return { method: "GET", path: `/api/v1/ext/projects/${slug}/members` };
    }
    case "task_list": {
      const { slug } = args as { slug: string };

      return { method: "GET", path: `/api/v1/ext/projects/${slug}/tasks` };
    }
    case "task_find_by_source": {
      const { slug, kind, instance, externalId } = args as {
        slug: string;
        kind: string;
        instance: string;
        externalId: string;
      };
      const sp = new URLSearchParams({ kind, instance, externalId });

      return {
        method: "GET",
        path: `/api/v1/ext/projects/${slug}/tasks/by-source?${sp.toString()}`,
      };
    }
    case "task_source_bind": {
      const { slug, taskId, ...rest } = args as {
        slug: string;
        taskId: string;
      } & Record<string, unknown>;
      const body: Record<string, unknown> = {};

      for (const key of [
        "kind",
        "instance",
        "scope",
        "externalId",
        "externalKey",
        "url",
        "expectedRevision",
      ]) {
        if (rest[key] !== undefined) body[key] = rest[key];
      }

      return {
        method: "PUT",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/source`,
        body,
      };
    }
    case "task_get": {
      const { slug, taskId } = args as { slug: string; taskId: string };

      return {
        method: "GET",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}`,
      };
    }
    case "flow_list": {
      const { slug } = args as { slug: string };

      return { method: "GET", path: `/api/v1/ext/projects/${slug}/flows` };
    }
    case "runner_list": {
      const { slug } = args as { slug: string };

      return { method: "GET", path: `/api/v1/ext/projects/${slug}/runners` };
    }
    case "evaluation_context_get":
      return { method: "GET", path: `/api/v1/ext/evaluations/context` };
    case "evaluation_evidence_list": {
      const { cursor, limit } = args as { cursor?: string; limit?: number };
      const sp = new URLSearchParams();

      if (cursor !== undefined) sp.set("cursor", cursor);
      if (limit !== undefined) sp.set("limit", String(limit));

      const suffix = sp.size > 0 ? `?${sp.toString()}` : "";

      return {
        method: "GET",
        path: `/api/v1/ext/evaluations/evidence${suffix}`,
      };
    }
    case "evaluation_evidence_read": {
      const { itemId, offset, length } = args as {
        itemId: string;
        offset?: number;
        length?: number;
      };
      const sp = new URLSearchParams();

      if (offset !== undefined) sp.set("offset", String(offset));
      if (length !== undefined) sp.set("length", String(length));

      const suffix = sp.size > 0 ? `?${sp.toString()}` : "";

      return {
        method: "GET",
        path: `/api/v1/ext/evaluations/evidence/${itemId}${suffix}`,
      };
    }
    case "evaluation_objective_results":
      return {
        method: "GET",
        path: `/api/v1/ext/evaluations/objective-results`,
      };
    case "evaluation_result_submit": {
      const { criteria, winner } = args as {
        criteria: unknown;
        winner?: unknown;
      };

      return {
        method: "POST",
        path: `/api/v1/ext/evaluations/result`,
        body: winner === undefined ? { criteria } : { criteria, winner },
      };
    }
    case "memory_recall": {
      const { slug, q, limit, kinds, minConfidence } = args as {
        slug: string;
        q: string;
        limit?: number;
        kinds?: string[];
        minConfidence?: number;
      };
      const sp = new URLSearchParams();

      sp.set("q", q);
      if (limit !== undefined) sp.set("limit", String(limit));
      if (minConfidence !== undefined)
        sp.set("minConfidence", String(minConfidence));
      for (const k of kinds ?? []) sp.append("kinds", k);

      return {
        method: "GET",
        path: `/api/v1/ext/projects/${slug}/memory?${sp.toString()}`,
      };
    }
    case "memory_clusters": {
      const { slug, kinds, minRecurrence, limit } = args as {
        slug: string;
        kinds?: string[];
        minRecurrence?: number;
        limit?: number;
      };
      const sp = new URLSearchParams();

      for (const k of kinds ?? []) sp.append("kinds", k);
      if (minRecurrence !== undefined)
        sp.set("minRecurrence", String(minRecurrence));
      if (limit !== undefined) sp.set("limit", String(limit));

      const suffix = sp.size > 0 ? `?${sp.toString()}` : "";

      return {
        method: "GET",
        path: `/api/v1/ext/projects/${slug}/memory/clusters${suffix}`,
      };
    }
    case "memory_propose": {
      const {
        slug,
        kind,
        evidenceItemIds,
        draft,
        blastRadius,
        clusterHash,
        rationale,
      } = args as {
        slug: string;
        kind: string;
        evidenceItemIds?: string[];
        draft: Record<string, unknown>;
        blastRadius?: string;
        clusterHash?: string | null;
        rationale?: string;
      };
      const body: Record<string, unknown> = { kind, draft };

      if (evidenceItemIds !== undefined) body.evidenceItemIds = evidenceItemIds;
      if (blastRadius !== undefined) body.blastRadius = blastRadius;
      if (clusterHash !== undefined) body.clusterHash = clusterHash;
      if (rationale !== undefined) body.rationale = rationale;

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/memory/proposals`,
        body,
      };
    }
    case "memory_retain": {
      const { slug, content, kind, title, tags } = args as {
        slug: string;
        content: string;
        kind: string;
        title?: string;
        tags?: string[];
      };
      const body: Record<string, unknown> = { content, kind };

      if (title !== undefined) body.title = title;
      if (tags !== undefined) body.tags = tags;

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/memory`,
        body,
      };
    }
    case "memory":
      return {
        method: "POST",
        path: "/api/v1/ext/agent/memory/commands",
        body: args,
      };
    case "memory_search":
    case "memory_backlinks":
    case "memory_tags": {
      const query = new URLSearchParams();

      for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string" || typeof value === "number") query.set(key, String(value));
      }

      return {
        method: "GET",
        path: `/api/v1/ext/agent/memory/${vaultIndexRoutes[name]}${query.size ? `?${query}` : ""}`,
      };
    }
    case "agent_memory_write": {
      // No `slug`: the project and agent are derived server-side from the
      // run-bound token (ADR-152 D15).
      const { content, ifHash } = args as {
        content: string;
        ifHash?: string | null;
      };

      return {
        method: "POST",
        path: "/api/v1/ext/agent/memory",
        body: { content, ifHash: ifHash ?? null },
      };
    }
    case "task_update": {
      const { slug, taskId, title, prompt } = args as {
        slug: string;
        taskId: string;
        title?: string;
        prompt?: string;
      };
      const body: Record<string, unknown> = {};

      if (title !== undefined) body.title = title;
      if (prompt !== undefined) body.prompt = prompt;

      return {
        method: "PATCH",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}`,
        body,
      };
    }
    case "task_complete": {
      const { slug, taskId, expectedRevision } = args as {
        slug: string;
        taskId: string;
        expectedRevision?: number;
      };
      const body: Record<string, unknown> = {};

      if (expectedRevision !== undefined)
        body.expectedRevision = expectedRevision;

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/complete`,
        body,
      };
    }
    case "run_launch": {
      const {
        taskId,
        expectedTaskRevision,
        expectedSettingsToken,
        runnerId,
        executorOverrideId,
        baseBranch,
        targetBranch,
      } = args as {
        taskId: string;
        expectedTaskRevision?: number;
        expectedSettingsToken?: string;
        runnerId?: string;
        executorOverrideId?: string;
        baseBranch?: string;
        targetBranch?: string;
      };
      const body: Record<string, unknown> = { taskId };

      if (expectedTaskRevision !== undefined)
        body.expectedTaskRevision = expectedTaskRevision;
      if (expectedSettingsToken !== undefined)
        body.expectedSettingsToken = expectedSettingsToken;

      if (runnerId !== undefined) body.runnerId = runnerId;
      if (executorOverrideId !== undefined)
        body.executorOverrideId = executorOverrideId;
      if (baseBranch !== undefined) body.baseBranch = baseBranch;
      if (targetBranch !== undefined) body.targetBranch = targetBranch;

      return { method: "POST", path: `/api/v1/ext/runs`, body };
    }
    case "run_get": {
      const { runId } = args as { runId: string };

      return { method: "GET", path: `/api/v1/ext/runs/${runId}` };
    }
    case "activity_pulse": {
      const { since, salience } = args as {
        since?: string;
        salience?: string;
      };
      const sp = new URLSearchParams();

      if (since !== undefined) sp.set("since", since);
      if (salience !== undefined) sp.set("salience", salience);

      const suffix = sp.size > 0 ? `?${sp.toString()}` : "";

      return { method: "GET", path: `/api/v1/ext/activity${suffix}` };
    }
    case "run_activity": {
      const { runId, sinceId, limit, salience } = args as {
        runId: string;
        sinceId?: string;
        limit?: number;
        salience?: string;
      };
      const sp = new URLSearchParams();

      if (sinceId !== undefined) sp.set("sinceId", sinceId);
      if (limit !== undefined) sp.set("limit", String(limit));
      if (salience !== undefined) sp.set("salience", salience);

      const suffix = sp.size > 0 ? `?${sp.toString()}` : "";

      return {
        method: "GET",
        path: `/api/v1/ext/runs/${runId}/activity${suffix}`,
      };
    }
    case "run_delegate": {
      const {
        target,
        mode,
        prompt,
        title,
        workspace,
        workspaceMode,
        persistent,
        addressableKey,
        runnerOverride,
        resultProfile,
        assignmentWork,
      } = args as {
        target: { agentId?: string; flowId?: string };
        mode: string;
        prompt: string;
        title?: string;
        workspace?: string;
        workspaceMode?: string;
        persistent?: boolean;
        addressableKey?: string;
        runnerOverride?: string;
        resultProfile?: string;
        assignmentWork?: Record<string, unknown>;
      };
      const body: Record<string, unknown> = { target, mode, prompt };

      if (title !== undefined) body.title = title;
      if (workspace !== undefined) body.workspace = workspace;
      if (workspaceMode !== undefined) body.workspaceMode = workspaceMode;
      if (persistent !== undefined) body.persistent = persistent;
      if (addressableKey !== undefined) body.addressableKey = addressableKey;
      if (runnerOverride !== undefined) body.runnerOverride = runnerOverride;
      if (resultProfile !== undefined) body.resultProfile = resultProfile;
      if (assignmentWork !== undefined) body.assignmentWork = assignmentWork;

      return { method: "POST", path: `/api/v1/ext/runs/delegate`, body };
    }
    case "run_plan": {
      const { tasks } = args as { tasks: unknown };

      return {
        method: "POST",
        path: `/api/v1/ext/runs/plan`,
        body: { tasks },
      };
    }
    case "run_collect": {
      const { childRunId, all } = args as {
        childRunId?: string;
        all?: boolean;
      };
      const body: Record<string, unknown> = {};

      if (childRunId !== undefined) body.childRunId = childRunId;
      if (all !== undefined) body.all = all;

      return { method: "POST", path: `/api/v1/ext/runs/collect`, body };
    }
    case "run_cancel": {
      const { childRunId } = args as { childRunId: string };

      return {
        method: "POST",
        path: `/api/v1/ext/runs/cancel`,
        body: { childRunId },
      };
    }
    case "run_stop": {
      const { runId } = args as { runId: string };

      return {
        method: "POST",
        path: `/api/v1/ext/runs/${runId}/stop`,
        body: {},
      };
    }
    case "run_operator_message": {
      const { runId, message } = args as { runId: string; message: string };

      return {
        method: "POST",
        path: `/api/v1/ext/runs/${runId}/operator-message`,
        body: { message },
      };
    }
    case "librarian_memory_remember": {
      const { kind, content, scope, projectSlug, validUntil } = args as {
        kind: string;
        content: string;
        scope: string;
        projectSlug?: string;
        validUntil?: string;
      };

      return {
        method: "POST",
        path: "/api/v1/ext/librarian/memory",
        body: {
          kind,
          content,
          scope,
          ...(projectSlug ? { projectSlug } : {}),
          ...(validUntil ? { validUntil } : {}),
        },
      };
    }
    case "librarian_history_search": {
      const { q } = args as { q: string };

      return {
        method: "GET",
        path: `/api/v1/ext/librarian/history/search?q=${encodeURIComponent(q)}`,
      };
    }
    case "librarian_card_propose": {
      const {
        action,
        taskId,
        expectedRevision,
        statement,
        runId,
        hitlRequestId,
        response,
        mode,
        reviewedTargetCommit,
        memory,
      } = args as {
        action:
          | "statement_accept"
          | "hitl_respond"
          | "run_promote"
          | "run_discard"
          | "memory_suggest";
        taskId?: string;
        expectedRevision?: number;
        statement?: Record<string, unknown>;
        runId?: string;
        hitlRequestId?: string;
        response?: Record<string, unknown>;
        mode?: string;
        reviewedTargetCommit?: string;
        memory?: Record<string, unknown>;
      };
      const body =
        action === "statement_accept"
          ? { action, taskId, expectedRevision, statement }
          : action === "hitl_respond"
            ? { action, runId, hitlRequestId, response }
            : action === "run_promote"
              ? { action, runId, mode, reviewedTargetCommit }
              : action === "memory_suggest"
                ? { action, memory }
                : { action, runId };

      return { method: "POST", path: "/api/v1/ext/librarian/cards", body };
    }
    case "run_message": {
      const { addressableKey, childRunId, prompt, requestKey, mode } = args as {
        addressableKey?: string;
        childRunId?: string;
        prompt: string;
        requestKey?: string;
        mode?: "steer" | "queue";
      };
      const body: Record<string, unknown> = { prompt };

      if (addressableKey !== undefined) body.addressableKey = addressableKey;
      if (childRunId !== undefined) body.childRunId = childRunId;
      if (requestKey !== undefined) body.requestKey = requestKey;
      if (mode !== undefined) body.mode = mode;

      return { method: "POST", path: `/api/v1/ext/runs/message`, body };
    }
    case "run_promote": {
      const { childRunId } = args as { childRunId: string };

      return {
        method: "POST",
        path: `/api/v1/ext/runs/promote`,
        body: { childRunId },
      };
    }
    case "run_rework": {
      const { childRunId, prompt, assignmentWork } = args as {
        childRunId: string;
        prompt: string;
        assignmentWork?: Record<string, unknown>;
      };

      return {
        method: "POST",
        path: `/api/v1/ext/runs/rework`,
        body: {
          childRunId,
          prompt,
          ...(assignmentWork ? { assignmentWork } : {}),
        },
      };
    }
    case "specialist_assignment_work_decide": {
      const { assignmentId, workId, ...body } = args as {
        assignmentId: string;
        workId: string;
        decision: "accept" | "reject";
        expectedRevision: number;
        workRevision: number;
        inputRevision: number;
        resultRevision: number;
        reason: string;
        idempotencyKey: string;
      };

      return {
        method: "POST",
        path: `/api/v1/ext/specialist-assignments/${encodeURIComponent(assignmentId)}/work/${encodeURIComponent(workId)}/decisions`,
        body,
      };
    }
    case "run_sync": {
      const { runId, strategy, agent, push, runnerId } = args as {
        runId: string;
        strategy?: string;
        agent?: boolean;
        push?: boolean;
        runnerId?: string;
      };
      const body: Record<string, unknown> = { runId };

      if (strategy !== undefined) body.strategy = strategy;
      if (agent !== undefined) body.agent = agent;
      if (push !== undefined) body.push = push;
      if (runnerId !== undefined) body.runnerId = runnerId;

      return { method: "POST", path: `/api/v1/ext/runs/sync`, body };
    }
    case "run_reopen": {
      const { runId } = args as { runId: string };

      return {
        method: "POST",
        path: `/api/v1/ext/runs/reopen`,
        body: { runId },
      };
    }
    case "run_recover": {
      const { runId } = args as { runId: string };

      return { method: "POST", path: `/api/v1/ext/runs/${runId}/recover` };
    }
    case "run_discard": {
      const { runId } = args as { runId: string };

      return { method: "POST", path: `/api/v1/ext/runs/${runId}/discard` };
    }
    case "readiness_get": {
      const { runId } = args as { runId: string };

      return { method: "GET", path: `/api/v1/ext/runs/${runId}/readiness` };
    }
    case "gate_report": {
      const {
        runId,
        gateId,
        status,
        externalRunUrl,
        commitSha,
        summary,
        payload,
      } = args as {
        runId: string;
        gateId: string;
        status: string;
        externalRunUrl?: string;
        commitSha?: string;
        summary?: string;
        payload?: unknown;
      };
      const body: Record<string, unknown> = { status };

      if (externalRunUrl !== undefined) body.externalRunUrl = externalRunUrl;
      if (commitSha !== undefined) body.commitSha = commitSha;
      if (summary !== undefined) body.summary = summary;
      if (payload !== undefined) body.payload = payload;

      return {
        method: "POST",
        path: `/api/v1/ext/runs/${runId}/gates/${gateId}/report`,
        body,
      };
    }
    case "hitl_list": {
      const { runId } = args as { runId: string };

      return { method: "GET", path: `/api/v1/ext/runs/${runId}/hitl` };
    }
    case "hitl_inbox":
      return { method: "GET", path: `/api/v1/ext/hitl` };
    case "hitl_respond": {
      const { runId, hitlRequestId, optionId, response, confidence } = args as {
        runId: string;
        hitlRequestId: string;
        optionId?: string;
        response?: unknown;
        confidence?: number;
      };
      const body: Record<string, unknown> = {};

      if (optionId !== undefined) body.optionId = optionId;
      if (response !== undefined) body.response = response;
      if (confidence !== undefined) body.confidence = confidence;

      return {
        method: "POST",
        path: `/api/v1/ext/runs/${runId}/hitl/${hitlRequestId}/respond`,
        body,
      };
    }
    case "ask_human": {
      const { slug, taskId, question, schema, reTriggerMode } = args as {
        slug: string;
        taskId: string;
        question: string;
        schema: Record<string, unknown>;
        reTriggerMode?: "agent" | "triage";
      };
      const body: Record<string, unknown> = { question, schema };

      if (reTriggerMode !== undefined) body.reTriggerMode = reTriggerMode;

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/human-asks`,
        body,
      };
    }
    case "comment_list": {
      const { slug, taskId, limit, offset } = args as {
        slug: string;
        taskId: string;
        limit?: number;
        offset?: number;
      };
      const query = new URLSearchParams();

      if (limit !== undefined) query.set("limit", String(limit));
      if (offset !== undefined) query.set("offset", String(offset));

      const suffix = query.size > 0 ? `?${query.toString()}` : "";

      return {
        method: "GET",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/comments${suffix}`,
      };
    }
    case "comment_create": {
      const { slug, taskId, body } = args as {
        slug: string;
        taskId: string;
        body: string;
      };

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/comments`,
        body: { body },
      };
    }
    case "triage_set": {
      const {
        slug,
        taskId,
        flowId,
        runnerId,
        baseBranch,
        targetBranch,
        promotionMode,
        flag,
        enqueue,
        priority,
        confidence,
        qualification,
        requestKey,
        expectedInputRevision,
        expectedQualificationRevision,
      } = args as {
        slug: string;
        taskId: string;
        flowId?: string;
        runnerId?: string;
        baseBranch?: string;
        targetBranch?: string;
        promotionMode?: string;
        flag?: boolean;
        enqueue?: boolean;
        // null is a legitimate wire value: explicit clear (≠ undefined/omit).
        priority?: string | null;
        confidence?: number | null;
        qualification?: unknown;
        requestKey?: string;
        expectedInputRevision?: number;
        expectedQualificationRevision?: number | null;
      };
      const body: Record<string, unknown> = {};

      if (flowId !== undefined) body.flowId = flowId;
      if (runnerId !== undefined) body.runnerId = runnerId;
      if (baseBranch !== undefined) body.baseBranch = baseBranch;
      if (targetBranch !== undefined) body.targetBranch = targetBranch;
      if (promotionMode !== undefined) body.promotionMode = promotionMode;
      if (flag !== undefined) body.flag = flag;
      if (enqueue !== undefined) body.enqueue = enqueue;
      if (priority !== undefined) body.priority = priority;
      if (confidence !== undefined) body.confidence = confidence;
      if (qualification !== undefined) body.qualification = qualification;
      if (requestKey !== undefined) body.requestKey = requestKey;
      if (expectedInputRevision !== undefined)
        body.expectedInputRevision = expectedInputRevision;
      if (expectedQualificationRevision !== undefined)
        body.expectedQualificationRevision = expectedQualificationRevision;

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/triage`,
        body,
      };
    }
    case "relation_list": {
      const { slug, taskId } = args as { slug: string; taskId: string };

      return {
        method: "GET",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/relations`,
      };
    }
    case "relation_add":
    case "relation_remove": {
      const { slug, taskId, kind, toNumber, toTaskKey } = args as {
        slug: string;
        taskId: string;
        kind: string;
        toNumber?: number;
        toTaskKey?: string;
      };

      // Sparse body: the route refuses both-or-neither, so forward exactly what
      // the caller sent rather than materializing an undefined key.
      const body: Record<string, unknown> = { kind };

      // `!= null` not `!== undefined`: models routinely emit an explicit null
      // for an unused optional, and the route's XOR refine treats a present
      // null as "supplied" — forwarding it would 422 a valid call.
      if (toNumber != null) body.toNumber = toNumber;
      if (toTaskKey != null) body.toTaskKey = toTaskKey;

      return {
        method: name === "relation_add" ? "POST" : "DELETE",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/relations`,
        body,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// The tools a facade process exposes. An unnamed or unknown toolset exposes
// every registered tool — the default for project and agent tokens.
export function toolNamesForToolset(toolset: string | undefined): string[] {
  if (!isToolsetName(toolset)) return Object.keys(TOOL_SPECS);

  const allowed = new Set<string>(TOOLSETS[toolset]);

  return Object.keys(TOOL_SPECS).filter((name) => allowed.has(name));
}

export function isToolInToolset(
  name: string,
  toolset: string | undefined,
): boolean {
  return (
    Object.hasOwn(TOOL_SPECS, name) &&
    toolNamesForToolset(toolset).includes(name)
  );
}
