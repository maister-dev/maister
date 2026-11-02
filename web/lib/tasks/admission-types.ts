import "server-only";

import { requireActiveSession } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";

const interactiveAuthority = Symbol("interactive task launch");

/** Only the active-session adapter can construct a human decision. Never decode this from a request. */
export type InteractiveTaskLaunchPrincipal = Readonly<{
  kind: "session_user";
  userId: string;
  [interactiveAuthority]: true;
}>;

export async function interactiveTaskLaunchPrincipal(): Promise<InteractiveTaskLaunchPrincipal> {
  const user = await requireActiveSession();

  return {
    kind: "session_user",
    userId: user.id,
    [interactiveAuthority]: true,
  };
}

export function assertInteractiveTaskLaunchPrincipal(
  principal: InteractiveTaskLaunchPrincipal,
): void {
  if (
    principal?.[interactiveAuthority] !== true ||
    principal.kind !== "session_user"
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "An explicit authenticated user action is required",
      {
        details: { reason: "launch_manual_authority_required" },
      },
    );
}
