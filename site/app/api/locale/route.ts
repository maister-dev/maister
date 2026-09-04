import type { NextRequest } from "next/server";

import { NextResponse } from "next/server";

import { isLocale, LOCALE_COOKIE } from "@/lib/locale";

export function GET(request: NextRequest): NextResponse {
  const locale = request.nextUrl.searchParams.get("locale");

  if (!locale || !isLocale(locale)) {
    return NextResponse.json(
      { error: "INVALID_LOCALE" },
      { status: 400 },
    );
  }

  const response = NextResponse.redirect(new URL(`/${locale}`, request.url));

  response.cookies.set(LOCALE_COOKIE, locale, {
    httpOnly: true,
    maxAge: 31_536_000,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}
