export type AuthContext =
  | { transport: "http"; inboundAuthorization?: string }
  | { transport: "stdio"; env: { MAISTER_PROJECT_TOKEN?: string } };

export function resolveAuthHeader(ctx: AuthContext): string | null {
  if (ctx.transport === "http") {
    return ctx.inboundAuthorization?.length ? ctx.inboundAuthorization : null;
  }
  // stdio
  const token = ctx.env.MAISTER_PROJECT_TOKEN;

  return token?.length ? `Bearer ${token}` : null;
}

/**
 * Build an http AuthContext from the raw header value provided by
 * IsomorphicHeaders (Record<string, string | string[] | undefined>).
 * When the header is duplicated the SDK may give a string[] — we take
 * the first element. Never logs or persists the value.
 */
export function httpAuthContext(rawHeader: string | string[] | undefined): {
  transport: "http";
  inboundAuthorization?: string;
} {
  let inboundAuthorization: string | undefined;

  if (typeof rawHeader === "string") {
    inboundAuthorization = rawHeader;
  } else if (Array.isArray(rawHeader) && rawHeader.length > 0) {
    inboundAuthorization = rawHeader[0];
  }

  return { transport: "http", inboundAuthorization };
}
