import type { ApiErrorBody } from "@/lib/api-error";

import { readApiErrorBody } from "@/lib/api-error";

type TrustResult =
  | { kind: "complete" }
  | { kind: "setup"; href: string }
  | { kind: "unconfirmed"; error: ApiErrorBody };

/** Only the durable setup receipt distinguishes accepted trust from a refused command. */
export async function requestPackageTrust(url: string): Promise<TrustResult> {
  const response = await fetch(url, { method: "POST" });
  const body = await readApiErrorBody(response);

  if (response.ok && body?.ok === true) return { kind: "complete" };
  const details = body?.details;

  if (
    ((response.status === 409 && body?.code === "CONFLICT") ||
      (response.status === 502 && body?.code === "FLOW_INSTALL")) &&
    details?.trustAccepted === true &&
    typeof details.projectSlug === "string" &&
    details.projectSlug &&
    typeof details.declarationId === "string" &&
    details.declarationId
  ) {
    return {
      kind: "setup",
      href: `/projects/${encodeURIComponent(details.projectSlug)}?tab=packages#dependency-${encodeURIComponent(details.declarationId)}`,
    };
  }

  return { kind: "unconfirmed", error: body };
}
