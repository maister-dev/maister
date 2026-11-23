import type { HostState } from "./host-state";
import type { McpServerInput } from "./types";

import { resolveFacadeLaunch } from "../../runtime/facade-launch";

import { SupervisorError } from "./types";

function trustedWebOrigin(value: string | undefined): string | null {
  const parsed = value ? URL.parse(value) : null;
  if (
    !parsed ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    return null;

  return parsed.origin;
}

function resolveNativeFacade(server: McpServerInput): McpServerInput {
  const webOrigin = trustedWebOrigin(process.env.MAISTER_API_BASE_URL);
  const declaredOrigin = trustedWebOrigin(server.env?.MAISTER_API_BASE_URL);
  const token = server.env?.MAISTER_PROJECT_TOKEN;
  const toolset = server.env?.MAISTER_MCP_TOOLSET;
  if (
    server.transport !== "stdio" ||
    !webOrigin ||
    declaredOrigin !== webOrigin ||
    !token ||
    !/^mai_[A-Za-z0-9_-]{43}$/.test(token) ||
    (toolset && !["project-run", "company", "vault"].includes(toolset))
  )
    throw new SupervisorError(
      "PRECONDITION",
      "Workspace facade requires the configured Web origin and a scoped token",
      {
        details: { reason: "workspace_rejected" },
      },
    );
  const executable = resolveFacadeLaunch();
  if (!executable)
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "MAIster MCP facade is unavailable on the workspace supervisor",
      {
        details: { reason: "workspace_protocol_unsupported" },
      },
    );

  return {
    name: server.name,
    platformOrigin: "maister_facade",
    transport: "stdio",
    ...executable,
    env: {
      MAISTER_API_BASE_URL: webOrigin,
      MAISTER_PROJECT_TOKEN: token,
      ...(toolset ? { MAISTER_MCP_TOOLSET: toolset } : {}),
    },
  };
}

export function workspaceSessionMcpServers(
  state: HostState,
  workspaceId: string,
  servers: McpServerInput[] | undefined,
): McpServerInput[] | undefined {
  const owned = state.getWorkspaceExecutionState(workspaceId);
  if (!owned?.inputDigest) {
    if (
      servers?.some(
        ({ transport, command, distribution }) =>
          transport === "stdio" && !command && !distribution,
      )
    )
      throw new SupervisorError(
        "PRECONDITION",
        "A legacy workspace cannot resolve a host-owned facade",
      );
    return servers;
  }
  return servers?.map((server) =>
    server.platformOrigin === "maister_facade"
      ? resolveNativeFacade(server)
      : server,
  );
}
