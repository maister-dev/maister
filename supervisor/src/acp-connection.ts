import * as acp from "@agentclientprotocol/sdk/unstable";

import { createAcpToolCallContext } from "./acp-tool-call-context";

// SDK 2 removed `ClientSideConnection` in favour of the app API. The supervisor
// keeps this one named-method seam so its call sites and test fakes do not
// track SDK churn. The `/unstable` entrypoint matches what SDK 1.x exposed by
// default: the stable one would strip unstable fields (e.g. turn usage) from
// parsed messages.
export type AcpConnection = {
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse>;
  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>;
  resumeSession(
    params: acp.ResumeSessionRequest,
  ): Promise<acp.ResumeSessionResponse>;
  setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse>;
  prompt(params: acp.PromptRequest): Promise<acp.PromptResponse>;
  cancel(params: acp.CancelNotification): Promise<void>;
  request<Response>(method: string, params: unknown): Promise<Response>;
};

export type AcpClientHandlers = {
  requestPermission?: (
    params: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
  sessionUpdate?: (params: acp.SessionNotification) => Promise<void>;
  // SDK 1.x routed only `_`-prefixed (extension) methods to these callbacks.
  extMethod?: (method: string, params: unknown) => Promise<unknown>;
  extNotification?: (method: string, params: unknown) => Promise<void>;
};

export function connectAcpClient(
  stream: acp.Stream,
  handlers: AcpClientHandlers = {},
): AcpConnection {
  const app = acp.client();
  const toolCalls = createAcpToolCallContext();
  const { requestPermission, sessionUpdate, extMethod, extNotification } =
    handlers;

  if (requestPermission) {
    app.onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
      requestPermission(toolCalls.permission(params)),
    );
  }
  if (sessionUpdate || requestPermission) {
    app.onNotification(
      acp.methods.client.session.update,
      async ({ params }) => {
        toolCalls.observe(params);
        await sessionUpdate?.(params);
      },
    );
  }
  if (extMethod) {
    app.onRequest("*", ({ method, params }) => {
      if (!method.startsWith("_"))
        throw acp.RequestError.methodNotFound(method);

      return extMethod(method, params);
    });
  }
  if (extNotification) {
    app.onNotification("*", async ({ method, params }) => {
      if (method.startsWith("_")) await extNotification(method, params);
    });
  }

  const { agent, signal, closed } = app.connect(stream);
  const methods = acp.methods.agent;

  return {
    signal,
    closed,
    initialize: (params) => agent.request(methods.initialize, params),
    newSession: (params) => agent.request(methods.session.new, params),
    resumeSession: (params) => agent.request(methods.session.resume, params),
    setSessionConfigOption: (params) =>
      agent.request(methods.session.setConfigOption, params),
    prompt: (params) => agent.request(methods.session.prompt, params),
    cancel: (params) => agent.notify(methods.session.cancel, params),
    request: <Response>(method: string, params: unknown) =>
      agent.request<Response>(method, params),
  };
}
