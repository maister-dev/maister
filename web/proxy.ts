import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import authConfig from "@/auth.config";

const { auth } = NextAuth(authConfig);
const EXECUTION_HOST_ADMIN_PATH = "/admin/execution-host";
const EXECUTION_HOST_DENIED_PATH = "/access-denied/execution-host";

export default auth(async (req) => {
  const { nextUrl } = req;
  const isLoggedIn = Boolean(req.auth);
  const isLoginPage = nextUrl.pathname === "/login";

  if (isLoginPage) {
    if (isLoggedIn) {
      return NextResponse.redirect(new URL("/", nextUrl));
    }

    return NextResponse.next();
  }

  if (!isLoggedIn) {
    const url = new URL("/login", nextUrl);

    url.searchParams.set("callbackUrl", nextUrl.pathname + nextUrl.search);

    return NextResponse.redirect(url);
  }

  if (
    nextUrl.pathname === EXECUTION_HOST_ADMIN_PATH ||
    nextUrl.pathname.startsWith(`${EXECUTION_HOST_ADMIN_PATH}/`)
  ) {
    const userId = req.auth?.user?.id;

    if (typeof userId !== "string") {
      return NextResponse.redirect(new URL("/login", nextUrl));
    }

    const { hasActiveGlobalRoleById } = await import("@/lib/authz");

    if (!(await hasActiveGlobalRoleById(userId, "admin"))) {
      return NextResponse.rewrite(
        new URL(EXECUTION_HOST_DENIED_PATH, nextUrl),
        { status: 403 },
      );
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
