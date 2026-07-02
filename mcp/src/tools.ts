import { type AuthContext, resolveAuthHeader } from "@/auth";
import { callExt, restResponseToToolError } from "@/rest";

export type ToolSpec = {
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOL_SPECS: Record<string, ToolSpec> = {
  task_create: {
    description:
      "Create a new task in a project (flowId optional — a flowless task is a simple-intent task awaiting triage)",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        title: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        flowId: { type: "string", minLength: 1 },
      },
      required: ["slug", "title", "prompt"],
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
  memory_recall: {
    description:
      "Recall relevant project-memory items (ADR-122) via hybrid vector + lexical ranking. No LLM at read. Requires the project's Brain to be enabled and (for agent tokens) can_read_brain.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        query: { type: "string", minLength: 1, maxLength: 2000 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: ["lesson", "observation", "state_fact"],
          },
        },
        minConfidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["slug", "query"],
    },
  },
  memory_retain: {
    description:
      "Retain a project-memory item (ADR-122). Embeds and dedup-or-reinforces. Requires the project's Brain to be enabled and (for agent tokens) can_write_brain. The body carries no project id.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        content: { type: "string", minLength: 1, maxLength: 32000 },
        kind: {
          type: "string",
          enum: ["lesson", "observation", "state_fact"],
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
      },
      required: ["slug", "taskId"],
    },
  },
  run_launch: {
    description:
      "Launch a run for a task. `runnerId` is an optional per-launch platform ACP runner override (highest priority in runner resolution). `baseBranch`/`targetBranch` (M18) optionally set the worktree base and the promotion target — both server-validated against the project's branch allow-list. `executorOverrideId` is the DEPRECATED alias for `runnerId`; send `runnerId` instead — the route refuses both when they conflict.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        runnerId: { type: "string", minLength: 1 },
        executorOverrideId: { type: "string", minLength: 1 },
        baseBranch: { type: "string", minLength: 1 },
        targetBranch: { type: "string", minLength: 1 },
      },
      required: ["taskId"],
    },
  },
  run_get: {
    description: "Get a run by ID",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
    },
  },
  run_delegate: {
    description:
      "Delegate work to a governed child run spawned from a catalog agent (target.agentId, package-qualified <flowRefId>:<stem>). mode:'task' also creates a child board task linked parent_of under the orchestrator's task; mode:'run' spawns a board-less child. The parent orchestrator run is derived from the calling token — it is never accepted in the body. Delegating to an untrusted/disabled agent is refused (no child run is created).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            flowId: { type: "string" },
          },
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
      },
      required: ["target", "mode", "prompt"],
    },
  },
  run_plan: {
    description:
      "Emit a task-DAG of as-plan child tasks under the calling orchestrator. Each entry is a catalog-agent target with a unique `key` and a `dependsOn` list of in-batch keys; the DAG must be acyclic. Every task is created launch_mode='auto' and linked parent_of under the orchestrator's task; dependencies become success-gated `requires` relations. Source tasks (empty dependsOn) launch immediately; downstream tasks auto-launch once their requires-dependencies all complete successfully. The orchestrator run is derived from the calling token — never accepted in the body. Returns { tasks: [{ key, taskId, childRunId? }] } (childRunId only for launched sources).",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", minLength: 1 },
              target: {
                type: "object",
                properties: { agentId: { type: "string" } },
                required: ["agentId"],
              },
              prompt: { type: "string", minLength: 1 },
              title: { type: "string", minLength: 1 },
              workspace: {
                type: "string",
                enum: ["none", "repo_read", "worktree"],
              },
              runnerOverride: { type: "string", minLength: 1 },
              dependsOn: { type: "array", items: { type: "string" } },
            },
            required: ["key", "target", "prompt", "dependsOn"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  run_collect: {
    description:
      "Collect status, output, and produced artifacts from the orchestrator's delegated child runs. Pass childRunId for one child, or all:true for every child of the calling orchestrator run. Returns an array of { childRunId, status, outputText?, artifacts, diffRef? }.",
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
      "Cancel a delegated child run of the calling orchestrator. The child must be a direct child of the bound orchestrator run. Returns { childRunId, status }.",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: { type: "string" },
      },
      required: ["childRunId"],
    },
  },
  run_message: {
    description:
      "Re-message a PERSISTENT child agent in the calling orchestrator's run-tree by its addressableKey (or childRunId). If the child is parked between turns it is respawned and resumed with prior context; if live the prompt is delivered to the running session. The child re-parks on its next end_turn. Addressing is scoped to the caller's own tree — a child in another tree is invisible. Returns { childRunId, status }.",
    inputSchema: {
      type: "object",
      properties: {
        addressableKey: { type: "string", minLength: 1 },
        childRunId: { type: "string" },
        prompt: { type: "string", minLength: 1 },
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
      "Re-open a reviewed delegated child of the calling orchestrator for another turn with a rework prompt. The child must be a direct child of the bound orchestrator run and currently in Review. It is respawned and resumed with prior context against its existing worktree, then re-reviews on its next end_turn. Returns { childRunId, status }.",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: { type: "string" },
        prompt: { type: "string", minLength: 1 },
      },
      required: ["childRunId", "prompt"],
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
      "Answer a pending permission/form HITL request for a run. Human-kind requests require a global personal token with exact hitl:respond:human scope; project tokens and wildcard scopes are refused for human gates.",
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
  comment_list: {
    description:
      "List comments on a task (markdown bodies with KEY-N mentions already expanded)",
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
      "Add a markdown comment to a task; KEY-N mentions are expanded to task links at write time",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        body: { type: "string", minLength: 1 },
      },
      required: ["slug", "taskId", "body"],
    },
  },
  triage_set: {
    description:
      "Submit a triage verdict for a task: any of flowId/runnerId/baseBranch/targetBranch/promotionMode stamps triage_status='triaged'; `flag: true` instead holds the task for a human (mutually exclusive with verdict fields). `enqueue: true` sets the auto-launch intent (valid only with a verdict that yields a flow). `priority` (queue admission order) and `confidence` (0..1, advisory) are independent and may accompany either shape — send `null` to clear (priority → 'normal', confidence → none).",
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
      },
      required: ["slug", "taskId"],
    },
  },
  relation_list: {
    description: "List a task's typed relations",
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
      "Add a typed relation from this task to another task (by per-project number). `duplicate_of` marks this task as a duplicate of the target — a non-blocking annotation used by triage dedup.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        kind: {
          type: "string",
          enum: ["blocks", "depends_on", "parent_of", "duplicate_of"],
        },
        toNumber: { type: "integer", minimum: 1 },
      },
      required: ["slug", "taskId", "kind", "toNumber"],
    },
  },
  relation_remove: {
    description:
      "Remove a typed relation from this task (idempotent — missing relation is a no-op)",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        kind: {
          type: "string",
          enum: ["blocks", "depends_on", "parent_of", "duplicate_of"],
        },
        toNumber: { type: "integer", minimum: 1 },
      },
      required: ["slug", "taskId", "kind", "toNumber"],
    },
  },
};

type DispatchResult =
  | { isError?: false; [key: string]: unknown }
  | { isError: true; status: number; code?: string; message?: string };

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

  const { method, path, body } = resolveRouting(name, args);

  let res: Response;

  try {
    res = await callExt({ baseUrl, authHeader, method, path, body, signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { isError: true, status: 0, code: "NETWORK", message };
  }

  if (!res.ok) {
    return restResponseToToolError(res);
  }

  try {
    return (await res.json()) as { [key: string]: unknown };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { isError: true, status: res.status, code: "UPSTREAM", message };
  }
}

function resolveRouting(
  name: string,
  args: Record<string, unknown>,
): {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
} {
  switch (name) {
    case "task_create": {
      const { slug, title, prompt, flowId } = args as {
        slug: string;
        title: string;
        prompt: string;
        flowId?: string;
      };
      const body: Record<string, unknown> = { title, prompt };

      if (flowId !== undefined) body.flowId = flowId;

      return {
        method: "POST",
        path: `/api/v1/ext/projects/${slug}/tasks`,
        body,
      };
    }
    case "task_list": {
      const { slug } = args as { slug: string };

      return { method: "GET", path: `/api/v1/ext/projects/${slug}/tasks` };
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
    case "memory_recall": {
      const { slug, query, limit, kinds, minConfidence } = args as {
        slug: string;
        query: string;
        limit?: number;
        kinds?: string[];
        minConfidence?: number;
      };
      const sp = new URLSearchParams();

      sp.set("q", query);
      if (limit !== undefined) sp.set("limit", String(limit));
      if (minConfidence !== undefined)
        sp.set("minConfidence", String(minConfidence));
      for (const k of kinds ?? []) sp.append("kinds", k);

      return {
        method: "GET",
        path: `/api/v1/ext/projects/${slug}/memory?${sp.toString()}`,
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
    case "run_launch": {
      const { taskId, runnerId, executorOverrideId, baseBranch, targetBranch } =
        args as {
          taskId: string;
          runnerId?: string;
          executorOverrideId?: string;
          baseBranch?: string;
          targetBranch?: string;
        };
      const body: Record<string, unknown> = { taskId };

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
      };
      const body: Record<string, unknown> = { target, mode, prompt };

      if (title !== undefined) body.title = title;
      if (workspace !== undefined) body.workspace = workspace;
      if (workspaceMode !== undefined) body.workspaceMode = workspaceMode;
      if (persistent !== undefined) body.persistent = persistent;
      if (addressableKey !== undefined) body.addressableKey = addressableKey;
      if (runnerOverride !== undefined) body.runnerOverride = runnerOverride;

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
    case "run_message": {
      const { addressableKey, childRunId, prompt } = args as {
        addressableKey?: string;
        childRunId?: string;
        prompt: string;
      };
      const body: Record<string, unknown> = { prompt };

      if (addressableKey !== undefined) body.addressableKey = addressableKey;
      if (childRunId !== undefined) body.childRunId = childRunId;

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
      const { childRunId, prompt } = args as {
        childRunId: string;
        prompt: string;
      };

      return {
        method: "POST",
        path: `/api/v1/ext/runs/rework`,
        body: { childRunId, prompt },
      };
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
      const { slug, taskId, kind, toNumber } = args as {
        slug: string;
        taskId: string;
        kind: string;
        toNumber: number;
      };

      return {
        method: name === "relation_add" ? "POST" : "DELETE",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}/relations`,
        body: { kind, toNumber },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
