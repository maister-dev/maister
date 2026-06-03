export async function callExt(opts: {
  baseUrl: string;
  authHeader: string;
  method: "GET" | "POST" | "PATCH";
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

export async function restResponseToToolError(res: Response): Promise<{
  isError: true;
  status: number;
  code: string;
  message: string;
}> {
  const text = await res.text();

  try {
    const json = JSON.parse(text) as { code: string; message: string };

    return {
      isError: true,
      status: res.status,
      code: json.code,
      message: json.message,
    };
  } catch {
    return {
      isError: true,
      status: res.status,
      code: "UPSTREAM",
      message: res.statusText || text.slice(0, 200),
    };
  }
}
