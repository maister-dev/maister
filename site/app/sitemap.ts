import type { MetadataRoute } from "next";

import { LOCALES } from "@/lib/locale";
import { siteUrl } from "@/lib/site-config";

export default function sitemap(): MetadataRoute.Sitemap {
  return LOCALES.map((locale) => ({
    changeFrequency: "weekly",
    priority: locale === "en" ? 1 : 0.9,
    url: new URL(`/${locale}`, siteUrl()).toString(),
  }));
}
