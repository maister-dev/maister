import { type AuthContext, resolveAuthHeader } from "./auth";
import { callExt, restResponseToToolError } from "./rest";

export type ToolSpec = {
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOL_SPECS: Record<string, ToolSpec> = {
  task_create: {
    description:
      "Create a new task in a project (flowId optional — a flowless task is a simple-intent task awaiting triage). `flowId` accepts either the flow's UUID or its ref (e.g. `aif-bugfix`), as returned by `flow_list` (`id` or `ref`).",
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
      "Retain a project-memory item (ADR-122). Embeds and dedup-or-reinforces. Requires the project's Brain to be enabled and (for agent tokens) can_write_brain. The body carries no project id.",
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
  agent_memory_write: {
    description:
      "Replace THIS agent's memory file for its bound project (ADR-152), through a content-hash CAS. Pass the `ifHash` you were given; `null` is the first-writer form and succeeds only while the file is absent. A lost CAS returns 409 with the CURRENT content and hash so you can merge and retry rather than clobber. NOTE: unlike every other MAIster tool, this one takes NO `slug` — the project and the agent both come from your run-bound token. This is NOT the Project Brain: `memory_recall`/`memory_retain` remain a separate, project-owned store.",
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
      "Delegate work to a governed child run. Supply EXACTLY ONE target: target.agentId = a single-purpose catalog agent (one session, one turn-loop, package-qualified <flowRefId>:<stem>); target.flowId = a governed multi-node process from the project's enabled+trusted flows (its own graph, gates, review). Flow targets accept only title and runnerOverride — workspace, workspaceMode, persistent, addressableKey are agent-only and are refused, not ignored; a flow child always gets a linked board task (childTaskId is always returned) and run_rework/run_message do not apply to it. For an agent target, mode:'task' also creates a child board task linked parent_of under the orchestrator's task and mode:'run' spawns a board-less child; for a flow target mode is only recorded (the carrier task always exists). The parent orchestrator run is derived from the calling token — never accepted in the body. An untrusted/disabled/incompatible target, or one with no Ready platform runner, is refused and no child run is created.",
    inputSchema: {
      type: "object",
      properties: {
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
      "Emit a task-DAG of as-plan child tasks under the calling orchestrator. Each entry supplies EXACTLY ONE target — target.agentId (a catalog agent) or target.flowId (a governed multi-node process from the project's enabled+trusted flows) — plus a unique `key` and a `dependsOn` list of in-batch keys; a batch may mix both kinds and the DAG must be acyclic. `workspace` is agent-only and is refused on a flow entry, not ignored. Every task is created launch_mode='auto' and linked parent_of under the orchestrator's task; dependencies become success-gated `requires` relations. Source tasks (empty dependsOn) are launched right after the DAG commits: a refused source is reported on its result row as `launchError` (and as a system comment on the task) and is retried when a sibling child next settles; when EVERY source is refused the committed DAG is abandoned and the call fails with the refusal's code — re-plan. Downstream tasks auto-launch once their requires-dependencies all complete successfully. The orchestrator run is derived from the calling token — never accepted in the body. Returns { tasks: [{ key, taskId, childRunId?, launchError? }] } (childRunId only for launched sources, launchError only for refused ones).",
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
      required: ["tasks"],
    },
  },
  run_collect: {
    description:
      "Collect results, status, and produced artifacts from the orchestrator's delegated child runs. Pass childRunId for one child, or all:true for every child. result.value is the validated public result — use it, not outputText (deprecated); resultStatus says why it is absent (pending|valid|absent|missing|stale|invalid|unavailable) and resultFailure carries the reason. Collect is idempotent and shows only your DIRECT children. Research flow children finish by themselves when they publish a result and change nothing; collect BEFORE run_cancel — a failure-terminal child reports unavailable. Returns an array of { childRunId, status, settled, resultStatus, result, resultRevision, resultFailure, artifacts, diffRef?, outputText? }.",
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
  run_message: {
    description:
      "Re-message a PERSISTENT child agent in the calling orchestrator's run-tree by its addressableKey (or childRunId). If the child is parked between turns it is respawned and resumed with prior context; if live the prompt is delivered to the running session. The child re-parks on its next end_turn. Addressing is scoped to the caller's own tree — a child in another tree is invisible. Agent children only: a flow child has no addressable session and is refused PRECONDITION. Returns { childRunId, status }.",
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
      "Re-open a reviewed delegated child of the calling orchestrator for another turn with a rework prompt. Agent children only — a flow child owns its own review/rework loop and is refused PRECONDITION (promote or cancel it instead). The child must be a direct child of the bound orchestrator run and currently in Review. It is respawned and resumed with prior context against its existing worktree, then re-reviews on its next end_turn. Returns { childRunId, status }.",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: { type: "string" },
        prompt: { type: "string", minLength: 1 },
      },
      required: ["childRunId", "prompt"],
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
  ask_human: {
    description:
      "Create a task-bound Human-ask clarification for this running standalone agent. The server derives the requesting agent and source run from the ephemeral token; use reTriggerMode='triage' only from core:triager.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        question: { type: "string", minLength: 1, maxLength: 10000 },
        schema: { type: "object" },
        reTriggerMode: { type: "string", enum: ["agent", "triage"] },
      },
      required: ["slug", "taskId", "question", "schema"],
    },
  },
  comment_list: {
    description:
      "List comments on a task (markdown bodies with mentions already expanded). Two expanded forms appear: `[KEY-N](/projects/<slug>/tasks/<n>)` is a real task link, while `[@<agentId>](/agents/<agentId>)` marks an AGENT MENTION — that href is a marker, not a route, so read it as \"this comment mentioned <agentId>\" and never follow it.",
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
      },
      required: ["slug", "taskId", "body"],
    },
  },
  triage_set: {
    description:
      "Submit a triage verdict for a task: any of flowId/runnerId/baseBranch/targetBranch/promotionMode stamps triage_status='triaged'; `flag: true` instead holds the task for a human (mutually exclusive with verdict fields). `flowId` accepts either the flow's UUID or its ref (e.g. `aif-bugfix`), as returned by `flow_list` (`id` or `ref`). `enqueue: true` sets the auto-launch intent (valid only with a verdict that yields a flow). `priority` (queue admission order) and `confidence` (0..1, advisory) are independent and may accompany either shape — send `null` to clear (priority → 'normal', confidence → none).",
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
      },
      required: ["slug", "taskId", "kind"],
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

  const { method, path, body } = resolveRouting(
    name,
    coerceNumericArgs(name, args),
  );

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

function propertyIsNumeric(prop: unknown): boolean {
  if (typeof prop !== "object" || prop === null) return false;
  const type = (prop as { type?: unknown }).type;
  const numeric = (t: unknown) => t === "number" || t === "integer";

  return numeric(type) || (Array.isArray(type) && type.some(numeric));
}

// LLMs routinely emit numeric arguments as JSON strings ("0.8" instead of 0.8).
// The MCP inputSchema is advisory only (main.ts registers a passthrough
// z.record — args are never validated against it), so such a string would reach
// the ext route's strict z.number() gate and fail 422. Normalize every arg whose
// declared inputSchema type admits a number: a finite numeric string becomes a
// number; anything else (null, non-numeric string, an already-numeric value) is
// left untouched so genuinely bad input still surfaces at the route.
function coerceNumericArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (
    TOOL_SPECS[name]?.inputSchema as
      | { properties?: Record<string, unknown> }
      | undefined
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
      };
      const body: Record<string, unknown> = { target, mode, prompt };

      if (title !== undefined) body.title = title;
      if (workspace !== undefined) body.workspace = workspace;
      if (workspaceMode !== undefined) body.workspaceMode = workspaceMode;
      if (persistent !== undefined) body.persistent = persistent;
      if (addressableKey !== undefined) body.addressableKey = addressableKey;
      if (runnerOverride !== undefined) body.runnerOverride = runnerOverride;
      if (resultProfile !== undefined) body.resultProfile = resultProfile;

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
