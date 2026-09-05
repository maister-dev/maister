import "@/styles/globals.css";
import { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import clsx from "clsx";
import { cookies } from "next/headers";

import { Providers } from "./providers";

import { siteConfig } from "@/config/site";
import { fontMono, fontSans } from "@/config/fonts";

export const metadata: Metadata = {
  title: {
    default: siteConfig.name,
    template: `%s · ${siteConfig.name}`,
  },
  description: siteConfig.description,
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0c120d" },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const cookieStore = await cookies();

  const theme = cookieStore.get("theme")?.value === "dark" ? "dark" : "light";

  return (
    <html
      suppressHydrationWarning
      className={clsx(fontSans.variable, fontMono.variable, theme)}
      lang={locale}
      // @ts-ignore
      style={{ "color-scheme": theme }}
    >
      <head />
      <body className="min-h-screen bg-paper-warm font-sans text-body antialiased">
        <NextIntlClientProvider>
          <Providers initialTheme={theme}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
