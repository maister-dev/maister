import { type AuthContext, resolveAuthHeader } from "@/auth";
import { callExt, restResponseToToolError } from "@/rest";

export type ToolSpec = {
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOL_SPECS: Record<string, ToolSpec> = {
  task_create: {
    description: "Create a new task in a project",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        title: { type: "string" },
        prompt: { type: "string" },
        flowId: { type: "string" },
        executorOverrideId: { type: "string" },
      },
      required: ["slug", "title", "prompt", "flowId"],
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
  task_update: {
    description: "Update fields on a task",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        taskId: { type: "string" },
        title: { type: "string" },
        prompt: { type: "string" },
        executorOverrideId: { type: ["string", "null"] },
      },
      required: ["slug", "taskId"],
    },
  },
  run_launch: {
    description: "Launch a run for a task",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        executorOverrideId: { type: "string" },
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
        status: { type: "string" },
        externalRunUrl: { type: "string" },
        commitSha: { type: "string" },
        summary: { type: "string" },
        payload: { type: "object" },
      },
      required: ["runId", "gateId", "status"],
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
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
} {
  switch (name) {
    case "task_create": {
      const { slug, title, prompt, flowId, executorOverrideId } = args as {
        slug: string;
        title: string;
        prompt: string;
        flowId: string;
        executorOverrideId?: string;
      };
      const body: Record<string, unknown> = { title, prompt, flowId };

      if (executorOverrideId !== undefined)
        body.executorOverrideId = executorOverrideId;

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
    case "task_update": {
      const { slug, taskId, title, prompt, executorOverrideId } = args as {
        slug: string;
        taskId: string;
        title?: string;
        prompt?: string;
        executorOverrideId?: string | null;
      };
      const body: Record<string, unknown> = {};

      if (title !== undefined) body.title = title;
      if (prompt !== undefined) body.prompt = prompt;
      if (executorOverrideId !== undefined)
        body.executorOverrideId = executorOverrideId;

      return {
        method: "PATCH",
        path: `/api/v1/ext/projects/${slug}/tasks/${taskId}`,
        body,
      };
    }
    case "run_launch": {
      const { taskId, executorOverrideId } = args as {
        taskId: string;
        executorOverrideId?: string;
      };
      const body: Record<string, unknown> = { taskId };

      if (executorOverrideId !== undefined)
        body.executorOverrideId = executorOverrideId;

      return { method: "POST", path: `/api/v1/ext/runs`, body };
    }
    case "run_get": {
      const { runId } = args as { runId: string };

      return { method: "GET", path: `/api/v1/ext/runs/${runId}` };
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
