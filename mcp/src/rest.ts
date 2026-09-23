export async function callExt(opts: {
  baseUrl: string;
  authHeader: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<Response> {
  const { baseUrl, authHeader, method, path, body, signal } = opts;

  const headers: Record<string, string> = {
    Authorization: authHeader,
  };

  const init: RequestInit = { method, headers, signal };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  return fetch(`${baseUrl}${path}`, init);
}

type ParsedUpstreamError = {
  isError: true;
  status: number;
  code: string;
  message: string;
  publicBody?: Record<string, unknown>;
};

async function parseUpstreamError(res: Response): Promise<ParsedUpstreamError> {
  const raw = await res.text();

  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).code === "string" &&
      typeof (parsed as Record<string, unknown>).message === "string"
    ) {
      const publicBody = parsed as Record<string, unknown>;

      return {
        isError: true,
        status: res.status,
        code: publicBody.code as string,
        message: publicBody.message as string,
        publicBody,
      };
    }
  } catch {
    // Present malformed upstream responses as an ordinary transport failure.
  }

  return {
    isError: true,
    status: res.status,
    code: "UPSTREAM",
    message: res.statusText || raw.slice(0, 200),
  };
}

export async function restResponseToToolError(res: Response): Promise<{
  isError: true;
  status: number;
  code: string;
  message: string;
}> {
  const { isError, status, code, message } = await parseUpstreamError(res);

  return { isError, status, code, message };
}

export async function hitlRespondToolError(
  res: Response,
): Promise<ParsedUpstreamError> {
  return parseUpstreamError(res);
}
