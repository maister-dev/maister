import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site-config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { allow: "/", userAgent: "*" },
    sitemap: new URL("/sitemap.xml", siteUrl()).toString(),
  };
}
