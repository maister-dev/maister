import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

export async function hasExecutionHostAdminAccess(
  userId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({
      role: users.role,
      accountStatus: users.accountStatus,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];

  return (
    user?.role === "admin" &&
    user.accountStatus === "active" &&
    !user.mustChangePassword
  );
}
