import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import taskLaunchInputs from "../../runtime/task-launch-inputs.schema.json";

const operationKey = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description:
    "Required Idempotency-Key for this effect. Reuse the same key and payload after an uncertain response; use a new key for a new decision.",
};
const intentId = { type: "string", minLength: 1, maxLength: 256 };

export const LEGACY_RUN_LAUNCH_TOOL_SPEC = {
  description:
    "Deprecated compatibility adapter for automatic task launch. Prefer task_launch_options then task_launch. New effects require expectedTaskRevision, expectedSettingsToken and operationKey; only historical Librarian receipts may replay without optimistic fields. Requires current accepted qualification and armed automation. Returns an actual run receipt only after run binding; intent-only acceptance has code launch_pending and intentId. executorOverrideId is the deprecated runnerId alias; conflicting aliases are refused.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      taskId: taskLaunchInputs.launch.properties.taskId,
      expectedTaskRevision:
        taskLaunchInputs.launch.properties.expectedTaskRevision,
      expectedSettingsToken:
        taskLaunchInputs.launch.properties.expectedSettingsToken,
      runnerId: taskLaunchInputs.launch.properties.runnerId,
      executorOverrideId: taskLaunchInputs.launch.properties.runnerId,
      baseBranch: taskLaunchInputs.launch.properties.baseBranch,
      targetBranch: taskLaunchInputs.launch.properties.targetBranch,
      operationKey,
    },
    required: ["taskId"],
  },
} satisfies { description: string; inputSchema: Tool["inputSchema"] };

export const TASK_LAUNCH_TOOL_SPECS = {
  task_launch_options: {
    description:
      "Read the exact current taskRevision and settingsToken before an automatic launch. Pass them as expectedTaskRevision and expectedSettingsToken to task_launch with the same Flow/agent/workspace/package selection. Includes qualification and any active launch; this read does not launch or grant human authority.",
    inputSchema: { ...taskLaunchInputs.options, type: "object" },
  },
  task_launch: {
    description:
      "Accept an automatic task launch for the exact task revision and resolved settings token. Select an attached code-delivery agent with agentId and optional workspace, or a Flow with flowId; never combine the targets. Requires current accepted qualification and armed automation. Token callers cannot create a human manual decision. The returned intent may wait for capacity; acceptance does not prove model dispatch or delivery.",
    inputSchema: {
      ...taskLaunchInputs.launch,
      type: "object",
      properties: { ...taskLaunchInputs.launch.properties, operationKey },
      required: [...taskLaunchInputs.launch.required, "operationKey"],
    },
  },
  task_launch_status: {
    description:
      "Read an accepted task launch intent, its admission basis, state, linked run and actionable hold reason. Requires current scoped read access; does not launch or retry anything.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { intentId },
      required: ["intentId"],
    },
  },
  task_launch_cancel: {
    description:
      "Cancel a task launch before dispatch using its current state version. This records a token cancellation decision and retains the original admission audit. An executing launch cannot be cancelled through this operation.",
    inputSchema: {
      ...taskLaunchInputs.cancel,
      type: "object",
      properties: {
        ...taskLaunchInputs.cancel.properties,
        intentId,
        operationKey,
      },
      required: [
        ...taskLaunchInputs.cancel.required,
        "intentId",
        "operationKey",
      ],
    },
  },
  task_launch_replace: {
    description:
      "Atomically replace an undispatched launch with a newly qualified automatic request for the exact current task revision and settings token. Requires the old intent's current state version. A refusal leaves the predecessor unchanged; a token cannot inherit a human grant for the new request.",
    inputSchema: {
      ...taskLaunchInputs.replace,
      type: "object",
      properties: {
        ...taskLaunchInputs.replace.properties,
        intentId,
        operationKey,
      },
      required: [
        ...taskLaunchInputs.replace.required,
        "intentId",
        "operationKey",
      ],
    },
  },
} satisfies Record<
  string,
  { description: string; inputSchema: Tool["inputSchema"] }
>;

export type TaskLaunchToolName = keyof typeof TASK_LAUNCH_TOOL_SPECS;
type LaunchAdmissionToolName = TaskLaunchToolName | "run_launch";

export function isTaskLaunchTool(name: string): name is TaskLaunchToolName {
  return Object.hasOwn(TASK_LAUNCH_TOOL_SPECS, name);
}

export function isLaunchAdmissionTool(
  name: string,
): name is LaunchAdmissionToolName {
  return name === "run_launch" || isTaskLaunchTool(name);
}

const taskLaunchSchemas = {
  ...TASK_LAUNCH_TOOL_SPECS,
  run_launch: LEGACY_RUN_LAUNCH_TOOL_SPEC,
};
const taskLaunchValidators = Object.fromEntries(
  Object.entries(taskLaunchSchemas).map(([name, spec]) => [
    name,
    z.fromJSONSchema(spec.inputSchema as z.core.JSONSchema.JSONSchema),
  ]),
);

export function taskLaunchArgumentIssues(
  name: LaunchAdmissionToolName,
  args: Record<string, unknown>,
): Array<{ path: PropertyKey[]; code: string }> | null {
  // Zod JSON-schema composition can widen unknown-key handling. Check the
  // canonical declared keys independently before its nested/target validator.
  const properties = taskLaunchSchemas[name].inputSchema.properties;
  const unknownKeys = Object.keys(args).filter(
    (key) => !Object.hasOwn(properties, key),
  );

  if (unknownKeys.length)
    return unknownKeys.map((key) => ({
      path: [key],
      code: "unrecognized_keys",
    }));
  const result = taskLaunchValidators[name].safeParse(args);

  return result.success
    ? null
    : result.error.issues.map(({ path, code }) => ({ path, code }));
}

export function taskLaunchRouting(
  name: TaskLaunchToolName,
  args: Record<string, unknown>,
): {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
} {
  const root = "/api/v1/ext/task-launch-intents";

  if (name === "task_launch_options") {
    const query = new URLSearchParams(
      Object.entries(args).map(([key, value]): [string, string] => [
        key,
        key === "packageVersions" ? JSON.stringify(value) : String(value),
      ]),
    );

    return { method: "GET", path: `${root}/options?${query.toString()}` };
  }

  if (name === "task_launch") {
    return { method: "POST", path: root, body: args };
  }
  const { intentId: selectedIntentId, ...body } = args;
  const path = `${root}/${encodeURIComponent(selectedIntentId as string)}`;

  if (name === "task_launch_status") return { method: "GET", path };

  return {
    method: "POST",
    path: `${path}/${name === "task_launch_cancel" ? "cancel" : "replace"}`,
    body,
  };
}
