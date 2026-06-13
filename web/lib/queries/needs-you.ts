import "server-only";

import type { GlobalRole } from "@/lib/db/schema";

import { getUnreadInboxCount } from "@/lib/queries/inbox";
import { getCrossProjectHitlInbox } from "@/lib/queries/portfolio";

// The canonical cross-project "Needs you" number: respondable HITL across the
// visible projects plus unread mentions/comments. Every cross-project surface
// (rail Inbox badge, portfolio headline, /inbox) reads this one count; the
// project board computes the project-scoped equivalent inline. RBAC scoping is
// inherited from the two queries (admin = all, member = own projects).
export async function getNeedsYouCount(
  userId: string,
  globalRole: GlobalRole,
): Promise<number> {
  const [hitl, unread] = await Promise.all([
    getCrossProjectHitlInbox(userId, globalRole),
    getUnreadInboxCount(userId, globalRole),
  ]);

  return hitl.count + unread;
}
