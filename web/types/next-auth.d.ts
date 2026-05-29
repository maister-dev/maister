import type { DefaultSession } from "next-auth";
import type { GlobalRole } from "@/lib/db/schema";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: GlobalRole;
      mustChangePassword: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    role?: GlobalRole;
    mustChangePassword?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: GlobalRole;
    mustChangePassword?: boolean;
  }
}
